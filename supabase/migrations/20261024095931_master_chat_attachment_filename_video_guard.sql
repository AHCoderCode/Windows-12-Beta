-- Disallow common video formats by extension at both the message and Storage boundaries.
-- Voice notes may use audio/webm and remain allowed as message_type='voice'.
alter table public.aeroshell_messages drop constraint if exists aeroshell_messages_body_check;
alter table public.aeroshell_messages add constraint aeroshell_messages_body_check check (
  (message_type = 'text' and char_length(btrim(body)) between 1 and 2000
    and attachment_path is null and attachment_name is null and attachment_mime is null
    and attachment_size is null and voice_duration_ms is null)
  or (message_type = 'file' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_name !~* '[.](mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$'
    and attachment_mime is not null and char_length(attachment_mime) between 1 and 120
    and attachment_mime not like 'video/%' and attachment_size between 1 and 15728640 and voice_duration_ms is null)
  or (message_type = 'voice' and char_length(body) <= 2000 and attachment_path is not null
    and attachment_name is not null and char_length(attachment_name) between 1 and 200
    and attachment_mime like 'audio/%' and attachment_size between 1 and 15728640
    and voice_duration_ms between 1 and 120000)
);
drop policy if exists "Send messages as yourself" on public.aeroshell_messages;
create policy "Send messages as yourself" on public.aeroshell_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and ((group_id is null and recipient_id is not null and recipient_id <> (select auth.uid())
        and exists (select 1 from public.aeroshell_profiles p where p.id = recipient_id))
    or (group_id is not null and recipient_id is null and private.aeroshell_group_is_member(group_id, (select auth.uid()))))
  and ((message_type = 'text' and char_length(btrim(body)) between 1 and 2000)
    or (message_type = 'file' and attachment_path is not null and attachment_mime not like 'video/%'
        and attachment_name !~* '[.](mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|3gp|ogv)$'
        and attachment_size between 1 and 15728640)
    or (message_type = 'voice' and attachment_path is not null and attachment_mime like 'audio/%'
        and attachment_size between 1 and 15728640 and voice_duration_ms between 1 and 120000))
);
drop policy if exists "Participants can upload Master Chat attachments" on storage.objects;
create policy "Participants can upload Master Chat attachments" on storage.objects for insert to authenticated
with check (
  bucket_id = 'master-chat-attachments'
  and coalesce(metadata ->> 'mimetype', '') not like 'video/%'
  and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 15728640
  and split_part(name, '/', array_length(string_to_array(name, '/'), 1)) !~* '[.](mp4|mov|m4v|mkv|avi|mpeg|mpg|3gp|ogv)$'
  and (split_part(name, '/', array_length(string_to_array(name, '/'), 1)) !~* '[.]webm$'
       or coalesce(metadata ->> 'mimetype', '') like 'audio/%')
  and (
    ((storage.foldername(name))[1] = 'direct'
      and (storage.foldername(name))[2] = (select auth.uid())::text
      and (storage.foldername(name))[3] <> (select auth.uid())::text
      and exists (select 1 from public.aeroshell_profiles p where p.id::text = (storage.foldername(name))[3]))
    or ((storage.foldername(name))[1] = 'groups'
      and (storage.foldername(name))[3] = (select auth.uid())::text
      and private.aeroshell_group_is_member(
        case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then ((storage.foldername(name))[2])::uuid else null end, (select auth.uid())))
  )
);
