create extension if not exists pgcrypto;

-- Day 1 (API security): server-verified manager approval for online privileged terminal actions
-- (inventory writes, open-check discount approval). Replaces trusting a client-supplied
-- manager_id + manager_approved_at timestamp with a short-lived, single-use token the terminal
-- must first obtain by submitting the approving manager's PIN to the server, verified against
-- that employee's own stored PBKDF2 verifier (terminal_employees.pin_salt/pin_hash) -- the same
-- primitive terminal-auth/security.ts already uses for cashier login, never a new one.
--
-- Bound to store + device + action + the exact payload being approved (payload_hash), so a token
-- issued for one discount can't be replayed against a different one, a different device, or a
-- different kind of action. consumed_at makes it single-use; expires_at makes it short-lived.
-- Never stores the PIN itself, only a hash of the random approval token (same digest() pattern as
-- every other terminal credential in this schema).
create table public.terminal_manager_approvals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  device_id uuid not null,
  manager_id uuid not null,
  action text not null,
  payload_hash text not null,
  token_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  unique (store_id, token_hash),
  foreign key (store_id, device_id) references public.terminal_devices(store_id, id),
  foreign key (store_id, manager_id) references public.terminal_employees(store_id, id)
);

-- Fast "is this token still usable" lookup; consumed/expired rows fall out of the index's own
-- predicate rather than needing a separate cleanup job for correctness (a cron to delete old rows
-- is still worth adding operationally, but isn't required for the approval check itself to work).
create index terminal_manager_approvals_active on public.terminal_manager_approvals(store_id, token_hash)
  where consumed_at is null;

alter table public.terminal_manager_approvals enable row level security;
-- Service-role only, same convention as terminal_cashier_sessions/terminal_device_sessions: a
-- PIN-approval token is exactly the kind of credential that must never be readable through a
-- client-side Supabase query.
create policy terminal_manager_approvals_service_role_only on public.terminal_manager_approvals
  for all to authenticated, anon using (false);
