-- Master Chat groups, secure attachments, voice notes and group administration.
-- Applied to project windows-12-beta-chat on 2026-10-24.
-- Existing direct chats remain valid; attachments are stored in a private bucket.

create schema if not exists private;
grant usage on schema private to authenticated;

create table if not exists public.aeroshell_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  avatar_data text,
  created_by uuid not null references public.aeroshell_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint aeroshell_groups_name_check check (char_length(btrim(name)) between 1 and 60),
  constraint aeroshell_groups_avatar_check check (
    avatar_data is null or (
      length(avatar_data) <= 60000
      and avatar_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
    )
  )
);
create index if not exists aeroshell_groups_created_by_idx on public.aeroshell_groups(created_by, created_at desc);

create table if not exists public.aeroshell_group_members (
  group_id uuid not null references public.aeroshell_groups(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  added_by uuid not null references public.aeroshell_profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists aeroshell_group_members_user_idx on public.aeroshell_group_members(user_id, joined_at desc);
create index if not exists aeroshell_group_members_group_role_idx on public.aeroshell_group_members(group_id, role);
alter table public.aeroshell_groups enable row level security;
alter table public.aeroshell_group_members enable row level security;
grant select on public.aeroshell_groups to authenticated;
grant insert (name, avatar_data, created_by) on public.aeroshell_groups to authenticated;
grant update (name, avatar_data, updated_at) on public.aeroshell_groups to authenticated;
grant delete on public.aeroshell_groups to authenticated;
grant select, insert, update, delete on public.aeroshell_group_members to authenticated;

create or replace function private.aeroshell_group_is_member(p_group_id uuid, p_actor_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_actor_id is not null and p_actor_id = (select auth.uid())
    and private.aeroshell_chat_actor_is_valid()
    and exists (select 1 from public.aeroshell_group_members gm
                where gm.group_id = p_group_id and gm.user_id = p_actor_id);
$$;
create or replace function private.aeroshell_group_is_admin(p_group_id uuid, p_actor_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select p_actor_id is not null and p_actor_id = (select auth.uid())
    and private.aeroshell_chat_actor_is_valid()
    and exists (select 1 from public.aeroshell_group_members gm
                where gm.group_id = p_group_id and gm.user_id = p_actor_id and gm.role = 'admin');
$$;
revoke all on function private.aeroshell_group_is_member(uuid, uuid) from public, anon;
revoke all on function private.aeroshell_group_is_admin(uuid, uuid) from public, anon;
grant execute on function private.aeroshell_group_is_member(uuid, uuid) to authenticated;
grant execute on function private.aeroshell_group_is_admin(uuid, uuid) to authenticated;

drop policy if exists "Members can read their own groups" on public.aeroshell_groups;
create policy "Members can read their own groups" on public.aeroshell_groups for select to authenticated
using (private.aeroshell_group_is_member(id, (select auth.uid())));
drop policy if exists "Users can create groups as themselves" on public.aeroshell_groups;
create policy "Users can create groups as themselves" on public.aeroshell_groups for insert to authenticated
with check (
  created_by = (select auth.uid())
  and exists (select 1 from public.aeroshell_profiles p where p.id = (select auth.uid()))
  and char_length(btrim(name)) between 1 and 60
);
drop policy if exists "Group admins can update group details" on public.aeroshell_groups;
create policy "Group admins can update group details" on public.aeroshell_groups for update to authenticated
using (private.aeroshell_group_is_admin(id, (select auth.uid())))
with check (
  private.aeroshell_group_is_admin(id, (select auth.uid()))
  and char_length(btrim(name)) between 1 and 60
);
drop policy if exists "Only group creators can delete groups" on public.aeroshell_groups;
create policy "Only group creators can delete groups" on public.aeroshell_groups for delete to authenticated
using (created_by = (select auth.uid()) and private.aeroshell_chat_actor_is_valid());

drop policy if exists "Group members can read the group roster" on public.aeroshell_group_members;
create policy "Group members can read the group roster" on public.aeroshell_group_members for select to authenticated
using (private.aeroshell_group_is_member(group_id, (select auth.uid())));
drop policy if exists "Group admins can add members and creators can start a group" on public.aeroshell_group_members;
create policy "Group admins can add members and creators can start a group" on public.aeroshell_group_members for insert to authenticated
with check (
  added_by = (select auth.uid())
  and (
    (
      user_id = (select auth.uid()) and role = 'admin'
      and exists (select 1 from public.aeroshell_groups g where g.id = aeroshell_group_members.group_id and g.created_by = (select auth.uid()))
      and not exists (select 1 from public.aeroshell_group_members gm where gm.group_id = aeroshell_group_members.group_id)
    )
    or (role = 'member' and private.aeroshell_group_is_admin(aeroshell_group_members.group_id, (select auth.uid())))
  )
);
drop policy if exists "Group admins can change member roles" on public.aeroshell_group_members;
create policy "Group admins can change member roles" on public.aeroshell_group_members for update to authenticated
using (private.aeroshell_group_is_admin(group_id, (select auth.uid())))
with check (private.aeroshell_group_is_admin(group_id, (select auth.uid())));
drop policy if exists "Group admins can remove members and members can leave" on public.aeroshell_group_members;
create policy "Group admins can remove members and members can leave" on public.aeroshell_group_members for delete to authenticated
using (user_id = (select auth.uid()) or private.aeroshell_group_is_admin(group_id, (select auth.uid())));

create or replace function public.aeroshell_guard_group_membership()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); admins_left integer;
begin
  if tg_op = 'INSERT' then
    if actor is null or not private.aeroshell_chat_actor_is_valid() or new.added_by is distinct from actor then
      raise exception 'A valid signed-in group actor is required.' using errcode = '42501';
    end if;
    if new.role = 'admin' and new.user_id = actor
       and exists (select 1 from public.aeroshell_groups g where g.id = new.group_id and g.created_by = actor)
       and not exists (select 1 from public.aeroshell_group_members gm where gm.group_id = new.group_id) then
      return new;
    end if;
    if new.role <> 'member' or not private.aeroshell_group_is_admin(new.group_id, actor) then
      raise exception 'Only a group admin can add members. New members start as regular members.' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if actor is null or not private.aeroshell_chat_actor_is_valid()
       or not private.aeroshell_group_is_admin(old.group_id, actor)
       or new.group_id is distinct from old.group_id or new.user_id is distinct from old.user_id
       or new.added_by is distinct from old.added_by or new.role not in ('admin', 'member') then
      raise exception 'Only a group admin may change a member role.' using errcode = '42501';
    end if;
    if old.role = 'admin' and new.role <> 'admin' then
      select count(*) into admins_left from public.aeroshell_group_members gm
      where gm.group_id = old.group_id and gm.role = 'admin' and gm.user_id <> old.user_id;
      if admins_left = 0 then raise exception 'A group must keep at least one admin.' using errcode = '23514'; end if;
    end if;
    return new;
  else
    if not exists (select 1 from public.aeroshell_groups g where g.id = old.group_id)
       or not private.aeroshell_chat_actor_is_valid() then return old; end if;
    if actor is null or (old.user_id <> actor and not private.aeroshell_group_is_admin(old.group_id, actor)) then
      raise exception 'Only a group admin can remove another member.' using errcode = '42501';
    end if;
    if old.role = 'admin' then
      select count(*) into admins_left from public.aeroshell_group_members gm
      where gm.group_id = old.group_id and gm.role = 'admin' and gm.user_id <> old.user_id;
      if admins_left = 0 then raise exception 'A group must keep at least one admin. Promote another member first.' using errcode = '23514'; end if;
    end if;
    return old;
  end if;
end;
$$;
revoke all on function public.aeroshell_guard_group_membership() from public, anon, authenticated;
drop trigger if exists aeroshell_guard_group_membership_before_write on public.aeroshell_group_members;
create trigger aeroshell_guard_group_membership_before_write
before insert or update or delete on public.aeroshell_group_members for each row
execute function public.aeroshell_guard_group_membership();

create or replace function public.aeroshell_create_group(p_name text, p_avatar_data text default null, p_member_ids uuid[] default '{}'::uuid[])
returns uuid language plpgsql security definer set search_path = ''
as $$
declare actor uuid := (select auth.uid()); clean_name text := btrim(coalesce(p_name, ''));
group_id uuid; requested_count integer; valid_count integer;
begin
  if actor is null or not private.aeroshell_chat_actor_is_valid()
     or not exists (select 1 from public.aeroshell_profiles p where p.id = actor) then
    raise exception 'A signed-in Master Chat profile is required.' using errcode = '42501';
  end if;
  if char_length(clean_name) not between 1 and 60 then raise exception 'Group names must contain 1–60 characters.' using errcode = '22023'; end if;
  if p_avatar_data is not null and (length(p_avatar_data) > 60000 or p_avatar_data !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$') then
    raise exception 'Choose a valid, compressed group image.' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_member_ids), 0) > 99 then raise exception 'A group can have up to 100 members, including its creator.' using errcode = '22023'; end if;
  select count(distinct m) into requested_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m where m is not null and m <> actor;
  select count(distinct m) into valid_count from unnest(coalesce(p_member_ids, '{}'::uuid[])) as m join public.aeroshell_profiles p on p.id = m where m is not null and m <> actor;
  if requested_count <> valid_count then raise exception 'One or more selected accounts no longer exist.' using errcode = '22023'; end if;
  insert into public.aeroshell_groups (name, avatar_data, created_by) values (clean_name, p_avatar_data, actor) returning id into group_id;
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by) values (group_id, actor, 'admin', actor);
  insert into public.aeroshell_group_members (group_id, user_id, role, added_by)
  select group_id, p.id, 'member', actor from public.aeroshell_profiles p
  where p.id = any(coalesce(p_member_ids, '{}'::uuid[])) and p.id <> actor
  on conflict (group_id, user_id) do nothing;
  return group_id;
end;
$$;
revoke all on function public.aeroshell_create_group(text, text, uuid[]) from public, anon;
grant execute on function public.aeroshell_create_group(text, text, uuid[]) to authenticated;

alter table public.aeroshell_messages alter column recipient_id drop not null;
alter table public.aeroshell_messages add column if not exists group_id uuid references public.aeroshell_groups(id) on delete cascade;
alter table public.aeroshell_messages add column if not exists message_type text not null default 'text';
alter table public.aeroshell_messages add column if not exists attachment_path text;
alter table public.aeroshell_messages add column if not exists attachment_name text;
alter table public.aeroshell_messages add column if not exists attachment_mime text;
alter table public.aeroshell_messages add column if not exists attachment_size bigint;
alter table public.aeroshell_messages add column if not exists voice_duration_ms integer;
alter table public.aeroshell_messages drop constraint if exists aeroshell_messages_body_check;
alter table public.aeroshell_messages drop constraint if exists aeroshell_no_self_message;
alter table public.aeroshell_messages add constraint aeroshell_no_self_message check (recipient_id is null or sender_id <> recipient_id);
alter table public.aeroshell_messages add constraint aeroshell_messages_conversation_shape check (
  (group_id is null and recipient_id is not null) or (group_id is not null and recipient_id is null)
);
alter table public.aeroshell_messages add constraint aeroshell_messages_body_check check (
  (message_type = 'text' and char_length(btrim(body)) between 1 and 2000
    and attachment_path is null and attachment_name is null and attachment_mime is null
    and attachment_size is null and voice_duration_ms is null)
  or (message_type = 'file' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime is not null and char_length(attachment_mime) between 1 and 120
    and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640 and voice_duration_ms is null)
  or (message_type = 'voice' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640
    and voice_duration_ms between 1 and 120000)
);
create index if not exists aeroshell_messages_group_created_idx on public.aeroshell_messages(group_id, created_at desc) where group_id is not null;
create index if not exists aeroshell_messages_attachment_path_idx on public.aeroshell_messages(attachment_path) where attachment_path is not null;
grant select, insert, delete on public.aeroshell_messages to authenticated;

drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages" on public.aeroshell_messages for select to authenticated
using (
  ((group_id is null and ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id))
    or (group_id is not null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and not exists (select 1 from public.aeroshell_message_hides h where h.message_id = aeroshell_messages.id and h.user_id = (select auth.uid()))
);
drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and ((group_id is null and recipient_id is not null and recipient_id <> (select auth.uid())
        and exists (select 1 from public.aeroshell_profiles p where p.id = recipient_id))
    or (group_id is not null and recipient_id is null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and ((message_type = 'text' and char_length(btrim(body)) between 1 and 2000)
    or (message_type = 'file' and attachment_path is not null and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640)
    or (message_type = 'voice' and attachment_path is not null and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640 and voice_duration_ms between 1 and 120000))
);
drop policy if exists "Senders can delete their own messages for everyone" on public.aeroshell_messages;
create policy "Senders can delete their own messages for everyone" on public.aeroshell_messages for delete to authenticated
using ((select auth.uid()) = sender_id);

create or replace function public.aeroshell_validate_message_hide()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is null or new.user_id is distinct from (select auth.uid()) or not private.aeroshell_chat_actor_is_valid() then
    raise exception 'A user may hide messages only for themselves.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.aeroshell_messages m where m.id = new.message_id and (
      (m.group_id is null and (m.sender_id = (select auth.uid()) or m.recipient_id = (select auth.uid())))
      or (m.group_id is not null and exists (select 1 from public.aeroshell_group_members gm where gm.group_id = m.group_id and gm.user_id = (select auth.uid())))
    )
  ) then raise exception 'Message not found or not accessible to this user.' using errcode = '42501'; end if;
  return new;
end;
$$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('master-chat-attachments', 'master-chat-attachments', false, 15728640, null)
on conflict (id) do update set public = false, file_size_limit = 15728640, allowed_mime_types = null;
drop policy if exists "Participants can read Master Chat attachments" on storage.objects;
create policy "Participants can read Master Chat attachments" on storage.objects for select to authenticated
using (
  bucket_id = 'master-chat-attachments'
  and (
    ((storage.foldername(name))[1] = 'direct'
      and ((storage.foldername(name))[2] = (select auth.uid())::text or (storage.foldername(name))[3] = (select auth.uid())::text))
    or ((storage.foldername(name))[1] = 'groups'
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);
drop policy if exists "Participants can upload Master Chat attachments" on storage.objects;
create policy "Participants can upload Master Chat attachments" on storage.objects for insert to authenticated
with check (
  bucket_id = 'master-chat-attachments'
  and coalesce(metadata ->> 'mimetype', '') not like 'video/%'
  and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 15728640
  and (
    ((storage.foldername(name))[1] = 'direct'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and (storage.foldername(name))[3] <> (select auth.uid())::text
      and exists (select 1 from public.aeroshell_profiles p where p.id::text = (storage.foldername(name))[3]))
    or ((storage.foldername(name))[1] = 'groups'
      and (storage.foldername(name))[3] = (select auth.uid())::text
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);
drop policy if exists "Uploaders can remove their own Master Chat attachments" on storage.objects;
create policy "Uploaders can remove their own Master Chat attachments" on storage.objects for delete to authenticated
using (
  bucket_id = 'master-chat-attachments'
  and (((storage.foldername(name))[1] = 'direct' and (storage.foldername(name))[2] = (select auth.uid())::text)
    or ((storage.foldername(name))[1] = 'groups' and (storage.foldername(name))[3] = (select auth.uid())::text))
);

drop policy if exists "Members can access Master Chat group updates" on realtime.messages;
create policy "Members can access Master Chat group updates" on realtime.messages for select to authenticated
using ((select realtime.topic()) = 'aeroshell-master-chat-groups');
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_groups') then alter publication supabase_realtime add table public.aeroshell_groups; end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_group_members') then alter publication supabase_realtime add table public.aeroshell_group_members; end if;
end;
$$;
