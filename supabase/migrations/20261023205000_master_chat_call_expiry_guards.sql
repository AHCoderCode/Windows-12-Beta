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
