-- Optimize Auth identity lookups in chat message policies.
-- This migration has already been applied to the windows-12-beta-chat database.

drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages"
on public.aeroshell_messages for select to authenticated
using ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id);

drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself"
on public.aeroshell_messages for insert to authenticated
with check ((select auth.uid()) = sender_id and (select auth.uid()) <> recipient_id and char_length(btrim(body)) between 1 and 2000);
