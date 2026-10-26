-- Prioritize exact username matches before prefix and substring matches.
-- Keep the existing authenticated-only, rate-limited private search implementation.
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

  select count(*)::integer
    into v_recent_count
    from private.aeroshell_profile_search_events e
    where e.user_id = v_actor
      and e.searched_at >= now() - interval '1 minute';

  if v_recent_count >= 20 then
    raise exception 'Too many username searches. Wait a minute and try again.'
      using errcode = '54000';
  end if;

  insert into private.aeroshell_profile_search_events (user_id) values (v_actor);

  return query
    select p.id, p.username, p.avatar_data
    from public.aeroshell_profiles p
    where p.id <> v_actor
      and position(v_query in lower(p.username)) > 0
    order by
      (lower(p.username) = v_query) desc,
      (left(lower(p.username), char_length(v_query)) = v_query) desc,
      lower(p.username)
    limit 8;
end;
$function$;
