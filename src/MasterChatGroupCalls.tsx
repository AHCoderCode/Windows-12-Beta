import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertTriangle, Camera, CameraOff, Check, LoaderCircle, Mic, MicOff, PhoneCall, PhoneOff, ShieldCheck, UserRound, Users, Video, X } from 'lucide-react';
import { VOICE_MICROPHONE_CONSTRAINTS, REMOTE_AUDIO_FALLBACK_VOLUME } from './voiceAudio';

type Profile = { id: string; username: string; avatar_data?: string | null };
type GroupOption = { id: string; name: string; avatar_data?: string | null };
type SessionRow = {
  id: string;
  group_id: string;
  initiator_id: string;
  media_type: 'audio' | 'video';
  status: 'active' | 'ended';
  created_at: string;
  ended_at?: string | null;
};
type ParticipantRow = {
  group_call_id: string;
  user_id: string;
  invited_by: string;
  status: 'invited' | 'accepted' | 'declined' | 'left';
  created_at: string;
  responded_at?: string | null;
};
type ParticipantView = Profile & { status: ParticipantRow['status'] };
type GroupSignal = {
  id: string;
  group_call_id: string;
  from_user_id: string;
  to_user_id: string;
  kind: 'offer' | 'answer' | 'ice';
  payload: Record<string, unknown>;
  created_at?: string;
};
type IncomingInvite = {
  session: SessionRow;
  groupName: string;
  initiator: Profile;
  created_at: string;
};

type Props = {
  client: SupabaseClient | null;
  profile: Profile;
  groups: GroupOption[];
  activeGroup: GroupOption | null;
  enabled: boolean;
  pickerOpen: boolean;
  onPickerClose: () => void;
  portalRoot?: HTMLElement | null;
};

export function MasterChatGroupCalls({ client, profile, groups, activeGroup, enabled, pickerOpen, onPickerClose, portalRoot }: Props) {
  const [activeSession, setActiveSession] = useState<SessionRow | null>(null);
  const [incomingInvites, setIncomingInvites] = useState<IncomingInvite[]>([]);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [mainVideoUserId, setMainVideoUserId] = useState(profile.id);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const activeSessionRef = useRef<SessionRow | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingPeerSetupRef = useRef<Map<string, Promise<RTCPeerConnection | null>>>(new Map());
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const processingSignalsRef = useRef<Set<string>>(new Set());
  const processedSignalsRef = useRef<Set<string>>(new Set());
  const participantProfilesRef = useRef<ParticipantView[]>([]);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  const turnServersRef = useRef<Map<string, RTCIceServer[]>>(new Map());
  const turnServerRequestsRef = useRef<Map<string, Promise<RTCIceServer[]>>>(new Map());
  const sessionStartRef = useRef<number | null>(null);

  participantProfilesRef.current = participants;
  localStreamRef.current = localStream;
  activeSessionRef.current = activeSession;

  const setSession = useCallback((next: SessionRow | null) => {
    activeSessionRef.current = next;
    setActiveSession(next);
  }, []);

  const getRelayServers = useCallback(async (sessionId: string): Promise<RTCIceServer[]> => {
    const cached = turnServersRef.current.get(sessionId);
    if (cached?.length) return cached;
    const pending = turnServerRequestsRef.current.get(sessionId);
    if (pending) return pending;

    const request = (async (): Promise<RTCIceServer[]> => {
      if (!client) throw new Error('The group calling service is unavailable.');
      const { data: leg, error: legError } = await client.from('aeroshell_calls')
        .select('id')
        .eq('group_call_id', sessionId)
        .eq('status', 'accepted')
        .or('caller_id.eq.' + profile.id + ',callee_id.eq.' + profile.id)
        .limit(1)
        .maybeSingle();
      if (legError || !leg) throw new Error('Waiting for an accepted group member before opening the private relay.');
      const { data, error } = await client.functions.invoke('master-chat-turn-credentials', { body: { callId: leg.id } });
      if (error) throw new Error('The private relay is unavailable. Verify the Metered TURN server settings and retry the group call.');
      const raw = Array.isArray(data?.iceServers) ? data.iceServers as RTCIceServer[] : [];
      const servers: RTCIceServer[] = raw.flatMap(server => {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url): url is string =>
          typeof url === 'string' && /^turns?:[a-z0-9.-]+\\.relay\\.metered\\.ca:\\d+(?:\\?transport=(?:tcp|udp))?$/i.test(url.trim()));
        if (!urls.length || typeof server.username !== 'string' || !server.username.trim() ||
          typeof server.credential !== 'string' || !server.credential.trim()) return [];
        return [{ urls: urls.length === 1 ? urls[0] : urls, username: server.username, credential: server.credential }];
      });
      if (!servers.length) throw new Error('The private relay returned no usable TURN credentials. No direct connection will be attempted.');
      turnServersRef.current.set(sessionId, servers);
      return servers;
    })();

    turnServerRequestsRef.current.set(sessionId, request);
    try {
      return await request;
    } finally {
      if (turnServerRequestsRef.current.get(sessionId) === request) {
        turnServerRequestsRef.current.delete(sessionId);
      }
    }
  }, [client, profile.id]);

  const sendSignal = useCallback(async (sessionId: string, peerId: string, kind: GroupSignal['kind'], payload: Record<string, unknown>) => {
    if (!client) throw new Error('Group call signaling is unavailable.');
    const { error } = await client.from('aeroshell_group_call_signals').insert({
      group_call_id: sessionId,
      from_user_id: profile.id,
      to_user_id: peerId,
      kind,
      payload,
    });
    if (error) throw new Error('A private group-call signal could not be delivered. Check that both participants have accepted the call.');
  }, [client, profile.id]);

  const ensurePeerConnection = useCallback(async (session: SessionRow, peer: Profile, initiateOffer: boolean): Promise<RTCPeerConnection | null> => {
    if (!client || peer.id === profile.id || !localStreamRef.current || activeSessionRef.current?.id !== session.id) return null;
    const existing = peerConnectionsRef.current.get(peer.id);
    if (existing && existing.connectionState !== 'closed') return existing;
    const pending = pendingPeerSetupRef.current.get(peer.id);
    if (pending) return pending;

    const promise = (async () => {
      let servers: RTCIceServer[];
      try {
        servers = await getRelayServers(session.id);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not prepare the private group-call relay.');
        return null;
      }
      if (activeSessionRef.current?.id !== session.id || !localStreamRef.current) return null;
      const pc = new RTCPeerConnection({
        iceServers: servers,
        iceTransportPolicy: 'relay',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 0,
      });
      peerConnectionsRef.current.set(peer.id, pc);
      localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current!));
      pc.onicecandidate = event => {
        if (!event.candidate || activeSessionRef.current?.id !== session.id) return;
        void sendSignal(session.id, peer.id, 'ice', { candidate: event.candidate.toJSON() }).catch(error => {
          setNotice(error instanceof Error ? error.message : 'A group-call network candidate was not delivered.');
        });
      };
      pc.ontrack = event => {
        if (activeSessionRef.current?.id !== session.id) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        setRemoteStreams(current => ({ ...current, [peer.id]: stream }));
        setMainVideoUserId(current => current === profile.id ? peer.id : current);
      };
      pc.onconnectionstatechange = () => {
        if (activeSessionRef.current?.id !== session.id) return;
        if (pc.connectionState === 'failed') {
          pc.close();
          peerConnectionsRef.current.delete(peer.id);
          setRemoteStreams(current => {
            const next = { ...current };
            delete next[peer.id];
            return next;
          });
          setNotice('A group member’s private relay connection failed. Other members may still remain connected.');
        }
      };
      if (initiateOffer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!pc.localDescription?.sdp) throw new Error('Could not prepare a group-call offer.');
        await sendSignal(session.id, peer.id, 'offer', { type: 'offer', sdp: pc.localDescription.sdp });
      }
      return pc;
    })();
    pendingPeerSetupRef.current.set(peer.id, promise);
    try {
      return await promise;
    } finally {
      pendingPeerSetupRef.current.delete(peer.id);
    }
  }, [client, getRelayServers, profile.id, sendSignal]);

  const processSignal = useCallback(async (signal: GroupSignal) => {
    if (signal.to_user_id !== profile.id || processingSignalsRef.current.has(signal.id) || processedSignalsRef.current.has(signal.id)) return;
    const session = activeSessionRef.current;
    if (!session || session.id !== signal.group_call_id || session.status !== 'active') return;
    processingSignalsRef.current.add(signal.id);
    try {
      let peer: Profile | undefined = participantProfilesRef.current.find(item => item.id === signal.from_user_id);
      if (!peer) {
        const { data } = await client!.from('aeroshell_profiles').select('id, username, avatar_data').eq('id', signal.from_user_id).maybeSingle();
        if (data) peer = data as Profile;
      }
      if (!peer) return;
      const initiate = profile.id.localeCompare(peer.id) < 0;
      const pc = await ensurePeerConnection(session, peer, initiate);
      if (!pc || activeSessionRef.current?.id !== session.id) return;
      if (signal.kind === 'ice') {
        const candidate = signal.payload.candidate as RTCIceCandidateInit | undefined;
        if (!candidate || typeof candidate.candidate !== 'string') return;
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Ignore stale candidates after a peer has reconnected. */ }
        } else {
          const queue = pendingIceRef.current.get(peer.id) ?? [];
          queue.push(candidate);
          pendingIceRef.current.set(peer.id, queue);
        }
      } else if (signal.kind === 'offer') {
        const sdp = signal.payload.sdp;
        if (typeof sdp !== 'string' || pc.remoteDescription || pc.signalingState !== 'stable') return;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        for (const candidate of pendingIceRef.current.get(peer.id) ?? []) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Ignore stale queued candidate. */ }
        }
        pendingIceRef.current.delete(peer.id);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        if (!pc.localDescription?.sdp) throw new Error('Could not prepare a group-call answer.');
        await sendSignal(session.id, peer.id, 'answer', { type: 'answer', sdp: pc.localDescription.sdp });
      } else {
        const sdp = signal.payload.sdp;
        if (typeof sdp !== 'string' || pc.remoteDescription || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
        for (const candidate of pendingIceRef.current.get(peer.id) ?? []) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Ignore stale queued candidate. */ }
        }
        pendingIceRef.current.delete(peer.id);
      }
      processedSignalsRef.current.add(signal.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Group-call signaling failed for one participant.');
    } finally {
      processingSignalsRef.current.delete(signal.id);
    }
  }, [client, ensurePeerConnection, profile.id, sendSignal]);

  const refreshInvites = useCallback(async () => {
    if (!client || !enabled || activeSessionRef.current) return;
    const { data: rows, error } = await client.from('aeroshell_group_call_participants')
      .select('group_call_id, invited_by, created_at')
      .eq('user_id', profile.id)
      .eq('status', 'invited')
      .order('created_at', { ascending: false })
      .limit(8);
    if (error || !rows?.length) {
      if (!error) setIncomingInvites([]);
      return;
    }
    const fresh = rows.filter(row => Date.now() - new Date(row.created_at).getTime() < 60_000);
    if (!fresh.length) { setIncomingInvites([]); return; }
    const ids = Array.from(new Set(fresh.map(row => row.group_call_id)));
    const { data: sessions } = await client.from('aeroshell_group_calls')
      .select('id, group_id, initiator_id, media_type, status, created_at, ended_at')
      .in('id', ids)
      .eq('status', 'active');
    if (!sessions?.length) { setIncomingInvites([]); return; }
    const sessionRows = sessions as SessionRow[];
    const groupIds = Array.from(new Set(sessionRows.map(row => row.group_id)));
    const initiatorIds = Array.from(new Set(sessionRows.map(row => row.initiator_id)));
    const [{ data: groupRows }, { data: initiators }] = await Promise.all([
      client.from('aeroshell_groups').select('id, name, avatar_data, created_by, updated_at').in('id', groupIds),
      client.from('aeroshell_profiles').select('id, username, avatar_data').in('id', initiatorIds),
    ]);
    const groupNameById = new Map((groupRows ?? []).map(row => [row.id, row.name as string]));
    const initiatorById = new Map(((initiators ?? []) as Profile[]).map(row => [row.id, row]));
    setIncomingInvites(sessionRows.flatMap(session => {
      const initiator = initiatorById.get(session.initiator_id);
      if (!initiator) return [];
      return [{ session, groupName: groupNameById.get(session.group_id) ?? 'Group', initiator, created_at: session.created_at }];
    }));
  }, [client, enabled, profile.id]);

  const refreshActiveSession = useCallback(async () => {
    const session = activeSessionRef.current;
    if (!client || !session) return;
    const { data: sessionRow, error: sessionError } = await client.from('aeroshell_group_calls')
      .select('id, group_id, initiator_id, media_type, status, created_at, ended_at')
      .eq('id', session.id)
      .maybeSingle();
    if (sessionError || !sessionRow) return;
    if ((sessionRow as SessionRow).status === 'ended') {
      cleanupGroupCallLocal();
      setNotice('The group call has ended.');
      return;
    }
    const { data: roster, error: rosterError } = await client.from('aeroshell_group_call_participants')
      .select('user_id, status')
      .eq('group_call_id', session.id)
      .eq('status', 'accepted');
    if (rosterError || !roster) return;
    const ids = Array.from(new Set(roster.map(row => row.user_id)));
    const { data: profiles } = ids.length
      ? await client.from('aeroshell_profiles').select('id, username, avatar_data').in('id', ids)
      : { data: [] };
    const profileById = new Map(((profiles ?? []) as Profile[]).map(row => [row.id, row]));
    const loaded = roster.flatMap(row => {
      const item = profileById.get(row.user_id);
      return item ? [{ ...item, status: 'accepted' as const }] : [];
    });
    setParticipants(loaded);
    const acceptedIds = new Set(loaded.map(item => item.id));
    for (const [peerId, pc] of peerConnectionsRef.current.entries()) {
      if (!acceptedIds.has(peerId)) {
        pc.close();
        peerConnectionsRef.current.delete(peerId);
        setRemoteStreams(current => { const next = { ...current }; delete next[peerId]; return next; });
      }
    }
    for (const peer of loaded) {
      if (peer.id === profile.id) continue;
      const initiate = profile.id.localeCompare(peer.id) < 0;
      void ensurePeerConnection(session as SessionRow, peer, initiate);
    }
  }, [client, profile.id, ensurePeerConnection]);

  const cleanupGroupCallLocal = useCallback(() => {
    for (const pc of peerConnectionsRef.current.values()) {
      try { pc.close(); } catch { /* A peer may already have disconnected. */ }
    }
    peerConnectionsRef.current.clear();
    pendingPeerSetupRef.current.clear();
    pendingIceRef.current.clear();
    processingSignalsRef.current.clear();
    processedSignalsRef.current.clear();
    turnServersRef.current.clear();
    turnServerRequestsRef.current.clear();
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams({});
    setParticipants([]);
    setMainVideoUserId(profile.id);
    setMuted(false);
    setCameraOff(false);
    setElapsedSeconds(0);
    sessionStartRef.current = null;
    setSession(null);
  }, [profile.id, setSession]);

  const startGroupCall = useCallback(async (mediaType: 'audio' | 'video') => {
    if (!client || !enabled || !activeGroup || busy || activeSessionRef.current) return;
    setBusy(true);
    setNotice('');
    let sessionId: string | null = null;
    let stream: MediaStream | null = null;
    try {
      const { data: roster, error: rosterError } = await client.from('aeroshell_group_members')
        .select('user_id')
        .eq('group_id', activeGroup.id);
      if (rosterError || !roster) throw new Error('Could not load group members. Refresh the group and try again.');
      const recipientIds = Array.from(new Set(roster.map(row => row.user_id).filter(id => id !== profile.id)));
      if (!recipientIds.length) throw new Error('Add at least one other member to this group before starting a call.');
      const { data: knownProfiles, error: profileError } = await client.from('aeroshell_profiles')
        .select('id, username, avatar_data')
        .in('id', recipientIds);
      if (profileError || (knownProfiles ?? []).length !== recipientIds.length) throw new Error('Some group member profiles could not be loaded. Please try again.');
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new Error('This browser does not support secure group calls. Use a current browser over HTTPS.');
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: VOICE_MICROPHONE_CONSTRAINTS,
        video: mediaType === 'video' ? { facingMode: 'user', width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } } : false,
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      const { data: created, error: createError } = await client.from('aeroshell_group_calls')
        .insert({ group_id: activeGroup.id, initiator_id: profile.id, media_type: mediaType, status: 'active' })
        .select('id, group_id, initiator_id, media_type, status, created_at, ended_at')
        .single();
      if (createError || !created) throw new Error('Could not start a group call. Verify the group-call database migration is installed.');
      sessionId = created.id;
      const now = new Date().toISOString();
      const participantRows = [
        { group_call_id: sessionId, user_id: profile.id, invited_by: profile.id, status: 'accepted', responded_at: now },
        ...recipientIds.map(userId => ({ group_call_id: sessionId!, user_id: userId, invited_by: profile.id, status: 'invited', responded_at: null })),
      ];
      const { error: participantError } = await client.from('aeroshell_group_call_participants').insert(participantRows);
      if (participantError) throw new Error('Could not create group call invitations. Please retry.');
      const legs = recipientIds.map(userId => ({ caller_id: profile.id, callee_id: userId, media_type: mediaType, status: 'ringing', group_call_id: sessionId }));
      const { error: legsError } = await client.from('aeroshell_calls').insert(legs);
      if (legsError) throw new Error('The group call could not invite every member. Check that the group-call database migration is installed and no member has another active call.');
      const session = created as SessionRow;
      setSession(session);
      setParticipants([{ ...profile, status: 'accepted' }]);
      setMainVideoUserId(profile.id);
      sessionStartRef.current = Date.now();
      setElapsedSeconds(0);
      onPickerClose();
      setNotice('Group call started. All ' + recipientIds.length + ' other member' + (recipientIds.length === 1 ? '' : 's') + ' have been invited.');
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
      setLocalStream(null);
      if (client && sessionId) {
        try {
          await client.from('aeroshell_group_calls').update({ status: 'ended', ended_at: new Date().toISOString() }).eq('id', sessionId);
          await client.from('aeroshell_calls').update({ status: 'ended' }).eq('group_call_id', sessionId).in('status', ['ringing', 'accepted']);
        } catch { /* The UI still closes if invite cleanup fails. */ }
      }
      setNotice(error instanceof Error ? error.message : 'Could not start the group call.');
    } finally { setBusy(false); }
  }, [activeGroup, busy, client, enabled, onPickerClose, profile, setSession]);

  const acceptInvite = useCallback(async (invite: IncomingInvite) => {
    if (!client || busy || activeSessionRef.current) return;
    setBusy(true);
    setNotice('');
    let stream: MediaStream | null = null;
    try {
      const { data: activeCalls, error: activeError } = await client.from('aeroshell_calls')
        .select('id')
        .in('status', ['ringing', 'accepted'])
        .or('caller_id.eq.' + profile.id + ',callee_id.eq.' + profile.id)
        .limit(1);
      if (activeError) throw new Error('Could not check your current call state. Refresh and try again.');
      if (activeCalls?.length) throw new Error('Finish your current voice/video call before accepting a group call.');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support calls over HTTPS.');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: VOICE_MICROPHONE_CONSTRAINTS,
        video: invite.session.media_type === 'video' ? { facingMode: 'user', width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 } } : false,
      });
      const { data: participant, error: participantError } = await client.from('aeroshell_group_call_participants')
        .update({ status: 'accepted', responded_at: new Date().toISOString() })
        .eq('group_call_id', invite.session.id)
        .eq('user_id', profile.id)
        .eq('status', 'invited')
        .select('user_id')
        .maybeSingle();
      if (participantError || !participant) throw new Error('This invitation is no longer available. Ask the group to invite you again.');
      const { data: leg, error: legError } = await client.from('aeroshell_calls')
        .update({ status: 'accepted' })
        .eq('group_call_id', invite.session.id)
        .eq('callee_id', profile.id)
        .eq('status', 'ringing')
        .select('id')
        .maybeSingle();
      if (legError || !leg) {
        await client.from('aeroshell_group_call_participants').update({ status: 'declined', responded_at: new Date().toISOString() })
          .eq('group_call_id', invite.session.id).eq('user_id', profile.id).eq('status', 'accepted');
        throw new Error('You may already be in another call, or this call has expired. Finish other calls and request a new invitation.');
      }
      localStreamRef.current = stream;
      setLocalStream(stream);
      const session = invite.session;
      setSession(session);
      setParticipants([{ ...profile, status: 'accepted' }]);
      setMainVideoUserId(profile.id);
      sessionStartRef.current = Date.now();
      setElapsedSeconds(0);
      setIncomingInvites(current => current.filter(item => item.session.id !== invite.session.id));
      setNotice('You joined ' + invite.groupName + '. Connecting to the other participants…');
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      setNotice(error instanceof Error ? error.message : 'Could not join the group call.');
    } finally { setBusy(false); }
  }, [busy, client, profile, setSession]);

  const declineInvite = useCallback(async (invite: IncomingInvite) => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.from('aeroshell_group_call_participants')
        .update({ status: 'declined', responded_at: new Date().toISOString() })
        .eq('group_call_id', invite.session.id).eq('user_id', profile.id).eq('status', 'invited');
      await client.from('aeroshell_calls')
        .update({ status: 'rejected' })
        .eq('group_call_id', invite.session.id).eq('callee_id', profile.id).eq('status', 'ringing');
      setIncomingInvites(current => current.filter(item => item.session.id !== invite.session.id));
    } finally { setBusy(false); }
  }, [busy, client, profile.id]);

  const endGroupCall = useCallback(async () => {
    const session = activeSessionRef.current;
    if (!client || !session || busy) return;
    setBusy(true);
    try {
      if (session.initiator_id === profile.id) {
        await client.from('aeroshell_group_calls')
          .update({ status: 'ended', ended_at: new Date().toISOString() })
          .eq('id', session.id).eq('initiator_id', profile.id).eq('status', 'active');
        await client.from('aeroshell_calls').update({ status: 'ended' })
          .eq('group_call_id', session.id).in('status', ['ringing', 'accepted']);
      } else {
        await client.from('aeroshell_group_call_participants')
          .update({ status: 'left', responded_at: new Date().toISOString() })
          .eq('group_call_id', session.id).eq('user_id', profile.id).eq('status', 'accepted');
        await client.from('aeroshell_calls').update({ status: 'ended' })
          .eq('group_call_id', session.id).eq('callee_id', profile.id).eq('status', 'accepted');
      }
    } finally {
      cleanupGroupCallLocal();
      setBusy(false);
    }
  }, [busy, client, cleanupGroupCallLocal, profile.id]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach(track => { track.enabled = !next; });
    setCameraOff(next);
  }, [cameraOff]);

  useEffect(() => {
    if (localVideoRef.current && localStream && localVideoRef.current.srcObject !== localStream) {
      localVideoRef.current.srcObject = localStream;
      void localVideoRef.current.play().catch(() => undefined);
    }
  }, [localStream, activeSession?.id, mainVideoUserId]);

  useEffect(() => {
    if (!enabled || !client) {
      setIncomingInvites([]);
      return;
    }
    let running = false;
    const poll = () => {
      if (running || document.visibilityState === 'hidden' || activeSessionRef.current) return;
      running = true;
      void refreshInvites().finally(() => { running = false; });
    };
    poll();
    const interval = window.setInterval(poll, 3500);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    const channel = client.channel('aeroshell-group-call-invitations-' + profile.id, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_group_call_participants', filter: 'user_id=eq.' + profile.id }, () => poll())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'aeroshell_group_call_participants', filter: 'user_id=eq.' + profile.id }, () => poll())
      .subscribe();
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', poll);
      document.removeEventListener('visibilitychange', poll);
      void client.removeChannel(channel);
    };
  }, [client, enabled, profile.id, refreshInvites]);

  useEffect(() => {
    if (!activeSession || !client) return;
    let running = false;
    const sync = () => {
      if (running || document.visibilityState === 'hidden' || activeSessionRef.current?.id !== activeSession.id) return;
      running = true;
      void refreshActiveSession().finally(() => { running = false; });
    };
    sync();
    const interval = window.setInterval(sync, 2200);
    window.addEventListener('focus', sync);
    const signalChannel = client.channel('aeroshell-group-call-mesh-' + activeSession.id + '-' + profile.id, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_group_call_signals', filter: 'to_user_id=eq.' + profile.id }, payload => {
        const signal = payload.new as GroupSignal;
        if (signal.group_call_id === activeSession.id) void processSignal(signal);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'aeroshell_group_call_participants', filter: 'group_call_id=eq.' + activeSession.id }, () => sync())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'aeroshell_group_calls', filter: 'id=eq.' + activeSession.id }, () => sync())
      .subscribe();
    const signalPoll = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || activeSessionRef.current?.id !== activeSession.id) return;
      void client.from('aeroshell_group_call_signals')
        .select('id, group_call_id, from_user_id, to_user_id, kind, payload, created_at')
        .eq('group_call_id', activeSession.id)
        .eq('to_user_id', profile.id)
        .order('created_at', { ascending: true })
        .limit(150)
        .then(({ data }) => {
          for (const item of (data ?? []) as GroupSignal[]) void processSignal(item);
        });
    }, 2200);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(signalPoll);
      window.removeEventListener('focus', sync);
      void client.removeChannel(signalChannel);
    };
  }, [activeSession?.id, client, processSignal, profile.id, refreshActiveSession]);

  useEffect(() => {
    if (!activeSession) return;
    const interval = window.setInterval(() => {
      if (sessionStartRef.current !== null) setElapsedSeconds(Math.floor((Date.now() - sessionStartRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [activeSession?.id]);

  useEffect(() => {
    if (!pickerOpen || !activeGroup) return;
    setNotice('');
  }, [pickerOpen, activeGroup?.id]);

  const selectedMainProfile = useMemo(() =>
    mainVideoUserId === profile.id ? profile : participants.find(item => item.id === mainVideoUserId) ?? null,
  [mainVideoUserId, participants, profile]);

  const modalTarget = portalRoot ?? document.body;
  const view = <>
    {pickerOpen && activeGroup && <div className="master-chat-group-call-picker-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onPickerClose(); }}>
      <section className="master-chat-group-call-picker" role="dialog" aria-modal="true" aria-label="Start a group call">
        <button type="button" className="master-chat-group-call-close" aria-label="Close group call options" onClick={onPickerClose}><X size={18}/></button>
        <span className="master-chat-group-call-icon"><Users size={24}/></span>
        <p className="master-chat-group-call-eyebrow">GROUP CALL</p>
        <h3>Call {activeGroup.name}</h3>
        <p>Every member of this group will be invited. Members choose whether to accept or decline. Use a small group for the smoothest video performance.</p>
        <div className="master-chat-group-call-actions">
          <button type="button" className="voice-option" disabled={busy} onClick={() => void startGroupCall('audio')}><PhoneCall size={18}/><span><b>Voice call</b><small>Audio only</small></span>{busy && <LoaderCircle className="spin" size={16}/>}</button>
          <button type="button" className="video-option" disabled={busy} onClick={() => void startGroupCall('video')}><Video size={18}/><span><b>Video call</b><small>Camera and microphone</small></span>{busy && <LoaderCircle className="spin" size={16}/>}</button>
        </div>
      </section>
    </div>}
    {!activeSession && incomingInvites.length > 0 && <div className="master-chat-group-call-picker-overlay" role="presentation">
      <section className="master-chat-group-call-invite" role="dialog" aria-modal="true" aria-label="Incoming group call invitation">
        <span className="master-chat-group-call-icon incoming"><PhoneCall size={24}/></span>
        <p className="master-chat-group-call-eyebrow">INCOMING GROUP {incomingInvites[0].session.media_type === 'video' ? 'VIDEO' : 'VOICE'} CALL</p>
        <h3>{incomingInvites[0].initiator.username} invited you</h3>
        <p className="master-chat-group-call-invite-group"><Users size={15}/>{incomingInvites[0].groupName}</p>
        <p>You will join only after accepting. Your camera and microphone will be requested before you connect.</p>
        {notice && <p className="master-chat-group-call-error" role="status">{notice}</p>}
        <div className="master-chat-group-call-actions">
          <button type="button" className="decline" disabled={busy} onClick={() => void declineInvite(incomingInvites[0])}><X size={17}/><span>Decline</span></button>
          <button type="button" className="accept" disabled={busy} onClick={() => void acceptInvite(incomingInvites[0])}>{busy ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>}<span>Accept call</span></button>
        </div>
      </section>
    </div>}
    {activeSession && <div className="master-chat-group-call-overlay" role="dialog" aria-modal="true" aria-label={activeSession.media_type === 'video' ? 'Group video call' : 'Group voice call'}>
      <section className="master-chat-group-call-stage">
        <header className="master-chat-group-call-topbar">
          <span className="master-chat-group-call-avatar">{groups.find(item => item.id === activeSession.group_id)?.avatar_data ? <img src={groups.find(item => item.id === activeSession.group_id)?.avatar_data ?? ''} alt=""/> : <Users size={19}/>}</span>
          <span className="master-chat-group-call-title"><b>{groups.find(item => item.id === activeSession.group_id)?.name ?? 'Group call'}</b><small>{participants.length} joined · {elapsedSeconds < 3600 ? new Date(elapsedSeconds * 1000).toISOString().slice(14,19) : Math.floor(elapsedSeconds / 3600) + ':' + new Date(elapsedSeconds * 1000).toISOString().slice(14,19)}</small></span>
          <span className="master-chat-group-call-private"><ShieldCheck size={14}/> Relay protected</span>
          <button type="button" className="master-chat-group-call-close" aria-label="End group call" title="End group call" disabled={busy} onClick={() => void endGroupCall()}><X size={18}/></button>
        </header>
        {activeSession.media_type === 'video' ? <div className="master-chat-group-call-video-stage">
          {mainVideoUserId === profile.id
            ? <video ref={node => { localVideoRef.current = node; if (node && localStream && node.srcObject !== localStream) { node.srcObject = localStream; void node.play().catch(() => undefined); } }} autoPlay playsInline muted className="master-chat-group-video-main self" aria-label="Your camera, enlarged"/>
            : remoteStreams[mainVideoUserId]
              ? <video key={'main-'+mainVideoUserId} ref={node => { if (node) { remoteVideoRefs.current.set(mainVideoUserId,node); const stream=remoteStreams[mainVideoUserId]; if (stream && node.srcObject !== stream) { node.srcObject=stream; void node.play().catch(() => undefined); } } else remoteVideoRefs.current.delete(mainVideoUserId); }} autoPlay playsInline muted className="master-chat-group-video-main" aria-label={'Video from '+(selectedMainProfile?.username ?? 'group member')}/>
              : <div className="master-chat-group-video-placeholder"><span className="master-chat-group-call-avatar large">{selectedMainProfile?.avatar_data ? <img src={selectedMainProfile.avatar_data} alt=""/> : <UserRound size={34}/>}</span><b>{selectedMainProfile?.username ?? 'Connecting to group…'}</b><small>Waiting for video…</small></div>}
          <div className="master-chat-group-call-thumbnails">
            {mainVideoUserId !== profile.id && <button type="button" className="master-chat-group-thumb tile" onClick={() => setMainVideoUserId(profile.id)} aria-label="Enlarge your own video">
              <video ref={node => { localVideoRef.current = node; if (node && localStream && node.srcObject !== localStream) { node.srcObject = localStream; void node.play().catch(() => undefined); } }} autoPlay playsInline muted className="master-chat-group-thumb-video self" />
              <span>You</span>
            </button>}
            {participants.filter(person => person.id !== profile.id && person.id !== mainVideoUserId).map(person => <button type="button" className="master-chat-group-thumb tile" key={person.id} onClick={() => setMainVideoUserId(person.id)} aria-label={'Enlarge '+person.username+' video'}>
              {remoteStreams[person.id] ? <video ref={node => { if (node) { remoteVideoRefs.current.set(person.id,node); const stream=remoteStreams[person.id]; if (stream && node.srcObject !== stream) { node.srcObject=stream; void node.play().catch(() => undefined); } } else remoteVideoRefs.current.delete(person.id); }} autoPlay playsInline muted className="master-chat-group-thumb-video" /> : <span className="master-chat-group-thumb-avatar">{person.avatar_data ? <img src={person.avatar_data} alt=""/> : person.username.slice(0,1).toUpperCase()}</span>}
              <span>{person.username}</span>
            </button>)}
          </div>
          {participants.filter(person => person.id !== profile.id).map(person => remoteStreams[person.id] && <audio key={'audio-'+person.id} autoPlay ref={node => { if (node && node.srcObject !== remoteStreams[person.id]) { node.srcObject=remoteStreams[person.id]; node.volume=REMOTE_AUDIO_FALLBACK_VOLUME; void node.play().catch(() => undefined); } }} className="master-chat-group-call-hidden-audio" aria-label={'Audio from '+person.username}/>)}
        </div> : <div className="master-chat-group-call-audio-stage">
          <span className="master-chat-group-call-audio-orb"><Users size={40}/></span>
          <h2>{groups.find(item => item.id === activeSession.group_id)?.name ?? 'Group call'}</h2>
          <p>{participants.length} participants joined</p>
          <div className="master-chat-group-audio-people">{participants.map(person => <span key={person.id} className="master-chat-group-audio-person"><span>{person.avatar_data ? <img src={person.avatar_data} alt=""/> : person.username.slice(0,1).toUpperCase()}</span><b>{person.username}{person.id === profile.id ? ' (you)' : ''}</b></span>)}</div>
          {participants.filter(person => person.id !== profile.id).map(person => remoteStreams[person.id] && <audio key={'audio-'+person.id} autoPlay ref={node => { if (node && node.srcObject !== remoteStreams[person.id]) { node.srcObject=remoteStreams[person.id]; node.volume=REMOTE_AUDIO_FALLBACK_VOLUME; void node.play().catch(() => undefined); } }} className="master-chat-group-call-hidden-audio" aria-label={'Audio from '+person.username}/>)}
        </div>}
        <div className="master-chat-group-call-controls">
          <button type="button" className={muted ? 'muted' : ''} onClick={toggleMute}>{muted ? <MicOff size={18}/> : <Mic size={18}/>}<span>{muted ? 'Unmute' : 'Mute'}</span></button>
          {activeSession.media_type === 'video' && <button type="button" className={cameraOff ? 'muted' : ''} onClick={toggleCamera}>{cameraOff ? <CameraOff size={18}/> : <Camera size={18}/>}<span>{cameraOff ? 'Camera on' : 'Camera off'}</span></button>}
          <button type="button" className="end" disabled={busy} onClick={() => void endGroupCall()}><PhoneOff size={18}/><span>End call</span></button>
        </div>
        {notice && <div className="master-chat-group-call-notice" role="status">{notice}</div>}
      </section>
    </div>}
    {notice && !activeSession && !incomingInvites.length && !pickerOpen && createPortal(<div className="master-chat-group-call-toast" role="status"><AlertTriangle size={15}/><span>{notice}</span><button type="button" aria-label="Dismiss group call notice" onClick={() => setNotice('')}><X size={14}/></button></div>, modalTarget)}
  </>;
  return createPortal(view, modalTarget);
}
