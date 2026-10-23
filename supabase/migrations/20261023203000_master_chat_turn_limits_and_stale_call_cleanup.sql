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
