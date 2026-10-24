-- Allow each authenticated user to set an optional, bounded profile avatar.
alter table public.aeroshell_profiles
  add column if not exists avatar_data text;

alter table public.aeroshell_profiles
  drop constraint if exists aeroshell_profiles_avatar_data_valid;

alter table public.aeroshell_profiles
  add constraint aeroshell_profiles_avatar_data_valid
  check (
    avatar_data is null
    or (
      length(avatar_data) <= 60000
      and avatar_data ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$'
    )
  );

drop policy if exists "Users can update their own profile avatar" on public.aeroshell_profiles;
create policy "Users can update their own profile avatar"
  on public.aeroshell_profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Restrict client updates to the avatar column; usernames and profile IDs stay read-only.
grant update (avatar_data) on table public.aeroshell_profiles to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'aeroshell_profiles'
  ) then
    alter publication supabase_realtime add table public.aeroshell_profiles;
  end if;
end;
$$;
