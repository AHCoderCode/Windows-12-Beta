-- AeroShell Master Chat: Supabase schema
-- Run once in Supabase Dashboard > SQL Editor for the project used by Master Chat.
-- Then disable email confirmation in Authentication > Sign In / Providers > Email,
-- because this username-only beta uses non-deliverable app identities for Supabase Auth.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.aeroshell_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now(),
  constraint aeroshell_profiles_username_format check (username ~ '^[a-z0-9_]{3,20}$')
);

create table if not exists public.aeroshell_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.aeroshell_profiles (id) on delete cascade,
  recipient_id uuid not null references public.aeroshell_profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint aeroshell_no_self_message check (sender_id <> recipient_id)
);

create index if not exists aeroshell_messages_sender_created_idx on public.aeroshell_messages (sender_id, created_at desc);
create index if not exists aeroshell_messages_recipient_created_idx on public.aeroshell_messages (recipient_id, created_at desc);

alter table public.aeroshell_profiles enable row level security;
alter table public.aeroshell_messages enable row level security;

grant usage on schema public to authenticated;
grant select on public.aeroshell_profiles to authenticated;
grant select, insert on public.aeroshell_messages to authenticated;

drop policy if exists "Authenticated users can discover profiles" on public.aeroshell_profiles;
create policy "Authenticated users can discover profiles" on public.aeroshell_profiles for select to authenticated using (true);

drop policy if exists "Participants can read their own messages" on public.aeroshell_messages;
create policy "Participants can read their own messages" on public.aeroshell_messages for select to authenticated using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check (auth.uid() = sender_id and auth.uid() <> recipient_id and char_length(btrim(body)) between 1 and 2000);

create or replace function public.aeroshell_create_master_chat_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  requested_username text;
begin
  if new.raw_user_meta_data ->> 'aeroshell_chat' is distinct from 'true' then return new; end if;
  requested_username := lower(trim(new.raw_user_meta_data ->> 'username'));
  if requested_username is null or requested_username !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'Username must be 3–20 letters, numbers or underscores.';
  end if;
  insert into public.aeroshell_profiles (id, username) values (new.id, requested_username);
  return new;
end;
$$;

drop trigger if exists aeroshell_auth_user_profile on auth.users;
create trigger aeroshell_auth_user_profile after insert on auth.users
for each row execute function public.aeroshell_create_master_chat_profile();

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aeroshell_messages') then
    alter publication supabase_realtime add table public.aeroshell_messages;
  end if;
end;
$$;

-- Private Realtime presence is restricted to authenticated chat accounts.
drop policy if exists "Authenticated users can access the Master Chat presence channel" on realtime.messages;
drop policy if exists "Authenticated users can read the Master Chat presence channel" on realtime.messages;
drop policy if exists "Authenticated users can publish to the Master Chat presence channel" on realtime.messages;
create policy "Authenticated users can read the Master Chat presence channel"
  on realtime.messages for select to authenticated using (true);
create policy "Authenticated users can publish to the Master Chat presence channel"
  on realtime.messages for insert to authenticated with check (true);

-- Never put the Supabase service-role/secret key in browser code.
