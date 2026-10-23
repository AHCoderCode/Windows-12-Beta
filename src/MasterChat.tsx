import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createClient, type RealtimeChannel, type Session } from '@supabase/supabase-js';
import { ArrowLeft, Check, CircleHelp, LockKeyhole, LogIn, MessageCircle, MoreHorizontal, Search, Send, ShieldCheck, UserPlus, Users, Wifi, WifiOff } from 'lucide-react';

type ChatProfile = { id: string; username: string };
type ChatMessage = { id: string; sender_id: string; recipient_id: string; body: string; created_at: string };
type AuthMode = 'signin' | 'signup';

const supabaseClient = (() => {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
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
const sameConversation = (message: ChatMessage, userId: string, peerId: string) =>
  (message.sender_id === userId && message.recipient_id === peerId) ||
  (message.sender_id === peerId && message.recipient_id === userId);

export function MasterChat() {
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
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const tell = (text: string, kind: 'error' | 'success' | 'info' = 'info') => {
    setNotice(text);
    setNoticeKind(kind);
  };

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from('aeroshell_profiles').select('id, username').eq('id', userId).maybeSingle();
    if (error) {
      tell('Could not load your profile. Check that the Master Chat SQL setup was applied.', 'error');
      return;
    }
    setProfile(data as ChatProfile | null);
  }, []);

  const loadPeople = useCallback(async (userId: string) => {
    if (!supabaseClient) return;
    const { data, error } = await supabaseClient.from('aeroshell_profiles').select('id, username')
      .neq('id', userId).order('username', { ascending: true }).limit(200);
    if (error) {
      tell('Member directory is unavailable. Check the database policies and setup SQL.', 'error');
      return;
    }
    setPeople((data ?? []) as ChatProfile[]);
  }, []);

  useEffect(() => {
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
  }, [loadPeople, loadProfile]);

  useEffect(() => {
    if (!supabaseClient || !session || !profile) return;
    let channel: RealtimeChannel | null = null;
    channel = supabaseClient.channel('aeroshell-master-chat-presence', { config: { presence: { key: profile.id }, private: true } });
    channel.on('presence', { event: 'sync' }, () => {
      const entries = Object.values(channel?.presenceState<{ user_id: string }>() ?? {}).flat();
      setOnlineIds(Array.from(new Set(entries.map(entry => entry.user_id).filter(Boolean))));
      void loadPeople(profile.id);
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
  }, [session, profile]);

  useEffect(() => {
    if (!supabaseClient || !session || !profile || !activePerson) {
      setMessages([]);
      return;
    }
    let mounted = true;
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
      setMessages(current => {
        const byId = new Map(current.map(message => [message.id, message]));
        for (const message of (data ?? []) as ChatMessage[]) byId.set(message.id, message);
        return [...byId.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 30);
    };
    void loadConversation();
    const channel = supabaseClient.channel('aeroshell-conversation-' + profile.id + '-' + activePerson.id, { config: { private: true } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'aeroshell_messages' }, payload => {
        const incoming = payload.new as ChatMessage;
        if (!mounted || !sameConversation(incoming, profile.id, activePerson.id)) return;
        setMessages(current => {
          if (current.some(message => message.id === incoming.id)) return current;
          return [...current, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at));
        });
        window.setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 25);
      }).subscribe();
    return () => {
      mounted = false;
      void supabaseClient?.removeChannel(channel);
    };
  }, [session, profile, activePerson]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  const filteredPeople = useMemo(() => {
    const query = peopleQuery.trim().toLowerCase();
    return people.filter(person => !query || person.username.toLowerCase().includes(query));
  }, [people, peopleQuery]);

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

  if (!supabaseClient) {
    return <section className="master-chat-setup">
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

  if (booting) return <div className="master-chat-loading"><span className="master-chat-spinner"/><b>Connecting to Master Chat…</b><small>Restoring your session securely</small></div>;

  if (!session || !profile) {
    return <section className="master-chat-auth">
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

  return <section className="master-chat-app">
    <aside className="master-chat-sidebar">
      <div className="master-chat-brand"><span className="master-chat-brand-icon"><MessageCircle size={20}/></span><span><b>Master Chat</b><small>Talk to your people</small></span><button className="master-chat-icon-button" title="Refresh member list" onClick={() => void loadPeople(profile.id)}><MoreHorizontal size={18}/></button></div>
      <label className="master-chat-search"><Search size={15}/><input value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} placeholder="Find a username"/></label>
      <div className="master-chat-list-heading"><Users size={14}/><span>PEOPLE</span><small>{filteredPeople.length}</small></div>
      <div className="master-chat-people">
        {filteredPeople.map(person => <button className={'master-chat-person '+(activePerson?.id === person.id ? 'active' : '')} key={person.id} onClick={() => { setActivePerson(person); setNotice(''); }}>
          <span className="master-chat-avatar">{person.username.slice(0, 1).toUpperCase()}<i className={onlineIds.includes(person.id) ? 'online' : ''}/></span>
          <span className="master-chat-person-meta"><b>{person.username}</b><small>{onlineIds.includes(person.id) ? 'Online now' : 'Master Chat member'}</small></span>
          {activePerson?.id === person.id && <span className="master-chat-selected-mark"><Check size={13}/></span>}
        </button>)}
        {!filteredPeople.length && <div className="master-chat-empty-people"><Users size={20}/><b>No other members yet</b><span>{peopleQuery ? 'No username matches this search.' : 'Share the site with a friend so they can join.'}</span></div>}
      </div>
      <div className="master-chat-account"><span className="master-chat-avatar own">{profile.username.slice(0, 1).toUpperCase()}<i className="online"/></span><span className="master-chat-person-meta"><b>{profile.username}</b><small><span className="master-chat-live-dot"/> {live ? 'Connected' : 'Reconnecting…'}</small></span><button className="master-chat-signout" title="Sign out" onClick={() => void signOut()}><LockKeyhole size={15}/></button></div>
    </aside>
    <div className="master-chat-main">
      {!activePerson ? <div className="master-chat-welcome"><div className="master-chat-orb"><MessageCircle size={28}/></div><h2>Your conversations start here.</h2><p>Choose someone from the people list to open a private conversation. New members appear as they join.</p><span><Wifi size={14}/> {live ? 'Real-time connection active' : 'Connecting to real-time service'}</span></div> : <>
        <header className="master-chat-conversation-header"><button className="master-chat-back" title="Back to people" onClick={() => setActivePerson(null)}><ArrowLeft size={17}/></button><span className="master-chat-avatar">{activePerson.username.slice(0, 1).toUpperCase()}<i className={onlineIds.includes(activePerson.id) ? 'online' : ''}/></span><span><b>{activePerson.username}</b><small>{onlineIds.includes(activePerson.id) ? 'Online now' : 'Private conversation'}</small></span><span className={'master-chat-connection '+(live ? 'connected' : '')}><i/>{live ? 'Live' : 'Reconnecting'}</span></header>
        {notice && <p className={'master-chat-inline-notice '+noticeKind} role="status">{notice}</p>}
        <div className="master-chat-messages">
          {!messages.length && <div className="master-chat-first-message"><span className="master-chat-orb"><MessageCircle size={21}/></span><b>Say hello to {activePerson.username}</b><p>This conversation is private to these two accounts.</p></div>}
          {messages.map((message, index) => {
            const mine = message.sender_id === profile.id;
            const previous = messages[index - 1];
            const grouped = previous?.sender_id === message.sender_id && new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < 5 * 60 * 1000;
            return <div className={'master-chat-message-row '+(mine ? 'mine' : 'theirs')} key={message.id}>
              {!mine && !grouped && <span className="master-chat-tiny-avatar">{activePerson.username.slice(0, 1).toUpperCase()}</span>}
              <div className="master-chat-message-wrap"><div className="master-chat-bubble">{message.body}</div><small>{shortTime(message.created_at)}{mine ? ' · You' : ''}</small></div>
            </div>;
          })}
          <div ref={endRef}/>
        </div>
        <form className="master-chat-composer" onSubmit={event => void sendMessage(event)}>
          <div className="master-chat-composer-box"><textarea ref={inputRef} rows={1} maxLength={2000} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onComposerKeyDown} placeholder={'Message '+activePerson.username+'…'} aria-label="Write a message"/><div className="master-chat-composer-footer"><small>Enter to send · Shift + Enter for a new line · {draft.length}/2000</small><button type="submit" disabled={!draft.trim() || sending} aria-label="Send message">{sending ? <span className="master-chat-spinner small"/> : <Send size={16}/>}</button></div></div>
        </form>
      </>}
    </div>
  </section>;
}
