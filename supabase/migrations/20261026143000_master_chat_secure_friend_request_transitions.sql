create or replace function public.aeroshell_validate_friend_request_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is null
     or old.recipient_id is distinct from (select auth.uid())
     or new.recipient_id is distinct from old.recipient_id
     or new.requester_id is distinct from old.requester_id
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at
     or old.status <> 'pending'
     or new.status not in ('accepted', 'declined') then
    raise exception 'Only the recipient may accept or decline an unchanged pending friend request.'
      using errcode = '42501';
  end if;
  new.responded_at := now();
  return new;
end;
$$;

revoke all on function public.aeroshell_validate_friend_request_transition() from public, anon, authenticated;
drop trigger if exists aeroshell_validate_friend_request_transition_before_update on public.aeroshell_friend_requests;
create trigger aeroshell_validate_friend_request_transition_before_update
before update on public.aeroshell_friend_requests
for each row execute function public.aeroshell_validate_friend_request_transition();