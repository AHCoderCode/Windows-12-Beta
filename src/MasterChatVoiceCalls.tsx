import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AlertTriangle, LoaderCircle, Mic, MicOff, PhoneCall, PhoneIncoming, PhoneOff, ShieldCheck, X } from 'lucide-react';
import { setSafeRemoteAudioVolume, VOICE_MICROPHONE_CONSTRAINTS } from './voiceAudio';

type ChatProfile = { id: string; username: string; avatar_data?: string | null };
type CallRow = {
  id: string;
  caller_id: string;
  callee_id: string;
  status: 'ringing' | 'accepted' | 'rejected' | 'ended';
  created_at: string;
  updated_at: string;
};
type CallSignal = {
  id: string;
  call_id: string;
  from_user_id: string;
  to_user_id: string;
  kind: 'offer' | 'answer' | 'ice';
  payload: Record<string, unknown>;
  created_at?: string;
};
type CallView = CallRow & { direction: 'incoming' | 'outgoing'; peer: ChatProfile };
type CallState = 'idle' | 'preparing' | 'outgoing' | 'incoming' | 'connecting' | 'connected';

type Props = {
  client: SupabaseClient | null;
  profile: ChatProfile;
  people: ChatProfile[];
  activePerson: ChatProfile | null;
  enabled: boolean;
  showCallLauncher?: boolean;
  /** Place overlays inside the native fullscreen element when necessary. */
  portalRoot?: HTMLElement | null;
};

const MAX_CALL_MS = 50 * 60 * 1000;

function durationLabel(seconds: number) {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = Math.floor(seconds % 60).toString().padStart(2, '0');
  return mm + ':' + ss;
}

export function MasterChatVoiceCalls({ client, profile, people, activePerson, enabled, showCallLauncher = true, portalRoot }: Props) {
  const [activeCall, setActiveCall] = useState<CallView | null>(null);
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false);
  const [callState, setCallState] = useState<CallState>('idle');
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [quietIncoming, setQuietIncoming] = useState(false);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeCallRef = useRef<CallView | null>(null);
  const peopleRef = useRef(people);
  peopleRef.current = people;
  const pendingSignalsRef = useRef<Map<string, CallSignal[]>>(new Map());
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const seenSignalIdsRef = useRef<Set<string>>(new Set());
  const ringTimerRef = useRef<number | null>(null);
  const callExpiryTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const setCall = useCallback((next: CallView | null) => {
    activeCallRef.current = next;
    setActiveCall(next);
  }, []);

  const cleanupLocal = useCallback(() => {
    if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current);
    if (callExpiryTimerRef.current !== null) window.clearTimeout(callExpiryTimerRef.current);
    ringTimerRef.current = null;
    callExpiryTimerRef.current = null;
    try { peerConnectionRef.current?.close(); } catch { /* The connection may already be closed. */ }
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
    const oldCallId = activeCallRef.current?.id;
    if (oldCallId) pendingSignalsRef.current.delete(oldCallId);
    pendingCandidatesRef.current = [];
    seenSignalIdsRef.current.clear();
    setCall(null);
    setCallState('idle');
    setMuted(false);
    setConnectedAt(null);
    setElapsedSeconds(0);
    setBusy(false);
  }, [setCall]);

  const finishCall = useCallback(async (status: 'ended' | 'rejected' = 'ended', message?: string) => {
    const current = activeCallRef.current;
    if (client && current) {
      try {
        await client.from('aeroshell_calls').update({ status }).eq('id', current.id);
      } catch { /* Clear local microphone and audio even if the network is gone. */ }
    }
    cleanupLocal();
    if (message) setNotice(message);
  }, [client, cleanupLocal]);

  const turnServersForCall = useCallback(async (callId: string): Promise<RTCIceServer[]> => {
    if (!client) throw new Error('The voice calling backend is unavailable.');
    const { data, error } = await client.functions.invoke('master-chat-turn-credentials', { body: { callId } });
    if (error) {
      let serviceCode = '';
      let httpStatus = 0;
      let platformCode = '';
      const context = (error as { context?: unknown }).context;
      if (context instanceof Response) {
        httpStatus = context.status;
        platformCode = context.headers.get('sb-error-code') ?? '';
        try {
          const body = await context.clone().json() as { error?: unknown };
          if (typeof body.error === 'string') serviceCode = body.error;
        } catch { /* Some gateway errors do not return JSON. */ }
      }
      if (serviceCode === 'private_relay_not_configured') {
        throw new Error('Secure voice calling is not configured on the server. The relay administrator must configure METERED_TURN_DOMAIN and METERED_TURN_API_KEY in Supabase Edge Function secrets.');
      }
      if (serviceCode === 'invalid_session' || serviceCode === 'authentication_required' || platformCode === 'UNAUTHORIZED_ASYMMETRIC_JWT' || httpStatus === 401) {
        throw new Error('The secure call server rejected this sign-in session. Sign out of Master Chat, sign back in, and retry. No call was connected.');
      }
      if (serviceCode === 'rate_limited' || httpStatus === 429) {
        throw new Error('Too many secure relay requests were made recently. Wait a minute, then try calling again. No call was connected.');
      }
      if (serviceCode === 'private_relay_unavailable' || serviceCode === 'backend_configuration_unavailable' || httpStatus === 503 || httpStatus === 502) {
        throw new Error('The secure voice relay service is unavailable (server HTTP ' + (httpStatus || 'error') + '). No voice connection was made. Please retry after the relay service recovers.');
      }
      if (serviceCode === 'call_not_active' || serviceCode === 'call_expired' || serviceCode === 'call_not_found_or_forbidden') {
        throw new Error('This call expired or is no longer active. Start a new call and have the other person accept promptly.');
      }
      throw new Error('The secure voice relay could not be prepared (server HTTP ' + (httpStatus || 'unknown') + (platformCode ? ', ' + platformCode : '') + '). No call was connected. Try again, and contact the app owner if it continues.');
    }
    const returnedServers = Array.isArray(data?.iceServers) ? data.iceServers as RTCIceServer[] : [];
    const turnServers: RTCIceServer[] = returnedServers.flatMap(server => {
      const allUrls = Array.isArray(server.urls) ? server.urls : [server.urls];
      const urls = allUrls.filter((url): url is string =>
        typeof url === 'string'
        && /^turns?:[a-z0-9.-]+\.relay\.metered\.ca:\d+(?:\?transport=(?:tcp|udp))?$/i.test(url.trim()),
      );
      if (!urls.length || typeof server.username !== 'string' || !server.username.trim()
        || typeof server.credential !== 'string' || !server.credential.trim()) return [];
      return [{ urls: urls.length === 1 ? urls[0] : urls, username: server.username, credential: server.credential }];
    });
    if (!turnServers.length) {
      throw new Error('The free relay did not return valid TURN credentials. Direct connections remain blocked for privacy. Verify the Metered credential, wait up to two minutes after creating it, then retry.');
    }
    return turnServers;
  }, [client]);

  const sendSignal = useCallback(async (call: CallView, kind: CallSignal['kind'], payload: Record<string, unknown>) => {
    if (!client) throw new Error('The call signaling service is unavailable.');
    const { error } = await client.from('aeroshell_call_signals').insert({
      call_id: call.id,
      from_user_id: profile.id,
      to_user_id: call.peer.id,
      kind,
      payload,
    });
    if (error) throw new Error('The private call signal could not be delivered.');
  }, [client, profile.id]);

  const flushCandidates = useCallback(async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription) return;
    const queued = pendingCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Ignore malformed/stale candidates. */ }
    }
  }, []);

  const applySignal = useCallback(async (signal: CallSignal) => {
    const current = activeCallRef.current;
    const pc = peerConnectionRef.current;
    if (!current || !pc || signal.call_id !== current.id || signal.to_user_id !== profile.id) return;
    try {
      if (signal.kind === 'ice') {
        const candidate = signal.payload.candidate as RTCIceCandidateInit | undefined;
        if (!candidate || typeof candidate.candidate !== 'string') return;
        if (pc.remoteDescription) {
          try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* Stale candidates are harmless. */ }
        } else {
          pendingCandidatesRef.current.push(candidate);
        }
        return;
      }

      if (signal.kind === 'offer') {
        const sdp = signal.payload.sdp;
        if (typeof sdp !== 'string' || pc.remoteDescription) return;
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await flushCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const local = pc.localDescription;
        if (!local?.sdp || !activeCallRef.current) throw new Error('Could not create an audio answer.');
        await sendSignal(current, 'answer', { type: 'answer', sdp: local.sdp });
        setCallState('connecting');
      } else if (signal.kind === 'answer') {
        const sdp = signal.payload.sdp;
        if (typeof sdp !== 'string' || pc.remoteDescription || pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp });
        await flushCandidates(pc);
        setCallState('connecting');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice signaling failed.';
      setNotice(message);
      await finishCall('ended', message);
    }
  }, [finishCall, flushCandidates, profile.id, sendSignal]);

  const buildPeerConnection = useCallback((call: CallView, servers: RTCIceServer[]) => {
    const pc = new RTCPeerConnection({
      iceServers: servers,
      iceTransportPolicy: 'relay',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0,
    });
    peerConnectionRef.current = pc;
    pc.onicecandidate = event => {
      if (!event.candidate || !client || !activeCallRef.current || activeCallRef.current.id !== call.id) return;
      void client.from('aeroshell_call_signals').insert({
        call_id: call.id,
        from_user_id: profile.id,
        to_user_id: call.peer.id,
        kind: 'ice',
        payload: { candidate: event.candidate.toJSON() },
      }).then(({ error }) => {
        if (error && mountedRef.current) setNotice('A network candidate could not be delivered. Check the connection or end the call.');
      });
    };
    pc.ontrack = event => {
      const audio = remoteAudioRef.current;
      if (!audio) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      // Keep incoming audio at a conservative level on mobile speakers and other high-gain devices.
      setSafeRemoteAudioVolume(audio);
      void audio.play().catch(() => setNotice('Tap the audio control to allow call playback.'));
    };
    pc.onconnectionstatechange = () => {
      if (!mountedRef.current) return;
      if (pc.connectionState === 'connected') {
        setCallState('connected');
        setConnectedAt(Date.now());
        setNotice('Voice connected using a relay-only route.');
        if (callExpiryTimerRef.current !== null) window.clearTimeout(callExpiryTimerRef.current);
        callExpiryTimerRef.current = window.setTimeout(() => {
          void finishCall('ended', 'The private relay session reached its time limit. Start a new call if needed.');
        }, MAX_CALL_MS);
      } else if (pc.connectionState === 'failed') {
        void finishCall('ended', 'The private relay connection failed. The call has ended; no direct connection fallback was attempted.');
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && mountedRef.current) {
        setNotice('The relay network could not establish a connection. Direct peer networking remains disabled.');
      }
    };
    return pc;
  }, [client, finishCall, profile.id]);

  const queueOrApplySignal = useCallback((signal: CallSignal) => {
    if (seenSignalIdsRef.current.has(signal.id)) return;
    seenSignalIdsRef.current.add(signal.id);
    const current = activeCallRef.current;
    if (!current || current.id !== signal.call_id || !peerConnectionRef.current) {
      const list = pendingSignalsRef.current.get(signal.call_id) ?? [];
      if (!list.some(item => item.id === signal.id)) list.push(signal);
      pendingSignalsRef.current.set(signal.call_id, list);
      return;
    }
    void applySignal(signal);
  }, [applySignal]);

  const replaySignals = useCallback(async (callId: string) => {
    if (!client || !profile) return;
    const queued = pendingSignalsRef.current.get(callId) ?? [];
    pendingSignalsRef.current.delete(callId);
    const { data, error } = await client.from('aeroshell_call_signals')
      .select('id, call_id, from_user_id, to_user_id, kind, payload, created_at')
      .eq('call_id', callId).eq('to_user_id', profile.id).order('created_at', { ascending: true }).limit(200);
    if (error) {
      setNotice('Could not load private call signaling. End the call and try again.');
      return;
    }
    const all = [...queued, ...((data ?? []) as CallSignal[])];
    const byId = new Map(all.map(signal => [signal.id, signal]));
    const signals = [...byId.values()].sort((a, b) => {
      const weight = (item: CallSignal) => item.kind === 'offer' ? 0 : item.kind === 'answer' ? 1 : 2;
      return weight(a) - weight(b) || (a.created_at ?? '').localeCompare(b.created_at ?? '');
    });
    for (const signal of signals) {
      if (!seenSignalIdsRef.current.has(signal.id)) {
        seenSignalIdsRef.current.add(signal.id);
        await applySignal(signal);
      } else {
        // Signals queued before a peer connection exists are marked seen. Replay them once it is ready.
        await applySignal(signal);
      }
    }
  }, [applySignal, client, profile]);

  const startCall = useCallback(async (recipient: ChatProfile) => {
    if (!enabled || !client || !recipient || recipient.id === profile.id || !profile || activeCallRef.current || busy) return;
    setRecipientPickerOpen(false);
    setNotice('');
    setBusy(true);
    setCallState('preparing');
    let createdCallId: string | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new Error('This browser does not support secure audio calling. Use an up-to-date browser over HTTPS.');
      }
      const local = await navigator.mediaDevices.getUserMedia({
        audio: VOICE_MICROPHONE_CONSTRAINTS,
        video: false,
      });
      localStreamRef.current = local;
      const { data, error } = await client.from('aeroshell_calls')
        .insert({ caller_id: profile.id, callee_id: recipient.id })
        .select('id, caller_id, callee_id, status, created_at, updated_at').single();
      if (error || !data) throw new Error(error?.message ?? 'Could not start the call.');
      createdCallId = data.id;
      const call: CallView = { ...data as CallRow, direction: 'outgoing', peer: recipient };
      setCall(call);
      if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current);
      ringTimerRef.current = window.setTimeout(() => {
        if (activeCallRef.current?.id === call.id && activeCallRef.current.status === 'ringing') {
          void finishCall('ended', 'No answer. The call was closed after 45 seconds.');
        }
      }, 45_000);
      const servers = await turnServersForCall(call.id);
      const pc = buildPeerConnection(call, servers);
      local.getTracks().forEach(track => pc.addTrack(track, local));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!pc.localDescription?.sdp) throw new Error('Could not create the audio offer.');
      await sendSignal(call, 'offer', { type: 'offer', sdp: pc.localDescription.sdp });
      setCallState('outgoing');
      setNotice('Calling ' + recipient.username + ' through the private relay. Camera access is never requested.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice call could not start.';
      if (createdCallId) {
        try { await client.from('aeroshell_calls').update({ status: 'ended' }).eq('id', createdCallId); } catch { /* Clean up locally below. */ }
      }
      cleanupLocal();
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }, [buildPeerConnection, busy, cleanupLocal, client, enabled, profile, sendSignal, setCall, turnServersForCall]);

  const acceptCall = useCallback(async () => {
    const current = activeCallRef.current;
    if (!enabled || !client || !profile || !current || current.direction !== 'incoming' || busy) return;
    setBusy(true);
    // Keep the incoming-call controls in place while permissions and relay setup run.
    // Swapping the Accept button for Cancel during a touch can cause the same tap
    // to activate Cancel on mobile browsers.
    setNotice('');
    if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new Error('This browser does not support secure audio calling. Use an up-to-date browser over HTTPS.');
      }
      const local = await navigator.mediaDevices.getUserMedia({
        audio: VOICE_MICROPHONE_CONSTRAINTS,
        video: false,
      });
      localStreamRef.current = local;
      const servers = await turnServersForCall(current.id);
      const pc = buildPeerConnection(current, servers);
      local.getTracks().forEach(track => pc.addTrack(track, local));
      const { data, error } = await client.from('aeroshell_calls')
        .update({ status: 'accepted' }).eq('id', current.id).eq('status', 'ringing')
        .select('id, caller_id, callee_id, status, created_at, updated_at').maybeSingle();
      if (error || !data) throw new Error('This call is no longer available or could not be accepted.');
      setCall({ ...current, ...data as CallRow, direction: 'incoming', peer: current.peer });
      // Only transition to the in-call controls after the server confirms acceptance.
      setCallState('connecting');
      await replaySignals(current.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not accept the voice call.';
      const terminalStatus = activeCallRef.current?.status === 'accepted' ? 'ended' : 'rejected';
      try {
        await client.from('aeroshell_calls').update({ status: terminalStatus }).eq('id', current.id).in('status', ['ringing', 'accepted']);
      } catch { /* Local cleanup must still run. */ }
      cleanupLocal();
      setNotice(message);
    } finally {
      setBusy(false);
    }
  }, [buildPeerConnection, busy, cleanupLocal, client, enabled, profile, replaySignals, setCall, turnServersForCall]);

  const rejectCall = useCallback(async () => {
    const current = activeCallRef.current;
    if (!current) return;
    try {
      if (client) await client.from('aeroshell_calls').update({ status: 'rejected' }).eq('id', current.id).eq('status', 'ringing');
    } finally {
      cleanupLocal();
      setNotice('Incoming call declined.');
    }
  }, [client, cleanupLocal]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    localStreamRef.current?.getAudioTracks().forEach(track => { track.enabled = !next; });
    setMuted(next);
  }, [muted]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled || !client || !profile) return;
    let active = true;
    const endIfStillHere = async (callId: string, status: 'ended' | 'rejected') => {
      if (activeCallRef.current?.id === callId) {
        cleanupLocal();
        setNotice(status === 'rejected' ? 'The call was declined.' : 'The other participant ended the call.');
      }
    };
    const receiveCall = async (row: CallRow) => {
      if (!active || row.callee_id !== profile.id || row.status !== 'ringing') return;
      const ageMs = Date.now() - new Date(row.created_at).getTime();
      if (!Number.isFinite(ageMs) || ageMs > 45000) {
        await client.from('aeroshell_calls').update({ status: 'rejected' }).eq('id', row.id).eq('status', 'ringing');
        return;
      }
      if (activeCallRef.current) return;
      const peer = peopleRef.current.find(person => person.id === row.caller_id)
        ?? (await client.from('aeroshell_profiles').select('id, username').eq('id', row.caller_id).maybeSingle()).data as ChatProfile | null;
      if (!active || !peer) return;
      const view: CallView = { ...row, direction: 'incoming', peer };
      setCall(view);
      setCallState('incoming');
      setQuietIncoming(false);
      setNotice(peer.username + ' is calling you. Accept only if you recognize this person.');
      if (ringTimerRef.current !== null) window.clearTimeout(ringTimerRef.current);
      ringTimerRef.current = window.setTimeout(() => {
        if (activeCallRef.current?.id === row.id && activeCallRef.current.direction === 'incoming') {
          void client.from('aeroshell_calls').update({ status: 'rejected' }).eq('id', row.id).eq('status', 'ringing');
          cleanupLocal();
          setNotice('The incoming call timed out.');
        }
      }, 45000);
    };
    const channel = client.channel('aeroshell-master-chat-calls', { config: { private: true } })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'aeroshell_calls' }, payload => {
        const row = payload.new as CallRow;
        const current = activeCallRef.current;
        if (!current || current.id !== row.id) return;
        if (row.status === 'rejected' || row.status === 'ended') {
          void endIfStillHere(row.id, row.status);
        } else {
          setCall({ ...current, ...row });
          if (row.status === 'accepted' && current.direction === 'outgoing') setCallState('connecting');
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_call_signals', filter: 'to_user_id=eq.' + profile.id }, payload => {
        const signal = payload.new as CallSignal;
        queueOrApplySignal(signal);
        if (signal.kind === 'offer') {
          void (async () => {
            const { data, error } = await client.from('aeroshell_calls')
              .select('id, caller_id, callee_id, status, created_at, updated_at')
              .eq('id', signal.call_id).eq('callee_id', profile.id).eq('status', 'ringing').maybeSingle();
            if (!active || error || !data) return;
            await receiveCall(data as CallRow);
          })();
        }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          void (async () => {
            const { data } = await client.from('aeroshell_calls')
              .select('id, caller_id, callee_id, status, created_at, updated_at')
              .eq('callee_id', profile.id).eq('status', 'ringing')
              .order('created_at', { ascending: false }).limit(5);
            if (!active || !data?.length) return;
            // A ringing DB row is not enough: wait until a real offer exists so relay failures never flash a fake incoming call.
            for (const row of data as CallRow[]) {
              if (!active) return;
              const { data: offers } = await client.from('aeroshell_call_signals')
                .select('id').eq('call_id', row.id).eq('to_user_id', profile.id).eq('kind', 'offer').limit(1);
              if (active && offers?.length) await receiveCall(row);
            }
          })();
        }
      });
    return () => {
      active = false;
      void client.removeChannel(channel);
      // Do not hang up active calls merely because a Realtime dependency refreshes.
    };
  }, [enabled, client, profile, cleanupLocal, queueOrApplySignal, setCall]);

  useEffect(() => {
    if (enabled) return;
    const current = activeCallRef.current;
    if (current) void finishCall('ended', 'The call ended because Master Chat was locked.');
  }, [enabled, finishCall]);

  useEffect(() => {
    if (!showCallLauncher) setRecipientPickerOpen(false);
  }, [showCallLauncher]);

  useEffect(() => {
    if (callState !== 'connected' || connectedAt === null) {
      setElapsedSeconds(0);
      return;
    }
    const update = () => setElapsedSeconds(Math.floor((Date.now() - connectedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [callState, connectedAt]);

  return <>
    <audio ref={remoteAudioRef} autoPlay playsInline aria-label="Remote voice call audio" className="master-chat-remote-audio"/>
    {showCallLauncher && callState === 'idle' && (portalRoot
      ? createPortal(<button type="button" className="master-chat-voice-call-button"
          onClick={() => setRecipientPickerOpen(true)} disabled={!enabled || busy || !client || !!activeCall}
          title="Choose whom to call" aria-label="Choose whom to call">
          <PhoneCall size={17}/> <span>Call someone</span>
        </button>, portalRoot)
      : <button type="button" className="master-chat-voice-call-button"
          onClick={() => setRecipientPickerOpen(true)} disabled={!enabled || busy || !client || !!activeCall}
          title="Choose whom to call" aria-label="Choose whom to call">
          <PhoneCall size={17}/> <span>Call someone</span>
        </button>)}
    {recipientPickerOpen && showCallLauncher && createPortal(
      <div className="master-chat-recipient-picker-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setRecipientPickerOpen(false); }}>
        <section className="master-chat-recipient-picker" role="dialog" aria-modal="true" aria-label="Choose a person to call">
          <header><span><PhoneCall size={19}/><b>Who would you like to call?</b></span><button type="button" aria-label="Close call picker" onClick={() => setRecipientPickerOpen(false)}><X size={18}/></button></header>
          <p>Select a Master Chat member. The other person must accept before audio can connect.</p>
          <div className="master-chat-recipient-picker-list">
            {people.filter(person => person.id !== profile.id).map(person => <button type="button" key={person.id} disabled={busy || !!activeCall} onClick={() => void startCall(person)}>
              <span className="master-chat-recipient-avatar">{person.avatar_data ? <img src={person.avatar_data} alt=""/> : person.username.slice(0,1).toUpperCase()}</span>
              <span className="master-chat-recipient-label"><b>{person.username}</b><small>Start an audio call</small></span>
              <PhoneCall size={17}/>
            </button>)}
            {!people.some(person => person.id !== profile.id) && <div className="master-chat-recipient-empty"><b>No one to call yet</b><span>Other Master Chat accounts will appear here.</span></div>}
          </div>
          <small className="master-chat-recipient-security"><ShieldCheck size={14}/> Calls require the private TURN relay; there is no direct-IP fallback.</small>
        </section>
      </div>, portalRoot ?? document.body
    )}
    {notice && createPortal(
      <div className="master-chat-voice-notice" role="status"><ShieldCheck size={14}/><span>{notice}</span><button aria-label="Dismiss call notice" title="Dismiss" onClick={() => setNotice('')}>×</button></div>, portalRoot ?? document.body
    )}
    {activeCall && createPortal(<div className="master-chat-call-overlay" role="dialog" aria-modal="true" aria-label="Voice call controls">
      <section className="master-chat-call-card">
        <button type="button" className="master-chat-call-close" title="Close call window" aria-label="Close call window"
          onClick={() => { if (activeCall.direction === 'incoming' && callState === 'incoming') void rejectCall(); else void finishCall('ended', 'Call ended.'); }}><X size={17}/></button>
        <div className={'master-chat-call-avatar '+(callState === 'connected' ? 'speaking' : '')}>{activeCall.peer.username.slice(0,1).toUpperCase()}</div>
        <p className="eyebrow">AEROSHELL · VOICE ONLY</p>
        <h3>{activeCall.peer.username}</h3>
        <p className="master-chat-call-state">{callState === 'incoming' ? 'Incoming audio call' : callState === 'preparing' ? 'Preparing secure audio…' : callState === 'outgoing' ? 'Calling…' : callState === 'connected' ? durationLabel(elapsedSeconds) : callState === 'connecting' ? 'Connecting through the relay…' : 'Starting call…'}</p>
        <div className="master-chat-call-privacy"><ShieldCheck size={15}/><span>Relay-only mode: direct connections are disabled to avoid exposing your IP address to the other caller. WebRTC encrypts the audio stream, but this beta does not independently verify caller identity end-to-end. Supabase retains call metadata; Cloudflare may observe relay IP/session metadata, not the audio content.</span></div>
        {callState === 'incoming' ? <div className="master-chat-call-actions"><button type="button" className="accept" disabled={busy} onClick={() => void acceptCall()}><PhoneIncoming size={17}/> {busy ? 'Connecting…' : 'Accept'}</button><button type="button" className="decline" disabled={busy} onClick={() => void rejectCall()}><PhoneOff size={17}/> Decline</button></div>
          : callState === 'connected' ? <div className="master-chat-call-actions">
            <button type="button" className={muted ? 'muted' : 'neutral'} onClick={toggleMute}>{muted ? <MicOff size={17}/> : <Mic size={17}/>} {muted ? 'Unmute' : 'Mute'}</button>
            <button type="button" className="decline" onClick={() => void finishCall('ended', 'Call ended.')}><PhoneOff size={17}/> End call</button>
          </div> : <div className="master-chat-call-actions">
            <button type="button" className="decline" onClick={() => void finishCall('ended', 'Call cancelled.')}><PhoneOff size={17}/> Cancel call</button>
          </div>}
        <small className="master-chat-call-footer"><AlertTriangle size={13}/> Use calls only with people you trust. Incoming voice is never auto-answered.</small>
      </section>
    </div>, portalRoot ?? document.body)}
    {quietIncoming && <span className="master-chat-visually-hidden">Incoming call is muted.</span>}
  </>;
}
