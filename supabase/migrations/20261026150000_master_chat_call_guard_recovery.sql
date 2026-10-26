CREATE OR REPLACE FUNCTION public.aeroshell_expire_stale_calls(p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if p_user is null or p_user is distinct from (select auth.uid()) then
    raise exception 'A signed-in participant is required.' using errcode = '42501';
  end if;

  perform set_config('aeroshell.internal_call_cleanup', 'on', true);

  -- A group call is considered abandoned once it is older than 3 minutes and
  -- no active call leg has sent a heartbeat in that interval.
  update public.aeroshell_group_calls gc
  set status = 'ended',
      ended_at = coalesce(gc.ended_at, clock_timestamp())
  where gc.status = 'active'
    and gc.created_at < clock_timestamp() - interval '3 minutes'
    and not exists (
      select 1
      from public.aeroshell_calls c
      where c.group_call_id = gc.id
        and c.status in ('ringing', 'accepted')
        and c.updated_at >= clock_timestamp() - interval '3 minutes'
    );

  -- Close any outstanding ringing/accepted legs for sessions that have ended.
  update public.aeroshell_calls c
  set status = 'ended',
      updated_at = clock_timestamp()
  where c.group_call_id is not null
    and c.status in ('ringing', 'accepted')
    and exists (
      select 1
      from public.aeroshell_group_calls gc
      where gc.id = c.group_call_id
        and gc.status = 'ended'
    );

  -- Direct calls have a 45-second ring window. Accepted calls are live only
  -- while their clients refresh updated_at; abandonments time out after 3 minutes.
  update public.aeroshell_calls c
  set status = 'ended',
      updated_at = clock_timestamp()
  where (c.caller_id = p_user or c.callee_id = p_user)
    and c.group_call_id is null
    and (
      (c.status = 'ringing' and c.created_at < clock_timestamp() - interval '45 seconds')
      or
      (c.status = 'accepted' and c.updated_at < clock_timestamp() - interval '3 minutes')
    );

  perform set_config('aeroshell.internal_call_cleanup', 'off', true);
end;
$function$;
revoke all on function public.aeroshell_expire_stale_calls(uuid) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.aeroshell_guard_call_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := (select auth.uid());
  recent_attempts integer;
begin
  -- The expiration helper may update other call rows while a call transition
  -- is being checked. Permit only these narrowly scoped internal end transitions.
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

    -- Exclude other legs in the same group session, but never allow a second
    -- unrelated direct/group call over a still-live session.
    if exists (
      select 1
      from public.aeroshell_calls c
      where c.status in ('ringing', 'accepted')
        and (c.caller_id = actor or c.callee_id = actor)
        and not (new.group_call_id is not null and c.group_call_id = new.group_call_id)
    ) then
      raise exception 'A direct call is already active. End that call before starting another.' using errcode = '55000';
    end if;

    if new.group_call_id is not null and not exists (
      select 1
      from public.aeroshell_group_calls gc
      join public.aeroshell_group_call_participants participant
        on participant.group_call_id = gc.id
       and participant.user_id = new.callee_id
       and participant.status = 'invited'
      where gc.id = new.group_call_id
        and gc.initiator_id = actor
        and gc.status = 'active'
        and gc.media_type = new.media_type
        and private.aeroshell_group_is_member(gc.group_id, actor)
        and private.aeroshell_group_is_member(gc.group_id, new.callee_id)
    ) then
      raise exception 'This group call invitation is invalid.' using errcode = '42501';
    end if;

    select count(*) into recent_attempts
    from (
      select coalesce(c.group_call_id, c.id) as attempt_id
      from public.aeroshell_calls c
      where c.caller_id = actor
        and c.created_at > clock_timestamp() - interval '1 minute'
      group by coalesce(c.group_call_id, c.id)
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

  -- Heartbeat writes intentionally keep status unchanged. Refresh updated_at
  -- here so stale-call cleanup can distinguish an active call from an orphan.
  if new.status = old.status then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status = 'ringing'
     and actor = old.callee_id
     and new.status in ('accepted', 'rejected') then

    if new.status = 'accepted' then
      if old.group_call_id is null
         and old.created_at < clock_timestamp() - interval '45 seconds' then
        raise exception 'The incoming call has expired.' using errcode = '55000';
      end if;

      if old.group_call_id is not null
         and old.created_at < clock_timestamp() - interval '3 minutes'
         and not exists (
           select 1
           from public.aeroshell_calls c
           where c.group_call_id = old.group_call_id
             and c.status = 'accepted'
             and c.updated_at >= clock_timestamp() - interval '3 minutes'
         ) then
        raise exception 'This group call invitation has expired.' using errcode = '55000';
      end if;

      perform pg_advisory_xact_lock(hashtextextended(actor::text, 1));
      perform public.aeroshell_expire_stale_calls(actor);

      if exists (
        select 1
        from public.aeroshell_calls c
        where c.id <> old.id
          and c.status in ('ringing', 'accepted')
          and (c.caller_id = actor or c.callee_id = actor)
          and not (old.group_call_id is not null and c.group_call_id = old.group_call_id)
      ) then
        raise exception 'Another direct call is still active. End that call before accepting this one.' using errcode = '55000';
      end if;
    end if;

    new.updated_at := clock_timestamp();
    return new;
  end if;

  if old.status in ('ringing', 'accepted')
     and actor in (old.caller_id, old.callee_id)
     and new.status = 'ended' then
    new.updated_at := clock_timestamp();
    return new;
  end if;

  raise exception 'Invalid call state transition for this participant.' using errcode = '42501';
end;
$function$;
revoke all on function public.aeroshell_guard_call_transition() from public, anon, authenticated;
