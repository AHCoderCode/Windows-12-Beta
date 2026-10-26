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
