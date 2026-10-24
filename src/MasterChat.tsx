import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createClient, type RealtimeChannel, type Session } from '@supabase/supabase-js';
import { AlertTriangle, ArrowLeft, Check, CircleHelp, EyeOff, ImagePlus, LockKeyhole, LogIn, Maximize2, MessageCircle, Minimize2, MoreHorizontal, Search, Send, ShieldCheck, Trash2, UserPlus, Users, Wifi, WifiOff, X } from 'lucide-react';
import { isValidAvatarData, MAX_PROFILE_AVATAR_DATA_LENGTH } from './profile-avatar-utils';
import { MasterChatVoiceCalls } from './MasterChatVoiceCalls';
import { getConversationMessages, isConversationMessage, mergeConversationMessages } from './master-chat-utils';

type ChatProfile = { id: string; username: string; avatar_data?: string | null };
type ChatMessage = { id: string; sender_id: string; recipient_id: string; body: string; created_at: string };
type AuthMode = 'signin' | 'signup';
type PinRecord = { version: 1; salt: string; verifier: string };
const PIN_STORAGE_KEY = 'aeroshell.master-chat.local-pin.v1';
const PIN_THROTTLE_KEY = 'aeroshell.master-chat.pin-throttle.v1';

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

const validUsername = (value: string) => /^[a-zA-Z0-9_]{3,20}$/.test(value);
const usernameEmail = (username: string) => username.toLowerCase() + '@aeroshell.invalid';
const shortTime = (value: string) => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });


function MasterChatExitButton({ onClose, className = 'master-chat-close-app' }: { onClose?: () => void; className?: string }) {
  if (!onClose) return null;
  return <button type="button" className={className} title="Close Master Chat" aria-label="Close Master Chat" onClick={onClose}><X size={18}/></button>;
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
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
  const [pinCooldownUntil, setPinCooldownUntil] = useState(0);
  const [pinNow, setPinNow] = useState(Date.now());
  const [pinChangeOpen, setPinChangeOpen] = useState(false);
  const [pinCurrentValue, setPinCurrentValue] = useState('');
  const [pinNewValue, setPinNewValue] = useState('');
  const [pinNewConfirmValue, setPinNewConfirmValue] = useState('');
  const [pinChangeError, setPinChangeError] = useState('');
  const [pinChangeBusy, setPinChangeBusy] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [messageActionId, setMessageActionId] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const lockAppRef = useRef<() => void>(() => undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tell = (text: string, kind: 'error' | 'success' | 'info' = 'info') => {
    setNotice(text);
    setNoticeKind(kind);
  };

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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PIN_STORAGE_KEY);
      if (!raw) {
        // Master Chat works without a PIN; enabling one is optional.
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
      }
      if (active) setBooting(false);
    });
    const { data: listener } = supabaseClient.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setPeople([]);
        setActivePerson(null);
        setMessages([]);
        setOnlineIds([]);
        setLive(false);
        setBooting(false);
      } else {
        window.setTimeout(() => {
          void loadProfile(next.user.id);
          void loadPeople(next.user.id);
          setBooting(false);
        }, 0);
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [loadPeople, loadProfile, pinUnlocked]);

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
      if (activePerson?.id === changed.id) setActivePerson(current => current ? { ...current, ...changed } : current);
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
  }, [session, profile, pinUnlocked]);

  useEffect(() => {
    if (!pinUnlocked || !supabaseClient || !session || !profile || !activePerson) {
      setMessages([]);
      return;
    }
    let mounted = true;
    // Keep the state scoped to this pair while loading; the render also filters defensively.
    setMessages(current => getConversationMessages(current, profile.id, activePerson.id));
    const loadConversation = async () => {
      const filter = 'and(sender_id.eq.' + profile.id + ',recipient_id.eq.' + activePerson.id + '),and(sender_id.eq.' + activePerson.id + ',recipient_id.eq.' + profile.id + ')';
      const { data, error } = await supabaseClient.from('aeroshell_messages')
        .select('id, sender_id, recipient_id, body, created_at').or(filter)
        .order('created_at', { ascending: true }).limit(500);
      if (!mounted) return;
      if (error) {
        tell('Could not load this conversation. Confirm the message-table policies are installed.', 'error');
        return;
      }
      setMessages(current => mergeConversationMessages(current, (data ?? []) as ChatMessage[], profile.id, activePerson.id));
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 30);
    };
    void loadConversation();
    const channel = supabaseClient.channel('aeroshell-conversation-' + profile.id + '-' + activePerson.id, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_messages' }, payload => {
        const incoming = payload.new as ChatMessage;
        if (!mounted || !isConversationMessage(incoming, profile.id, activePerson.id)) return;
        setMessages(current => {
          if (current.some(message => message.id === incoming.id)) return current;
          return [...current, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at));
        });
        window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 25);
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
      void supabaseClient?.removeChannel(channel);
    };
  }, [session, profile, activePerson, pinUnlocked]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const filteredPeople = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    return people.filter(person => !query || person.username.toLowerCase().includes(query));
  }, [people, peopleQuery]);

  // Never render cached messages unless both endpoints match the active conversation.
  const conversationMessages = useMemo(
    () => profile && activePerson ? getConversationMessages(messages, profile.id, activePerson.id) : [],
    [messages, profile, activePerson],
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
    if (!supabaseClient || !profile || !activePerson || !body || sending) return;
    if (body.length > 2000) {
      tell('Messages can be up to 2,000 characters.', 'error');
      return;
    }
    setSending(true);
    try {
      const { data, error } = await supabaseClient.from('aeroshell_messages')
        .insert({ sender_id: profile.id, recipient_id: activePerson.id, body })
        .select('id, sender_id, recipient_id, body, created_at').single();
      if (error) tell('Message did not send. Check your connection and database policies.', 'error');
      else if (data) {
        setDraft('');
        setMessages(current => current.some(message => message.id === data.id) ? current : [...current, data as ChatMessage]);
        tell('Message sent.', 'success');
        inputRef.current?.focus();
      }
    } catch {
      tell('Message did not send because the connection was interrupted. Please try again.', 'error');
    } finally {
      setSending(false);
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
        tell('Message deleted for everyone.', 'success');
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
      tell('The local PIN was reset. Master Chat is now open without a PIN.', 'info');
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
      tell(pinRecord ? 'This browser’s Master Chat PIN has been changed.' : 'Optional Master Chat PIN enabled.', 'success');
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
      if (!/^\d{4}$/.test(pinCurrentValue)) {
        setPinChangeError('Enter the current four-digit PIN to remove it.');
        return;
      }
      const candidate = await derivePinVerifier(pinCurrentValue, pinRecord.salt);
      if (!sameHex(candidate, pinRecord.verifier)) {
        setPinChangeError('The current PIN is incorrect.');
        return;
      }
      localStorage.removeItem(PIN_STORAGE_KEY);
      localStorage.removeItem(PIN_THROTTLE_KEY);
      setPinRecord(null);
      setPinMode('off');
      setPinUnlocked(true);
      setPinCurrentValue('');
      setPinNewValue('');
      setPinNewConfirmValue('');
      setPinChangeOpen(false);
      clearPinFailures();
      tell('The optional Master Chat PIN has been removed.', 'success');
    } catch (error) {
      setPinChangeError(error instanceof Error ? error.message : 'Could not remove the local PIN.');
    } finally {
      setPinChangeBusy(false);
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
    if (!iosMode || !activePerson) return;
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
    if (iosMode && activePerson && pinUnlocked) return;
    setConversationFullscreen(false);
    if (chatRootRef.current && document.fullscreenElement === chatRootRef.current) {
      nativeChatFullscreenRef.current = false;
      void document.exitFullscreen().catch(() => undefined);
    }
  }, [iosMode, activePerson, pinUnlocked]);

  const lockApp = () => {
    if (!pinRecord) {
      tell('A Master Chat PIN is optional. Set one in Privacy & app PIN before using the app lock.', 'info');
      return;
    }
    setConversationFullscreen(false);
    setPinUnlocked(false);
    setPinMode('unlock');
    setPinInput('');
    setPinConfirm('');
    setActivePerson(null);
    setMessages([]);
    setDraft('');
    setPinChangeOpen(false);
  };
  lockAppRef.current = lockApp;

  useEffect(() => {
    if (!pinUnlocked || !pinRecord) return;
    let timer = window.setTimeout(() => lockAppRef.current(), 5 * 60 * 1000);
    const resetTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => lockAppRef.current(), 5 * 60 * 1000);
    };
    const lockWhenHidden = () => {
      if (document.visibilityState === 'hidden') lockAppRef.current();
    };
    document.addEventListener('pointerdown', resetTimer, true);
    document.addEventListener('keydown', resetTimer, true);
    document.addEventListener('touchstart', resetTimer, { capture: true, passive: true });
    document.addEventListener('visibilitychange', lockWhenHidden);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', resetTimer, true);
      document.removeEventListener('keydown', resetTimer, true);
      document.removeEventListener('touchstart', resetTimer, true);
      document.removeEventListener('visibilitychange', lockWhenHidden);
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
    const { error } = await supabaseClient.auth.signOut();
    if (error) tell('Could not sign out. Please try again.', 'error');
    else {
      setActivePerson(null);
      setMessages([]);
      setPassword('');
      tell('You have signed out.', 'success');
    }
  };

  if (pinMode === 'loading') {
    return <section className="master-chat-pin-screen" aria-live="polite">
      <MasterChatExitButton onClose={onClose}/>
      <div className="master-chat-pin-card"><span className="master-chat-pin-icon"><LockKeyhole size={25}/></span><h2>Master Chat is locked</h2><p>Preparing your local app lock…</p></div>
    </section>;
  }

  if (!pinUnlocked) {
    const isSetup = pinMode === 'setup';
    const isRepair = pinMode === 'repair';
    const cooldownSeconds = Math.max(0, Math.ceil((pinCooldownUntil - pinNow) / 1000));
    return <section className="master-chat-pin-screen">
      <MasterChatExitButton onClose={onClose}/>
      <form className="master-chat-pin-card" onSubmit={submitPin}>
        <span className="master-chat-pin-icon"><LockKeyhole size={25}/></span>
        <p className="eyebrow">AEROSHELL · LOCAL APP LOCK</p>
        <h2>{isSetup ? 'Create your 4-digit PIN' : isRepair ? 'Local PIN needs repair' : 'Unlock Master Chat'}</h2>
        <p>{isSetup ? 'This PIN is separate from your Master Chat account password and is stored only in this browser.' : isRepair ? 'The local PIN could not be read. Repairing it only resets this browser lock, not your online account.' : 'Enter the four digits to open the messaging app.'}</p>
        {!isRepair && <>
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
        {!isRepair && <button className="master-chat-primary" disabled={pinBusy || (cooldownSeconds > 0 && !isSetup)} type="submit">{pinBusy ? 'Checking…' : isSetup ? 'Save PIN and continue' : 'Unlock messages'}</button>}
        {isRepair && <button type="button" className="master-chat-primary" onClick={resetLocalPin}>Reset this browser’s app PIN</button>}
        <div className="master-chat-pin-disclaimer"><ShieldCheck size={15}/><span>Privacy note: this is a browser-level lock, not end-to-end encryption. Someone with full access to this browser profile or developer tools may bypass it. Clearing site data can reset the local lock.</span></div>
      </form>
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

  return <section ref={chatRootRef} className={'master-chat-app'+(conversationFullscreen ? ' master-chat-conversation-fullscreen' : '')}>
    <MasterChatVoiceCalls client={supabaseClient} profile={profile} people={people} activePerson={activePerson} enabled={pinUnlocked && !!session} showCallLauncher={showCallLauncher}/>
    {conversationFullscreen && <><button type="button" className="master-chat-fullscreen-exit" title="Exit messages-only fullscreen" aria-label="Exit messages-only fullscreen" onClick={toggleConversationFullscreen}><Minimize2 size={18}/></button><MasterChatExitButton onClose={onClose} className="master-chat-fullscreen-close"/></>}
    <aside className="master-chat-sidebar">
      <div className="master-chat-brand"><span className="master-chat-brand-icon"><MessageCircle size={20}/></span><span><b>Master Chat</b><small>Talk to your people</small></span><button className="master-chat-icon-button" title="Refresh member list" onClick={() => void loadPeople(profile.id)}><MoreHorizontal size={18}/></button>{onClose && <button type="button" className="master-chat-icon-button master-chat-inline-close" title="Close Master Chat" aria-label="Close Master Chat" onClick={onClose}><X size={18}/></button>}</div>
      <label className="master-chat-search"><Search size={15}/><input value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} placeholder="Find a username"/></label>
      <div className="master-chat-list-heading"><Users size={14}/><span>PEOPLE</span><small>{filteredPeople.length}</small></div>
      <div className="master-chat-people">
        {filteredPeople.map(person => <button className={'master-chat-person '+(activePerson?.id === person.id ? 'active' : '')} key={person.id} onClick={() => { setConversationFullscreen(false); setMessages([]); setActivePerson(person); setNotice(''); }}>
          <span className="master-chat-avatar">{isValidAvatarData(person.avatar_data) ? <img src={person.avatar_data} alt=""/> : person.username.slice(0, 1).toUpperCase()}<i className={onlineIds.includes(person.id) ? 'online' : ''}/></span>
          <span className="master-chat-person-meta"><b>{person.username}</b><small>{onlineIds.includes(person.id) ? 'Online now' : 'Master Chat member'}</small></span>
          {activePerson?.id === person.id && <span className="master-chat-selected-mark"><Check size={13}/></span>}
        </button>)}
        {!filteredPeople.length && <div className="master-chat-empty-people"><Users size={20}/><b>No other members yet</b><span>{peopleQuery ? 'No username matches this search.' : 'Share the site with a friend so they can join.'}</span></div>}
      </div>
      <div className="master-chat-account"><span className="master-chat-avatar own">{isValidAvatarData(profile.avatar_data) ? <img src={profile.avatar_data} alt=""/> : profile.username.slice(0, 1).toUpperCase()}<i className="online"/></span><span className="master-chat-person-meta"><b>{profile.username}</b><small><span className="master-chat-live-dot"/> {live ? 'Connected' : 'Reconnecting…'}</small></span><div className="master-chat-account-actions"><label className={'master-chat-signout master-chat-avatar-change'+(avatarBusy?' busy':'')} title={avatarBusy?'Saving profile picture…':'Change profile picture'} aria-label="Change profile picture"><ImagePlus size={15}/><input type="file" accept="image/*" aria-label="Choose profile picture" disabled={avatarBusy} onChange={event=>{const file=event.currentTarget.files?.[0]??null;event.currentTarget.value='';void saveProfileAvatar(file);}}/></label>{profile.avatar_data && <button type="button" className="master-chat-signout" title="Remove profile picture" aria-label="Remove profile picture" disabled={avatarBusy} onClick={()=>void removeProfileAvatar()}><Trash2 size={14}/></button>}<button className="master-chat-signout" title={pinRecord?'Lock Master Chat':'Lock unavailable until you set an optional PIN'} onClick={lockApp}><LockKeyhole size={15}/></button><button className="master-chat-signout" title={pinRecord?'Change Master Chat PIN':'Set optional Master Chat PIN'} onClick={() => {setPinChangeOpen(true);setPinChangeError('');setPinCurrentValue('');setPinNewValue('');setPinNewConfirmValue('');}}><ShieldCheck size={15}/></button><button className="master-chat-signout" title="Sign out" onClick={() => void signOut()}><LogIn size={15}/></button></div></div>
    </aside>
    <div className="master-chat-main">
      {!activePerson ? <div className="master-chat-welcome"><div className="master-chat-orb"><MessageCircle size={28}/></div><h2>Your conversations start here.</h2><p>Choose someone from the people list to open a private conversation. New members appear as they join.</p><span><Wifi size={14}/> {live ? 'Real-time connection active' : 'Connecting to real-time service'}</span></div> : <>
        <header className="master-chat-conversation-header"><button className="master-chat-back" title="Back to people" onClick={() => {setConversationFullscreen(false);setActivePerson(null);}}><ArrowLeft size={17}/></button><span className="master-chat-avatar">{isValidAvatarData(activePerson.avatar_data) ? <img src={activePerson.avatar_data} alt=""/> : activePerson.username.slice(0, 1).toUpperCase()}<i className={onlineIds.includes(activePerson.id) ? 'online' : ''}/></span><span><b>{activePerson.username}</b><small>{onlineIds.includes(activePerson.id) ? 'Online now' : 'Private conversation'}</small></span><span className={'master-chat-connection '+(live ? 'connected' : '')}><i/>{live ? 'Live' : 'Reconnecting'}</span>{iosMode && <button type="button" className="master-chat-fullscreen-toggle" title="Show messages only" aria-label="Show messages only" onClick={toggleConversationFullscreen}><Maximize2 size={17}/></button>}</header>
        {notice && <p className={'master-chat-inline-notice '+noticeKind} role="status">{notice}</p>}
        <div className="master-chat-privacy-context"><ShieldCheck size={14}/><span>Access is restricted by database policies, but text messages are <b>not end-to-end encrypted</b>. Do not share passwords or sensitive personal information.</span></div>
        <div className="master-chat-messages">
          {!conversationMessages.length && <div className="master-chat-first-message"><span className="master-chat-orb"><MessageCircle size={21}/></span><b>Say hello to {activePerson.username}</b><p>Only the conversation participants can retrieve messages through the app. Message text is not end-to-end encrypted.</p></div>}
          {conversationMessages.map((message, index) => {
            const mine = message.sender_id === profile.id;
            const previous = conversationMessages[index - 1];
            const grouped = previous?.sender_id === message.sender_id && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60 * 1000;
            return <div className={'master-chat-message-row '+(mine ? 'mine' : 'theirs')} key={message.id}>
              {!mine && !grouped && <span className="master-chat-tiny-avatar">{isValidAvatarData(activePerson.avatar_data) ? <img src={activePerson.avatar_data} alt=""/> : activePerson.username.slice(0, 1).toUpperCase()}</span>}
              <div className="master-chat-message-wrap"><div className="master-chat-message-content"><div className="master-chat-bubble">{message.body}</div><div className="master-chat-message-actions"><button type="button" title="Hide this message for me" aria-label="Hide this message for me" disabled={messageActionId === message.id} onClick={() => void hideMessage(message)}><EyeOff size={13}/></button>{mine && <button type="button" title="Delete for everyone" aria-label="Delete this message for everyone" disabled={messageActionId === message.id} onClick={() => void deleteMessageForEveryone(message)}><Trash2 size={13}/></button>}</div></div><small>{shortTime(message.created_at)}{mine ? ' · You' : ''}</small></div>
            </div>;
          })}
          <div ref={endRef}/>
        </div>
        <form className="master-chat-composer" onSubmit={event => void sendMessage(event)}>
          <div className="master-chat-composer-box"><textarea ref={inputRef} rows={1} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={'Message '+activePerson.username+'…'} aria-label="Write a message"/><div className="master-chat-composer-footer"><small>Enter to send · Shift + Enter for a new line · {draft.length}/2000</small><button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">{sending ? <span className="master-chat-spinner small"/> : <Send size={16}/>}</button></div></div>
        </form>
      </>}
    </div>
    {pinChangeOpen && <div className="master-chat-pin-modal-backdrop" role="presentation" onMouseDown={event => {if(event.target===event.currentTarget)setPinChangeOpen(false);}}>
      <form className="master-chat-pin-modal" onSubmit={changeLocalPin} aria-label="Change local app PIN">
        <button type="button" className="master-chat-pin-close" title="Close PIN settings" onClick={() => setPinChangeOpen(false)}><X size={18}/></button>
        <span className="master-chat-pin-icon"><ShieldCheck size={23}/></span><h3>Privacy &amp; app PIN</h3>
        <p>The PIN is optional and protects this browser’s Master Chat screen only. It does not encrypt online message content. Cancel or close this panel to continue without a PIN.</p>
        {pinRecord && <label>Current PIN<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinCurrentValue} onChange={event=>setPinCurrentValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>}
        <label>{pinRecord?'New four-digit PIN':'Create four-digit PIN'}<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinNewValue} onChange={event=>setPinNewValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>
        <label>Confirm new PIN<input inputMode="numeric" type="password" autoComplete="off" maxLength={4} pattern="[0-9]{4}" value={pinNewConfirmValue} onChange={event=>setPinNewConfirmValue(event.target.value.replace(/\D/g,'').slice(0,4))} required/></label>
        {pinChangeError && <p className="master-chat-notice error" role="alert">{pinChangeError}</p>}
        <div className="master-chat-pin-modal-actions"><button className="master-chat-primary" type="submit" disabled={pinChangeBusy}>{pinChangeBusy?'Saving…':pinRecord?'Change PIN':'Set PIN'}</button><button type="button" className="secondary-button" onClick={()=>setPinChangeOpen(false)}>Cancel</button></div>
        {pinRecord && <button type="button" className="danger-button" disabled={pinChangeBusy} onClick={()=>void removeLocalPin()}>Remove PIN</button>
      </form>
    </div>}
  </section>;
}
