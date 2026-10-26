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
    order by lower(p.username)
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
