-- Track per-recipient reads for direct and group messages without exposing
-- receipts outside the conversation participants.
create table if not exists public.aeroshell_message_reads (
  message_id uuid not null references public.aeroshell_messages(id) on delete cascade,
  user_id uuid not null references public.aeroshell_profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.aeroshell_message_reads enable row level security;
grant select, insert on public.aeroshell_message_reads to authenticated;

drop policy if exists "Participants can read message receipts" on public.aeroshell_message_reads;
create policy "Participants can read message receipts"
on public.aeroshell_message_reads
for select to authenticated
using (
  private.aeroshell_chat_actor_is_valid()
  and exists (
    select 1
    from public.aeroshell_messages m
    where m.id = aeroshell_message_reads.message_id
      and (
        (m.group_id is null and (
          (select auth.uid()) = m.sender_id
          or (select auth.uid()) = m.recipient_id
        ))
        or
        (m.group_id is not null and private.aeroshell_group_is_member(m.group_id, (select auth.uid())))
      )
  )
);

drop policy if exists "Recipients can mark messages as read" on public.aeroshell_message_reads;
create policy "Recipients can mark messages as read"
on public.aeroshell_message_reads
for insert to authenticated
with check (
  private.aeroshell_chat_actor_is_valid()
  and user_id = (select auth.uid())
  and exists (
    select 1
    from public.aeroshell_messages m
    where m.id = aeroshell_message_reads.message_id
      and m.sender_id <> (select auth.uid())
      and (
        (m.group_id is null and m.recipient_id = (select auth.uid()))
        or
        (m.group_id is not null and private.aeroshell_group_is_member(m.group_id, (select auth.uid())))
      )
  )
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'aeroshell_message_reads'
     ) then
    alter publication supabase_realtime add table public.aeroshell_message_reads;
  end if;
end
$$;
