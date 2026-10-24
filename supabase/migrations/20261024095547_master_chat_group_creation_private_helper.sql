-- The public endpoint remains SECURITY INVOKER. Only this private helper uses
-- SECURITY DEFINER, with strict auth/profile/input validation and fully-qualified SQL.
create or replace function private.aeroshell_create_group_impl(
  p_name text,
  p_avatar_data text default null,
  p_member_ids uuid[] default '{}'::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  clean_name text := btrim(coalesce(p_name, ''));
  new_group_id uuid;
  requested_count integer;
  valid_count integer;
begin
  if actor is null or not private.aeroshell_chat_actor_is_valid()
     or not exists (select 1 from public.aeroshell_profiles p where p.id = actor) then
    raise exception 'A signed-in Master Chat profile is required.' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 60 then
    raise exception 'Group names must contain 1–60 characters.' using errcode = '22023';
  end if;
  if p_avatar_data is not null and (
    length(p_avatar_data) > 60000
    or p_avatar_data !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
  ) then
    raise exception 'Choose a valid, compressed group image.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_member_ids), 0) > 99 then
    raise exception 'A group can have up to 100 members, including its creator.' using errcode = '22023';
  end if;
  select count(distinct m) into requested_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m
    where m is not null and m <> actor;
  select count(distinct m) into valid_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m
    join public.aeroshell_profiles p on p.id = m where m is not null and m <> actor;
  if requested_count <> valid_count then
    raise exception 'One or more selected accounts no longer exist.' using errcode = '22023';
  end if;
  insert into public.aeroshell_groups (name, avatar_data, created_by)
    values (clean_name, p_avatar_data, actor) returning id into new_group_id;
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by)
    values (new_group_id, actor, 'admin', actor);
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by)
    select new_group_id, p.id, 'member', actor from public.aeroshell_profiles p
    where p.id = any(coalesce(p_member_ids, '{}'::uuid[])) and p.id <> actor
    on conflict (group_id, user_id) do nothing;
  return new_group_id;
end;
$$;
revoke all on function private.aeroshell_create_group_impl(text, text, uuid[]) from public, anon;
grant execute on function private.aeroshell_create_group_impl(text, text, uuid[]) to authenticated;

create or replace function public.aeroshell_create_group(
  p_name text,
  p_avatar_data text default null,
  p_member_ids uuid[] default '{}'::uuid[]
)
returns uuid language sql security invoker set search_path = ''
as $$ select private.aeroshell_create_group_impl(p_name, p_avatar_data, p_member_ids); $$;
revoke all on function public.aeroshell_create_group(text, text, uuid[]) from public, anon;
grant execute on function public.aeroshell_create_group(text, text, uuid[]) to authenticated;
