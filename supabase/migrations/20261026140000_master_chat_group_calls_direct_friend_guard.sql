-- Keep one-to-one calls limited to accepted friends while allowing session-bound group-call legs.
drop policy if exists "Users can create calls as themselves" on public.aeroshell_calls;
create policy "Users can create calls as themselves"
on public.aeroshell_calls for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and caller_id = (select auth.uid())
  and caller_id <> callee_id
  and status = 'ringing'
  and (
    (
      group_call_id is null
      and private.aeroshell_are_friends(caller_id, callee_id)
    )
    or
    (
      group_call_id is not null
      and exists (
        select 1
        from public.aeroshell_group_calls gc
        join public.aeroshell_group_call_participants invite
          on invite.group_call_id = gc.id
         and invite.user_id = aeroshell_calls.callee_id
         and invite.status = 'invited'
        where gc.id = aeroshell_calls.group_call_id
          and gc.initiator_id = (select auth.uid())
          and gc.status = 'active'
          and gc.media_type = aeroshell_calls.media_type
          and private.aeroshell_group_is_member(gc.group_id, (select auth.uid()))
          and private.aeroshell_group_is_member(gc.group_id, aeroshell_calls.callee_id)
      )
    )
  )
);

-- Limit mutable columns on group-call records; RLS still restricts which rows each user can update.
revoke update on table public.aeroshell_group_calls from authenticated;
grant update (status, ended_at) on table public.aeroshell_group_calls to authenticated;
revoke update on table public.aeroshell_group_call_participants from authenticated;
grant update (status, responded_at) on table public.aeroshell_group_call_participants to authenticated;
