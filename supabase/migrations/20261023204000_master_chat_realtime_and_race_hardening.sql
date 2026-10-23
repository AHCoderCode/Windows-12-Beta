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
