-- AeroShell Master Chat: Supabase schema
-- Run once in Supabase Dashboard > SQL Editor for the project used by Master Chat.
-- Then disable email confirmation in Authentication > Sign In / Providers > Email,
-- because this username-only beta uses non-deliverable app identities for Supabase Auth.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.aeroshell_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now(),
  constraint aeroshell_profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$')
);

create table if not exists public.aeroshell_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.aeroshell_profiles (id) on delete cascade,
  recipient_id uuid not null references public.aeroshell_profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint aeroshell_no_self_message check (sender_id <> recipient_id)
);

create index if not exists aeroshell_messages_sender_created_idx on public.aeroshell_messages (sender_id, created_at desc);
create index if not exists aeroshell_messages_recipient_created_idx on public.aeroshell_messages (recipient_id, created_at desc);

alter table public.aeroshell_profiles enable row level security;
alter table public.aeroshell_messages enable row level security;

grant usage on schema public to authenticated;
grant select on public.aeroshell_profiles to authenticated;
grant select, insert on public.aeroshell_messages to authenticated;

drop policy if exists "Authenticated users can discover profiles" on public.aeroshell_profiles;
create policy "Authenticated users can discover profiles" on public.aeroshell_profiles for select to authenticated using (true);

drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages" on public.aeroshell_messages for select to authenticated using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id);

drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check ((select auth.uid()) = sender_id and (select auth.uid()) <> recipient_id and char_length(btrim(body)) between 1 and 2000);

create or replace function public.aeroshell_create_master_chat_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requested_username text;
begin
  if new.raw_user_meta_data ->> 'aeroshell_chat' is distinct from 'true' then return new; end if;
  requested_username := lower(trim(new.raw_user_meta_data ->> 'username'));
  if requested_username is null or requested_username !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'Username must be 3–20 letters, numbers or underscores.';
  end if;
  insert into public.aeroshell_profiles (id, username) values (new.id, requested_username);
  return new;
end;
$$;

-- The SECURITY DEFINER helper is only intended to run from its auth.users trigger.
-- Prevent direct invocation through the database API by client roles.
revoke all on function public.aeroshell_create_master_chat_profile() from public, anon, authenticated;

drop trigger if exists aeroshell_auth_user_profile on auth.users;
create trigger aeroshell_auth_user_profile after insert on auth.users
for each row execute function public.aeroshell_create_master_chat_profile();

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_messages') then
    alter publication supabase_realtime add table public.aeroshell_messages;
  end if;
end;
$$;

-- Private Realtime presence is restricted to authenticated chat accounts.
drop policy if exists "Authenticated users can access the Master Chat presence channel" on realtime.messages;
drop policy if exists "Authenticated users can read the Master Chat presence channel" on realtime.messages;
drop policy if exists "Authenticated users can publish to the Master Chat presence channel" on realtime.messages;
create policy "Authenticated users can read the Master Chat presence channel"
  on realtime.messages for select to authenticated
  using (
    (select realtime.topic()) = 'aeroshell-master-chat-presence'
    and realtime.messages.extension = 'presence'
  );
create policy "Authenticated users can publish to the Master Chat presence channel"
  on realtime.messages for insert to authenticated
  with check (
    (select realtime.topic()) = 'aeroshell-master-chat-presence'
    and realtime.messages.extension = 'presence'
  );

-- Private direct-message change channels may only use a topic containing the signed-in user's UUID.
-- The underlying message-table RLS policy still limits each payload to its sender/recipient.
drop policy if exists "Authenticated users can access their Master Chat conversation channels" on realtime.messages;
create policy "Authenticated users can access their Master Chat conversation channels"
  on realtime.messages for select to authenticated
  using (
    (select realtime.topic()) like 'aeroshell-conversation-' || (select auth.uid())::text || '-%'
    or (select realtime.topic()) like 'aeroshell-conversation-%-' || (select auth.uid())::text
  );

-- Never put the Supabase service-role/secret key in browser code.


-- ===== supabase/migrations/20261023202000_master_chat_privacy_and_voice_calls.sql =====
-- Master Chat privacy controls, per-user message hiding, sender deletion, and voice signaling.
-- Additive migration: existing profiles and messages remain intact.

create table if not exists public.aeroshell_message_hides (
  message_id uuid not null references public.aeroshell_messages(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists aeroshell_message_hides_user_idx on public.aeroshell_message_hides(user_id, message_id);
alter table public.aeroshell_message_hides enable row level security;
grant select, insert on public.aeroshell_message_hides to authenticated;

drop policy if exists "Users can read their own message hides" on public.aeroshell_message_hides;
create policy "Users can read their own message hides"
on public.aeroshell_message_hides for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can hide messages only for themselves" on public.aeroshell_message_hides;
create policy "Users can hide messages only for themselves"
on public.aeroshell_message_hides for insert to authenticated
with check ((select auth.uid()) = user_id);

create or replace function public.aeroshell_validate_message_hide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or new.user_id is distinct from (select auth.uid()) then
    raise exception 'A user may hide messages only for themselves.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.aeroshell_messages m
    where m.id = new.message_id
      and (m.sender_id = (select auth.uid()) or m.recipient_id = (select auth.uid()))
  ) then
    raise exception 'Message not found or not accessible to this user.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_validate_message_hide() from public, anon, authenticated;
drop trigger if exists aeroshell_validate_message_hide_before_insert on public.aeroshell_message_hides;
create trigger aeroshell_validate_message_hide_before_insert
before insert on public.aeroshell_message_hides
for each row execute function public.aeroshell_validate_message_hide();

-- A hidden message becomes unreadable to that user through the Data API, not merely hidden in the UI.
drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages"
on public.aeroshell_messages for select to authenticated
using (
  ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id)
  and not exists (
    select 1
    from public.aeroshell_message_hides h
    where h.message_id = aeroshell_messages.id
      and h.user_id = (select auth.uid())
  )
);

grant delete on public.aeroshell_messages to authenticated;
drop policy if exists "Senders can delete their own messages for everyone" on public.aeroshell_messages;
create policy "Senders can delete their own messages for everyone"
on public.aeroshell_messages for delete to authenticated
using ((select auth.uid()) = sender_id);

create table if not exists public.aeroshell_calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  callee_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'rejected', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aeroshell_calls_no_self_call check (caller_id <> callee_id)
);
create index if not exists aeroshell_calls_caller_created_idx on public.aeroshell_calls(caller_id, created_at desc);
create index if not exists aeroshell_calls_callee_created_idx on public.aeroshell_calls(callee_id, created_at desc);
create index if not exists aeroshell_calls_active_status_idx on public.aeroshell_calls(status, created_at desc) where status in ('ringing', 'accepted');
alter table public.aeroshell_calls enable row level security;
grant select on public.aeroshell_calls to authenticated;
grant insert (caller_id, callee_id) on public.aeroshell_calls to authenticated;
grant update (status) on public.aeroshell_calls to authenticated;

drop policy if exists "Participants can read their own calls" on public.aeroshell_calls;
create policy "Participants can read their own calls"
on public.aeroshell_calls for select to authenticated
using ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id);

drop policy if exists "Users can create calls as themselves" on public.aeroshell_calls;
create policy "Users can create calls as themselves"
on public.aeroshell_calls for insert to authenticated
with check (
  (select auth.uid()) = caller_id
  and caller_id <> callee_id
  and status = 'ringing'
);

drop policy if exists "Participants can change call status" on public.aeroshell_calls;
create policy "Participants can change call status"
on public.aeroshell_calls for update to authenticated
using ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
with check (
  ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
  and status in ('ringing', 'accepted', 'rejected', 'ended')
);

create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_call_transition_before_write on public.aeroshell_calls;
create trigger aeroshell_guard_call_transition_before_write
before insert or update on public.aeroshell_calls
for each row execute function public.aeroshell_guard_call_transition();

create table if not exists public.aeroshell_call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.aeroshell_calls(id) on delete cascade,
  from_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  to_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  kind text not null check (kind in ('offer', 'answer', 'ice')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  created_at timestamptz not null default now(),
  constraint aeroshell_call_signals_no_self_signal check (from_user_id <> to_user_id)
);
create index if not exists aeroshell_call_signals_inbox_idx on public.aeroshell_call_signals(to_user_id, created_at);
create index if not exists aeroshell_call_signals_call_idx on public.aeroshell_call_signals(call_id, created_at);
alter table public.aeroshell_call_signals enable row level security;
grant select, insert on public.aeroshell_call_signals to authenticated;

drop policy if exists "Call participants can read signaling for their call" on public.aeroshell_call_signals;
create policy "Call participants can read signaling for their call"
on public.aeroshell_call_signals for select to authenticated
using (
  exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and ((select auth.uid()) = c.caller_id or (select auth.uid()) = c.callee_id)
  )
  and ((select auth.uid()) = from_user_id or (select auth.uid()) = to_user_id)
);

drop policy if exists "Participants can send signaling only to the other participant" on public.aeroshell_call_signals;
create policy "Participants can send signaling only to the other participant"
on public.aeroshell_call_signals for insert to authenticated
with check (
  (select auth.uid()) = from_user_id
  and from_user_id <> to_user_id
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and c.status in ('ringing', 'accepted')
      and (
        (c.caller_id = (select auth.uid()) and c.callee_id = aeroshell_call_signals.to_user_id)
        or (c.callee_id = (select auth.uid()) and c.caller_id = aeroshell_call_signals.to_user_id)
      )
      and (
        aeroshell_call_signals.kind = 'ice'
        or (aeroshell_call_signals.kind = 'offer' and c.caller_id = (select auth.uid()))
        or (aeroshell_call_signals.kind = 'answer' and c.callee_id = (select auth.uid()) and c.status = 'accepted')
      )
  )
);

create or replace function public.aeroshell_cleanup_call_signals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('rejected', 'ended') and old.status is distinct from new.status then
    delete from public.aeroshell_call_signals where call_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_cleanup_call_signals() from public, anon, authenticated;
drop trigger if exists aeroshell_cleanup_call_signals_after_call_end on public.aeroshell_calls;
create trigger aeroshell_cleanup_call_signals_after_call_end
after update of status on public.aeroshell_calls
for each row execute function public.aeroshell_cleanup_call_signals();

-- The static private channel carries only the notification transport. Call and signal rows remain RLS-protected.
drop policy if exists "Authenticated users can access Master Chat call signaling channel" on realtime.messages;
create policy "Authenticated users can access Master Chat call signaling channel"
on realtime.messages for select to authenticated
using ((select realtime.topic()) = 'aeroshell-master-chat-calls');

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_calls') then
    alter publication supabase_realtime add table public.aeroshell_calls;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_call_signals') then
    alter publication supabase_realtime add table public.aeroshell_call_signals;
  end if;
end;
$$;


-- ===== supabase/migrations/20261023203000_master_chat_turn_limits_and_stale_call_cleanup.sql =====
-- Rate-limit private TURN credential issuance at the database boundary.
create table if not exists public.aeroshell_turn_credential_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  call_id uuid not null references public.aeroshell_calls(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists aeroshell_turn_requests_user_created_idx
  on public.aeroshell_turn_credential_requests(user_id, created_at desc);
alter table public.aeroshell_turn_credential_requests enable row level security;
revoke insert, select, update, delete on public.aeroshell_turn_credential_requests from public, anon, authenticated;
grant insert (user_id, call_id) on public.aeroshell_turn_credential_requests to authenticated;

drop policy if exists "Participants can request relay credentials for an active call" on public.aeroshell_turn_credential_requests;
create policy "Participants can request relay credentials for an active call"
on public.aeroshell_turn_credential_requests for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_turn_credential_requests.call_id
      and c.status in ('ringing', 'accepted')
      and (c.caller_id = (select auth.uid()) or c.callee_id = (select auth.uid()))
      and (c.status <> 'ringing' or c.created_at > clock_timestamp() - interval '45 seconds')
  )
);

create or replace function public.aeroshell_guard_turn_credential_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_requests integer;
begin
  if actor is null or new.user_id is distinct from actor then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  if not exists (
    select 1 from public.aeroshell_calls c
    where c.id = new.call_id
      and c.status in ('ringing', 'accepted')
      and (c.caller_id = actor or c.callee_id = actor)
      and (c.status <> 'ringing' or c.created_at > clock_timestamp() - interval '45 seconds')
  ) then
    raise exception 'No active call permits relay credentials.' using errcode = '42501';
  end if;

  select count(*) into recent_requests
  from public.aeroshell_turn_credential_requests r
  where r.user_id = actor
    and r.created_at > clock_timestamp() - interval '1 minute';
  if recent_requests >= 8 then
    raise exception 'Too many relay credential requests. Try again shortly.' using errcode = '54000';
  end if;

  delete from public.aeroshell_turn_credential_requests
  where created_at < clock_timestamp() - interval '1 day';
  return new;
end;
$$;
revoke all on function public.aeroshell_guard_turn_credential_request() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_turn_credential_request_before_insert on public.aeroshell_turn_credential_requests;
create trigger aeroshell_guard_turn_credential_request_before_insert
before insert on public.aeroshell_turn_credential_requests
for each row execute function public.aeroshell_guard_turn_credential_request();

-- Expire stale call rows when a participant starts another call. Realtime can otherwise leave
-- a ringing row forever if a browser closes without sending a final state update.
create or replace function public.aeroshell_expire_stale_calls(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_user is distinct from (select auth.uid()) then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;

  perform set_config('aeroshell.internal_call_cleanup', 'on', true);
  update public.aeroshell_calls c
  set status = 'ended', updated_at = clock_timestamp()
  where (c.caller_id = p_user or c.callee_id = p_user)
    and (
      (c.status = 'ringing' and c.created_at < clock_timestamp() - interval '60 seconds')
      or (c.status = 'accepted' and c.updated_at < clock_timestamp() - interval '2 hours')
    );
  perform set_config('aeroshell.internal_call_cleanup', 'off', true);
end;
$$;
revoke all on function public.aeroshell_expire_stale_calls(uuid) from public, anon, authenticated;

create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;

-- Keep the TURN function's two foreign-key lookups indexed.
create index if not exists aeroshell_call_signals_from_user_idx
  on public.aeroshell_call_signals(from_user_id, created_at);
create index if not exists aeroshell_turn_requests_call_created_idx
  on public.aeroshell_turn_credential_requests(call_id, created_at desc);


-- ===== supabase/migrations/20261023203500_master_chat_missing_foreign_key_indexes.sql =====
-- Cover foreign-key lookups used by call signaling and TURN quotas.
create index if not exists aeroshell_call_signals_from_user_idx
  on public.aeroshell_call_signals(from_user_id, created_at);
create index if not exists aeroshell_turn_requests_call_created_idx
  on public.aeroshell_turn_credential_requests(call_id, created_at desc);


-- ===== supabase/migrations/20261023204000_master_chat_realtime_and_race_hardening.sql =====
-- Realtime sync for per-user message hides and concurrency/rate-limit hardening.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_message_hides'
  ) then
    alter publication supabase_realtime add table public.aeroshell_message_hides;
  end if;
end;
$$;

-- Serialize simultaneous call starts per account and do not refresh stale-call age on no-op updates.
create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;

-- Reject forged or cross-call signals and cap signaling spam at a server-enforced limit.
create or replace function public.aeroshell_guard_call_signal_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_signals integer;
begin
  if actor is null or new.from_user_id is distinct from actor then
    raise exception 'Call signals must be sent by the signed-in user.' using errcode = '42501';
  end if;
  if jsonb_typeof(new.payload) <> 'object' or pg_column_size(new.payload) > 8192 then
    raise exception 'Invalid call signal payload.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 2));

  if not exists (
    select 1 from public.aeroshell_calls c
    where c.id = new.call_id
      and c.status in ('ringing', 'accepted')
      and (
        (c.caller_id = actor and c.callee_id = new.to_user_id)
        or (c.callee_id = actor and c.caller_id = new.to_user_id)
      )
      and (
        new.kind = 'ice'
        or (new.kind = 'offer' and c.caller_id = actor)
        or (new.kind = 'answer' and c.callee_id = actor and c.status = 'accepted')
      )
  ) then
    raise exception 'Signal is not permitted for this call state.' using errcode = '42501';
  end if;

  select count(*) into recent_signals
  from public.aeroshell_call_signals s
  where s.from_user_id = actor and s.created_at > clock_timestamp() - interval '1 minute';
  if recent_signals >= 200 then
    raise exception 'Too many call signals. Wait before continuing.' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_guard_call_signal_insert() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_call_signal_before_insert on public.aeroshell_call_signals;
create trigger aeroshell_guard_call_signal_before_insert
before insert on public.aeroshell_call_signals
for each row execute function public.aeroshell_guard_call_signal_insert();


-- ===== supabase/migrations/20261023202000_master_chat_privacy_and_voice_calls.sql =====
-- Master Chat privacy controls, per-user message hiding, sender deletion, and voice signaling.
-- Additive migration: existing profiles and messages remain intact.

create table if not exists public.aeroshell_message_hides (
  message_id uuid not null references public.aeroshell_messages(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists aeroshell_message_hides_user_idx on public.aeroshell_message_hides(user_id, message_id);
alter table public.aeroshell_message_hides enable row level security;
grant select, insert on public.aeroshell_message_hides to authenticated;

drop policy if exists "Users can read their own message hides" on public.aeroshell_message_hides;
create policy "Users can read their own message hides"
on public.aeroshell_message_hides for select to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can hide messages only for themselves" on public.aeroshell_message_hides;
create policy "Users can hide messages only for themselves"
on public.aeroshell_message_hides for insert to authenticated
with check ((select auth.uid()) = user_id);

create or replace function public.aeroshell_validate_message_hide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or new.user_id is distinct from (select auth.uid()) then
    raise exception 'A user may hide messages only for themselves.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.aeroshell_messages m
    where m.id = new.message_id
      and (m.sender_id = (select auth.uid()) or m.recipient_id = (select auth.uid()))
  ) then
    raise exception 'Message not found or not accessible to this user.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_validate_message_hide() from public, anon, authenticated;
drop trigger if exists aeroshell_validate_message_hide_before_insert on public.aeroshell_message_hides;
create trigger aeroshell_validate_message_hide_before_insert
before insert on public.aeroshell_message_hides
for each row execute function public.aeroshell_validate_message_hide();

-- A hidden message becomes unreadable to that user through the Data API, not merely hidden in the UI.
drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages"
on public.aeroshell_messages for select to authenticated
using (
  ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id)
  and not exists (
    select 1
    from public.aeroshell_message_hides h
    where h.message_id = aeroshell_messages.id
      and h.user_id = (select auth.uid())
  )
);

grant delete on public.aeroshell_messages to authenticated;
drop policy if exists "Senders can delete their own messages for everyone" on public.aeroshell_messages;
create policy "Senders can delete their own messages for everyone"
on public.aeroshell_messages for delete to authenticated
using ((select auth.uid()) = sender_id);

create table if not exists public.aeroshell_calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  callee_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  status text not null default 'ringing' check (status in ('ringing', 'accepted', 'rejected', 'ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aeroshell_calls_no_self_call check (caller_id <> callee_id)
);
create index if not exists aeroshell_calls_caller_created_idx on public.aeroshell_calls(caller_id, created_at desc);
create index if not exists aeroshell_calls_callee_created_idx on public.aeroshell_calls(callee_id, created_at desc);
create index if not exists aeroshell_calls_active_status_idx on public.aeroshell_calls(status, created_at desc) where status in ('ringing', 'accepted');
alter table public.aeroshell_calls enable row level security;
grant select on public.aeroshell_calls to authenticated;
grant insert (caller_id, callee_id) on public.aeroshell_calls to authenticated;
grant update (status) on public.aeroshell_calls to authenticated;

drop policy if exists "Participants can read their own calls" on public.aeroshell_calls;
create policy "Participants can read their own calls"
on public.aeroshell_calls for select to authenticated
using ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id);

drop policy if exists "Users can create calls as themselves" on public.aeroshell_calls;
create policy "Users can create calls as themselves"
on public.aeroshell_calls for insert to authenticated
with check (
  (select auth.uid()) = caller_id
  and caller_id <> callee_id
  and status = 'ringing'
);

drop policy if exists "Participants can change call status" on public.aeroshell_calls;
create policy "Participants can change call status"
on public.aeroshell_calls for update to authenticated
using ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
with check (
  ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
  and status in ('ringing', 'accepted', 'rejected', 'ended')
);

create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_call_transition_before_write on public.aeroshell_calls;
create trigger aeroshell_guard_call_transition_before_write
before insert or update on public.aeroshell_calls
for each row execute function public.aeroshell_guard_call_transition();

create table if not exists public.aeroshell_call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.aeroshell_calls(id) on delete cascade,
  from_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  to_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  kind text not null check (kind in ('offer', 'answer', 'ice')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  created_at timestamptz not null default now(),
  constraint aeroshell_call_signals_no_self_signal check (from_user_id <> to_user_id)
);
create index if not exists aeroshell_call_signals_inbox_idx on public.aeroshell_call_signals(to_user_id, created_at);
create index if not exists aeroshell_call_signals_call_idx on public.aeroshell_call_signals(call_id, created_at);
alter table public.aeroshell_call_signals enable row level security;
grant select, insert on public.aeroshell_call_signals to authenticated;

drop policy if exists "Call participants can read signaling for their call" on public.aeroshell_call_signals;
create policy "Call participants can read signaling for their call"
on public.aeroshell_call_signals for select to authenticated
using (
  exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and ((select auth.uid()) = c.caller_id or (select auth.uid()) = c.callee_id)
  )
  and ((select auth.uid()) = from_user_id or (select auth.uid()) = to_user_id)
);

drop policy if exists "Participants can send signaling only to the other participant" on public.aeroshell_call_signals;
create policy "Participants can send signaling only to the other participant"
on public.aeroshell_call_signals for insert to authenticated
with check (
  (select auth.uid()) = from_user_id
  and from_user_id <> to_user_id
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and c.status in ('ringing', 'accepted')
      and (
        (c.caller_id = (select auth.uid()) and c.callee_id = aeroshell_call_signals.to_user_id)
        or (c.callee_id = (select auth.uid()) and c.caller_id = aeroshell_call_signals.to_user_id)
      )
      and (
        aeroshell_call_signals.kind = 'ice'
        or (aeroshell_call_signals.kind = 'offer' and c.caller_id = (select auth.uid()))
        or (aeroshell_call_signals.kind = 'answer' and c.callee_id = (select auth.uid()) and c.status = 'accepted')
      )
  )
);

create or replace function public.aeroshell_cleanup_call_signals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('rejected', 'ended') and old.status is distinct from new.status then
    delete from public.aeroshell_call_signals where call_id = new.id;
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_cleanup_call_signals() from public, anon, authenticated;
drop trigger if exists aeroshell_cleanup_call_signals_after_call_end on public.aeroshell_calls;
create trigger aeroshell_cleanup_call_signals_after_call_end
after update of status on public.aeroshell_calls
for each row execute function public.aeroshell_cleanup_call_signals();

-- The static private channel carries only the notification transport. Call and signal rows remain RLS-protected.
drop policy if exists "Authenticated users can access Master Chat call signaling channel" on realtime.messages;
create policy "Authenticated users can access Master Chat call signaling channel"
on realtime.messages for select to authenticated
using ((select realtime.topic()) = 'aeroshell-master-chat-calls');

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_calls') then
    alter publication supabase_realtime add table public.aeroshell_calls;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_call_signals') then
    alter publication supabase_realtime add table public.aeroshell_call_signals;
  end if;
end;
$$;


-- ===== supabase/migrations/20261023203000_master_chat_turn_limits_and_stale_call_cleanup.sql =====
-- Rate-limit private TURN credential issuance at the database boundary.
create table if not exists public.aeroshell_turn_credential_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  call_id uuid not null references public.aeroshell_calls(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists aeroshell_turn_requests_user_created_idx
  on public.aeroshell_turn_credential_requests(user_id, created_at desc);
alter table public.aeroshell_turn_credential_requests enable row level security;
revoke insert, select, update, delete on public.aeroshell_turn_credential_requests from public, anon, authenticated;
grant insert (user_id, call_id) on public.aeroshell_turn_credential_requests to authenticated;

drop policy if exists "Participants can request relay credentials for an active call" on public.aeroshell_turn_credential_requests;
create policy "Participants can request relay credentials for an active call"
on public.aeroshell_turn_credential_requests for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_turn_credential_requests.call_id
      and c.status in ('ringing', 'accepted')
      and (c.caller_id = (select auth.uid()) or c.callee_id = (select auth.uid()))
      and (c.status <> 'ringing' or c.created_at > clock_timestamp() - interval '45 seconds')
  )
);

create or replace function public.aeroshell_guard_turn_credential_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_requests integer;
begin
  if actor is null or new.user_id is distinct from actor then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));

  if not exists (
    select 1 from public.aeroshell_calls c
    where c.id = new.call_id
      and c.status in ('ringing', 'accepted')
      and (c.caller_id = actor or c.callee_id = actor)
      and (c.status <> 'ringing' or c.created_at > clock_timestamp() - interval '45 seconds')
  ) then
    raise exception 'No active call permits relay credentials.' using errcode = '42501';
  end if;

  select count(*) into recent_requests
  from public.aeroshell_turn_credential_requests r
  where r.user_id = actor
    and r.created_at > clock_timestamp() - interval '1 minute';
  if recent_requests >= 8 then
    raise exception 'Too many relay credential requests. Try again shortly.' using errcode = '54000';
  end if;

  delete from public.aeroshell_turn_credential_requests
  where created_at < clock_timestamp() - interval '1 day';
  return new;
end;
$$;
revoke all on function public.aeroshell_guard_turn_credential_request() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_turn_credential_request_before_insert on public.aeroshell_turn_credential_requests;
create trigger aeroshell_guard_turn_credential_request_before_insert
before insert on public.aeroshell_turn_credential_requests
for each row execute function public.aeroshell_guard_turn_credential_request();

-- Expire stale call rows when a participant starts another call. Realtime can otherwise leave
-- a ringing row forever if a browser closes without sending a final state update.
create or replace function public.aeroshell_expire_stale_calls(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null or p_user is distinct from (select auth.uid()) then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;

  perform set_config('aeroshell.internal_call_cleanup', 'on', true);
  update public.aeroshell_calls c
  set status = 'ended', updated_at = clock_timestamp()
  where (c.caller_id = p_user or c.callee_id = p_user)
    and (
      (c.status = 'ringing' and c.created_at < clock_timestamp() - interval '60 seconds')
      or (c.status = 'accepted' and c.updated_at < clock_timestamp() - interval '2 hours')
    );
  perform set_config('aeroshell.internal_call_cleanup', 'off', true);
end;
$$;
revoke all on function public.aeroshell_expire_stale_calls(uuid) from public, anon, authenticated;

create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;

-- Keep the TURN function's two foreign-key lookups indexed.
create index if not exists aeroshell_call_signals_from_user_idx
  on public.aeroshell_call_signals(from_user_id, created_at);
create index if not exists aeroshell_turn_requests_call_created_idx
  on public.aeroshell_turn_credential_requests(call_id, created_at desc);


-- ===== supabase/migrations/20261023203500_master_chat_missing_foreign_key_indexes.sql =====
-- Cover foreign-key lookups used by call signaling and TURN quotas.
create index if not exists aeroshell_call_signals_from_user_idx
  on public.aeroshell_call_signals(from_user_id, created_at);
create index if not exists aeroshell_turn_requests_call_created_idx
  on public.aeroshell_turn_credential_requests(call_id, created_at desc);


-- ===== supabase/migrations/20261023204000_master_chat_realtime_and_race_hardening.sql =====
-- Realtime sync for per-user message hides and concurrency/rate-limit hardening.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_message_hides'
  ) then
    alter publication supabase_realtime add table public.aeroshell_message_hides;
  end if;
end;
$$;

-- Serialize simultaneous call starts per account and do not refresh stale-call age on no-op updates.
create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;

-- Reject forged or cross-call signals and cap signaling spam at a server-enforced limit.
create or replace function public.aeroshell_guard_call_signal_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_signals integer;
begin
  if actor is null or new.from_user_id is distinct from actor then
    raise exception 'Call signals must be sent by the signed-in user.' using errcode = '42501';
  end if;
  if jsonb_typeof(new.payload) <> 'object' or pg_column_size(new.payload) > 8192 then
    raise exception 'Invalid call signal payload.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(actor::text, 2));

  if not exists (
    select 1 from public.aeroshell_calls c
    where c.id = new.call_id
      and c.status in ('ringing', 'accepted')
      and (
        (c.caller_id = actor and c.callee_id = new.to_user_id)
        or (c.callee_id = actor and c.caller_id = new.to_user_id)
      )
      and (
        new.kind = 'ice'
        or (new.kind = 'offer' and c.caller_id = actor)
        or (new.kind = 'answer' and c.callee_id = actor and c.status = 'accepted')
      )
  ) then
    raise exception 'Signal is not permitted for this call state.' using errcode = '42501';
  end if;

  select count(*) into recent_signals
  from public.aeroshell_call_signals s
  where s.from_user_id = actor and s.created_at > clock_timestamp() - interval '1 minute';
  if recent_signals >= 200 then
    raise exception 'Too many call signals. Wait before continuing.' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.aeroshell_guard_call_signal_insert() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_call_signal_before_insert on public.aeroshell_call_signals;
create trigger aeroshell_guard_call_signal_before_insert
before insert on public.aeroshell_call_signals
for each row execute function public.aeroshell_guard_call_signal_insert();


-- ===== supabase/migrations/20261023205000_master_chat_call_expiry_guards.sql =====
-- Enforce ring expiry and one active call per participant at accept time.
create or replace function public.aeroshell_guard_call_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;
    select count(*) into recent_attempts
    from public.aeroshell_calls c
    where c.caller_id = actor and c.created_at > clock_timestamp() - interval '1 minute';
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id or new.callee_id is distinct from old.callee_id
     or new.id is distinct from old.id or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then
    return new;
  end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted', 'rejected') then
    if new.status = 'accepted' then
      if old.created_at < clock_timestamp() - interval '45 seconds' then
        raise exception 'The incoming call has expired.' using errcode = '55000';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
      perform public.aeroshell_expire_stale_calls(actor);
      if exists (
        select 1 from public.aeroshell_calls c
        where c.id <> old.id
          and c.status in ('ringing', 'accepted')
          and (c.caller_id = actor or c.callee_id = actor)
      ) then
        raise exception 'Finish your other call before accepting this one.' using errcode = '55000';
      end if;
    end if;
    new.updated_at := clock_timestamp();
    return new;
  end if;
  if old.status in ('ringing', 'accepted') and actor in (old.caller_id, old.callee_id) and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;


-- Optional Master Chat profile photos (additive and safe to re-run).
-- Allow each authenticated user to set an optional, bounded profile avatar.
alter table public.aeroshell_profiles
  add column if not exists avatar_data text;

alter table public.aeroshell_profiles
  drop constraint if exists aeroshell_profiles_avatar_data_valid;

alter table public.aeroshell_profiles
  add constraint aeroshell_profiles_avatar_data_valid
  check (
    avatar_data is null
    or (
      length(avatar_data) <= 60000
      and avatar_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
    )
  );

drop policy if exists "Users can update their own profile avatar" on public.aeroshell_profiles;
create policy "Users can update their own profile avatar"
  on public.aeroshell_profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Restrict client updates to the avatar column; usernames and profile IDs stay read-only.
grant update (avatar_data) on table public.aeroshell_profiles to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'aeroshell_profiles'
  ) then
    alter publication supabase_realtime add table public.aeroshell_profiles;
  end if;
end;
$$;


-- ===== supabase/migrations/20261024094541_master_chat_groups_attachments_voice_notes.sql =====
-- Master Chat groups, secure attachments, voice notes and group administration.
-- Applied to project windows-12-beta-chat on 2026-10-24.
-- Existing direct chats remain valid; attachments are stored in a private bucket.

create schema if not exists private;
grant usage on schema private to authenticated;

create table if not exists public.aeroshell_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  avatar_data text,
  created_by uuid not null references public.aeroshell_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aeroshell_groups_name_check check (char_length(btrim(name)) between 1 and 60),
  constraint aeroshell_groups_avatar_check check (
    avatar_data is null or (
      length(avatar_data) <= 60000
      and avatar_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
    )
  )
);
create index if not exists aeroshell_groups_created_by_idx on public.aeroshell_groups(created_by, created_at desc);

create table if not exists public.aeroshell_group_members (
  group_id uuid not null references public.aeroshell_groups(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  added_by uuid not null references public.aeroshell_profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists aeroshell_group_members_user_idx on public.aeroshell_group_members(user_id, joined_at desc);
create index if not exists aeroshell_group_members_group_role_idx on public.aeroshell_group_members(group_id, role);
alter table public.aeroshell_groups enable row level security;
alter table public.aeroshell_group_members enable row level security;
grant select on public.aeroshell_groups to authenticated;
grant insert (name, avatar_data, created_by) on public.aeroshell_groups to authenticated;
grant update (name, avatar_data, updated_at) on public.aeroshell_groups to authenticated;
grant delete on public.aeroshell_groups to authenticated;
grant select, insert, update, delete on public.aeroshell_group_members to authenticated;

create or replace function private.aeroshell_group_is_member(p_group_id uuid, p_actor_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_actor_id is not null and p_actor_id = (select auth.uid())
    and private.aeroshell_chat_actor_is_valid()
    and exists (select 1 from public.aeroshell_group_members gm
                where gm.group_id = p_group_id and gm.user_id = p_actor_id);
$$;
create or replace function private.aeroshell_group_is_admin(p_group_id uuid, p_actor_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_actor_id is not null and p_actor_id = (select auth.uid())
    and private.aeroshell_chat_actor_is_valid()
    and exists (select 1 from public.aeroshell_group_members gm
                where gm.group_id = p_group_id and gm.user_id = p_actor_id and gm.role = 'admin');
$$;
revoke all on function private.aeroshell_group_is_member(uuid, uuid) from public, anon;
revoke all on function private.aeroshell_group_is_admin(uuid, uuid) from public, anon;
grant execute on function private.aeroshell_group_is_member(uuid, uuid) to authenticated;
grant execute on function private.aeroshell_group_is_admin(uuid, uuid) to authenticated;

drop policy if exists "Members can read their own groups" on public.aeroshell_groups;
create policy "Members can read their own groups" on public.aeroshell_groups for select to authenticated
using (private.aeroshell_group_is_member(id, (select auth.uid())));
drop policy if exists "Users can create groups as themselves" on public.aeroshell_groups;
create policy "Users can create groups as themselves" on public.aeroshell_groups for insert to authenticated
with check (
  created_by = (select auth.uid())
  and exists (select 1 from public.aeroshell_profiles p where p.id = (select auth.uid()))
  and char_length(btrim(name)) between 1 and 60
);
drop policy if exists "Group admins can update group details" on public.aeroshell_groups;
create policy "Group admins can update group details" on public.aeroshell_groups for update to authenticated
using (private.aeroshell_group_is_admin(id, (select auth.uid())))
with check (
  private.aeroshell_group_is_admin(id, (select auth.uid()))
  and char_length(btrim(name)) between 1 and 60
);
drop policy if exists "Only group creators can delete groups" on public.aeroshell_groups;
create policy "Only group creators can delete groups" on public.aeroshell_groups for delete to authenticated
using (created_by = (select auth.uid()) and private.aeroshell_chat_actor_is_valid());

drop policy if exists "Group members can read the group roster" on public.aeroshell_group_members;
create policy "Group members can read the group roster" on public.aeroshell_group_members for select to authenticated
using (private.aeroshell_group_is_member(group_id, (select auth.uid())));
drop policy if exists "Group admins can add members and creators can start a group" on public.aeroshell_group_members;
create policy "Group admins can add members and creators can start a group" on public.aeroshell_group_members for insert to authenticated
with check (
  added_by = (select auth.uid())
  and (
    (
      user_id = (select auth.uid()) and role = 'admin'
      and exists (select 1 from public.aeroshell_groups g where g.id = aeroshell_group_members.group_id and g.created_by = (select auth.uid()))
      and not exists (select 1 from public.aeroshell_group_members gm where gm.group_id = aeroshell_group_members.group_id)
    )
    or (role = 'member' and private.aeroshell_group_is_admin(aeroshell_group_members.group_id, (select auth.uid())))
  )
);
drop policy if exists "Group admins can change member roles" on public.aeroshell_group_members;
create policy "Group admins can change member roles" on public.aeroshell_group_members for update to authenticated
using (private.aeroshell_group_is_admin(group_id, (select auth.uid())))
with check (private.aeroshell_group_is_admin(group_id, (select auth.uid())));
drop policy if exists "Group admins can remove members and members can leave" on public.aeroshell_group_members;
create policy "Group admins can remove members and members can leave" on public.aeroshell_group_members for delete to authenticated
using (user_id = (select auth.uid()) or private.aeroshell_group_is_admin(group_id, (select auth.uid())));

create or replace function public.aeroshell_guard_group_membership()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); admins_left integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or not private.aeroshell_chat_actor_is_valid() or new.added_by is distinct from actor then
      raise exception 'A valid signed-in group actor is required.' using errcode = '42501';
    end if;
    if new.role = 'admin' and new.user_id = actor
       and exists (select 1 from public.aeroshell_groups g where g.id = new.group_id and g.created_by = actor)
       and not exists (select 1 from public.aeroshell_group_members gm where gm.group_id = new.group_id) then
      return new;
    end if;
    if new.role <> 'member' or not private.aeroshell_group_is_admin(new.group_id, actor) then
      raise exception 'Only a group admin can add members. New members start as regular members.' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if actor is null or not private.aeroshell_chat_actor_is_valid()
       or not private.aeroshell_group_is_admin(old.group_id, actor)
       or new.group_id is distinct from old.group_id or new.user_id is distinct from old.user_id
       or new.added_by is distinct from old.added_by or new.role not in ('admin', 'member') then
      raise exception 'Only a group admin may change a member role.' using errcode = '42501';
    end if;
    if old.role = 'admin' and new.role <> 'admin' then
      select count(*) into admins_left from public.aeroshell_group_members gm
      where gm.group_id = old.group_id and gm.role = 'admin' and gm.user_id <> old.user_id;
      if admins_left = 0 then raise exception 'A group must keep at least one admin.' using errcode = '23514'; end if;
    end if;
    return new;
  else
    if not exists (select 1 from public.aeroshell_groups g where g.id = old.group_id)
       or not private.aeroshell_chat_actor_is_valid() then return old; end if;
    if actor is null or (old.user_id <> actor and not private.aeroshell_group_is_admin(old.group_id, actor)) then
      raise exception 'Only a group admin can remove another member.' using errcode = '42501';
    end if;
    if old.role = 'admin' then
      select count(*) into admins_left from public.aeroshell_group_members gm
      where gm.group_id = old.group_id and gm.role = 'admin' and gm.user_id <> old.user_id;
      if admins_left = 0 then raise exception 'A group must keep at least one admin. Promote another member first.' using errcode = '23514'; end if;
    end if;
    return old;
  end if;
end;
$$;
revoke all on function public.aeroshell_guard_group_membership() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_group_membership_before_write on public.aeroshell_group_members;
create trigger aeroshell_guard_group_membership_before_write
before insert or update or delete on public.aeroshell_group_members for each row
execute function public.aeroshell_guard_group_membership();

create or replace function public.aeroshell_create_group(p_name text, p_avatar_data text default null, p_member_ids uuid[] default '{}'::uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); clean_name text := btrim(coalesce(p_name, ''));
group_id uuid; requested_count integer; valid_count integer;
begin
  if actor is null or not private.aeroshell_chat_actor_is_valid()
     or not exists (select 1 from public.aeroshell_profiles p where p.id = actor) then
    raise exception 'A signed-in Master Chat profile is required.' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 60 then raise exception 'Group names must contain 1–60 characters.' using errcode = '22023'; end if;
  if p_avatar_data is not null and (length(p_avatar_data) > 60000 or p_avatar_data !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$') then
    raise exception 'Choose a valid, compressed group image.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_member_ids), 0) > 99 then raise exception 'A group can have up to 100 members, including its creator.' using errcode = '22023'; end if;
  select count(distinct m) into requested_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m where m is not null and m <> actor;
  select count(distinct m) into valid_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m join public.aeroshell_profiles p on p.id = m where m is not null and m <> actor;
  if requested_count <> valid_count then raise exception 'One or more selected accounts no longer exist.' using errcode = '22023'; end if;
  insert into public.aeroshell_groups (name, avatar_data, created_by) values (clean_name, p_avatar_data, actor) returning id into group_id;
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by) values (group_id, actor, 'admin', actor);
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by)
  select group_id, p.id, 'member', actor from public.aeroshell_profiles p
  where p.id = any(coalesce(p_member_ids, '{}'::uuid[])) and p.id <> actor
  on conflict (group_id, user_id) do nothing;
  return group_id;
end;
$$;
revoke all on function public.aeroshell_create_group(text, text, uuid[]) from public, anon;
grant execute on function public.aeroshell_create_group(text, text, uuid[]) to authenticated;

alter table public.aeroshell_messages alter column recipient_id drop not null;
alter table public.aeroshell_messages add column if not exists group_id uuid references public.aeroshell_groups(id) on delete cascade;
alter table public.aeroshell_messages add column if not exists message_type text not null default 'text';
alter table public.aeroshell_messages add column if not exists attachment_path text;
alter table public.aeroshell_messages add column if not exists attachment_name text;
alter table public.aeroshell_messages add column if not exists attachment_mime text;
alter table public.aeroshell_messages add column if not exists attachment_size bigint;
alter table public.aeroshell_messages add column if not exists voice_duration_ms integer;
alter table public.aeroshell_messages drop constraint if exists aeroshell_messages_body_check;
alter table public.aeroshell_messages drop constraint if exists aeroshell_no_self_message;
alter table public.aeroshell_messages add constraint aeroshell_no_self_message check (recipient_id is null or sender_id <> recipient_id);
alter table public.aeroshell_messages drop constraint if exists aeroshell_messages_conversation_shape;
alter table public.aeroshell_messages add constraint aeroshell_messages_conversation_shape check (
  (group_id is null and recipient_id is not null) or (group_id is not null and recipient_id is null)
);
alter table public.aeroshell_messages add constraint aeroshell_messages_body_check check (
  (message_type = 'text' and char_length(btrim(body)) between 1 and 2000
    and attachment_path is null and attachment_name is null and attachment_mime is null
    and attachment_size is null and voice_duration_ms is null)
  or (message_type = 'file' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime is not null and char_length(attachment_mime) between 1 and 120
    and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640 and voice_duration_ms is null)
  or (message_type = 'voice' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640
    and voice_duration_ms between 1 and 120000)
);
create index if not exists aeroshell_messages_group_created_idx on public.aeroshell_messages(group_id, created_at desc) where group_id is not null;
create index if not exists aeroshell_messages_attachment_path_idx on public.aeroshell_messages(attachment_path) where attachment_path is not null;
grant select, insert, delete on public.aeroshell_messages to authenticated;

drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages" on public.aeroshell_messages for select to authenticated
using (
  ((group_id is null and ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id))
    or (group_id is not null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and not exists (select 1 from public.aeroshell_message_hides h where h.message_id = aeroshell_messages.id and h.user_id = (select auth.uid()))
);
drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and ((group_id is null and recipient_id is not null and recipient_id <> (select auth.uid())
        and exists (select 1 from public.aeroshell_profiles p where p.id = recipient_id))
    or (group_id is not null and recipient_id is null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and ((message_type = 'text' and char_length(btrim(body)) between 1 and 2000)
    or (message_type = 'file' and attachment_path is not null and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640)
    or (message_type = 'voice' and attachment_path is not null and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640 and voice_duration_ms between 1 and 120000))
);
drop policy if exists "Senders can delete their own messages for everyone" on public.aeroshell_messages;
create policy "Senders can delete their own messages for everyone" on public.aeroshell_messages for delete to authenticated
using ((select auth.uid()) = sender_id);

create or replace function public.aeroshell_validate_message_hide()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or new.user_id is distinct from (select auth.uid()) or not private.aeroshell_chat_actor_is_valid() then
    raise exception 'A user may hide messages only for themselves.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.aeroshell_messages m where m.id = new.message_id and (
      (m.group_id is null and (m.sender_id = (select auth.uid()) or m.recipient_id = (select auth.uid())))
      or (m.group_id is not null and exists (select 1 from public.aeroshell_group_members gm where gm.group_id = m.group_id and gm.user_id = (select auth.uid())))
    )
  ) then raise exception 'Message not found or not accessible to this user.' using errcode = '42501'; end if;
  return new;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('master-chat-attachments', 'master-chat-attachments', false, 15728640, null)
on conflict (id) do update set public = false, file_size_limit = 15728640, allowed_mime_types = null;
drop policy if exists "Participants can read Master Chat attachments" on storage.objects;
create policy "Participants can read Master Chat attachments" on storage.objects for select to authenticated
using (
  bucket_id = 'master-chat-attachments'
  and (
    ((storage.foldername(name))[1] = 'direct'
      and ((storage.foldername(name))[2] = (select auth.uid())::text or (storage.foldername(name))[3] = (select auth.uid())::text))
    or ((storage.foldername(name))[1] = 'groups'
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);
drop policy if exists "Participants can upload Master Chat attachments" on storage.objects;
create policy "Participants can upload Master Chat attachments" on storage.objects for insert to authenticated
with check (
  bucket_id = 'master-chat-attachments'
  and coalesce(metadata ->> 'mimetype', '') not like 'video/%'
  and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 15728640
  and (
    ((storage.foldername(name))[1] = 'direct'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and (storage.foldername(name))[3] <> (select auth.uid())::text
      and exists (select 1 from public.aeroshell_profiles p where p.id::text = (storage.foldername(name))[3]))
    or ((storage.foldername(name))[1] = 'groups'
      and (storage.foldername(name))[3] = (select auth.uid())::text
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);
drop policy if exists "Uploaders can remove their own Master Chat attachments" on storage.objects;
create policy "Uploaders can remove their own Master Chat attachments" on storage.objects for delete to authenticated
using (
  bucket_id = 'master-chat-attachments'
  and (((storage.foldername(name))[1] = 'direct' and (storage.foldername(name))[2] = (select auth.uid())::text)
    or ((storage.foldername(name))[1] = 'groups' and (storage.foldername(name))[3] = (select auth.uid())::text))
);

drop policy if exists "Members can access Master Chat group updates" on realtime.messages;
create policy "Members can access Master Chat group updates" on realtime.messages for select to authenticated
using ((select realtime.topic()) = 'aeroshell-master-chat-groups');
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_groups') then alter publication supabase_realtime add table public.aeroshell_groups; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_group_members') then alter publication supabase_realtime add table public.aeroshell_group_members; end if;
end;
$$;


-- ===== supabase/migrations/20261024094701_master_chat_group_rpc_invoker_and_policy_correlation.sql =====
-- Group creation validates every input in SQL and uses caller-scoped RLS.
alter function public.aeroshell_create_group(text, text, uuid[]) security invoker;

drop policy if exists "Group admins can add members and creators can start a group" on public.aeroshell_group_members;
create policy "Group admins can add members and creators can start a group"
on public.aeroshell_group_members for insert to authenticated
with check (
  added_by = (select auth.uid())
  and (
    (
      user_id = (select auth.uid()) and role = 'admin'
      and exists (select 1 from public.aeroshell_groups g where g.id = aeroshell_group_members.group_id and g.created_by = (select auth.uid()))
      and not exists (select 1 from public.aeroshell_group_members gm where gm.group_id = aeroshell_group_members.group_id)
    )
    or (role = 'member' and private.aeroshell_group_is_admin(aeroshell_group_members.group_id, (select auth.uid())))
  )
);


-- ===== supabase/migrations/20261024095547_master_chat_group_creation_private_helper.sql =====
undefined

-- ===== supabase/migrations/20261024095931_master_chat_attachment_filename_video_guard.sql =====
-- Disallow common video formats by extension at both the message and Storage boundaries.
-- Voice notes may use audio/webm and remain allowed as message_type='voice'.
alter table public.aeroshell_messages drop constraint if exists aeroshell_messages_body_check;
alter table public.aeroshell_messages add constraint aeroshell_messages_body_check check (
  (message_type = 'text' and char_length(btrim(body)) between 1 and 2000
    and attachment_path is null and attachment_name is null and attachment_mime is null
    and attachment_size is null and voice_duration_ms is null)
  or (message_type = 'file' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_name !~* '[.](mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$'
    and attachment_mime is not null and char_length(attachment_mime) between 1 and 120
    and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640 and voice_duration_ms is null)
  or (message_type = 'voice' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640
    and voice_duration_ms between 1 and 120000)
);
drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and ((group_id is null and recipient_id is not null and recipient_id <> (select auth.uid())
        and exists (select 1 from public.aeroshell_profiles p where p.id = recipient_id))
    or (group_id is not null and recipient_id is null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and ((message_type = 'text' and char_length(btrim(body)) between 1 and 2000)
    or (message_type = 'file' and attachment_path is not null and attachment_mime not like 'video/%'
        and attachment_name !~* '[.](mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$'
        and attachment_size between 1 and 15728640)
    or (message_type = 'voice' and attachment_path is not null and attachment_mime like 'audio/%'
        and attachment_size between 1 and 15728640 and voice_duration_ms between 1 and 120000))
);
drop policy if exists "Participants can upload Master Chat attachments" on storage.objects;
create policy "Participants can upload Master Chat attachments" on storage.objects for insert to authenticated
with check (
  bucket_id = 'master-chat-attachments'
  and coalesce(metadata ->> 'mimetype', '') not like 'video/%'
  and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 15728640
  and split_part(name, '/', array_length(string_to_array(name, '/'), 1)) !~* '[.](mp4|mov|m4v|mkv|avi|mpeg|mpg|3gp|ogv)$'
  and (split_part(name, '/', array_length(string_to_array(name, '/'), 1)) !~* '[.]webm$'
       or coalesce(metadata ->> 'mimetype', '') like 'audio/%')
  and (
    ((storage.foldername(name))[1] = 'direct'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and (storage.foldername(name))[3] <> (select auth.uid())::text
      and exists (select 1 from public.aeroshell_profiles p where p.id::text = (storage.foldername(name))[3]))
    or ((storage.foldername(name))[1] = 'groups'
      and (storage.foldername(name))[3] = (select auth.uid())::text
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);


-- ===== Private profile discovery and search =====

-- Restrict profile listing to related accounts and expose rate-limited, search-on-demand discovery.
create schema if not exists private;

create table if not exists private.aeroshell_profile_search_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  searched_at timestamptz not null default now()
);
create index if not exists aeroshell_profile_search_events_user_time_idx
  on private.aeroshell_profile_search_events (user_id, searched_at desc);
alter table private.aeroshell_profile_search_events enable row level security;
revoke all on table private.aeroshell_profile_search_events from public, anon, authenticated;

create or replace function private.aeroshell_search_profiles(search_query text)
returns table (id uuid, username text, avatar_data text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_query text := lower(btrim(coalesce(search_query, '')));
  v_recent_count integer;
begin
  if v_actor is null
     or not private.aeroshell_chat_actor_is_valid()
     or not exists (select 1 from public.aeroshell_profiles self where self.id = v_actor) then
    raise exception 'A signed-in Master Chat profile is required to search usernames.'
      using errcode = '42501';
  end if;

  if char_length(v_query) < 3 or char_length(v_query) > 20 or v_query !~ '^[a-z0-9_]+$' then
    return;
  end if;

  delete from private.aeroshell_profile_search_events
    where searched_at < now() - interval '10 minutes';

  select count(*)::integer into v_recent_count
    from private.aeroshell_profile_search_events e
    where e.user_id = v_actor and e.searched_at >= now() - interval '1 minute';

  if v_recent_count >= 20 then
    raise exception 'Too many username searches. Wait a minute and try again.'
      using errcode = '54000';
  end if;

  insert into private.aeroshell_profile_search_events (user_id) values (v_actor);

  return query
    select p.id, p.username, p.avatar_data
    from public.aeroshell_profiles p
    where p.id <> v_actor and position(v_query in lower(p.username)) > 0
    order by
      (lower(p.username) = v_query) desc,
      (left(lower(p.username), char_length(v_query)) = v_query) desc,
      lower(p.username)
    limit 8;
end;
$function$;
revoke all on function private.aeroshell_search_profiles(text) from public, anon;
grant execute on function private.aeroshell_search_profiles(text) to authenticated;

create or replace function public.aeroshell_search_profiles(search_query text)
returns table (id uuid, username text, avatar_data text)
language sql
security invoker
set search_path = ''
as $function$
  select * from private.aeroshell_search_profiles(search_query);
$function$;
revoke all on function public.aeroshell_search_profiles(text) from public, anon;
grant execute on function public.aeroshell_search_profiles(text) to authenticated;

drop policy if exists "Authenticated users can discover profiles" on public.aeroshell_profiles;
drop policy if exists "Users can discover only related profiles" on public.aeroshell_profiles;
create policy "Users can discover only related profiles"
on public.aeroshell_profiles
for select
to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and (
    id = (select auth.uid())
    or private.aeroshell_are_friends((select auth.uid()), id)
    or exists (
      select 1 from public.aeroshell_friend_requests fr
      where fr.status = 'pending'
        and (
          (fr.requester_id = (select auth.uid()) and fr.recipient_id = aeroshell_profiles.id)
          or (fr.recipient_id = (select auth.uid()) and fr.requester_id = aeroshell_profiles.id)
        )
    )
    or exists (
      select 1 from public.aeroshell_group_members mine
      join public.aeroshell_group_members other_member on other_member.group_id = mine.group_id
      where mine.user_id = (select auth.uid()) and other_member.user_id = aeroshell_profiles.id
    )
  )
);

-- Group voice/video calls: private invite records, per-member acceptance, and relay-only mesh signaling.
-- Private group-call sessions with recipient invitations and peer-to-peer mesh signaling.
create table if not exists public.aeroshell_group_calls (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.aeroshell_groups(id) on delete cascade,
  initiator_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  media_type text not null check (media_type in ('audio','video')),
  status text not null default 'active' check (status in ('active','ended')),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint aeroshell_group_calls_ended_at_guard check ((status = 'active' and ended_at is null) or (status = 'ended' and ended_at is not null))
);
create index if not exists aeroshell_group_calls_group_created_idx on public.aeroshell_group_calls(group_id, created_at desc);
create index if not exists aeroshell_group_calls_initiator_status_idx on public.aeroshell_group_calls(initiator_id, status, created_at desc);

create table if not exists public.aeroshell_group_call_participants (
  group_call_id uuid not null references public.aeroshell_group_calls(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  invited_by uuid not null references public.aeroshell_profiles(id) on delete cascade,
  status text not null check (status in ('invited','accepted','declined','left')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (group_call_id,user_id)
);
create index if not exists aeroshell_group_call_participants_user_status_idx on public.aeroshell_group_call_participants(user_id,status,created_at desc);
create index if not exists aeroshell_group_call_participants_session_status_idx on public.aeroshell_group_call_participants(group_call_id,status);

create table if not exists public.aeroshell_group_call_signals (
  id uuid primary key default gen_random_uuid(),
  group_call_id uuid not null references public.aeroshell_group_calls(id) on delete cascade,
  from_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  to_user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  kind text not null check (kind in ('offer','answer','ice')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  created_at timestamptz not null default now(),
  constraint aeroshell_group_call_signals_no_self_signal check (from_user_id <> to_user_id)
);
create index if not exists aeroshell_group_call_signals_recipient_created_idx on public.aeroshell_group_call_signals(group_call_id,to_user_id,created_at);
create index if not exists aeroshell_group_call_signals_cleanup_idx on public.aeroshell_group_call_signals(created_at);

alter table public.aeroshell_calls add column if not exists group_call_id uuid references public.aeroshell_group_calls(id) on delete cascade;
create index if not exists aeroshell_calls_group_call_idx on public.aeroshell_calls(group_call_id,callee_id,status) where group_call_id is not null;
create unique index if not exists aeroshell_calls_one_group_leg_idx on public.aeroshell_calls(group_call_id,callee_id)
  where group_call_id is not null and status in ('ringing','accepted');

alter table public.aeroshell_group_calls enable row level security;
alter table public.aeroshell_group_call_participants enable row level security;
alter table public.aeroshell_group_call_signals enable row level security;
grant select, insert on public.aeroshell_group_calls to authenticated;
revoke update on table public.aeroshell_group_calls from authenticated;
grant update (status, ended_at) on table public.aeroshell_group_calls to authenticated;
grant select, insert on public.aeroshell_group_call_participants to authenticated;
revoke update on table public.aeroshell_group_call_participants from authenticated;
grant update (status, responded_at) on table public.aeroshell_group_call_participants to authenticated;
grant select, insert on public.aeroshell_group_call_signals to authenticated;
grant insert (caller_id, callee_id, media_type, group_call_id) on public.aeroshell_calls to authenticated;
grant update (status) on public.aeroshell_calls to authenticated;

drop policy if exists "Group members can read group calls" on public.aeroshell_group_calls;
create policy "Group members can read group calls" on public.aeroshell_group_calls
for select to authenticated
using (private.aeroshell_group_is_member(group_id,(select auth.uid())));

drop policy if exists "Group members can start group calls" on public.aeroshell_group_calls;
create policy "Group members can start group calls" on public.aeroshell_group_calls
for insert to authenticated
with check (initiator_id = (select auth.uid()) and private.aeroshell_group_is_member(group_id,(select auth.uid())) and status = 'active' and ended_at is null);

drop policy if exists "Initiators can end their group calls" on public.aeroshell_group_calls;
create policy "Initiators can end their group calls" on public.aeroshell_group_calls
for update to authenticated
using (initiator_id = (select auth.uid()) and status = 'active')
with check (initiator_id = (select auth.uid()) and status in ('active','ended'));

drop policy if exists "Group members can see group call participants" on public.aeroshell_group_call_participants;
create policy "Group members can see group call participants" on public.aeroshell_group_call_participants
for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.aeroshell_group_calls gc
    where gc.id = aeroshell_group_call_participants.group_call_id
      and private.aeroshell_group_is_member(gc.group_id,(select auth.uid()))
  )
);

drop policy if exists "Initiators can invite group call participants" on public.aeroshell_group_call_participants;
create policy "Initiators can invite group call participants" on public.aeroshell_group_call_participants
for insert to authenticated
with check (
  invited_by = (select auth.uid())
  and exists (
    select 1 from public.aeroshell_group_calls gc
    where gc.id = aeroshell_group_call_participants.group_call_id
      and gc.initiator_id = (select auth.uid())
      and gc.status = 'active'
      and private.aeroshell_group_is_member(gc.group_id,aeroshell_group_call_participants.user_id)
  )
  and (
    (user_id = (select auth.uid()) and status = 'accepted')
    or (user_id <> (select auth.uid()) and status = 'invited')
  )
);

drop policy if exists "Participants can answer group call invites" on public.aeroshell_group_call_participants;
create policy "Participants can answer group call invites" on public.aeroshell_group_call_participants
for update to authenticated
using (user_id = (select auth.uid()) and status in ('invited','accepted'))
with check (user_id = (select auth.uid()) and status in ('accepted','declined','left'));

drop policy if exists "Accepted participants can read mesh signals" on public.aeroshell_group_call_signals;
create policy "Accepted participants can read mesh signals" on public.aeroshell_group_call_signals
for select to authenticated
using (
  to_user_id = (select auth.uid())
  and exists (select 1 from public.aeroshell_group_call_participants p where p.group_call_id=aeroshell_group_call_signals.group_call_id and p.user_id=(select auth.uid()) and p.status='accepted')
  and exists (select 1 from public.aeroshell_group_call_participants p where p.group_call_id=aeroshell_group_call_signals.group_call_id and p.user_id=aeroshell_group_call_signals.from_user_id and p.status='accepted')
);

drop policy if exists "Accepted participants can send mesh signals" on public.aeroshell_group_call_signals;
create policy "Accepted participants can send mesh signals" on public.aeroshell_group_call_signals
for insert to authenticated
with check (
  from_user_id = (select auth.uid())
  and from_user_id <> to_user_id
  and exists (select 1 from public.aeroshell_group_call_participants p where p.group_call_id=aeroshell_group_call_signals.group_call_id and p.user_id=(select auth.uid()) and p.status='accepted')
  and exists (select 1 from public.aeroshell_group_call_participants p where p.group_call_id=aeroshell_group_call_signals.group_call_id and p.user_id=aeroshell_group_call_signals.to_user_id and p.status='accepted')
  and exists (select 1 from public.aeroshell_group_calls gc where gc.id=aeroshell_group_call_signals.group_call_id and gc.status='active')
);

drop policy if exists "Users can create calls as themselves" on public.aeroshell_calls;
create policy "Users can create calls as themselves" on public.aeroshell_calls
for insert to authenticated
with check (
  caller_id = (select auth.uid())
  and caller_id <> callee_id
  and status = 'ringing'
  and (
    group_call_id is null
    or exists (
      select 1
      from public.aeroshell_group_calls gc
      join public.aeroshell_group_call_participants invite
        on invite.group_call_id=gc.id and invite.user_id=aeroshell_calls.callee_id and invite.status='invited'
      where gc.id=aeroshell_calls.group_call_id
        and gc.initiator_id=(select auth.uid())
        and gc.status='active'
        and gc.media_type=aeroshell_calls.media_type
        and private.aeroshell_group_is_member(gc.group_id,(select auth.uid()))
        and private.aeroshell_group_is_member(gc.group_id,aeroshell_calls.callee_id)
    )
  )
);

create or replace function public.aeroshell_guard_call_transition()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  if tg_op = 'UPDATE'
     and pg_trigger_depth() > 1
     and current_setting('aeroshell.internal_call_cleanup', true) = 'on'
     and old.status in ('ringing', 'accepted')
     and new.status = 'ended'
     and new.id is not distinct from old.id
     and new.caller_id is not distinct from old.caller_id
     and new.callee_id is not distinct from old.callee_id
     and new.group_call_id is not distinct from old.group_call_id
     and new.created_at is not distinct from old.created_at then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if tg_op = 'INSERT' then
    if actor is null or new.caller_id is distinct from actor then
      raise exception 'A call must be initiated by the signed-in caller.' using errcode = '42501';
    end if;
    if new.status <> 'ringing' or new.caller_id = new.callee_id then
      raise exception 'Invalid initial call state.' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
    perform public.aeroshell_expire_stale_calls(actor);

    if exists (
      select 1 from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
        and not (new.group_call_id is not null and c.group_call_id = new.group_call_id and c.caller_id = actor)
    ) then
      raise exception 'Finish your current call before starting another.' using errcode = '55000';
    end if;

    if new.group_call_id is not null and not exists (
      select 1 from public.aeroshell_group_calls gc
      join public.aeroshell_group_call_participants participant
        on participant.group_call_id=gc.id and participant.user_id=new.callee_id and participant.status='invited'
      where gc.id=new.group_call_id
        and gc.initiator_id=actor
        and gc.status='active'
        and gc.media_type=new.media_type
        and private.aeroshell_group_is_member(gc.group_id,actor)
        and private.aeroshell_group_is_member(gc.group_id,new.callee_id)
    ) then
      raise exception 'This group call invitation is invalid.' using errcode = '42501';
    end if;

    select count(*) into recent_attempts
    from (
      select coalesce(c.group_call_id,c.id) as attempt_id
      from public.aeroshell_calls c
      where c.caller_id=actor and c.created_at > clock_timestamp() - interval '1 minute'
      group by coalesce(c.group_call_id,c.id)
    ) attempts;
    if recent_attempts >= 5 then
      raise exception 'Too many call attempts. Please wait before trying again.' using errcode = '54000';
    end if;
    return new;
  end if;

  if actor is null then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;
  if new.caller_id is distinct from old.caller_id
     or new.callee_id is distinct from old.callee_id
     or new.group_call_id is distinct from old.group_call_id
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'Call participants and identifiers cannot be changed.' using errcode = '42501';
  end if;
  if new.status = old.status then return new; end if;

  if old.status = 'ringing' and actor = old.callee_id and new.status in ('accepted','rejected') then
    if new.status = 'accepted' then
      if old.created_at < clock_timestamp() - interval '45 seconds' then
        raise exception 'The incoming call has expired.' using errcode = '55000';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
      perform public.aeroshell_expire_stale_calls(actor);
      if exists (
        select 1 from public.aeroshell_calls c
        where c.id <> old.id
          and c.status in ('ringing','accepted')
          and (c.caller_id=actor or c.callee_id=actor)
      ) then
        raise exception 'Finish your other call before accepting this one.' using errcode = '55000';
      end if;
    end if;
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status in ('ringing','accepted') and actor in (old.caller_id,old.callee_id) and new.status='ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$function$;

do $publication$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    begin alter publication supabase_realtime add table public.aeroshell_group_calls; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.aeroshell_group_call_participants; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.aeroshell_group_call_signals; exception when duplicate_object then null; end;
  end if;
end;
$publication$;
