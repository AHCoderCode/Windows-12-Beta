-- Guard Master Chat data APIs against still-unexpired JWTs after a user deletes their account.
-- Supabase Auth access tokens remain valid until expiry, so checking auth.users in RLS
-- prevents a deleted account's old token from continuing to enumerate profiles or chat data.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.aeroshell_chat_actor_is_valid()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and exists (
       select 1
       from auth.users as u
       where u.id = (select auth.uid())
     );
$$;

revoke all on function private.aeroshell_chat_actor_is_valid() from public, anon;
grant execute on function private.aeroshell_chat_actor_is_valid() to authenticated;

-- Profiles
drop policy if exists "Authenticated users can discover profiles" on public.aeroshell_profiles;
create policy "Authenticated users can discover profiles"
on public.aeroshell_profiles for select to authenticated
using (private.aeroshell_chat_actor_is_valid());

drop policy if exists "Users can update their own profile avatar" on public.aeroshell_profiles;
create policy "Users can update their own profile avatar"
on public.aeroshell_profiles for update to authenticated
using (private.aeroshell_chat_actor_is_valid() and (select auth.uid()) = id)
with check (private.aeroshell_chat_actor_is_valid() and (select auth.uid()) = id);

-- Messages
drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages"
on public.aeroshell_messages for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and ((select auth.uid()) = sender_id or (select auth.uid()) = recipient_id)
  and not exists (
    select 1
    from public.aeroshell_message_hides h
    where h.message_id = aeroshell_messages.id
      and h.user_id = (select auth.uid())
  )
);

drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself"
on public.aeroshell_messages for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and (select auth.uid()) = sender_id
  and (select auth.uid()) <> recipient_id
  and char_length(btrim(body)) between 1 and 2000
);

drop policy if exists "Senders can delete their own messages for everyone" on public.aeroshell_messages;
create policy "Senders can delete their own messages for everyone"
on public.aeroshell_messages for delete to authenticated
using (private.aeroshell_chat_actor_is_valid() and (select auth.uid()) = sender_id);

-- Per-user hidden messages
drop policy if exists "Users can read their own message hides" on public.aeroshell_message_hides;
create policy "Users can read their own message hides"
on public.aeroshell_message_hides for select to authenticated
using (private.aeroshell_chat_actor_is_valid() and (select auth.uid()) = user_id);

drop policy if exists "Users can hide messages only for themselves" on public.aeroshell_message_hides;
create policy "Users can hide messages only for themselves"
on public.aeroshell_message_hides for insert to authenticated
with check (private.aeroshell_chat_actor_is_valid() and (select auth.uid()) = user_id);

-- Voice-call records
drop policy if exists "Participants can read their own calls" on public.aeroshell_calls;
create policy "Participants can read their own calls"
on public.aeroshell_calls for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
);

drop policy if exists "Users can create calls as themselves" on public.aeroshell_calls;
create policy "Users can create calls as themselves"
on public.aeroshell_calls for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and (select auth.uid()) = caller_id
  and caller_id <> callee_id
  and status = 'ringing'
);

drop policy if exists "Participants can change call status" on public.aeroshell_calls;
create policy "Participants can change call status"
on public.aeroshell_calls for update to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
)
with check (
  private.aeroshell_chat_actor_is_valid()
  and ((select auth.uid()) = caller_id or (select auth.uid()) = callee_id)
  and status in ('ringing', 'accepted', 'rejected', 'ended')
);

-- Voice signaling
drop policy if exists "Call participants can read signaling for their call" on public.aeroshell_call_signals;
create policy "Call participants can read signaling for their call"
on public.aeroshell_call_signals for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and ((select auth.uid()) = c.caller_id or (select auth.uid()) = c.callee_id)
  )
  and ((select auth.uid()) = from_user_id or (select auth.uid()) = to_user_id)
);

drop policy if exists "Participants can send signaling only to the other participant" on public.aeroshell_call_signals;
create policy "Participants can send signaling only to the other participant"
on public.aeroshell_call_signals for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and (select auth.uid()) = from_user_id
  and from_user_id <> to_user_id
  and exists (
    select 1 from public.aeroshell_calls c
    where c.id = aeroshell_call_signals.call_id
      and c.status in ('ringing', 'accepted')
      and (
        (c.caller_id = (select auth.uid()) and c.callee_id = aeroshell_call_signals.to_user_id)
        or (c.callee_id = (select auth.uid()) and c.caller_id = aeroshell_call_signals.to_user_id)
      )
      and (
        aeroshell_call_signals.kind = 'ice'
        or (aeroshell_call_signals.kind = 'offer' and c.caller_id = (select auth.uid()))
        or (aeroshell_call_signals.kind = 'answer' and c.callee_id = (select auth.uid()) and c.status = 'accepted')
      )
  )
);

-- TURN credential requests
drop policy if exists "Participants can request relay credentials for an active call" on public.aeroshell_turn_credential_requests;
create policy "Participants can request relay credentials for an active call"
on public.aeroshell_turn_credential_requests for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and (select auth.uid()) = user_id
  and exists (
    select 1
    from public.aeroshell_calls c
    where c.id = aeroshell_turn_credential_requests.call_id
      and c.status in ('ringing', 'accepted')
      and ((select auth.uid()) = c.caller_id or (select auth.uid()) = c.callee_id)
      and (c.status <> 'ringing' or c.created_at > (clock_timestamp() - interval '45 seconds'))
  )
);

-- Private Realtime policies must also reject a deleted user's still-valid JWT.
drop policy if exists "Authenticated users can read the Master Chat presence channel" on realtime.messages;
create policy "Authenticated users can read the Master Chat presence channel"
on realtime.messages for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and (select realtime.topic()) = 'aeroshell-master-chat-presence'
  and realtime.messages.extension = 'presence'
);

drop policy if exists "Authenticated users can publish to the Master Chat presence channel" on realtime.messages;
create policy "Authenticated users can publish to the Master Chat presence channel"
on realtime.messages for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and (select realtime.topic()) = 'aeroshell-master-chat-presence'
  and realtime.messages.extension = 'presence'
);

drop policy if exists "Authenticated users can access their Master Chat conversation channels" on realtime.messages;
create policy "Authenticated users can access their Master Chat conversation channels"
on realtime.messages for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and (
    (select realtime.topic()) like 'aeroshell-conversation-' || (select auth.uid())::text || '-%'
    or (select realtime.topic()) like 'aeroshell-conversation-%-' || (select auth.uid())::text
  )
);

drop policy if exists "Authenticated users can access Master Chat call signaling channel" on realtime.messages;
create policy "Authenticated users can access Master Chat call signaling channel"
on realtime.messages for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and (select realtime.topic()) = 'aeroshell-master-chat-calls'
);
