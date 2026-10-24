-- Group creation validates every input in SQL and uses caller-scoped RLS.
alter function public.aeroshell_create_group(text, text, uuid[]) security invoker;

drop policy if exists "Group admins can add members and creators can start a group" on public.aeroshell_group_members;
create policy "Group admins can add members and creators can start a group"
on public.aeroshell_group_members for insert to authenticated
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
