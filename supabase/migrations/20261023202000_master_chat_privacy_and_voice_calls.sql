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
