-- Cover foreign-key lookups used by call signaling and TURN quotas.
create index if not exists aeroshell_call_signals_from_user_idx
  on public.aeroshell_call_signals(from_user_id, created_at);
create index if not exists aeroshell_turn_requests_call_created_idx
  on public.aeroshell_turn_credential_requests(call_id, created_at desc);
