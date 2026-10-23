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
