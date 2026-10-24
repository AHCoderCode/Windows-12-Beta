import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { createClient, type RealtimeChannel, type Session } from '@supabase/supabase-js';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, CircleHelp, Clock3, Copy, Download, EyeOff, FileText, Fingerprint, ImagePlus, LockKeyhole, LogIn, LogOut, Maximize2, MessageCircle, Mic, Minimize2, MoreHorizontal, Paperclip, Pause, Play, Search, Send, Settings2, ShieldCheck, Trash2, UserPlus, Users, Wifi, WifiOff, X } from 'lucide-react';
import { isValidAvatarData, MAX_PROFILE_AVATAR_DATA_LENGTH } from './profile-avatar-utils';
import { MasterChatVoiceCalls } from './MasterChatVoiceCalls';
import { getConversationMessages, getGroupMessages } from './master-chat-utils';

type ChatProfile = { id: string; username: string; avatar_data?: string | null };
type MessageType = 'text' | 'file' | 'voice';
type ScheduledChatMessage = { id: string; user_id: string; recipient_id: string | null; group_id: string | null; body: string; send_at: string };
const SCHEDULED_CHAT_MESSAGES_KEY = 'aeroshell.master-chat.scheduled-messages.v1';
const scheduledWorkerInFlight = new Set<string>();
const scheduledWorkerDelivered = new Set<string>();
const scheduledWorkerRetryAt = new Map<string, number>();

function readScheduledChatMessages(): ScheduledChatMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SCHEDULED_CHAT_MESSAGES_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ScheduledChatMessage => !!item && typeof item === 'object' &&
      typeof item.id === 'string' && typeof item.user_id === 'string' &&
      (item.recipient_id === null || typeof item.recipient_id === 'string') &&
      (item.group_id === null || typeof item.group_id === 'string') &&
      typeof item.body === 'string' && item.body.trim().length > 0 &&
      typeof item.send_at === 'string' && Number.isFinite(Date.parse(item.send_at)));
  } catch { return []; }
}

function writeScheduledChatMessages(items: ScheduledChatMessage[]): boolean {
  try { localStorage.setItem(SCHEDULED_CHAT_MESSAGES_KEY, JSON.stringify(items)); return true; } catch { return false; }
}

function asLocalDateTimeInput(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

type ChatMessage = {
  id: string;
  sender_id: string;
  recipient_id: string | null;
  group_id?: string | null;
  body: string;
  message_type?: MessageType;
  attachment_path?: string | null;
  attachment_name?: string | null;
  attachment_mime?: string | null;
  attachment_size?: number | null;
  voice_duration_ms?: number | null;
  attachment_url?: string | null;
  created_at: string;
};
type ChatGroup = {
  id: string;
  name: string;
  avatar_data: string | null;
  created_by: string;
  updated_at: string;
  my_role: 'admin' | 'member';
  member_count: number;
};
type ChatGroupMember = {
  group_id: string;
  user_id: string;
  role: 'admin' | 'member';
  added_by: string;
  joined_at: string;
  username: string;
  avatar_data: string | null;
};
const ATTACHMENT_BUCKET = 'master-chat-attachments';
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MESSAGE_FIELDS = 'id, sender_id, recipient_id, group_id, body, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, voice_duration_ms, created_at';
function isVideoFile(file: File, messageType: 'file' | 'voice' = 'file') {
  return file.type.toLowerCase().startsWith('video/')
    || (messageType === 'file' && /\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$/i.test(file.name));
}
function safeAttachmentName(name: string) {
  return name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'attachment.txt';
}
function mergeScopedMessages(current: ChatMessage[], incoming: ChatMessage[], userId: string, peerId: string | null, groupId: string | null) {
  const inScope = (message: ChatMessage) => groupId
    ? message.group_id === groupId
    : !message.group_id && !!peerId && (
      (message.sender_id === userId && message.recipient_id === peerId)
      || (message.sender_id === peerId && message.recipient_id === userId)
    );
  const byId = new Map<string, ChatMessage>();
  for (const message of current) if (inScope(message)) byId.set(message.id, message);
  for (const message of incoming) if (inScope(message)) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
async function compressImageForGroup(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file for the group picture.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose an image smaller than 8 MB.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('This image could not be opened.'));
      candidate.src = objectUrl;
    });
    for (const maxSide of [192, 144, 96]) {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Your browser could not prepare this image.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.68, 0.54, 0.42]) {
        const value = canvas.toDataURL('image/jpeg', quality);
        if (value.length <= 60000) return value;
      }
    }
    throw new Error('That group image is too large even after compression. Try a smaller picture.');
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
type AuthMode = 'signin' | 'signup';
type PinRecord = { version: 1; salt: string; verifier: string };
type LocalPasskeyRecord = { version: 1; credentialId: string; publicKey: string; rpId: string; userId: string; method?: 'face' | 'fingerprint'; algorithm: -7; signCount: number; createdAt: string };
const PIN_STORAGE_KEY = 'aeroshell.master-chat.local-pin.v1';
const PIN_THROTTLE_KEY = 'aeroshell.master-chat.pin-throttle.v1';
const LOCAL_PASSKEY_STORAGE_KEY = 'aeroshell.master-chat.passkey.v1';

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value: string) {
  const result = new Uint8Array(value.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return result;
}

async function derivePinVerifier(pin: string, saltHex: string) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure browser cryptography is unavailable. Open the site over HTTPS and try again.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: 310000, hash: 'SHA-256' },
    key,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}

function sameHex(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function passkeyToBase64Url(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function passkeyFromBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(base64);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function passkeyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function passkeyConcat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function passkeyBytesEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left[i] ^ right[i];
  return mismatch === 0;
}

function readLocalPasskey(): LocalPasskeyRecord | null {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_PASSKEY_STORAGE_KEY) ?? 'null') as Partial<LocalPasskeyRecord> | null;
    if (!value || value.version !== 1 || typeof value.credentialId !== 'string' || typeof value.publicKey !== 'string' ||
        typeof value.rpId !== 'string' || typeof value.userId !== 'string' || value.algorithm !== -7 ||
        typeof value.signCount !== 'number' || !Number.isFinite(value.signCount) || typeof value.createdAt !== 'string') return null;
    return value as LocalPasskeyRecord;
  } catch { return null; }
}

function passkeyDerSignatureToRaw(signature: Uint8Array): Uint8Array | null {
  if (signature.length === 64) return signature;
  let offset = 0;
  if (signature[offset++] !== 0x30 || offset >= signature.length) return null;
  let sequenceLength = signature[offset++];
  if (sequenceLength & 0x80) {
    const count = sequenceLength & 0x7f;
    if (count < 1 || count > 2 || offset + count > signature.length) return null;
    sequenceLength = 0;
    for (let i = 0; i < count; i += 1) sequenceLength = (sequenceLength << 8) | signature[offset++];
  }
  if (sequenceLength > signature.length - offset || signature[offset++] !== 0x02 || offset >= signature.length) return null;
  const rLength = signature[offset++];
  if (offset + rLength > signature.length) return null;
  const r = signature.slice(offset, offset + rLength); offset += rLength;
  if (signature[offset++] !== 0x02 || offset >= signature.length) return null;
  const sLength = signature[offset++];
  if (offset + sLength > signature.length) return null;
  const s = signature.slice(offset, offset + sLength);
  const normalize = (value: Uint8Array) => {
    while (value.length > 32 && value[0] === 0) value = value.slice(1);
    if (!value.length || value.length > 32) return null;
    const output = new Uint8Array(32);
    output.set(value, 32 - value.length);
    return output;
  };
  const rr = normalize(r);
  const ss = normalize(s);
  if (!rr || !ss) return null;
  return passkeyConcat(rr, ss);
}

function readPinThrottle() {
  try {
    const raw = localStorage.getItem(PIN_THROTTLE_KEY);
    if (!raw) return { failures: 0, lockedUntil: 0 };
    const value = JSON.parse(raw) as { failures?: unknown; lockedUntil?: unknown };
    return {
      failures: typeof value.failures === 'number' && Number.isFinite(value.failures) ? Math.max(0, Math.floor(value.failures)) : 0,
      lockedUntil: typeof value.lockedUntil === 'number' && Number.isFinite(value.lockedUntil) ? Math.max(0, value.lockedUntil) : 0,
    };
  } catch {
    return { failures: 0, lockedUntil: 0 };
  }
}

function recordPinFailure() {
  const previous = readPinThrottle();
  const failures = previous.failures + 1;
  const delayMs = failures < 5 ? 0 : Math.min(5 * 60 * 1000, 30 * 1000 * (2 ** Math.floor((failures - 5) / 5)));
  const next = { failures, lockedUntil: delayMs ? Date.now() + delayMs : 0 };
  try { localStorage.setItem(PIN_THROTTLE_KEY, JSON.stringify(next)); } catch { /* A device lock still works when storage writes are available. */ }
  return next;
}

function clearPinFailures() {
  try { localStorage.removeItem(PIN_THROTTLE_KEY); } catch { /* The PIN itself remains unchanged. */ }
}

const supabaseClient = (() => {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return null;
  try {
    const parsedUrl = new URL(url);
    const localHost = parsedUrl.hostname === 'localhost' || parsedUrl.hostname === '127.0.0.1';
    const acceptedHost = parsedUrl.hostname.endsWith('.supabase.co') || localHost;
    const acceptedProtocol = parsedUrl.protocol === 'https:' || (localHost && parsedUrl.protocol === 'http:');
    if (!acceptedHost || !acceptedProtocol) return null;
    return createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  } catch {
    return null;
  }
})();

export async function processMasterChatScheduledMessages() {
  if (!supabaseClient || typeof window === 'undefined') return;
  let userId = '';
  try {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session?.user.id) return;
    userId = data.session.user.id;
  } catch { return; }
  if (!userId) return;
  const due = readScheduledChatMessages().filter(item => item.user_id === userId && Date.parse(item.send_at) <= Date.now());
  for (const item of due) {
    if (scheduledWorkerInFlight.has(item.id) || scheduledWorkerDelivered.has(item.id) || (scheduledWorkerRetryAt.get(item.id) ?? 0) > Date.now()) continue;
    scheduledWorkerInFlight.add(item.id);
    try {
      const { data, error } = await supabaseClient.from('aeroshell_messages').insert({
        sender_id: item.user_id,
        recipient_id: item.recipient_id,
        group_id: item.group_id,
        body: item.body,
        message_type: 'text',
      }).select('id').single();
      if (error || !data) throw error ?? new Error('The message was not saved by the server.');
      scheduledWorkerRetryAt.delete(item.id);
      scheduledWorkerDelivered.add(item.id);
      const remaining = readScheduledChatMessages().filter(queued => queued.id !== item.id);
      if (!writeScheduledChatMessages(remaining)) scheduledWorkerRetryAt.set(item.id, Number.MAX_SAFE_INTEGER);
      window.dispatchEvent(new CustomEvent('aeroshell-master-chat-scheduled-sent', { detail: { id: item.id, user_id: item.user_id } }));
    } catch {
      scheduledWorkerRetryAt.set(item.id, Date.now() + 60000);
      window.dispatchEvent(new CustomEvent('aeroshell-master-chat-scheduled-failed', { detail: { id: item.id, user_id: item.user_id, message: 'A scheduled message could not send. It remains queued and will be retried shortly while AeroShell is open and you are signed in.' } }));
    } finally {
      scheduledWorkerInFlight.delete(item.id);
    }
  }
}

const validUsername = (value: string) => /^[a-zA-Z0-9_]{3,20}$/.test(value);
const usernameEmail = (username: string) => username.toLowerCase() + '@aeroshell.invalid';
const shortTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const formatVoiceTime = (seconds: number) => {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
};
const VOICE_WAVEFORM = [8,13,19,11,23,15,9,17,25,12,20,15,8,18,27,12,22,16,10,24,14,19,9,26,15,21,11,17,24,13,8,20,15,26,12,18];

function MasterChatVoicePlayer({ src, durationMs }: { src: string; durationMs?: number | null }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Math.max(0, (durationMs ?? 0) / 1000));
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setPlaying(false);
    setCurrentTime(0);
    setDuration(Math.max(0, (durationMs ?? 0) / 1000));
    setLoadError(false);
    const onTimeUpdate = () => setCurrentTime(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
      setLoadError(false);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => { setPlaying(false); setCurrentTime(Number.isFinite(audio.duration) ? audio.duration : 0); };
    const onError = () => { setPlaying(false); setLoadError(true); };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [src, durationMs]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio || loadError) return;
    if (audio.paused) {
      setLoadError(false);
      void audio.play().catch(() => { setPlaying(false); setLoadError(true); });
    } else audio.pause();
  };
  const seek = (value: string) => {
    const audio = audioRef.current;
    const next = Number(value);
    if (!audio || !Number.isFinite(next)) return;
    audio.currentTime = next;
    setCurrentTime(next);
  };
  const seekMax = Math.max(1, duration);
  const progress = Math.min(1, Math.max(0, currentTime / seekMax));

  return <div className="master-chat-voice-player-shell">
    <audio ref={audioRef} className="master-chat-audio-element" preload="metadata" src={src}/>
    <button type="button" className="master-chat-voice-play" onClick={togglePlayback} disabled={loadError}
      title={playing ? 'Pause voice message' : 'Play voice message'} aria-label={playing ? 'Pause voice message' : 'Play voice message'}>
      {playing ? <Pause size={18} fill="currentColor"/> : <Play size={18} fill="currentColor"/>}
    </button>
    <div className="master-chat-voice-timeline">
      <div className="master-chat-voice-wave" aria-hidden="true">
        {VOICE_WAVEFORM.map((height, index) => <span key={index} className={index / VOICE_WAVEFORM.length <= progress ? 'played' : ''}
          style={{height: height + 'px'}}/>)}
      </div>
      <input className="master-chat-voice-seek" aria-label="Seek voice message" type="range" min={0} max={seekMax} step={0.1}
        value={Math.min(currentTime, seekMax)} onChange={event => seek(event.target.value)} disabled={loadError}/>
      <div className="master-chat-voice-time"><span>{formatVoiceTime(currentTime)}</span><span>{formatVoiceTime(duration)}</span></div>
    </div>
    {loadError && <p className="master-chat-voice-error" role="status">Audio could not load. Reopen the conversation to refresh its secure audio link.</p>}
  </div>;
}

function MasterChatExitButton({ onClose, className = 'master-chat-close-app', portalTarget }: { onClose?: () => void; className?: string; portalTarget?: HTMLElement | null }) {
  if (!onClose) return null;
  return createPortal(<button type="button" className={className} title="Close Master Chat" aria-label="Close Master Chat" onClick={onClose}><X size={18}/></button>, portalTarget ?? document.body);
}

export function MasterChat({ iosMode = false, showCallLauncher = true, onClose }: { iosMode?: boolean; showCallLauncher?: boolean; onClose?: () => void } = {}) {
  const chatRootRef = useRef<HTMLElement | null>(null);
  const nativeChatFullscreenRef = useRef(false);
  const [conversationFullscreen, setConversationFullscreen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<ChatProfile | null>(null);
  const [booting, setBooting] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>('signup');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'error' | 'success' | 'info'>('info');
  const [people, setPeople] = useState<ChatProfile[]>([]);
  const [peopleQuery, setPeopleQuery] = useState('');
  const [activePerson, setActivePerson] = useState<ChatProfile | null>(null);
  const [groups, setGroups] = useState<ChatGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<ChatGroup | null>(null);
  const [groupMembers, setGroupMembers] = useState<ChatGroupMember[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupDialogMode, setGroupDialogMode] = useState<'create' | 'manage'>('create');
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [groupAvatarDraft, setGroupAvatarDraft] = useState<string | null>(null);
  const [groupMemberSelection, setGroupMemberSelection] = useState<string[]>([]);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [pendingImage, setPendingImage] = useState<{
    file: File;
    previewUrl: string;
    target: { person: ChatProfile | null; group: ChatGroup | null };
    draftSnapshot: string;
  } | null>(null);
  const [imageCaption, setImageCaption] = useState('');
  const [imageViewer, setImageViewer] = useState<{ url: string; name: string; caption: string; messageId: string } | null>(null);
  const [imageViewerReady, setImageViewerReady] = useState(false);
  const [imageViewerError, setImageViewerError] = useState(false);
  const [imageActionBusy, setImageActionBusy] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [voicePreparing, setVoicePreparing] = useState(false);
  const [pastedFileOpen, setPastedFileOpen] = useState(false);
  const [pastedFileName, setPastedFileName] = useState('notes.txt');
  const [pastedFileContent, setPastedFileContent] = useState('');
  const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);
  const [accountCurrentPassword, setAccountCurrentPassword] = useState('');
  const [accountNewPassword, setAccountNewPassword] = useState('');
  const [accountConfirmPassword, setAccountConfirmPassword] = useState('');
  const [accountPasswordBusy, setAccountPasswordBusy] = useState(false);
  const [accountPasswordError, setAccountPasswordError] = useState('');
  const [draft, setDraft] = useState('');
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => asLocalDateTimeInput(new Date(Date.now() + 5 * 60 * 1000)));
  const [scheduleError, setScheduleError] = useState('');
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledChatMessage[]>(() => readScheduledChatMessages());
  const [sending, setSending] = useState(false);
  const [live, setLive] = useState(false);
  const [onlineIds, setOnlineIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pinMode, setPinMode] = useState<'loading' | 'setup' | 'unlock' | 'repair' | 'off'>('loading');
  const [pinRecord, setPinRecord] = useState<PinRecord | null>(null);
  const [pinUnlocked, setPinUnlocked] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [localPasskey, setLocalPasskey] = useState<LocalPasskeyRecord | null>(() => readLocalPasskey());
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState('');
  const [passkeyPromptIntent, setPasskeyPromptIntent] = useState<{
    method: 'face' | 'fingerprint' | 'device';
    action: 'create' | 'unlock';
  } | null>(null);
  const [pinCooldownUntil, setPinCooldownUntil] = useState(0);
  const [pinNow, setPinNow] = useState(Date.now());
  const [pinChangeOpen, setPinChangeOpen] = useState(false);
  const [pinCurrentValue, setPinCurrentValue] = useState('');
  const [pinNewValue, setPinNewValue] = useState('');
  const [pinNewConfirmValue, setPinNewConfirmValue] = useState('');
  const [pinChangeError, setPinChangeError] = useState('');
  const [pinChangeBusy, setPinChangeBusy] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [deleteAccountStep, setDeleteAccountStep] = useState<0 | 1 | 2>(0);
  const [deleteAccountText, setDeleteAccountText] = useState('');
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState('');
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [messageActionId, setMessageActionId] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const lockAppRef = useRef<() => void>(() => undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voicePreparingRef = useRef(false);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceStartRef = useRef(0);
  const voiceLimitTimerRef = useRef<number | null>(null);

  const tell = (text: string, kind: 'error' | 'success' | 'info' = 'info') => {
    setNotice(text);
    setNoticeKind(kind);
  };

  useEffect(() => {
    writeScheduledChatMessages(scheduledMessages);
  }, [scheduledMessages]);

  useEffect(() => {
    const previewUrl = pendingImage?.previewUrl;
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [pendingImage?.previewUrl]);

  useEffect(() => {
    if (!imageViewer) return;
    let cancelled = false;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setImageViewer(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    const warmImage = new Image();
    warmImage.decoding = 'async';
    warmImage.src = imageViewer.url;
    const markReady = () => {
      if (!cancelled) {
        setImageViewerReady(true);
        setImageViewerError(false);
      }
    };
    if (warmImage.complete && warmImage.naturalWidth > 0) markReady();
    else if (typeof warmImage.decode === 'function') void warmImage.decode().then(markReady).catch(() => undefined);
    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [imageViewer?.url]);

  useEffect(() => {
    const onSent = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; user_id?: string }>).detail;
      if (!detail?.id) return;
      setScheduledMessages(current => current.filter(item => item.id !== detail.id));
      if (detail.user_id === profile?.id) tell('Scheduled message sent.', 'success');
    };
    const onFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ user_id?: string; message?: string }>).detail;
      if (detail?.user_id === profile?.id && detail.message) tell(detail.message, 'error');
    };
    window.addEventListener('aeroshell-master-chat-scheduled-sent', onSent);
    window.addEventListener('aeroshell-master-chat-scheduled-failed', onFailed);
    return () => {
      window.removeEventListener('aeroshell-master-chat-scheduled-sent', onSent);
      window.removeEventListener('aeroshell-master-chat-scheduled-failed', onFailed);
    };
  }, [profile?.id]);

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from('aeroshell_profiles').select('id, username, avatar_data').eq('id', userId).maybeSingle();
    if (error) {
      tell('Could not load your profile. Check that the Master Chat SQL setup was applied.', 'error');
      return;
    }
    setProfile(data as ChatProfile | null);
  }, []);

  const saveProfileAvatar = async (file: File | null) => {
    if (!file || !supabaseClient || !profile || avatarBusy) return;
    if (!file.type.startsWith('image/')) {
      tell('Choose an image file to use as your profile picture.', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      tell('That image is too large. Choose an image under 8 MB.', 'error');
      return;
    }
    setAvatarBusy(true);
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const candidate = new Image();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(new Error('This image could not be opened. Try another file.'));
        candidate.src = objectUrl;
      });
      let avatarData = '';
      for (const maxSide of [192, 144, 96]) {
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Your browser could not prepare this image.');
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of [0.82, 0.68, 0.54, 0.42]) {
          avatarData = canvas.toDataURL('image/jpeg', quality);
          if (avatarData.length <= MAX_PROFILE_AVATAR_DATA_LENGTH) break;
        }
        if (avatarData.length <= MAX_PROFILE_AVATAR_DATA_LENGTH) break;
      }
      if (!isValidAvatarData(avatarData)) {
        throw new Error('That image could not be compressed enough. Try a smaller image.');
      }
      const { data, error } = await supabaseClient.from('aeroshell_profiles')
        .update({ avatar_data: avatarData }).eq('id', profile.id)
        .select('id, username, avatar_data').single();
      if (error || !data) throw new Error('The profile image could not be saved. Please retry after checking your connection.');
      setProfile(data as ChatProfile);
      tell('Profile picture updated. Other signed-in members can see it.', 'success');
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not update the profile picture.', 'error');
    } finally {
      URL.revokeObjectURL(objectUrl);
      setAvatarBusy(false);
    }
  };

  const removeProfileAvatar = async () => {
    if (!supabaseClient || !profile || avatarBusy || !profile.avatar_data) return;
    setAvatarBusy(true);
    try {
      const { data, error } = await supabaseClient.from('aeroshell_profiles')
        .update({ avatar_data: null }).eq('id', profile.id)
        .select('id, username, avatar_data').single();
      if (error || !data) throw new Error('Could not remove the profile picture. Please retry.');
      setProfile(data as ChatProfile);
      tell('Profile picture removed.', 'success');
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not remove the profile picture.', 'error');
    } finally {
      setAvatarBusy(false);
    }
  };

  const loadPeople = useCallback(async (userId: string) => {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from('aeroshell_profiles').select('id, username, avatar_data')
      .neq('id', userId).order('username', { ascending: true }).limit(200);
    if (error) {
      tell('Member directory is unavailable. Check the database policies and setup SQL.', 'error');
      return;
    }
    setPeople((data ?? []) as ChatProfile[]);
  }, []);

  const loadGroups = useCallback(async (userId: string): Promise<ChatGroup[]> => {
    if (!supabaseClient) return [];
    const { data: memberships, error: membershipError } = await supabaseClient
      .from('aeroshell_group_members').select('group_id, role').eq('user_id', userId);
    if (membershipError) {
      tell('Could not load groups. Check that the Master Chat groups migration is installed.', 'error');
      return [];
    }
    const myMemberships = (memberships ?? []) as Array<{ group_id: string; role: 'admin' | 'member' }>;
    if (!myMemberships.length) {
      setGroups([]);
      setActiveGroup(null);
      return [];
    }
    const groupIds = myMemberships.map(item => item.group_id);
    const [{ data: groupRows, error: groupError }, { data: rosterRows }] = await Promise.all([
      supabaseClient.from('aeroshell_groups').select('id, name, avatar_data, created_by, updated_at').in('id', groupIds).order('updated_at', { ascending: false }),
      supabaseClient.from('aeroshell_group_members').select('group_id, user_id, role').in('group_id', groupIds),
    ]);
    if (groupError) {
      tell('Could not load group details. Check group database permissions.', 'error');
      return [];
    }
    const roleById = new Map(myMemberships.map(item => [item.group_id, item.role]));
    const countById = new Map<string, number>();
    for (const item of (rosterRows ?? []) as Array<{ group_id: string }>) {
      countById.set(item.group_id, (countById.get(item.group_id) ?? 0) + 1);
    }
    const loaded = ((groupRows ?? []) as Omit<ChatGroup, 'my_role' | 'member_count'>[]).map(group => ({
      ...group,
      my_role: roleById.get(group.id) ?? 'member',
      member_count: countById.get(group.id) ?? 1,
    }));
    setGroups(loaded);
    setActiveGroup(current => current ? loaded.find(group => group.id === current.id) ?? null : null);
    return loaded;
  }, []);

  const withSignedAttachment = useCallback(async (message: ChatMessage): Promise<ChatMessage> => {
    if (!supabaseClient || !message.attachment_path) return message;
    const { data, error } = await supabaseClient.storage.from(ATTACHMENT_BUCKET).createSignedUrl(message.attachment_path, 60 * 60);
    if (error || !data?.signedUrl) return { ...message, attachment_url: null };
    return { ...message, attachment_url: data.signedUrl };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PIN_STORAGE_KEY);
      if (!raw) {
        // The app PIN is optional; users can configure it later in Privacy & app PIN.
        setPinMode('off');
        setPinUnlocked(true);
      } else {
        const value = JSON.parse(raw) as Partial<PinRecord>;
        if (value.version === 1 && typeof value.salt === 'string' && /^[a-f0-9]{32}$/.test(value.salt) &&
            typeof value.verifier === 'string' && /^[a-f0-9]{64}$/.test(value.verifier)) {
          setPinRecord(value as PinRecord);
          setPinMode('unlock');
          setPinCooldownUntil(readPinThrottle().lockedUntil);
        } else {
          setPinMode('repair');
          setPinError('The local PIN record is invalid. Resetting it only resets this browser lock; it does not recover or delete your account.');
        }
      }
    } catch {
      setPinMode('repair');
      setPinError('Browser storage is unavailable. Master Chat stays locked because it cannot safely remember the local PIN.');
    }
  }, []);

  useEffect(() => {
    if (!pinUnlocked) return;
    if (!supabaseClient) {
      setBooting(false);
      return;
    }
    let active = true;
    void supabaseClient.auth.getSession().then(async ({ data, error }) => {
      if (!active) return;
      if (error) tell('Unable to restore your session. Please sign in again.', 'error');
      const current = data.session;
      setSession(current);
      if (current) {
        await loadProfile(current.user.id);
        await loadPeople(current.user.id);
        await loadGroups(current.user.id);
      }
      if (active) setBooting(false);
    });
    const { data: listener } = supabaseClient.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setPeople([]);
        setGroups([]);
        setActivePerson(null);
        setActiveGroup(null);
        setGroupMembers([]);
        setMessages([]);
        setOnlineIds([]);
        setLive(false);
        setBooting(false);
      } else {
        window.setTimeout(() => {
          void loadProfile(next.user.id);
          void loadPeople(next.user.id);
          void loadGroups(next.user.id);
          setBooting(false);
        }, 0);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadGroups, loadPeople, loadProfile, pinUnlocked]);

  useEffect(() => {
    if (!pinUnlocked || !supabaseClient || !session || !profile) return;
    let channel: RealtimeChannel | null = null;
    channel = supabaseClient.channel('aeroshell-master-chat-presence', { config: { presence: { key: profile.id }, private: true } });
    channel.on('presence', { event: 'sync' }, () => {
      const entries = Object.values(channel?.presenceState<{ user_id: string }>() ?? {}).flat();
      setOnlineIds(Array.from(new Set(entries.map(entry => entry.user_id).filter(Boolean))));
      void loadPeople(profile.id);
    }).on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'aeroshell_profiles' }, payload => {
      const changed = payload.new as ChatProfile;
      if (!changed?.id || typeof changed.username !== 'string') return;
      setPeople(current => current.map(person => person.id === changed.id ? { ...person, ...changed } : person));
      if (changed.id === profile.id) setProfile(current => current ? { ...current, ...changed } : current);
      setActivePerson(current => current?.id === changed.id ? { ...current, ...changed } : current);
    }).on('postgres_changes', { event: '*', schema: 'public', table: 'aeroshell_groups' }, () => {
      void loadGroups(profile.id);
    }).on('postgres_changes', { event: '*', schema: 'public', table: 'aeroshell_group_members' }, () => {
      void loadGroups(profile.id);
    }).subscribe(status => {
      setLive(status === 'SUBSCRIBED');
      if (status === 'SUBSCRIBED') {
        void channel?.track({ user_id: profile.id, username: profile.username, online_at: new Date().toISOString() });
      }
    });
    return () => {
      if (channel) void supabaseClient.removeChannel(channel);
      setOnlineIds([]);
      setLive(false);
    };
  }, [session, profile, pinUnlocked, loadGroups]);

  useEffect(() => {
    if (!pinUnlocked || !supabaseClient || !session || !profile || (!activePerson && !activeGroup)) {
      setMessages([]);
      return;
    }
    let mounted = true;
    const groupId = activeGroup?.id ?? null;
    const peerId = activePerson?.id ?? null;
    setMessages(current => current.filter(message => groupId
      ? message.group_id === groupId
      : !message.group_id && !!peerId && (
        (message.sender_id === profile.id && message.recipient_id === peerId)
        || (message.sender_id === peerId && message.recipient_id === profile.id)
      )));
    const loadConversation = async () => {
      let query = supabaseClient.from('aeroshell_messages').select(MESSAGE_FIELDS).order('created_at', { ascending: true }).limit(500);
      if (groupId) {
        query = query.eq('group_id', groupId);
      } else if (peerId) {
        const filter = 'and(sender_id.eq.' + profile.id + ',recipient_id.eq.' + peerId + '),and(sender_id.eq.' + peerId + ',recipient_id.eq.' + profile.id + ')';
        query = query.or(filter).is('group_id', null);
      }
      const { data, error } = await query;
      if (!mounted) return;
      if (error) {
        tell('Could not load this conversation. Confirm the message-table policies and group migration are installed.', 'error');
        return;
      }
      const enriched = await Promise.all(((data ?? []) as ChatMessage[]).map(withSignedAttachment));
      if (!mounted) return;
      setMessages(current => mergeScopedMessages(current, enriched, profile.id, peerId, groupId));
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 30);
    };
    void loadConversation();
    const topic = groupId
      ? 'aeroshell-conversation-' + profile.id + '-group-' + groupId
      : 'aeroshell-conversation-' + profile.id + '-' + peerId;
    const channel = supabaseClient.channel(topic, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_messages' }, payload => {
        const incoming = payload.new as ChatMessage;
        const inScope = groupId
          ? incoming.group_id === groupId
          : !incoming.group_id && !!peerId && (
            (incoming.sender_id === profile.id && incoming.recipient_id === peerId)
            || (incoming.sender_id === peerId && incoming.recipient_id === profile.id)
          );
        if (!mounted || !inScope) return;
        void withSignedAttachment(incoming).then(enriched => {
          if (!mounted) return;
          setMessages(current => mergeScopedMessages(current, [enriched], profile.id, peerId, groupId));
          window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 25);
        });
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'aeroshell_messages' }, payload => {
        const deleted = payload.old as { id?: string };
        if (mounted && deleted.id) setMessages(current => current.filter(message => message.id !== deleted.id));
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_message_hides', filter: 'user_id=eq.' + profile.id }, payload => {
        const hidden = payload.new as { message_id?: string };
        if (!mounted || !hidden.message_id) return;
        setMessages(current => current.filter(message => message.id !== hidden.message_id));
      }).subscribe();
    return () => {
      mounted = false;
      void supabaseClient.removeChannel(channel);
    };
  }, [session, profile, activePerson, activeGroup, pinUnlocked, withSignedAttachment]);

  useEffect(() => {
    if (!pinUnlocked || !supabaseClient || !session || !profile || !activeGroup) {
      setGroupMembers([]);
      return;
    }
    let active = true;
    const loadRoster = async () => {
      const { data, error } = await supabaseClient.from('aeroshell_group_members')
        .select('group_id, user_id, role, added_by, joined_at')
        .eq('group_id', activeGroup.id).order('joined_at', { ascending: true });
      if (!active) return;
      if (error) {
        tell('Could not load this group’s member list.', 'error');
        return;
      }
      const roster = (data ?? []) as Array<Omit<ChatGroupMember, 'username' | 'avatar_data'>>;
      const ids = roster.map(item => item.user_id);
      const { data: profiles, error: profileError } = ids.length
        ? await supabaseClient.from('aeroshell_profiles').select('id, username, avatar_data').in('id', ids)
        : { data: [], error: null };
      if (!active) return;
      if (profileError) {
        tell('Could not load group member profiles.', 'error');
        return;
      }
      const profilesById = new Map(((profiles ?? []) as ChatProfile[]).map(item => [item.id, item]));
      setGroupMembers(roster.flatMap(item => {
        const member = profilesById.get(item.user_id);
        return member ? [{ ...item, username: member.username, avatar_data: member.avatar_data ?? null }] : [];
      }));
    };
    void loadRoster();
    const channel = supabaseClient.channel('aeroshell-master-chat-groups', { config: { private: true } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'aeroshell_group_members' }, () => {
        void loadRoster();
        void loadGroups(profile.id);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'aeroshell_groups', filter: 'id=eq.' + activeGroup.id }, () => {
        void loadGroups(profile.id);
      }).subscribe();
    return () => {
      active = false;
      void supabaseClient.removeChannel(channel);
    };
  }, [session, profile, activeGroup?.id, pinUnlocked, loadGroups]);



  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const filteredPeople = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    return people.filter(person => !query || person.username.toLowerCase().includes(query));
  }, [people, peopleQuery]);

  const filteredGroups = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    return groups.filter(group => !query || group.name.toLowerCase().includes(query));
  }, [groups, peopleQuery]);

  // Never render cached messages unless both endpoints match the active conversation.
  const conversationMessages = useMemo(
    () => profile && activeGroup
      ? getGroupMessages(messages, activeGroup.id)
      : profile && activePerson
        ? getConversationMessages(messages, profile.id, activePerson.id)
        : [],
    [messages, profile, activePerson, activeGroup],
  );

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabaseClient || busy) return;
    const normalized = username.trim().toLowerCase();
    if (!validUsername(normalized)) {
      tell('Use 3–20 letters, numbers or underscores for your username.', 'error');
      return;
    }
    if (password.length < 8) {
      tell('Choose a password with at least 8 characters.', 'error');
      return;
    }
    if (authMode === 'signup' && password !== confirmPassword) {
      tell('Those passwords do not match.', 'error');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      if (authMode === 'signup') {
        const { data, error } = await supabaseClient.auth.signUp({
          email: usernameEmail(normalized),
          password,
          options: { data: { username: normalized, aeroshell_chat: 'true' } },
        });
        if (error) throw error;
        setUsername(normalized);
        if (data.session) tell('Your account is ready. Welcome to Master Chat.', 'success');
        else tell('Account created, but sign-in is waiting for email confirmation. For username-only accounts, turn off Confirm email in Supabase Auth settings and try again.', 'info');
      } else {
        const { error } = await supabaseClient.auth.signInWithPassword({ email: usernameEmail(normalized), password });
        if (error) throw error;
        setPassword('');
        setConfirmPassword('');
        tell('You are signed in.', 'success');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authentication failed. Please try again.';
      if (/duplicate key|unique constraint|aeroshell_profiles_username_key/i.test(message)) tell('That username is already taken. Choose another one.', 'error');
      else if (/invalid login credentials/i.test(message)) tell('Username or password is incorrect.', 'error');
      else tell(message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const sendMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!supabaseClient || !profile || (!activePerson && !activeGroup) || !body || sending || attachmentBusy) return;
    if (body.length > 2000) {
      tell('Messages can be up to 2,000 characters.', 'error');
      return;
    }
    setSending(true);
    try {
      const { data, error } = await supabaseClient.from('aeroshell_messages')
        .insert({
          sender_id: profile.id,
          recipient_id: activeGroup ? null : activePerson!.id,
          group_id: activeGroup?.id ?? null,
          body,
          message_type: 'text',
        })
        .select(MESSAGE_FIELDS).single();
      if (error) tell('Message did not send. Check the connection and group/message policies.', 'error');
      else if (data) {
        setDraft('');
        const enriched = await withSignedAttachment(data as ChatMessage);
        setMessages(current => mergeScopedMessages(current, [enriched], profile.id, activePerson?.id ?? null, activeGroup?.id ?? null));
        tell('Message sent.', 'success');
        inputRef.current?.focus();
      }
    } catch {
      tell('Message did not send because the connection was interrupted. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  };

  const openScheduleDialog = () => {
    if (!profile || (!activePerson && !activeGroup)) {
      tell('Open an individual or group conversation before scheduling a message.', 'info');
      return;
    }
    if (!draft.trim()) {
      tell('Write a message first, then choose Schedule message.', 'info');
      inputRef.current?.focus();
      return;
    }
    setScheduleAt(asLocalDateTimeInput(new Date(Date.now() + 5 * 60 * 1000)));
    setScheduleError('');
    setScheduleDialogOpen(true);
  };

  const submitScheduledMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!profile || (!activePerson && !activeGroup)) {
      setScheduleError('Choose a conversation first.');
      return;
    }
    const body = draft.trim();
    if (!body) {
      setScheduleError('Write a message to schedule.');
      return;
    }
    if (body.length > 2000) {
      setScheduleError('Messages can be up to 2,000 characters.');
      return;
    }
    const scheduledTime = new Date(scheduleAt);
    if (!Number.isFinite(scheduledTime.getTime()) || scheduledTime.getTime() < Date.now() + 30000) {
      setScheduleError('Choose a time at least 30 seconds in the future.');
      return;
    }
    const item: ScheduledChatMessage = {
      id: crypto.randomUUID(),
      user_id: profile.id,
      recipient_id: activeGroup ? null : activePerson!.id,
      group_id: activeGroup?.id ?? null,
      body,
      send_at: scheduledTime.toISOString(),
    };
    try {
      const next = [...readScheduledChatMessages().filter(existing => existing.id !== item.id), item].sort((left, right) => Date.parse(left.send_at) - Date.parse(right.send_at));
      if (!writeScheduledChatMessages(next)) {
        setScheduleError('This browser is blocking local storage, so the message could not be scheduled.');
        return;
      }
      setScheduledMessages(next);
      setDraft('');
      setScheduleDialogOpen(false);
      setScheduleError('');
      tell('Message scheduled for ' + scheduledTime.toLocaleString() + '.', 'success');
    } catch {
      setScheduleError('Could not save this scheduled message in this browser.');
    }
  };

  const cancelScheduledMessage = (id: string) => {
    const next = readScheduledChatMessages().filter(item => item.id !== id);
    writeScheduledChatMessages(next);
    setScheduledMessages(next);
    tell('Scheduled message cancelled.', 'info');
  };

  const sendAttachment = async (
    file: File,
    type: 'file' | 'voice' = 'file',
    durationMs = 0,
    target: { person: ChatProfile | null; group: ChatGroup | null } = { person: activePerson, group: activeGroup },
    caption = '',
  ): Promise<boolean> => {
    if (!supabaseClient || !profile || (!target.person && !target.group) || attachmentBusy) return false;
    if (isVideoFile(file, type)) {
      tell('Video attachments are disabled. Send an image, document, text/code file, or voice note instead.', 'error');
      return false;
    }
    if (file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
      tell('Files must be smaller than 15 MB.', 'error');
      return false;
    }
    if (type === 'voice' && (!file.type.toLowerCase().startsWith('audio/') || durationMs < 1 || durationMs > 120000)) {
      tell('That voice note could not be prepared. Record a note up to two minutes long and retry.', 'error');
      return false;
    }
    setAttachmentBusy(true);
    setNotice('');
    const fileName = safeAttachmentName(file.name).slice(0, 180);
    const mime = file.type || (/\.(txt|md|csv|json|js|jsx|ts|tsx|py|html|css|sql|xml|yml|yaml)$/i.test(fileName) ? 'text/plain' : 'application/octet-stream');
    const objectName = Date.now() + '-' + crypto.randomUUID() + '-' + fileName;
    const path = target.group
      ? 'groups/' + target.group.id + '/' + profile.id + '/' + objectName
      : 'direct/' + profile.id + '/' + target.person!.id + '/' + objectName;
    try {
      const { error: uploadError } = await supabaseClient.storage.from(ATTACHMENT_BUCKET).upload(path, file, {
        contentType: mime,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploadError) {
        const reason = String(uploadError.message ?? '');
        if (/size|limit/i.test(reason)) throw new Error('This file exceeds the 15 MB attachment limit.');
        if (/row-level security|permission denied|accessdenied|unauthorized/i.test(reason)) {
          throw new Error((type === 'voice' ? 'Voice message upload' : 'File upload') +
            ' was rejected by the private Storage security policy. The file was not saved. Refresh the conversation, confirm you are signed in, and retry. (' + reason.slice(0, 120) + ')');
        }
        throw new Error((type === 'voice' ? 'Voice message upload failed' : 'File upload failed') +
          ': ' + (reason.slice(0, 160) || 'Storage returned no details') + '. Check the connection and try again.');
      }
      const row = {
        sender_id: profile.id,
        recipient_id: target.group ? null : target.person!.id,
        group_id: target.group?.id ?? null,
        body: type === 'file' ? caption.trim().slice(0, 2000) : '',
        message_type: type,
        attachment_path: path,
        attachment_name: fileName,
        attachment_mime: mime,
        attachment_size: file.size,
        voice_duration_ms: type === 'voice' ? Math.max(1, Math.min(120000, Math.round(durationMs))) : null,
      };
      const { data, error } = await supabaseClient.from('aeroshell_messages').insert(row).select(MESSAGE_FIELDS).single();
      if (error || !data) {
        await supabaseClient.storage.from(ATTACHMENT_BUCKET).remove([path]).catch(() => undefined);
        throw new Error('The upload finished, but the message could not be saved. Check the group membership and message policies.');
      }
      const enriched = await withSignedAttachment(data as ChatMessage);
      setMessages(current => mergeScopedMessages(
        current,
        [enriched],
        profile.id,
        target.person?.id ?? null,
        target.group?.id ?? null,
      ));
      tell(type === 'voice' ? 'Voice message sent.' : 'Attachment sent.', 'success');
      return true;
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not send this attachment. Please retry.', 'error');
      return false;
    } finally {
      setAttachmentBusy(false);
    }
  };

  const handleAttachmentSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = '';
    if (!file) return;
    if (file.type.toLowerCase().startsWith('image/')) {
      if (!activePerson && !activeGroup) {
        tell('Open a private or group conversation before sending an image.', 'info');
        return;
      }
      if (file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
        tell('Images must be smaller than 15 MB.', 'error');
        return;
      }
      setImageCaption(draft.trim());
      setPendingImage({
        file,
        previewUrl: URL.createObjectURL(file),
        target: { person: activePerson, group: activeGroup },
        draftSnapshot: draft.trim(),
      });
      return;
    }
    void sendAttachment(file);
  };

  const cancelPendingImage = () => {
    setPendingImage(null);
    setImageCaption('');
  };

  const sendPendingImage = async () => {
    if (!pendingImage || attachmentBusy) return;
    const chosenImage = pendingImage;
    const caption = imageCaption.trim().slice(0, 2000);
    const sent = await sendAttachment(chosenImage.file, 'file', 0, chosenImage.target, caption);
    if (!sent) return;
    if (chosenImage.draftSnapshot && draft.trim() === chosenImage.draftSnapshot) setDraft('');
    setPendingImage(null);
    setImageCaption('');
  };

  const getViewerImageBlob = async (viewer: NonNullable<typeof imageViewer>) => {
    const response = await fetch(viewer.url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) throw new Error('This image link expired or could not be downloaded. Reopen the conversation and try again.');
    const blob = await response.blob();
    if (!blob.type.toLowerCase().startsWith('image/')) throw new Error('The shared file is not available as an image.');
    return blob;
  };

  const copyImageFromViewer = async () => {
    if (!imageViewer || imageActionBusy) return;
    setImageActionBusy(true);
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('This browser cannot copy image data to the clipboard. Use Download image instead.');
      }
      const original = await getViewerImageBlob(imageViewer);
      const bitmap = await createImageBitmap(original);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) {
        bitmap.close();
        throw new Error('The image could not be prepared for copying. Use Download image instead.');
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The browser could not convert this image for the clipboard.')), 'image/png');
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      tell('Image copied to the clipboard.', 'success');
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not copy the image in this browser. Use Download image instead.', 'error');
    } finally {
      setImageActionBusy(false);
    }
  };

  const downloadImageFromViewer = async () => {
    if (!imageViewer || imageActionBusy) return;
    setImageActionBusy(true);
    try {
      const blob = await getViewerImageBlob(imageViewer);
      const localUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = localUrl;
      link.download = safeAttachmentName(imageViewer.name || 'shared-image.png');
      link.rel = 'noopener';
      link.style.position = 'fixed';
      link.style.left = '-10000px';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(localUrl), 60000);
      tell('Image download started.', 'success');
    } catch (error) {
      tell(error instanceof Error ? error.message : 'Could not download the image. Try opening the conversation again.', 'error');
    } finally {
      setImageActionBusy(false);
    }
  };

  const openImageViewer = (viewer: NonNullable<typeof imageViewer>) => {
    setImageViewerReady(false);
    setImageViewerError(false);
    setImageViewer(viewer);
  };

  const sendPastedTextFile = async (event: FormEvent) => {
    event.preventDefault();
    if (!pastedFileContent.trim()) {
      tell('Paste some text or code into the file first.', 'error');
      return;
    }
    const requestedName = safeAttachmentName(pastedFileName.trim() || 'notes.txt');
    const extension = requestedName.includes('.') ? requestedName.split('.').pop()?.toLowerCase() : '';
    const mimeByExtension: Record<string, string> = {
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
      js: 'text/javascript', jsx: 'text/javascript', ts: 'text/plain', tsx: 'text/plain',
      py: 'text/x-python', html: 'text/html', css: 'text/css', sql: 'text/plain', xml: 'application/xml',
      yaml: 'text/plain', yml: 'text/plain',
    };
    const file = new File([pastedFileContent], requestedName, { type: mimeByExtension[extension ?? ''] ?? 'text/plain' });
    const target = { person: activePerson, group: activeGroup };
    setPastedFileOpen(false);
    setPastedFileContent('');
    void sendAttachment(file, 'file', 0, target);
  };

  const toggleVoiceRecording = async () => {
    if (recordingVoice) {
      voiceRecorderRef.current?.stop();
      return;
    }
    if (voicePreparingRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      tell('Voice messages are not supported by this browser. Try a current version of Chrome, Edge, or Safari over HTTPS.', 'error');
      return;
    }
    if (!supabaseClient || !profile || (!activePerson && !activeGroup) || attachmentBusy) return;
    const target = { person: activePerson, group: activeGroup };
    voicePreparingRef.current = true;
    setVoicePreparing(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!voicePreparingRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      voiceStartRef.current = Date.now();
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      voiceRecorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        tell('Voice recording failed. Check microphone permissions and try again.', 'error');
        try { recorder.stop(); } catch { /* Recorder can already be stopped. */ }
      };
      recorder.onstop = () => {
        if (voiceLimitTimerRef.current !== null) window.clearTimeout(voiceLimitTimerRef.current);
        voiceLimitTimerRef.current = null;
        stream.getTracks().forEach(track => track.stop());
        voiceStreamRef.current = null;
        voiceRecorderRef.current = null;
        voicePreparingRef.current = false;
        setVoicePreparing(false);
        setRecordingVoice(false);
        const elapsed = Math.min(120000, Math.max(1, Date.now() - voiceStartRef.current));
        const type = recorder.mimeType || voiceChunksRef.current[0]?.type || 'audio/webm';
        const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const blob = new Blob(voiceChunksRef.current, { type });
        voiceChunksRef.current = [];
        if (blob.size > 0 && elapsed >= 500) {
          // Keep the actual audio MIME type. The private Storage policy reserves the
          // .webm filename suffix for MIME-verified audio; .audio avoids browsers
          // which omit that multipart metadata during object creation.
          const storageExtension = extension === 'webm' ? 'audio' : extension;
          const file = new File([blob], 'voice-message-' + Date.now() + '.' + storageExtension, { type: type.split(';')[0] });
          void sendAttachment(file, 'voice', elapsed, target);
        } else {
          tell('That voice note was too short. Hold the microphone a little longer and try again.', 'info');
        }
      };
      recorder.start(200);
      voicePreparingRef.current = false;
      setVoicePreparing(false);
      setRecordingVoice(true);
      tell('Recording voice message… Tap the microphone again to stop. Maximum duration: 2 minutes.', 'info');
      voiceLimitTimerRef.current = window.setTimeout(() => {
        if (voiceRecorderRef.current?.state === 'recording') {
          voiceRecorderRef.current.stop();
          tell('Two-minute recording limit reached. Sending your voice note…', 'info');
        }
      }, 120000);
    } catch (error) {
      voicePreparingRef.current = false;
      setVoicePreparing(false);
      voiceStreamRef.current?.getTracks().forEach(track => track.stop());
      voiceStreamRef.current = null;
      voiceRecorderRef.current = null;
      voiceChunksRef.current = [];
      setRecordingVoice(false);
      tell(error instanceof Error && /denied|permission/i.test(error.message)
        ? 'Microphone permission was denied. Allow microphone access in your browser settings, then retry.'
        : 'Could not start voice recording. Check microphone permissions and retry.', 'error');
    }
  };

  const cancelVoiceRecording = () => {
    voicePreparingRef.current = false;
    setVoicePreparing(false);
    if (voiceLimitTimerRef.current !== null) window.clearTimeout(voiceLimitTimerRef.current);
    voiceLimitTimerRef.current = null;
    const recorder = voiceRecorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Recorder may already be stopping. */ }
      }
    }
    voiceRecorderRef.current = null;
    voiceStreamRef.current?.getTracks().forEach(track => track.stop());
    voiceStreamRef.current = null;
    voiceChunksRef.current = [];
    setRecordingVoice(false);
  };

  useEffect(() => () => {
    voicePreparingRef.current = false;
    if (voiceLimitTimerRef.current !== null) window.clearTimeout(voiceLimitTimerRef.current);
    const recorder = voiceRecorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* Ignore during unmount. */ }
      }
    }
    voiceStreamRef.current?.getTracks().forEach(track => track.stop());
    voiceStreamRef.current = null;
    voiceRecorderRef.current = null;
    voiceChunksRef.current = [];
  }, []);

  const openCreateGroup = () => {
    setGroupDialogMode('create');
    setGroupNameDraft('');
    setGroupAvatarDraft(null);
    setGroupMemberSelection([]);
    setGroupError('');
    setGroupDialogOpen(true);
    setAccountSettingsOpen(false);
  };

  const openGroupManagement = () => {
    if (!activeGroup) return;
    setGroupDialogMode('manage');
    setGroupNameDraft(activeGroup.name);
    setGroupAvatarDraft(activeGroup.avatar_data);
    setGroupMemberSelection([]);
    setGroupError('');
    setGroupDialogOpen(true);
  };

  const handleGroupAvatarSelection = async (file: File | null) => {
    if (!file) return;
    try {
      const avatar = await compressImageForGroup(file);
      setGroupAvatarDraft(avatar);
      setGroupError('');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not prepare this group picture.');
    }
  };

  const toggleGroupMemberSelection = (userId: string) => {
    setGroupMemberSelection(current => current.includes(userId)
      ? current.filter(id => id !== userId)
      : current.length < 99 ? [...current, userId] : current);
  };

  const saveGroupDialog = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!supabaseClient || !profile || groupBusy) return;
    const name = groupNameDraft.trim();
    if (!name || name.length > 60) {
      setGroupError('Group names must contain 1–60 characters.');
      return;
    }
    setGroupBusy(true);
    setGroupError('');
    try {
      if (groupDialogMode === 'create') {
        const { data, error } = await supabaseClient.rpc('aeroshell_create_group', {
          p_name: name,
          p_avatar_data: groupAvatarDraft,
          p_member_ids: groupMemberSelection,
        });
        if (error || !data) throw new Error(error?.message ?? 'The group was not created.');
        const createdId = data as string;
        const loaded = await loadGroups(profile.id);
        const created = loaded.find(group => group.id === createdId);
        setActivePerson(null);
        setActiveGroup(created ?? null);
        setMessages([]);
        setDraft('');
        setGroupDialogOpen(false);
        tell('Group created. You are an admin and can add members or promote other admins.', 'success');
      } else {
        if (!activeGroup || activeGroup.my_role !== 'admin') throw new Error('Only a group admin can edit group details.');
        const { data, error } = await supabaseClient.from('aeroshell_groups')
          .update({ name, avatar_data: groupAvatarDraft, updated_at: new Date().toISOString() })
          .eq('id', activeGroup.id)
          .select('id, name, avatar_data, created_by, updated_at').single();
        if (error || !data) throw new Error('Group details were not saved. Only admins can edit the name and picture.');
        const loadedGroups = await loadGroups(profile.id);
        setActiveGroup(loadedGroups.find(group => group.id === data.id) ?? null);
        setGroupDialogOpen(false);
        tell('Group details updated.', 'success');
      }
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not save this group.');
    } finally {
      setGroupBusy(false);
    }
  };

  const addSelectedGroupMembers = async () => {
    if (!supabaseClient || !profile || !activeGroup || activeGroup.my_role !== 'admin' || !groupMemberSelection.length || groupBusy) return;
    setGroupBusy(true);
    setGroupError('');
    try {
      const { error } = await supabaseClient.from('aeroshell_group_members').insert(
        groupMemberSelection.map(user_id => ({ group_id: activeGroup.id, user_id, role: 'member', added_by: profile.id })),
      );
      if (error) throw new Error('Could not add one or more members. Only admins can invite members to this group.');
      setGroupMemberSelection([]);
      await loadGroups(profile.id);
      setGroupError('');
      tell('Members added to the group.', 'success');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not add group members.');
    } finally {
      setGroupBusy(false);
    }
  };

  const changeGroupMemberRole = async (member: ChatGroupMember) => {
    if (!supabaseClient || !profile || !activeGroup || activeGroup.my_role !== 'admin' || groupBusy) return;
    const role = member.role === 'admin' ? 'member' : 'admin';
    setGroupBusy(true);
    try {
      const { error } = await supabaseClient.from('aeroshell_group_members')
        .update({ role }).eq('group_id', activeGroup.id).eq('user_id', member.user_id);
      if (error) throw new Error(role === 'member'
        ? 'Could not remove admin rights. A group must always keep at least one admin.'
        : 'Could not promote this member to admin.');
      await loadGroups(profile.id);
      tell(role === 'admin' ? member.username + ' is now a group admin.' : member.username + ' is now a regular member.', 'success');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not change this member’s role.');
    } finally {
      setGroupBusy(false);
    }
  };

  const removeGroupMember = async (member: ChatGroupMember) => {
    if (!supabaseClient || !profile || !activeGroup || activeGroup.my_role !== 'admin' || member.user_id === profile.id || groupBusy) return;
    if (!window.confirm('Remove @' + member.username + ' from this group?')) return;
    setGroupBusy(true);
    try {
      const { error } = await supabaseClient.from('aeroshell_group_members')
        .delete().eq('group_id', activeGroup.id).eq('user_id', member.user_id);
      if (error) throw new Error('Could not remove this member. Confirm you are an admin.');
      await loadGroups(profile.id);
      tell(member.username + ' was removed from the group.', 'success');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not remove this member.');
    } finally {
      setGroupBusy(false);
    }
  };

  const leaveActiveGroup = async () => {
    if (!supabaseClient || !profile || !activeGroup || groupBusy) return;
    if (!window.confirm('Leave "' + activeGroup.name + '"? You will stop receiving group messages.')) return;
    setGroupBusy(true);
    setGroupError('');
    try {
      const { error } = await supabaseClient.from('aeroshell_group_members')
        .delete().eq('group_id', activeGroup.id).eq('user_id', profile.id);
      if (error) throw new Error('You cannot leave while you are the last admin. Promote another member first.');
      const groupName = activeGroup.name;
      setActiveGroup(null);
      setMessages([]);
      await loadGroups(profile.id);
      setGroupDialogOpen(false);
      tell('You left ' + groupName + '.', 'success');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not leave this group.');
    } finally {
      setGroupBusy(false);
    }
  };

  const deleteActiveGroup = async () => {
    if (!supabaseClient || !profile || !activeGroup || activeGroup.created_by !== profile.id || groupBusy) return;
    if (!window.confirm('Permanently delete "' + activeGroup.name + '" and its group messages for every member? This cannot be undone.')) return;
    setGroupBusy(true);
    setGroupError('');
    try {
      const { error } = await supabaseClient.from('aeroshell_groups').delete().eq('id', activeGroup.id);
      if (error) throw new Error('Only the original group creator can delete the group.');
      setActiveGroup(null);
      setMessages([]);
      await loadGroups(profile.id);
      setGroupDialogOpen(false);
      tell('Group deleted.', 'success');
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : 'Could not delete this group.');
    } finally {
      setGroupBusy(false);
    }
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  };

  const hideMessage = async (message: ChatMessage) => {
    if (!supabaseClient || !profile || messageActionId) return;
    setMessageActionId(message.id);
    try {
      const { error } = await supabaseClient.from('aeroshell_message_hides')
        .insert({ message_id: message.id, user_id: profile.id });
      if (error) {
        if (error.code === '23505') {
          setMessages(current => current.filter(item => item.id !== message.id));
          tell('This message is already hidden on this account.', 'info');
        } else {
          tell('Could not hide this message. The database denied the change or the connection failed.', 'error');
        }
      } else {
        setMessages(current => current.filter(item => item.id !== message.id));
        tell('Message hidden for this account only. The other participant still has their copy.', 'success');
      }
    } catch {
      tell('Could not hide this message because the connection failed.', 'error');
    } finally {
      setMessageActionId('');
    }
  };

  const deleteMessageForEveryone = async (message: ChatMessage) => {
    if (!supabaseClient || !profile || message.sender_id !== profile.id || messageActionId) return;
    if (!window.confirm('Delete this message for everyone in this conversation? This cannot be undone.')) return;
    setMessageActionId(message.id);
    try {
      const { data, error } = await supabaseClient.from('aeroshell_messages')
        .delete().eq('id', message.id).select('id').maybeSingle();
      if (error || !data) {
        tell('Message was not deleted. Only the original sender can delete their message for everyone.', 'error');
      } else {
        setMessages(current => current.filter(item => item.id !== message.id));
        // Only the sender's own storage object can be removed; database RLS prevents cross-user deletion.
        if (message.attachment_path) {
          const { error: storageError } = await supabaseClient.storage.from(ATTACHMENT_BUCKET).remove([message.attachment_path]);
          if (storageError) tell('Message deleted for everyone. Its private attachment will be cleaned up separately.', 'info');
          else tell('Message and its private attachment deleted for everyone.', 'success');
        } else {
          tell('Message deleted for everyone.', 'success');
        }
      }
    } catch {
      tell('Could not delete this message because the connection failed.', 'error');
    } finally {
      setMessageActionId('');
    }
  };

  const submitPin = async (event: FormEvent) => {
    event.preventDefault();
    if (pinBusy) return;
    setPinError('');
    if (!/^\d{4}$/.test(pinInput)) {
      setPinError('Enter exactly four digits.');
      return;
    }
    setPinBusy(true);
    try {
      if (pinMode === 'setup') {
        if (pinInput !== pinConfirm) {
          setPinError('The PINs do not match.');
          return;
        }
        const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
        const verifier = await derivePinVerifier(pinInput, salt);
        const record: PinRecord = { version: 1, salt, verifier };
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(record));
        setPinRecord(record);
        clearPinFailures();
        setPinInput('');
        setPinConfirm('');
        setPinUnlocked(true);
        setPinMode('unlock');
      } else if (pinMode === 'unlock' && pinRecord) {
        const throttle = readPinThrottle();
        setPinCooldownUntil(throttle.lockedUntil);
        if (throttle.lockedUntil > Date.now()) {
          setPinError('Too many attempts. Wait ' + Math.ceil((throttle.lockedUntil - Date.now()) / 1000) + ' seconds and try again.');
          return;
        }
        const candidate = await derivePinVerifier(pinInput, pinRecord.salt);
        if (!sameHex(candidate, pinRecord.verifier)) {
          const failure = recordPinFailure();
          setPinCooldownUntil(failure.lockedUntil);
          setPinError(failure.lockedUntil > Date.now()
            ? 'Too many incorrect attempts. Try again in ' + Math.ceil((failure.lockedUntil - Date.now()) / 1000) + ' seconds.'
            : 'Incorrect PIN. Try again.');
          setPinInput('');
          return;
        }
        clearPinFailures();
        setPinCooldownUntil(0);
        setPinInput('');
        setPinUnlocked(true);
      }
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'Could not verify or save the local PIN.');
    } finally {
      setPinBusy(false);
    }
  };

  const resetLocalPin = () => {
    try {
      localStorage.removeItem(PIN_STORAGE_KEY);
      localStorage.removeItem(PIN_THROTTLE_KEY);
      setPinRecord(null);
      setPinMode('off');
      setPinInput('');
      setPinConfirm('');
      setPinError('');
      setPinUnlocked(true);
    } catch {
      setPinError('The browser blocked storage changes, so the local PIN cannot be reset here.');
    }
  };

  const changeLocalPin = async (event: FormEvent) => {
    event.preventDefault();
    if (pinChangeBusy) return;
    setPinChangeBusy(true);
    setPinChangeError('');
    try {
      if (!/^\d{4}$/.test(pinNewValue)) {
        setPinChangeError('Choose exactly four digits for the new PIN.');
        return;
      }
      if (pinNewValue !== pinNewConfirmValue) {
        setPinChangeError('The new PINs do not match.');
        return;
      }
      if (pinRecord) {
        if (!/^\d{4}$/.test(pinCurrentValue)) {
          setPinChangeError('Enter the current four-digit PIN.');
          return;
        }
        const candidate = await derivePinVerifier(pinCurrentValue, pinRecord.salt);
        if (!sameHex(candidate, pinRecord.verifier)) {
          setPinChangeError('The current PIN is incorrect.');
          return;
        }
      }
      const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
      const verifier = await derivePinVerifier(pinNewValue, salt);
      const next: PinRecord = { version: 1, salt, verifier };
      localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next));
      setPinRecord(next);
      setPinMode('unlock');
      setPinUnlocked(true);
      clearPinFailures();
      setPinCurrentValue('');
      setPinNewValue('');
      setPinNewConfirmValue('');
      setPinChangeOpen(false);
      tell(pinRecord ? 'This browser’s Master Chat PIN has been changed.' : 'Master Chat PIN configured.', 'success');
    } catch (error) {
      setPinChangeError(error instanceof Error ? error.message : 'Could not save the local PIN.');
    } finally {
      setPinChangeBusy(false);
    }
  };

  const removeLocalPin = async () => {
    if (!pinRecord || pinChangeBusy) return;
    setPinChangeBusy(true);
    setPinChangeError('');
    try {
      if (!/^\d{4}$/.test(pinCurrentValue)) throw new Error('Enter your current four-digit PIN to remove it.');
      const candidate = await derivePinVerifier(pinCurrentValue, pinRecord.salt);
      if (!sameHex(candidate, pinRecord.verifier)) throw new Error('The current PIN is incorrect.');
      try {
        localStorage.removeItem(PIN_STORAGE_KEY);
      } catch {
        throw new Error('Your browser blocked storage changes, so the PIN could not be removed.');
      }
      try { localStorage.removeItem(PIN_THROTTLE_KEY); } catch { /* PIN removal still succeeded. */ }
      setPinRecord(null);
      setPinMode('off');
      setPinUnlocked(true);
      setPinInput('');
      setPinConfirm('');
      setPinCurrentValue('');
      setPinNewValue('');
      setPinNewConfirmValue('');
      setPinChangeOpen(false);
      tell('App PIN removed. Master Chat will stay available without a PIN.', 'success');
    } catch (error) {
      setPinChangeError(error instanceof Error ? error.message : 'Could not remove the app PIN.');
    } finally {
      setPinChangeBusy(false);
    }
  };

  const openPinSettings = () => {
    setAccountSettingsOpen(false);
    setPinChangeOpen(true);
    setPinChangeError('');
    setPinCurrentValue('');
    setPinNewValue('');
    setPinNewConfirmValue('');
  };

  const saveLocalPasskey = async (method: 'face' | 'fingerprint') => {
    if (!profile || passkeyBusy) return;
    setPasskeyBusy(true);
    setPasskeyError('');
    try {
      if (!window.isSecureContext || !navigator.credentials || typeof navigator.credentials.create !== 'function') {
        throw new Error('Biometric passkeys need a current browser on HTTPS (or localhost) with WebAuthn support.');
      }
      if (!globalThis.crypto?.subtle) throw new Error('Secure browser cryptography is unavailable.');
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userHandle = crypto.getRandomValues(new Uint8Array(16));
      const created = await navigator.credentials.create({
        publicKey: {
          challenge: passkeyArrayBuffer(challenge),
          rp: { name: 'AeroShell Master Chat', id: window.location.hostname },
          user: { id: passkeyArrayBuffer(userHandle), name: profile.username, displayName: profile.username },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          timeout: 60000,
          attestation: 'none',
          // Use the device's built-in authenticator for Face ID, Touch ID, fingerprint,
          // Windows Hello, or the platform's configured secure fallback.
          authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
        },
      }) as PublicKeyCredential | null;
      if (!created || created.type !== 'public-key') throw new Error('Your device did not create a built-in biometric passkey. Check that Face ID, fingerprint, or Windows Hello is configured, or use your app PIN.');
      const response = created.response as AuthenticatorAttestationResponse & {
        getPublicKey?: () => ArrayBuffer | null;
        getPublicKeyAlgorithm?: () => number;
      };
      const clientData = JSON.parse(new TextDecoder().decode(response.clientDataJSON)) as { type?: string; challenge?: string; origin?: string };
      if (clientData.type !== 'webauthn.create' || clientData.challenge !== passkeyToBase64Url(challenge) || clientData.origin !== window.location.origin) {
        throw new Error('The browser returned an invalid passkey registration response.');
      }
      const publicKey = typeof response.getPublicKey === 'function' ? response.getPublicKey() : null;
      const algorithm = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : 0;
      if (!publicKey || algorithm !== -7) {
        throw new Error('This device browser cannot expose the verification key needed by this local passkey feature. Try a current Safari, Chrome, or Edge browser with its built-in biometric authenticator, or use your account password/app PIN.');
      }
      const record: LocalPasskeyRecord = {
        version: 1,
        credentialId: passkeyToBase64Url(created.rawId),
        publicKey: passkeyToBase64Url(publicKey),
        rpId: window.location.hostname,
        userId: profile.id,
        method,
        algorithm: -7,
        signCount: 0,
        createdAt: new Date().toISOString(),
      };
      localStorage.setItem(LOCAL_PASSKEY_STORAGE_KEY, JSON.stringify(record));
      setLocalPasskey(record);
      setPasskeyError('');
      tell(`Device passkey created with ${method === 'face' ? 'Face ID' : 'fingerprint'} as your preference. The operating system may still request a pattern/PIN fallback.`, 'success');
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : 'Could not set up a passkey on this device.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const removeLocalPasskey = () => {
    if (!localPasskey || passkeyBusy) return;
    if (!window.confirm('Remove this biometric passkey link from Master Chat on this browser? This does not delete the passkey from your device password manager.')) return;
    try {
      localStorage.removeItem(LOCAL_PASSKEY_STORAGE_KEY);
      setLocalPasskey(null);
      setPasskeyError('');
      tell('The local Master Chat passkey link was removed. The device credential itself was not deleted.', 'success');
    } catch {
      setPasskeyError('Your browser blocked storage changes, so the passkey link could not be removed.');
    }
  };

  const unlockWithLocalPasskey = async () => {
    const saved = localPasskey;
    if (!saved || passkeyBusy) return;
    setPasskeyBusy(true);
    setPinError('');
    try {
      if (!window.isSecureContext || !navigator.credentials || typeof navigator.credentials.get !== 'function') {
        throw new Error('Biometric unlock needs a current browser on HTTPS (or localhost) with WebAuthn support.');
      }
      if (!globalThis.crypto?.subtle) throw new Error('Secure browser cryptography is unavailable.');
      if (saved.rpId !== window.location.hostname) throw new Error('This passkey was registered for a different website address.');
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const credential = await navigator.credentials.get({
        publicKey: {
          challenge: passkeyArrayBuffer(challenge),
          rpId: saved.rpId,
          allowCredentials: [{ type: 'public-key', id: passkeyArrayBuffer(passkeyFromBase64Url(saved.credentialId)) }],
          timeout: 60000,
          userVerification: 'required',
        },
      }) as PublicKeyCredential | null;
      if (!credential || credential.type !== 'public-key') throw new Error('No biometric passkey response was returned. Check your device screen-lock settings and try again.');
      if (passkeyToBase64Url(credential.rawId) !== saved.credentialId) throw new Error('The selected passkey does not match this browser’s registered credential.');
      const response = credential.response as AuthenticatorAssertionResponse;
      const clientDataBytes = new Uint8Array(response.clientDataJSON);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes)) as { type?: string; challenge?: string; origin?: string };
      if (clientData.type !== 'webauthn.get' || clientData.challenge !== passkeyToBase64Url(challenge) || clientData.origin !== window.location.origin) {
        throw new Error('The passkey response could not be verified for this site.');
      }
      const authenticatorData = new Uint8Array(response.authenticatorData);
      if (authenticatorData.length < 37) throw new Error('The authenticator returned incomplete verification data.');
      const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.rpId)));
      if (!passkeyBytesEqual(authenticatorData.slice(0, 32), rpHash)) throw new Error('This passkey belongs to a different website.');
      const flags = authenticatorData[32];
      if ((flags & 0x01) === 0 || (flags & 0x04) === 0) throw new Error('Your device did not confirm user verification. Try again.');
      const signature = passkeyDerSignatureToRaw(new Uint8Array(response.signature));
      if (!signature) throw new Error('The passkey signature format is not supported by this browser.');
      const publicKey = await crypto.subtle.importKey(
        'spki',
        passkeyArrayBuffer(passkeyFromBase64Url(saved.publicKey)),
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
      const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
      const signedData = passkeyConcat(authenticatorData, clientDataHash);
      const verified = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        passkeyArrayBuffer(signature),
        passkeyArrayBuffer(signedData),
      );
      if (!verified) throw new Error('The passkey signature could not be verified.');
      const signCount = new DataView(authenticatorData.buffer, authenticatorData.byteOffset + 33, 4).getUint32(0, false);
      if (saved.signCount > 0 && signCount > 0 && signCount <= saved.signCount) {
        throw new Error('The authenticator counter did not advance. Use your PIN or re-register this passkey.');
      }
      const updated = { ...saved, signCount: Math.max(saved.signCount, signCount) };
      localStorage.setItem(LOCAL_PASSKEY_STORAGE_KEY, JSON.stringify(updated));
      setLocalPasskey(updated);
      clearPinFailures();
      setPinCooldownUntil(0);
      setPinInput('');
      setPinConfirm('');
      setPinError('');
      setPinUnlocked(true);
      setPinMode('unlock');
    } catch (error) {
      setPinError(error instanceof Error ? error.message : 'Could not verify your passkey. Use your PIN instead.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const openAccountPasswordSettings = () => {
    setAccountSettingsOpen(false);
    setAccountPasswordError('');
    setAccountCurrentPassword('');
    setAccountNewPassword('');
    setAccountConfirmPassword('');
    setPasswordChangeOpen(true);
  };

  const changeAccountPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabaseClient || !profile || accountPasswordBusy) return;
    setAccountPasswordError('');
    if (accountCurrentPassword.length < 8) {
      setAccountPasswordError('Enter your current account password.');
      return;
    }
    if (accountNewPassword.length < 8) {
      setAccountPasswordError('Choose a new password with at least 8 characters.');
      return;
    }
    if (accountNewPassword !== accountConfirmPassword) {
      setAccountPasswordError('The new passwords do not match.');
      return;
    }
    if (accountCurrentPassword === accountNewPassword) {
      setAccountPasswordError('Choose a new password different from the current password.');
      return;
    }
    setAccountPasswordBusy(true);
    try {
      const { error: reauthError } = await supabaseClient.auth.signInWithPassword({
        email: usernameEmail(profile.username),
        password: accountCurrentPassword,
      });
      if (reauthError) throw new Error('The current account password is incorrect.');
      const { error } = await supabaseClient.auth.updateUser({ password: accountNewPassword });
      if (error) throw new Error('The password could not be changed. Please retry.');
      setPasswordChangeOpen(false);
      setAccountCurrentPassword('');
      setAccountNewPassword('');
      setAccountConfirmPassword('');
      setPassword('');
      tell('Your Master Chat system/account password has been changed.', 'success');
    } catch (error) {
      setAccountPasswordError(error instanceof Error ? error.message : 'Could not change the account password.');
    } finally {
      setAccountPasswordBusy(false);
    }
  };

  const openDeleteAccount = () => {
    setAccountSettingsOpen(false);
    setDeleteAccountStep(1);
    setDeleteAccountText('');
    setDeleteAccountError('');
  };

  const cancelDeleteAccount = () => {
    if (deleteAccountBusy) return;
    setDeleteAccountStep(0);
    setDeleteAccountText('');
    setDeleteAccountError('');
  };

  const permanentlyDeleteAccount = async () => {
    if (!supabaseClient || !session || !profile || deleteAccountBusy) return;
    if (deleteAccountText !== 'DELETE') {
      setDeleteAccountError('Type DELETE exactly to confirm permanent account deletion.');
      return;
    }
    setDeleteAccountBusy(true);
    setDeleteAccountError('');
    try {
      // The server derives the target account only from this authenticated session; no user ID or password is sent.
      const { data, error } = await supabaseClient.functions.invoke('delete-master-chat-account', {
        body: { confirmation: 'DELETE' },
      });
      if (error) {
        let reason = '';
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          try {
            const payload = await context.clone().json() as { error?: unknown };
            if (typeof payload.error === 'string') reason = payload.error;
          } catch { /* Use the safe fallback below. */ }
        }
        if (reason === 'account_deletion_unavailable') {
          throw new Error('Permanent deletion is not available because the server is missing its protected configuration. Your account has not been confirmed as deleted.');
        }
        if (reason === 'account_profile_not_found') {
          throw new Error('This Master Chat profile could not be verified. No account deletion was performed.');
        }
        throw new Error('The server could not confirm account deletion. Check your connection before trying again.');
      }
      if (!data || data.success !== true) {
        throw new Error('The server did not confirm permanent deletion. Your account may still exist; reconnect and check before retrying.');
      }

      try { localStorage.removeItem(PIN_STORAGE_KEY); } catch { /* Server-side deletion already completed. */ }
      try { localStorage.removeItem(PIN_THROTTLE_KEY); } catch { /* Server-side deletion already completed. */ }
      try { await supabaseClient.auth.signOut({ scope: 'local' }); } catch { /* Clear local UI even if the deleted session is invalid. */ }

      setSession(null);
      setProfile(null);
      setPeople([]);
      setGroups([]);
      setGroupMembers([]);
      setActivePerson(null);
      setActiveGroup(null);
      setMessages([]);
      setDraft('');
      setPeopleQuery('');
      setUsername('');
      setPassword('');
      setConfirmPassword('');
      setAuthMode('signup');
      setPinRecord(null);
      setPinMode('off');
      setPinUnlocked(true);
      setConversationFullscreen(false);
      setAccountSettingsOpen(false);
      setPinChangeOpen(false);
      setPasswordChangeOpen(false);
      setGroupDialogOpen(false);
      setDeleteAccountStep(0);
      setDeleteAccountText('');
      setNotice('Your Master Chat account and its chat data have been permanently deleted. You can create a new account now.');
      setNoticeKind('success');
    } catch (error) {
      setDeleteAccountError(error instanceof Error ? error.message : 'Could not confirm account deletion. Please retry.');
    } finally {
      setDeleteAccountBusy(false);
    }
  };

  const toggleConversationFullscreen = () => {
    if (conversationFullscreen) {
      setConversationFullscreen(false);
      nativeChatFullscreenRef.current = false;
      if (document.fullscreenElement === chatRootRef.current) {
        void document.exitFullscreen().catch(() => undefined);
      }
      return;
    }
    if (!iosMode || (!activePerson && !activeGroup)) return;
    setConversationFullscreen(true);
    const element = chatRootRef.current as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    if (!element) return;
    if (typeof element.requestFullscreen === 'function' && document.fullscreenEnabled) {
      nativeChatFullscreenRef.current = true;
      void element.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
        // CSS immersive mode remains available if the browser refuses native fullscreen.
        nativeChatFullscreenRef.current = false;
      });
    } else if (typeof element.webkitRequestFullscreen === 'function') {
      nativeChatFullscreenRef.current = true;
      try {
        const pending = element.webkitRequestFullscreen();
        if (pending && typeof (pending as Promise<void>).catch === 'function') {
          void (pending as Promise<void>).catch(() => { nativeChatFullscreenRef.current = false; });
        }
      } catch {
        nativeChatFullscreenRef.current = false;
      }
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (nativeChatFullscreenRef.current && document.fullscreenElement !== chatRootRef.current) {
        nativeChatFullscreenRef.current = false;
        setConversationFullscreen(false);
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange as EventListener);
    };
  }, []);

  useEffect(() => {
    if (iosMode && (activePerson || activeGroup) && pinUnlocked) return;
    setConversationFullscreen(false);
    if (chatRootRef.current && document.fullscreenElement === chatRootRef.current) {
      nativeChatFullscreenRef.current = false;
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [iosMode, activePerson, activeGroup, pinUnlocked]);

  const lockApp = () => {
    if (voiceRecorderRef.current || voicePreparingRef.current) cancelVoiceRecording();
    if (!pinRecord && !(localPasskey && localPasskey.rpId === window.location.hostname)) {
      tell('Set up an optional PIN or passkey in Account & privacy before locking Master Chat.', 'info');
      return;
    }
    setConversationFullscreen(false);
    setPinUnlocked(false);
    setPinMode('unlock');
    setPinInput('');
    setPinConfirm('');
    setActivePerson(null);
    setActiveGroup(null);
    setGroupMembers([]);
    setMessages([]);
    setDraft('');
    setPinChangeOpen(false);
    setGroupDialogOpen(false);
  };
  lockAppRef.current = lockApp;

  useEffect(() => {
    if (!pinUnlocked || !pinRecord) return;
    let timer = window.setTimeout(() => lockAppRef.current(), 5 * 60 * 1000);
    const resetTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => lockAppRef.current(), 5 * 60 * 1000);
    };
    // Mobile browsers briefly mark the page hidden while opening the system photo/file picker.
    // Treat that as a normal attachment flow, not as a request to lock the messaging app.
    document.addEventListener('pointerdown', resetTimer, true);
    document.addEventListener('keydown', resetTimer, true);
    document.addEventListener('touchstart', resetTimer, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', resetTimer, true);
      document.removeEventListener('keydown', resetTimer, true);
      document.removeEventListener('touchstart', resetTimer, true);
    };
  }, [pinUnlocked, pinRecord]);

  useEffect(() => {
    if (!pinCooldownUntil || pinCooldownUntil <= Date.now()) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setPinNow(now);
      if (pinCooldownUntil <= now) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pinCooldownUntil]);

  const signOut = async () => {
    if (!supabaseClient) return;
    if (voiceRecorderRef.current || voicePreparingRef.current) cancelVoiceRecording();
    const { error } = await supabaseClient.auth.signOut();
    if (error) tell('Could not sign out. Please try again.', 'error');
    else {
      setActivePerson(null);
      setActiveGroup(null);
      setGroupMembers([]);
      setGroups([]);
      setMessages([]);
      setPassword('');
      tell('You have signed out.', 'success');
    }
  };

const passkeyPreflightModal = passkeyPromptIntent ? createPortal(
      <div className="master-chat-passkey-preflight-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setPasskeyPromptIntent(null);}}>
        <section className="master-chat-passkey-preflight" role="dialog" aria-modal="true" aria-labelledby="master-chat-passkey-preflight-title">
          <button type="button" className="master-chat-account-modal-close" aria-label="Cancel passkey setup" title="Cancel" onClick={()=>setPasskeyPromptIntent(null)}><X size={18}/></button>
          <span className="master-chat-pin-icon"><Fingerprint size={23}/></span>
          <p className="eyebrow">DEVICE AUTHENTICATION</p>
          <h3 id="master-chat-passkey-preflight-title">{passkeyPromptIntent.action==='create'?'Before creating a passkey':'Before using this passkey'}</h3>
          <p>Master Chat requests the phone's built-in passkey authenticator. It cannot force Face ID or fingerprint exclusively. Android or your password manager may ask for the phone's pattern/PIN, including as a fallback even when a biometric is enrolled.</p>
          <p className="master-chat-passkey-preflight-note">If you do not want any pattern/PIN prompt, choose Cancel now. A website cannot guarantee biometric-only authentication; that requires a native app configured to allow biometrics without device-credential fallback.</p>
          <div className="master-chat-feature-modal-actions">
            <button type="button" className="secondary-button" onClick={()=>setPasskeyPromptIntent(null)}>Cancel — don't open prompt</button>
            <button type="button" className="master-chat-primary" disabled={passkeyBusy} onClick={()=>{const intent=passkeyPromptIntent;setPasskeyPromptIntent(null);if(intent.action==='create' && (intent.method==='face'||intent.method==='fingerprint'))void saveLocalPasskey(intent.method);else void unlockWithLocalPasskey();}}>Continue to device prompt</button>
          </div>
        </section>
      </div>,
      document.body
    ) : null;

  if (pinMode === 'loading') {
    return <section className="master-chat-pin-screen" aria-live="polite">
      <MasterChatExitButton onClose={onClose}/>
      <div className="master-chat-pin-card"><span className="master-chat-pin-icon"><LockKeyhole size={25}/></span><h2>Master Chat is locked</h2><p>Preparing your local app lock…</p></div>
    </section>;
  }

  if (!pinUnlocked) {
    const isSetup = pinMode === 'setup';
    const isRepair = pinMode === 'repair';
    const passkeyOnlyLock = !pinRecord && !!localPasskey && localPasskey.rpId === window.location.hostname && pinMode === 'unlock';
    const cooldownSeconds = Math.max(0, Math.ceil((pinCooldownUntil - pinNow) / 1000));
    return <section className="master-chat-pin-screen">
      <MasterChatExitButton onClose={onClose}/>
      <form className="master-chat-pin-card" onSubmit={submitPin}>
        <span className="master-chat-pin-icon"><LockKeyhole size={25}/></span>
        <p className="eyebrow">AEROSHELL · LOCAL APP LOCK</p>
        <h2>{isSetup ? 'Create your 4-digit PIN' : isRepair ? 'Local PIN needs repair' : passkeyOnlyLock ? 'Unlock with your passkey' : 'Unlock Master Chat'}</h2>
        <p>{isSetup ? 'This PIN is separate from your Master Chat account password and is stored only in this browser.' : isRepair ? 'The local PIN could not be read. Repairing it only resets this browser lock, not your online account.' : passkeyOnlyLock ? 'Confirm with the passkey saved for this site to unlock Master Chat on this browser.' : 'Enter the four digits to open the messaging app.'}</p>
        {!isRepair && !passkeyOnlyLock && <>
          <label className="master-chat-pin-label">{isSetup ? 'New PIN' : 'Four-digit PIN'}
            <input autoFocus inputMode="numeric" pattern="[0-9]{4}" type="password" autoComplete="off" maxLength={4} value={pinInput}
              onChange={event => setPinInput(event.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="Four-digit app PIN" required/>
          </label>
          {isSetup && <label className="master-chat-pin-label">Confirm PIN
            <input inputMode="numeric" pattern="[0-9]{4}" type="password" autoComplete="off" maxLength={4} value={pinConfirm}
              onChange={event => setPinConfirm(event.target.value.replace(/\D/g, '').slice(0, 4))} aria-label="Confirm four-digit app PIN" required/>
          </label>}
          {cooldownSeconds > 0 && !isSetup && <p className="master-chat-pin-warning"><AlertTriangle size={15}/> Too many attempts. Try again in {cooldownSeconds}s.</p>}
        </>}
        {pinError && <p className="master-chat-notice error" role="alert">{pinError}</p>}
        {!isRepair && !passkeyOnlyLock && <button className="master-chat-primary" disabled={pinBusy || (cooldownSeconds > 0 && !isSetup)} type="submit">{pinBusy ? 'Checking…' : isSetup ? 'Save PIN and continue' : 'Unlock messages'}</button>}
        {!isSetup && !isRepair && localPasskey && localPasskey.rpId === window.location.hostname && <button type="button" className="master-chat-pin-passkey-button" disabled={passkeyBusy} onClick={() => setPasskeyPromptIntent({method:localPasskey.method ?? 'device',action:'unlock'})}><Fingerprint size={16}/>{passkeyBusy ? 'Verifying…' : 'Use device passkey'}</button>}
        {isRepair && <button type="button" className="master-chat-primary" onClick={resetLocalPin}>Reset this browser’s app PIN</button>}
        <div className="master-chat-pin-disclaimer"><ShieldCheck size={15}/><span>Privacy note: this is a browser-level lock, not end-to-end encryption. Someone with full access to this browser profile or developer tools may bypass it. Clearing site data can reset the local lock.</span></div>
      </form>
      {passkeyPreflightModal}
    </section>;
  }

  if (!supabaseClient) {
    return <section className="master-chat-setup">
      <MasterChatExitButton onClose={onClose}/>
      <div className="master-chat-orb"><MessageCircle size={29}/></div>
      <p className="eyebrow">AEROSHELL · ONLINE MESSAGING</p>
      <h2>Master Chat</h2>
      <p className="master-chat-lead">Real accounts. Private conversations. Messages that reach other people on their own devices.</p>
      <div className="master-chat-setup-status"><WifiOff size={18}/><div><b>Chat server not connected</b><span>The app is in the project. Connect a Supabase project to enable shared accounts, message storage and real-time delivery.</span></div></div>
      <div className="master-chat-setup-steps">
        <h3>Connect the service</h3>
        <ol>
          <li>Create a project at <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">Supabase Dashboard</a>.</li>
          <li>Run supabase/master-chat.sql in the project's SQL Editor.</li>
          <li>In Supabase Realtime settings, turn off Allow public access so private-channel authorization is enforced.</li>
          <li>In Supabase Auth email-provider settings, turn off email confirmation for username-only accounts. These app-only identities cannot receive password-reset emails.</li>
          <li>Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to Vercel Project Settings → Environment Variables for Preview and Production, then redeploy.</li>
        </ol>
        <p className="hint">Only the public publishable key belongs in frontend settings. Never put a Supabase service-role key in website code or Vercel's VITE_ variables.</p>
      </div>
    </section>;
  }

  if (booting) return <div className="master-chat-loading"><MasterChatExitButton onClose={onClose}/><span className="master-chat-spinner"/><b>Connecting to Master Chat…</b><small>Restoring your session securely</small></div>;

  if (!session || !profile) {
    return <section className="master-chat-auth">
      <MasterChatExitButton onClose={onClose}/>
      <div className="master-chat-auth-art"><div className="master-chat-orb"><MessageCircle size={28}/></div><span className="master-chat-spark spark-a"/><span className="master-chat-spark spark-b"/><span className="master-chat-spark spark-c"/></div>
      <p className="eyebrow">AEROSHELL · PEOPLE, CONNECTED</p>
      <h2>{authMode === 'signup' ? 'Meet here.' : 'Welcome back.'}</h2>
      <p className="master-chat-lead">{authMode === 'signup' ? 'Create a username, set your password, and start a conversation.' : 'Sign in to pick up where your conversations left off.'}</p>
      <form className="master-chat-auth-form" onSubmit={submitAuth}>
        <label>Username<input autoComplete="username" value={username} maxLength={20} onChange={event => setUsername(event.target.value)} placeholder="e.g. sky_coder" required minLength={3}/><small>3–20 letters, numbers or underscores</small></label>
        <label>Password<input type="password" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={8} placeholder="At least 8 characters"/></label>
        {authMode === 'signup' && <label>Confirm password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required minLength={8} placeholder="Enter it again"/></label>}
        {notice && <p className={'master-chat-notice '+noticeKind} role="status">{notice}</p>}
        <button className="master-chat-primary" disabled={busy} type="submit">{busy ? <span className="master-chat-spinner small"/> : authMode === 'signup' ? <UserPlus size={16}/> : <LogIn size={16}/>} {busy ? 'Please wait…' : authMode === 'signup' ? 'Create account' : 'Sign in'}</button>
      </form>
      <button className="master-chat-switch-auth" onClick={() => { setAuthMode(current => current === 'signup' ? 'signin' : 'signup'); setNotice(''); }}>{authMode === 'signup' ? 'Already have an account? Sign in' : 'New to Master Chat? Create an account'}</button>
      <div className="master-chat-privacy"><ShieldCheck size={15}/><span>Your password is handled by Supabase Auth. Master Chat never stores a plaintext password in its own tables.</span></div>
      <button className="master-chat-help-link" onClick={() => setHelpOpen(value => !value)}><CircleHelp size={14}/> Why does username-only sign-in need setup?</button>
      {helpOpen && <p className="master-chat-help">Supabase Auth uses an email identity behind the scenes. Master Chat maps each username to a non-deliverable app identity, so email confirmation must be disabled. Users cannot receive password-reset emails in this beta.</p>}
    </section>;
  }

  return <section ref={chatRootRef} className={'master-chat-app'+(conversationFullscreen ? ' master-chat-conversation-fullscreen' : '')+(activePerson ? ' master-chat-has-active-person' : '')+(activeGroup ? ' master-chat-has-active-group' : '')}>
    <MasterChatVoiceCalls client={supabaseClient} profile={profile} people={people} activePerson={activePerson} enabled={pinUnlocked && !!session} showCallLauncher={showCallLauncher && !activeGroup} portalRoot={iosMode || conversationFullscreen ? document.body : undefined}/>
    {conversationFullscreen && <>
       {iosMode
         ? createPortal(<button type="button" className="master-chat-fullscreen-exit master-chat-ios-fullscreen-exit" title="Exit messages-only fullscreen" aria-label="Exit messages-only fullscreen" onClick={toggleConversationFullscreen}><Minimize2 size={18}/></button>, document.body)
         : <button type="button" className="master-chat-fullscreen-exit" title="Exit messages-only fullscreen" aria-label="Exit messages-only fullscreen" onClick={toggleConversationFullscreen}><Minimize2 size={18}/></button>}
       {!iosMode && <MasterChatExitButton onClose={onClose} className="master-chat-fullscreen-close" portalTarget={chatRootRef.current}/>}
     </>}
    <aside className="master-chat-sidebar">
      <div className="master-chat-brand"><span className="master-chat-brand-icon"><MessageCircle size={20}/></span><span><b>Master Chat</b><small>Talk to your people</small></span><button className="master-chat-icon-button" title="Refresh member list" onClick={() => void loadPeople(profile.id)}><MoreHorizontal size={18}/></button>{onClose && <button type="button" className="master-chat-icon-button master-chat-inline-close" title="Close Master Chat" aria-label="Close Master Chat" onClick={onClose}><X size={18}/></button>}</div>
      <label className="master-chat-search"><Search size={15}/><input value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} placeholder="Find a username"/></label>
      <div className="master-chat-list-heading"><Users size={14}/><span>PEOPLE</span><small>{filteredPeople.length}</small></div>
      <div className="master-chat-people">
        {filteredPeople.map(person => <button className={'master-chat-person '+(activePerson?.id === person.id ? 'active' : '')} key={person.id} onClick={() => {
          if (voiceRecorderRef.current || voicePreparingRef.current) { tell('Stop or cancel the voice recording before switching chats.', 'info'); return; }
          setConversationFullscreen(false); setMessages([]); setDraft(''); setActiveGroup(null); setActivePerson(person); setNotice(''); setAccountSettingsOpen(false); setGroupDialogOpen(false);
        }}>
          <span className="master-chat-avatar">{isValidAvatarData(person.avatar_data) ? <img src={person.avatar_data} alt=""/> : person.username.slice(0, 1).toUpperCase()}<i className={onlineIds.includes(person.id) ? 'online' : ''}/></span>
          <span className="master-chat-person-meta"><b>{person.username}</b><small>{onlineIds.includes(person.id) ? 'Online now' : 'Master Chat member'}</small></span>
          {activePerson?.id === person.id && <span className="master-chat-selected-mark"><Check size={13}/></span>}
        </button>)}
        {!filteredPeople.length && <div className="master-chat-empty-people"><Users size={20}/><b>No other members yet</b><span>{peopleQuery ? 'No username matches this search.' : 'Share the site with a friend so they can join.'}</span></div>}
      </div>
      <div className="master-chat-list-heading master-chat-groups-heading">
        <Users size={14}/><span>GROUPS</span><small>{groups.length}</small>
        <button type="button" className="master-chat-create-group-button" onClick={openCreateGroup} title="Create a group" aria-label="Create a group"><UserPlus size={15}/></button>
      </div>
      <div className="master-chat-people master-chat-groups-list">
        {filteredGroups.map(group => <button type="button" className={'master-chat-person '+(activeGroup?.id === group.id ? 'active' : '')} key={group.id} onClick={() => {
          if (voiceRecorderRef.current || voicePreparingRef.current) { tell('Stop or cancel the voice recording before switching chats.', 'info'); return; }
          setConversationFullscreen(false); setMessages([]); setDraft(''); setActivePerson(null); setActiveGroup(group); setNotice(''); setAccountSettingsOpen(false); setGroupDialogOpen(false);
        }}>
          <span className="master-chat-avatar">{group.avatar_data ? <img src={group.avatar_data} alt=""/> : group.name.slice(0, 1).toUpperCase()}</span>
          <span className="master-chat-person-meta"><b>{group.name}</b><small>{group.member_count} members · {group.my_role === 'admin' ? 'Admin' : 'Member'}</small></span>
          {activeGroup?.id === group.id && <span className="master-chat-selected-mark"><Check size={13}/></span>}
        </button>)}
        {!filteredGroups.length && <div className="master-chat-empty-people master-chat-empty-groups"><Users size={17}/><span>{peopleQuery ? 'No group matches this search.' : 'Create a group to start chatting together.'}</span></div>}
      </div>
      <div className="master-chat-account">
        <span className="master-chat-avatar own">{isValidAvatarData(profile.avatar_data) ? <img src={profile.avatar_data} alt=""/> : profile.username.slice(0, 1).toUpperCase()}<i className="online"/></span>
        <span className="master-chat-person-meta"><b>{profile.username}</b><small><span className="master-chat-live-dot"/> {live ? 'Connected' : 'Reconnecting…'}</small></span>
        <div className="master-chat-account-actions">
          <button type="button" className="master-chat-signout" title="Account & privacy settings" aria-label="Open account and privacy settings" onClick={() => setAccountSettingsOpen(true)}><Settings2 size={16}/></button>
          <button type="button" className="master-chat-signout" title="Sign out" aria-label="Sign out of Master Chat" onClick={() => void signOut()}><LogOut size={15}/></button>
        </div>
      </div>
    </aside>
    <div className="master-chat-main">
      {!activePerson && !activeGroup ? <div className="master-chat-welcome"><div className="master-chat-orb"><MessageCircle size={28}/></div><h2>Your conversations start here.</h2><p>Choose a person for a private chat or create a group to start chatting together.</p><span><Wifi size={14}/> {live ? 'Real-time connection active' : 'Connecting to real-time service'}</span></div> : <>
        <header className="master-chat-conversation-header">
          <button className="master-chat-back" title="Back to conversations" onClick={() => {setConversationFullscreen(false);setActivePerson(null);setActiveGroup(null);setMessages([]);setDraft('');setNotice('');}}><ArrowLeft size={17}/></button>
          {activeGroup
            ? <span className="master-chat-avatar">{activeGroup.avatar_data ? <img src={activeGroup.avatar_data} alt=""/> : activeGroup.name.slice(0, 1).toUpperCase()}</span>
            : <span className="master-chat-avatar">{isValidAvatarData(activePerson?.avatar_data) ? <img src={activePerson?.avatar_data ?? ''} alt=""/> : (activePerson?.username ?? '?').slice(0, 1).toUpperCase()}<i className={activePerson && onlineIds.includes(activePerson.id) ? 'online' : ''}/></span>}
          <span className="master-chat-conversation-title"><b>{activeGroup?.name ?? activePerson?.username}</b><small>{activeGroup ? activeGroup.member_count + ' members · ' + (activeGroup.my_role === 'admin' ? 'You are an admin' : 'Group conversation') : activePerson && onlineIds.includes(activePerson.id) ? 'Online now' : 'Private conversation'}</small></span>
          <span className={'master-chat-connection '+(live ? 'connected' : '')}><i/>{live ? 'Live' : 'Reconnecting'}</span>
          {activeGroup && <button type="button" className="master-chat-group-info-button" title="Group info and members" aria-label="Group info and members" onClick={openGroupManagement}><Users size={17}/><span>Group info</span></button>}
          {iosMode && <button type="button" className="master-chat-fullscreen-toggle" title="Show messages only" aria-label="Show messages only" onClick={toggleConversationFullscreen}><Maximize2 size={17}/></button>}
        </header>
        {notice && <p className={'master-chat-inline-notice '+noticeKind} role="status">{notice}</p>}
        <div className="master-chat-privacy-context"><ShieldCheck size={14}/><span>Messages and attachments are restricted by account and group membership policies, but they are <b>not end-to-end encrypted</b>. Do not share passwords or sensitive personal information.</span></div>
        <div className="master-chat-messages">
          {!conversationMessages.length && <div className="master-chat-first-message"><span className="master-chat-orb"><MessageCircle size={21}/></span><b>{activeGroup ? 'Say hello to ' + activeGroup.name : 'Say hello to ' + (activePerson?.username ?? 'your contact')}</b><p>{activeGroup ? 'Only current group members can read this group conversation.' : 'Only the conversation participants can retrieve messages through the app.'} Message text is not end-to-end encrypted.</p></div>}
          {conversationMessages.map((message, index) => {
            const mine = message.sender_id === profile.id;
            const previous = conversationMessages[index - 1];
            const grouped = previous?.sender_id === message.sender_id && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60 * 1000;
            const messageType = message.message_type ?? 'text';
            const senderProfile = activeGroup ? (mine ? profile : people.find(person => person.id === message.sender_id)) : activePerson;
            const senderName = senderProfile?.username ?? 'Group member';
            const avatarData = senderProfile?.avatar_data ?? null;
            const attachmentUrl = message.attachment_url;
            return <div className={'master-chat-message-row '+(mine ? 'mine' : 'theirs')} key={message.id}>
              {!mine && !grouped && <span className="master-chat-tiny-avatar">{isValidAvatarData(avatarData) ? <img src={avatarData ?? ''} alt=""/> : senderName.slice(0, 1).toUpperCase()}</span>}
              <div className="master-chat-message-wrap">
                {activeGroup && !mine && <small className="master-chat-group-sender">{senderName}</small>}
                <div className="master-chat-message-content">
                  {messageType === 'text'
                    ? <div className="master-chat-bubble">{message.body}</div>
                    : messageType === 'voice'
                      ? <div className="master-chat-attachment-card master-chat-voice-card">
                          <div className="master-chat-attachment-heading"><span className="master-chat-attachment-icon"><Mic size={17}/></span><span><b>Voice message</b><small>{Math.floor((message.voice_duration_ms ?? 0) / 1000)}s · {Math.max(1, Math.round((message.attachment_size ?? 0) / 1024))} KB</small></span></div>
                          {attachmentUrl
                            ? <MasterChatVoicePlayer key={message.id} src={attachmentUrl} durationMs={message.voice_duration_ms}/>
                            : <span className="master-chat-attachment-unavailable">Preparing secure audio…</span>}
                        </div>
                      : <div className="master-chat-attachment-card">
                          {message.attachment_mime?.startsWith('image/')
                            ? attachmentUrl
                              ? <button type="button" className="master-chat-image-attachment" onClick={() => openImageViewer({url:attachmentUrl,name:message.attachment_name ?? 'Shared image',caption:message.body ?? '',messageId:message.id})} title="View image" aria-label={'View image '+(message.attachment_name ?? '')}><img src={attachmentUrl} alt={message.attachment_name ?? 'Shared image'} loading="lazy" decoding="async" onLoad={() => { if (imageViewer?.messageId === message.id) setImageViewerReady(true); }}/></button>
                              : <span className="master-chat-attachment-unavailable">Preparing secure image…</span>
                            : <a className="master-chat-file-attachment" href={attachmentUrl ?? undefined} target="_blank" rel="noreferrer" download={message.attachment_name ?? 'attachment'} onClick={event => { if (!attachmentUrl) event.preventDefault(); }}>
                                <span className="master-chat-attachment-icon"><FileText size={18}/></span>
                                <span className="master-chat-file-meta"><b>{message.attachment_name ?? 'Attachment'}</b><small>{message.attachment_mime ?? 'File'} · {Math.max(1, Math.round((message.attachment_size ?? 0) / 1024))} KB{!attachmentUrl ? ' · Preparing…' : ''}</small></span>
                                <Download size={16}/>
                              </a>}
                          {message.attachment_mime?.startsWith('image/') && message.body.trim() && <p className="master-chat-image-caption">{message.body}</p>}
                        </div>}
                  <div className="master-chat-message-actions"><button type="button" title="Hide this message for me" aria-label="Hide this message for me" disabled={messageActionId === message.id} onClick={() => void hideMessage(message)}><EyeOff size={13}/></button>{mine && <button type="button" title="Delete for everyone" aria-label="Delete this message for everyone" disabled={messageActionId === message.id} onClick={() => void deleteMessageForEveryone(message)}><Trash2 size={13}/></button>}</div>
                </div>
                <small>{shortTime(message.created_at)}{mine ? ' · You' : ''}</small>
              </div>
            </div>;
          })}
          <div ref={endRef}/>
        </div>
        <form className="master-chat-composer" onSubmit={event => void sendMessage(event)}>
          <input ref={attachmentInputRef} className="master-chat-file-input" type="file" accept="*/*" aria-label="Choose attachment (videos are not allowed)" onChange={handleAttachmentSelection}/>
          <div className="master-chat-composer-box">
            <textarea ref={inputRef} rows={1} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={activeGroup ? 'Message ' + activeGroup.name + '…' : 'Message ' + (activePerson?.username ?? '') + '…'} aria-label="Write a message" disabled={attachmentBusy}/>
            <div className="master-chat-composer-tools">
              <button type="button" className="master-chat-composer-tool" disabled={attachmentBusy || recordingVoice || voicePreparing} onClick={() => attachmentInputRef.current?.click()} title="Attach a file, image, document or code file"><Paperclip size={16}/><span>Attach</span></button>
              <button type="button" className="master-chat-composer-tool" disabled={attachmentBusy || recordingVoice || voicePreparing} onClick={() => { setPastedFileName('notes.txt'); setPastedFileContent(''); setPastedFileOpen(true); }} title="Create a file from pasted text or code"><FileText size={16}/><span>Text / code</span></button>
              <button type="button" className="master-chat-composer-tool" disabled={attachmentBusy || recordingVoice || voicePreparing || !draft.trim()} onClick={openScheduleDialog} title="Schedule this text message"><Clock3 size={16}/><span>Schedule</span></button>
              <button type="button" className={'master-chat-composer-tool'+(recordingVoice ? ' recording' : '')} disabled={attachmentBusy || voicePreparing} onClick={() => void toggleVoiceRecording()} title={recordingVoice ? 'Stop and send voice message' : voicePreparing ? 'Requesting microphone access' : 'Record a voice message'}><Mic size={16}/><span>{voicePreparing ? 'Starting…' : recordingVoice ? 'Stop & send' : 'Voice'}</span></button>
              {voicePreparing && <span className="master-chat-recording-indicator"><i/> Waiting for microphone…</span>}
              {recordingVoice && <span className="master-chat-recording-indicator"><i/> Recording · 2 min max</span>}
              {attachmentBusy && <span className="master-chat-attachment-progress"><span className="master-chat-spinner small"/> Sending…</span>}
            </div>
            <div className="master-chat-composer-footer"><small>Enter to send · Shift + Enter for a new line · {draft.length}/2000</small><button type="submit" disabled={!draft.trim() || sending || attachmentBusy} aria-label="Send message">{sending ? <span className="master-chat-spinner small"/> : <Send size={16}/>}</button></div>
          </div>
        </form>
      </>}
    </div>
    {accountSettingsOpen && <div className="master-chat-account-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget)setAccountSettingsOpen(false);}}>
      <section className="master-chat-account-modal" role="dialog" aria-modal="true" aria-labelledby="master-chat-account-title" onMouseDown={event=>event.stopPropagation()}>
        <button type="button" className="master-chat-account-modal-close" title="Close account settings" aria-label="Close account settings" onClick={()=>setAccountSettingsOpen(false)}><X size={18}/></button>
        <div className="master-chat-account-modal-heading">
          <span className="master-chat-avatar own">{isValidAvatarData(profile.avatar_data) ? <img src={profile.avatar_data} alt=""/> : profile.username.slice(0,1).toUpperCase()}</span>
          <div><p className="eyebrow">MASTER CHAT</p><h3 id="master-chat-account-title">Account &amp; privacy</h3><p>@{profile.username} · {live ? 'Connected' : 'Reconnecting'}</p></div>
        </div>
        <div className="master-chat-account-settings-section">
          <div className="master-chat-account-photo-row">
            <div className="master-chat-account-setting-copy"><ImagePlus size={18}/><span><b>Profile picture</b><small>Choose a small image to represent you.</small></span></div>
            <label className={'master-chat-account-photo-pick'+(avatarBusy?' busy':'')} title="Upload a profile picture"><span>{avatarBusy?'Saving…':'Change'}</span><input type="file" accept="image/*" aria-label="Choose profile picture" disabled={avatarBusy} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value='';void saveProfileAvatar(file);}}/></label>
            {profile.avatar_data && <button type="button" className="master-chat-account-remove-photo" title="Remove profile picture" aria-label="Remove profile picture" disabled={avatarBusy} onClick={()=>void removeProfileAvatar()}><Trash2 size={15}/></button>}
          </div>
          <div className="master-chat-account-setting-row">
            <div className="master-chat-account-setting-copy"><ShieldCheck size={18}/><span><b>Optional app PIN</b><small>{pinRecord?'PIN protection is enabled in this browser.':'No PIN is set. Master Chat remains available without one.'}</small></span></div>
            <button type="button" className="master-chat-account-action" onClick={openPinSettings}>{pinRecord?'Manage':'Set PIN'} <ChevronRight size={15}/></button>
          </div>
          {localPasskey?.userId===profile.id && localPasskey.rpId===window.location.hostname ? <div className="master-chat-account-setting-row">
            <div className="master-chat-account-setting-copy"><Fingerprint size={18}/><span><b>{localPasskey.method === 'face' ? 'Face ID preferred' : localPasskey.method === 'fingerprint' ? 'Fingerprint preferred' : 'Device passkey saved'}</b><small>Saved in this browser. Android may still request its configured screen-lock pattern/PIN.</small></span></div>
            <button type="button" className="master-chat-account-action" disabled={passkeyBusy} onClick={removeLocalPasskey}>Remove <ChevronRight size={15}/></button>
          </div> : <div className="master-chat-account-setting-row master-chat-passkey-row">
            <div className="master-chat-account-setting-copy"><Fingerprint size={18}/><span><b>Create a biometric passkey</b><small>Choose a preferred method. The operating system controls which biometric is available.</small></span></div>
            <div className="master-chat-passkey-actions">
              <button type="button" className="master-chat-passkey-choice" disabled={passkeyBusy} onClick={()=>{setPasskeyError('');setPasskeyPromptIntent({method:'face',action:'create'});}}><ShieldCheck size={15}/>Prefer Face ID</button>
              <button type="button" className="master-chat-passkey-choice" disabled={passkeyBusy} onClick={()=>{setPasskeyError('');setPasskeyPromptIntent({method:'fingerprint',action:'create'});}}><Fingerprint size={15}/>Prefer fingerprint</button>
            </div>
          </div>}
          {passkeyError && <p className="master-chat-notice error" role="alert">{passkeyError}</p>}
          <div className="master-chat-account-setting-row">
            <div className="master-chat-account-setting-copy"><LockKeyhole size={18}/><span><b>Lock this browser</b><small>{pinRecord ? 'Lock now; use your PIN or configured passkey to return.' : localPasskey && localPasskey.rpId===window.location.hostname ? 'Lock now; use your device passkey to return.' : 'Set up an optional PIN or passkey to enable the app lock.'}</small></span></div>
            <button type="button" className="master-chat-account-action" disabled={!pinRecord && !(localPasskey && localPasskey.rpId===window.location.hostname)} onClick={()=>{setAccountSettingsOpen(false);lockApp();}}>Lock now <ChevronRight size={15}/></button>
          </div>
          <div className="master-chat-account-setting-row">
            <div className="master-chat-account-setting-copy"><LockKeyhole size={18}/><span><b>System password</b><small>Change your Master Chat sign-in password. This does not change your Windows or phone password.</small></span></div>
            <button type="button" className="master-chat-account-action" onClick={openAccountPasswordSettings}>Change <ChevronRight size={15}/></button>
          </div>
        </div>
        <div className="master-chat-account-modal-actions">
          <button type="button" className="master-chat-account-signout" onClick={()=>{setAccountSettingsOpen(false);void signOut();}}><LogOut size={16}/> Sign out</button>
          <button type="button" className="master-chat-account-delete" onClick={openDeleteAccount}><Trash2 size={16}/> Delete account permanently <ChevronRight size={16}/></button>
        </div>
        <p className="master-chat-account-modal-note"><ShieldCheck size={14}/> Important: "Prefer Face ID" and "Prefer fingerprint" tell Master Chat your preference only. The browser and operating system choose the actual verification method, and websites cannot block Android's screen-lock pattern/PIN fallback. Master Chat now asks for confirmation before opening the system prompt, so cancel when you require biometric-only verification. Removing this browser link does not delete a credential from the device's passkey manager.</p>
      </section>
    </div>}
    {passwordChangeOpen && <div className="master-chat-feature-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget && !accountPasswordBusy)setPasswordChangeOpen(false);}}>
      <form className="master-chat-feature-modal master-chat-account-password-modal" onSubmit={changeAccountPassword} role="dialog" aria-modal="true" aria-labelledby="master-chat-system-password-title">
        <button type="button" className="master-chat-account-modal-close" title="Close password settings" aria-label="Close password settings" disabled={accountPasswordBusy} onClick={() => setPasswordChangeOpen(false)}><X size={18}/></button>
        <span className="master-chat-pin-icon"><LockKeyhole size={22}/></span>
        <p className="eyebrow">ACCOUNT SECURITY</p>
        <h3 id="master-chat-system-password-title">Change system password</h3>
        <p>This changes your Master Chat account password used to sign in. A website cannot change or read your Windows, Android, or device unlock password.</p>
        <label>Current password<input autoComplete="current-password" type="password" minLength={8} value={accountCurrentPassword} onChange={event=>setAccountCurrentPassword(event.target.value)} required/></label>
        <label>New password<input autoComplete="new-password" type="password" minLength={8} value={accountNewPassword} onChange={event=>setAccountNewPassword(event.target.value)} required/></label>
        <label>Confirm new password<input autoComplete="new-password" type="password" minLength={8} value={accountConfirmPassword} onChange={event=>setAccountConfirmPassword(event.target.value)} required/></label>
        {accountPasswordError && <p className="master-chat-notice error" role="alert">{accountPasswordError}</p>}
        <div className="master-chat-feature-modal-actions"><button className="master-chat-primary" type="submit" disabled={accountPasswordBusy}>{accountPasswordBusy?'Changing password…':'Update password'}</button><button className="secondary-button" type="button" disabled={accountPasswordBusy} onClick={()=>setPasswordChangeOpen(false)}>Cancel</button></div>
      </form>
    </div>}
    {pastedFileOpen && <div className="master-chat-feature-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget)setPastedFileOpen(false);}}>
      <form className="master-chat-feature-modal master-chat-pasted-file-modal" onSubmit={sendPastedTextFile} role="dialog" aria-modal="true" aria-labelledby="master-chat-pasted-file-title">
        <button type="button" className="master-chat-account-modal-close" title="Close pasted file" aria-label="Close pasted file" onClick={()=>setPastedFileOpen(false)}><X size={18}/></button>
        <span className="master-chat-pin-icon"><FileText size={22}/></span>
        <p className="eyebrow">ATTACHMENT</p>
        <h3 id="master-chat-pasted-file-title">Send pasted text or code</h3>
        <p>Paste text or source code, give the file a name, and send it as a private attachment. Videos are not accepted.</p>
        <label>File name<input value={pastedFileName} maxLength={180} onChange={event=>setPastedFileName(event.target.value)} placeholder="notes.txt" required/></label>
        <label>Text or code<textarea className="master-chat-code-textarea" rows={9} value={pastedFileContent} onChange={event=>setPastedFileContent(event.target.value)} placeholder="Paste your notes, code, configuration, or text here…" required/></label>
        <div className="master-chat-feature-modal-actions"><button className="master-chat-primary" type="submit" disabled={!pastedFileContent.trim() || attachmentBusy}>Send file</button><button className="secondary-button" type="button" onClick={()=>setPastedFileOpen(false)}>Cancel</button></div>
      </form>
    </div>}
    {scheduleDialogOpen && <div className="master-chat-feature-modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setScheduleDialogOpen(false);}}>
      <form className="master-chat-feature-modal master-chat-schedule-modal" onSubmit={submitScheduledMessage} role="dialog" aria-modal="true" aria-labelledby="master-chat-schedule-title">
        <button type="button" className="master-chat-account-modal-close" title="Close scheduler" aria-label="Close scheduler" onClick={()=>setScheduleDialogOpen(false)}><X size={18}/></button>
        <span className="master-chat-pin-icon"><Clock3 size={22}/></span>
        <p className="eyebrow">MASTER CHAT · SCHEDULE</p>
        <h3 id="master-chat-schedule-title">Schedule message</h3>
        <p>To: <b>{activeGroup ? activeGroup.name + ' (group)' : '@' + (activePerson?.username ?? '')}</b></p>
        <div className="master-chat-scheduled-preview"><small>Message preview</small><p>{draft.trim()}</p></div>
        <label>Send date and time<input type="datetime-local" value={scheduleAt} min={asLocalDateTimeInput(new Date(Date.now()+30000))} onChange={event=>setScheduleAt(event.target.value)} required/></label>
        {scheduleError && <p className="master-chat-notice error" role="alert">{scheduleError}</p>}
        <div className="master-chat-feature-modal-actions"><button type="submit" className="master-chat-primary">Schedule message</button><button type="button" className="secondary-button" onClick={()=>setScheduleDialogOpen(false)}>Cancel</button></div>
        <section className="master-chat-scheduled-list"><b>Pending scheduled messages for this conversation</b>{scheduledMessages.filter(item=>item.user_id===profile?.id && (activeGroup ? item.group_id===activeGroup.id : !item.group_id && item.recipient_id===activePerson?.id)).length ? scheduledMessages.filter(item=>item.user_id===profile?.id && (activeGroup ? item.group_id===activeGroup.id : !item.group_id && item.recipient_id===activePerson?.id)).sort((a,b)=>Date.parse(a.send_at)-Date.parse(b.send_at)).map(item=><div className="master-chat-scheduled-item" key={item.id}><span><small>{new Date(item.send_at).toLocaleString()}</small><span>{item.body}</span></span><button type="button" className="master-chat-scheduled-cancel" onClick={()=>cancelScheduledMessage(item.id)}>Cancel</button></div>) : <small>No messages scheduled for this conversation.</small>}</section>
        <p className="hint">The schedule is stored on this device. Keep AeroShell open and signed in for on-time delivery. If the site is closed or offline at the selected time, it will attempt to send the overdue message when you return and sign in.</p>
      </form>
    </div>}
    {groupDialogOpen && <div className="master-chat-feature-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget && !groupBusy)setGroupDialogOpen(false);}}>
      <section className="master-chat-feature-modal master-chat-group-modal" role="dialog" aria-modal="true" aria-labelledby="master-chat-group-dialog-title">
        <button type="button" className="master-chat-account-modal-close" title="Close group details" aria-label="Close group details" disabled={groupBusy} onClick={()=>setGroupDialogOpen(false)}><X size={18}/></button>
        <div className="master-chat-group-dialog-heading">
          <span className="master-chat-group-avatar-preview">{groupAvatarDraft ? <img src={groupAvatarDraft} alt="Group picture preview"/> : <Users size={22}/>}</span>
          <div><p className="eyebrow">MASTER CHAT · GROUPS</p><h3 id="master-chat-group-dialog-title">{groupDialogMode==='create'?'Create a group':'Group info & members'}</h3><p>{groupDialogMode==='create'?'Choose a name, picture, and first members.':'Manage the group, membership, and admin roles.'}</p></div>
        </div>
        <form onSubmit={saveGroupDialog}>
          <label>Group name<input value={groupNameDraft} maxLength={60} disabled={groupDialogMode==='manage' && activeGroup?.my_role!=='admin'} onChange={event=>setGroupNameDraft(event.target.value)} placeholder="e.g. Weekend crew" required/></label>
          <div className="master-chat-group-picture-row">
            <span><b>Group picture</b><small>Optional · compressed before upload</small></span>
            <label className="master-chat-account-photo-pick"><span>{groupAvatarDraft?'Change picture':'Add picture'}</span><input type="file" accept="image/*" aria-label="Choose group picture" disabled={groupBusy || (groupDialogMode==='manage' && activeGroup?.my_role!=='admin')} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value='';void handleGroupAvatarSelection(file);}}/></label>
            {groupAvatarDraft && <button type="button" className="master-chat-account-remove-photo" title="Remove group picture" onClick={()=>setGroupAvatarDraft(null)} disabled={groupBusy || (groupDialogMode==='manage' && activeGroup?.my_role!=='admin')}><Trash2 size={15}/></button>}
          </div>
          {groupDialogMode==='create' ? <>
            <div className="master-chat-group-section-heading"><b>Add members</b><small>{groupMemberSelection.length} selected · up to 100 members total</small></div>
            <div className="master-chat-group-select-list">
              {people.map(person=><label className="master-chat-group-select-member" key={person.id}>
                <input type="checkbox" checked={groupMemberSelection.includes(person.id)} onChange={()=>toggleGroupMemberSelection(person.id)} disabled={groupBusy || (!groupMemberSelection.includes(person.id) && groupMemberSelection.length>=99)}/>
                <span className="master-chat-group-mini-avatar">{isValidAvatarData(person.avatar_data) ? <img src={person.avatar_data ?? ''} alt=""/> : person.username.slice(0,1).toUpperCase()}</span><span><b>{person.username}</b><small>Master Chat member</small></span>
              </label>)}
              {!people.length && <p className="master-chat-group-empty">Other members will appear here when they create Master Chat accounts.</p>}
            </div>
          </> : <>
            <div className="master-chat-group-section-heading"><b>Members · {groupMembers.length}</b><small>{activeGroup?.my_role==='admin'?'You can promote members to admin.':'Only admins can manage this group.'}</small></div>
            <div className="master-chat-group-roster">
              {groupMembers.map(member=><div className="master-chat-group-roster-row" key={member.user_id}>
                <span className="master-chat-group-mini-avatar">{isValidAvatarData(member.avatar_data) ? <img src={member.avatar_data ?? ''} alt=""/> : member.username.slice(0,1).toUpperCase()}</span>
                <span className="master-chat-group-roster-name"><b>{member.username}{member.user_id===profile.id?' (you)':''}</b><small>{member.role==='admin'?'Group admin':'Member'}</small></span>
                {activeGroup?.my_role==='admin' && <div className="master-chat-group-roster-actions">
                  <button type="button" className="master-chat-group-small-action" disabled={groupBusy} onClick={()=>void changeGroupMemberRole(member)}>{member.role==='admin'?'Demote':'Make admin'}</button>
                  {member.user_id!==profile.id && <button type="button" className="master-chat-group-remove-member" title={'Remove '+member.username} aria-label={'Remove '+member.username} disabled={groupBusy} onClick={()=>void removeGroupMember(member)}><X size={14}/></button>}
                </div>}
              </div>)}
            </div>
            {activeGroup?.my_role==='admin' && <>
              <div className="master-chat-group-section-heading"><b>Add more members</b><small>Only people not already in the group</small></div>
              <div className="master-chat-group-select-list">
                {people.filter(person=>!groupMembers.some(member=>member.user_id===person.id)).map(person=><label className="master-chat-group-select-member" key={person.id}>
                  <input type="checkbox" checked={groupMemberSelection.includes(person.id)} onChange={()=>toggleGroupMemberSelection(person.id)} disabled={groupBusy || (!groupMemberSelection.includes(person.id) && groupMemberSelection.length>=99-groupMembers.length)}/>
                  <span className="master-chat-group-mini-avatar">{isValidAvatarData(person.avatar_data) ? <img src={person.avatar_data ?? ''} alt=""/> : person.username.slice(0,1).toUpperCase()}</span><span><b>{person.username}</b><small>Available to add</small></span>
                </label>)}
              </div>
              <button type="button" className="master-chat-group-add-members" disabled={groupBusy || !groupMemberSelection.length} onClick={()=>void addSelectedGroupMembers()}>{groupBusy?'Working…':'Add selected members'}</button>
            </>}
          </>}
          {groupError && <p className="master-chat-notice error" role="alert">{groupError}</p>}
          <div className="master-chat-feature-modal-actions">
            {groupDialogMode==='create'
              ? <button type="submit" className="master-chat-primary" disabled={groupBusy || !groupNameDraft.trim()}>{groupBusy?'Creating…':'Create group'}</button>
              : activeGroup?.my_role==='admin'
                ? <button type="submit" className="master-chat-primary" disabled={groupBusy || !groupNameDraft.trim()}>{groupBusy?'Saving…':'Save group details'}</button>
                : null}
            {groupDialogMode==='manage' && <button type="button" className="secondary-button" disabled={groupBusy} onClick={()=>void leaveActiveGroup()}>Leave group</button>}
            {groupDialogMode==='manage' && activeGroup?.created_by===profile.id && <button type="button" className="master-chat-delete-cancel" disabled={groupBusy} onClick={()=>void deleteActiveGroup()}>Delete group</button>}
            <button type="button" className="secondary-button" disabled={groupBusy} onClick={()=>setGroupDialogOpen(false)}>Close</button>
          </div>
        </form>
      </section>
    </div>}
    {deleteAccountStep > 0 && <div className="master-chat-delete-account-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)cancelDeleteAccount();}}>
      <section className="master-chat-delete-account-modal" role="dialog" aria-modal="true" aria-labelledby="master-chat-delete-title" onMouseDown={event=>event.stopPropagation()}>
        <button type="button" className="master-chat-account-modal-close" title="Cancel deletion" aria-label="Cancel account deletion" disabled={deleteAccountBusy} onClick={cancelDeleteAccount}><X size={18}/></button>
        <span className="master-chat-delete-account-icon"><AlertTriangle size={24}/></span>
        {deleteAccountStep===1 ? <>
          <p className="eyebrow">WARNING 1 OF 2</p>
          <h3 id="master-chat-delete-title">Delete your Master Chat account?</h3>
          <p className="master-chat-delete-account-intro">This permanently removes your Master Chat account and its cloud data. This is not the same as signing out.</p>
          <ul className="master-chat-delete-list">
            <li>Your username and profile picture will be removed.</li>
            <li>Your messages and call records will be deleted for all participants.</li>
            <li>The deleted account cannot be restored. You can create a new account later, but old data will not return.</li>
          </ul>
          <p className="master-chat-delete-scope">Only Master Chat account data is affected. Your AeroShell desktop, iOS mode, and other local simulator data are not deleted.</p>
          {deleteAccountError && <p className="master-chat-notice error" role="alert">{deleteAccountError}</p>}
          <div className="master-chat-delete-actions"><button type="button" className="master-chat-delete-cancel" onClick={cancelDeleteAccount}>Keep my account</button><button type="button" className="master-chat-account-delete-primary" onClick={()=>{setDeleteAccountError('');setDeleteAccountStep(2);}}>Continue to final warning <ChevronRight size={16}/></button></div>
        </> : <>
          <p className="eyebrow">WARNING 2 OF 2 · FINAL CONFIRMATION</p>
          <h3 id="master-chat-delete-title">This action cannot be undone.</h3>
          <p className="master-chat-delete-account-intro">This will permanently delete <b>@{profile.username}</b> — the account signed in right now — and all Master Chat data linked to it. Only this authenticated account can be deleted; this action cannot delete another member's account.</p>
          <label className="master-chat-delete-confirm-label">Type <code>DELETE</code> to confirm
            <input autoFocus autoComplete="off" spellCheck={false} value={deleteAccountText} onChange={event=>{setDeleteAccountText(event.target.value);setDeleteAccountError('');}} placeholder="Type DELETE" aria-label="Type DELETE to confirm account deletion" />
          </label>
          {deleteAccountError && <p className="master-chat-notice error" role="alert">{deleteAccountError}</p>}
          <div className="master-chat-delete-actions"><button type="button" className="master-chat-delete-cancel" disabled={deleteAccountBusy} onClick={cancelDeleteAccount}>Cancel</button><button type="button" className="master-chat-account-delete-primary" disabled={deleteAccountBusy || deleteAccountText!=='DELETE'} onClick={()=>void permanentlyDeleteAccount()}>{deleteAccountBusy?<><span className="master-chat-spinner small"/> Deleting…</>:<>Permanently delete account <Trash2 size={16}/></>}</button></div>
          <p className="master-chat-delete-final-note">This is the second and final warning. There is no undo.</p>
        </>}
      </section>
    </div>}
    {pinChangeOpen && <div className="master-chat-pin-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget)setPinChangeOpen(false);}}>
      <form className="master-chat-pin-modal" onSubmit={changeLocalPin} aria-label="Change local app PIN">
        <button type="button" className="master-chat-pin-close" title="Close PIN settings" onClick={() => setPinChangeOpen(false)}><X size={18}/></button>
        <span className="master-chat-pin-icon"><ShieldCheck size={23}/></span><h3>Privacy &amp; app PIN</h3>
        <p>Creating a four-digit PIN is optional. If you cancel, you can keep using Master Chat without one and set it later here. The PIN is separate from your account password and does not encrypt online message content.</p>
        {pinRecord && <label>Current PIN<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinCurrentValue} onChange={event=>setPinCurrentValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>}
        <label>{pinRecord?'New four-digit PIN':'Create four-digit PIN'}<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinNewValue} onChange={event=>setPinNewValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>
        <label>Confirm new PIN<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinNewConfirmValue} onChange={event=>setPinNewConfirmValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>
        {pinChangeError && <p className="master-chat-notice error" role="alert">{pinChangeError}</p>}
        <div className="master-chat-pin-modal-actions"><button className="master-chat-primary" type="submit" disabled={pinChangeBusy}>{pinChangeBusy?'Saving…':pinRecord?'Change PIN':'Set PIN'}</button>{pinRecord && <button type="button" className="danger-button" disabled={pinChangeBusy} onClick={() => void removeLocalPin()}>{pinChangeBusy?'Working…':'Remove PIN'}</button>}<button type="button" className="secondary-button" onClick={()=>setPinChangeOpen(false)}>Cancel</button></div>
        </form>
    </div>}
    {passkeyPreflightModal}
    {pendingImage && createPortal(
      <div className="master-chat-image-compose-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)cancelPendingImage();}}>
        <section className="master-chat-image-compose" role="dialog" aria-modal="true" aria-labelledby="master-chat-image-compose-title">
          <header><div><b id="master-chat-image-compose-title">Send image</b><small>{pendingImage.file.name}</small></div><button type="button" title="Cancel image" aria-label="Cancel image" onClick={cancelPendingImage}><X size={19}/></button></header>
          <div className="master-chat-image-compose-preview"><img src={pendingImage.previewUrl} alt="Image ready to send" decoding="async"/></div>
          <label className="master-chat-image-compose-caption"><span>Caption (optional)</span><textarea autoFocus rows={3} maxLength={2000} value={imageCaption} onChange={event=>setImageCaption(event.target.value)} placeholder="Write a message under your picture…"/></label>
          <div className="master-chat-image-compose-actions"><button type="button" className="secondary-button" disabled={attachmentBusy} onClick={cancelPendingImage}>Cancel</button><button type="button" className="master-chat-primary" disabled={attachmentBusy} onClick={()=>void sendPendingImage()}>{attachmentBusy?<><span className="master-chat-spinner small"/> Sending…</>:<><Send size={15}/> Send image</>}</button></div>
        </section>
      </div>,
      document.body
    )}
    {imageViewer && createPortal(
      <div className="master-chat-image-viewer-backdrop" role="dialog" aria-modal="true" aria-label="Shared image viewer" onMouseDown={event=>{if(event.target===event.currentTarget)setImageViewer(null);}}>
        <section className="master-chat-image-viewer">
          <header className="master-chat-image-viewer-header">
            <div><b>{imageViewer.name}</b><small>{imageViewer.caption.trim()?'Image with caption':'Shared image'}</small></div>
            <div className="master-chat-image-viewer-actions">
              <button type="button" title="Copy image" aria-label="Copy image to clipboard" disabled={imageActionBusy} onClick={()=>void copyImageFromViewer()}><Copy size={17}/><span>{imageActionBusy?'Working…':'Copy image'}</span></button>
              <button type="button" title="Download image" aria-label="Download image" disabled={imageActionBusy} onClick={()=>void downloadImageFromViewer()}><Download size={17}/><span>Download</span></button>
              <button type="button" title="Close image viewer" aria-label="Close image viewer" onClick={()=>setImageViewer(null)}><X size={19}/></button>
            </div>
          </header>
          <div className={'master-chat-image-viewer-stage'+(imageViewerReady?' ready':'')}>
            {!imageViewerReady && !imageViewerError && <div className="master-chat-image-viewer-loading"><span className="master-chat-spinner"/><b>Opening image…</b></div>}
            {imageViewerError && <div className="master-chat-image-viewer-loading"><b>Image couldn't be loaded</b><span>Reopen the conversation and try again.</span></div>}
            <img src={imageViewer.url} alt={imageViewer.name} decoding="async" fetchPriority="high" onLoad={()=>{setImageViewerReady(true);setImageViewerError(false);}} onError={()=>{setImageViewerError(true);setImageViewerReady(false);}}/>
          </div>
          {imageViewer.caption.trim() && <p className="master-chat-image-viewer-caption">{imageViewer.caption}</p>}
        </section>
      </div>,
      document.body
    )}
  </section>;
}
