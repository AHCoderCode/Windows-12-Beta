-- Let authenticated users send a request to a profile returned by the
-- private username search function. A SELECT policy intentionally hides unrelated
-- profiles until there is a pending request, so checking profile existence through
-- an RLS-filtered SELECT here rejects every first-time friend request. The recipient
-- foreign key validates that the target profile actually exists.
drop policy if exists "Users can send friend requests as themselves" on public.aeroshell_friend_requests;

create policy "Users can send friend requests as themselves"
on public.aeroshell_friend_requests
for insert
to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and requester_id = (select auth.uid())
  and recipient_id <> (select auth.uid())
  and status = 'pending'
);
