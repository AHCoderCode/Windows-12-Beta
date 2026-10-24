-- Repair Master Chat Storage upload RLS checks without relaxing bucket privacy.
-- Storage can evaluate the INSERT policy before metadata.size is available.
-- When size metadata is present validate it; the private bucket enforces the 15 MiB cap
-- and public.aeroshell_messages validates the final attachment_size before linking an upload.
drop policy if exists "Participants can upload Master Chat attachments" on storage.objects;

create policy "Participants can upload Master Chat attachments"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'master-chat-attachments'
  and coalesce(metadata ->> 'mimetype', '') not like 'video/%'
  and (
    nullif(metadata ->> 'size', '') is null
    or (
      (metadata ->> 'size') ~ '^[0-9]+$'
      and (metadata ->> 'size')::bigint between 1 and 15728640
    )
  )
  and split_part(name, '/', array_length(string_to_array(name, '/'), 1))
      !~* '[.](mp4|mov|m4v|mkv|avi|mpeg|mpg|3gp|ogv)$'
  and (
    split_part(name, '/', array_length(string_to_array(name, '/'), 1)) !~* '[.]webm$'
    or coalesce(metadata ->> 'mimetype', '') like 'audio/%'
  )
  and (
    (
      (storage.foldername(name))[1] = 'direct'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and (storage.foldername(name))[3] <> (select auth.uid())::text
      and exists (
        select 1 from public.aeroshell_profiles p
        where p.id::text = (storage.foldername(objects.name))[3]
      )
    )
    or (
      (storage.foldername(name))[1] = 'groups'
      and (storage.foldername(name))[3] = (select auth.uid())::text
      and private.aeroshell_group_is_member(
        case
          when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid
          else null
        end,
        (select auth.uid())
      )
    )
  )
);
