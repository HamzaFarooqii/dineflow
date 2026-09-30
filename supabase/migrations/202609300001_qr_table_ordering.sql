-- QR table sessions and customer ordering (Day 1, Developer 2).
--
-- Additive only. Reuses open_checks / open_check_items as the single unpaid-tab model: a customer
-- submission is stored here first, then (after optional waiter confirmation) APPENDED to the
-- table's open check, tagged with open_check_items.qr_submission_id. Nothing here creates kitchen
-- tickets, payments or paid orders -- those still only happen when staff close the check.
--
-- Access model: every table below is written and read only through the API's service-role
-- connection. Customers never touch these tables directly (no anon/authenticated grants); staff
-- get member-read policies like the rest of the schema.

-- 1. Table identity. The public QR code itself is never stored -- only its sha256. The raw code is
--    shown to the manager once, at generate/rotate time. qr_generation is bumped on every
--    generate/rotate/revoke so previously issued customer sessions stop validating.
alter table public.restaurant_tables
  add column qr_code_hash text,
  add column qr_mode text not null default 'menu_and_order'
    check (qr_mode in ('menu_only', 'menu_and_order', 'waiter_only')),
  add column qr_require_confirmation boolean not null default true,
  add column qr_generation integer not null default 0 check (qr_generation >= 0),
  add column qr_rotated_at timestamptz;
create unique index restaurant_tables_qr_code_hash on public.restaurant_tables(qr_code_hash) where qr_code_hash is not null;

-- 2. Short-lived customer sessions. token_hash is sha256 of a random 32-byte token; the store and
--    table are fixed at issuance and never taken from later customer input.
create table public.qr_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  table_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  qr_generation integer not null check (qr_generation >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  unique (store_id, id),
  foreign key (store_id, table_id) references public.restaurant_tables(store_id, id)
);
create index qr_sessions_by_table on public.qr_sessions(store_id, table_id) where revoked_at is null;

-- 3. Customer submissions. lines holds the SERVER-RESOLVED, priced snapshot (never client prices).
--    (store_id, session_id, operation_id) is the replay key; payload_hash detects a reused
--    operation_id carrying different content.
create table public.qr_submissions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  session_id uuid not null,
  table_id uuid not null,
  operation_id uuid not null,
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  lines jsonb not null,
  customer_note text check (customer_note is null or length(customer_note) <= 300),
  subtotal_cents bigint not null check (subtotal_cents between 0 and 1000000000),
  tax_cents bigint not null check (tax_cents between 0 and 1000000000),
  check_id uuid,
  decided_at timestamptz,
  decided_by_employee_id uuid,
  decided_by_user_id uuid,
  auto_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  check ((status = 'pending') = (decided_at is null)),
  check ((status = 'confirmed') = (check_id is not null)),
  unique (store_id, id),
  unique (store_id, session_id, operation_id),
  foreign key (store_id, session_id) references public.qr_sessions(store_id, id),
  foreign key (store_id, table_id) references public.restaurant_tables(store_id, id),
  foreign key (store_id, check_id) references public.open_checks(store_id, id),
  foreign key (store_id, decided_by_employee_id) references public.terminal_employees(store_id, id)
);
create index qr_submissions_pending on public.qr_submissions(store_id, created_at) where status = 'pending';
create index qr_submissions_by_session on public.qr_submissions(store_id, session_id, created_at);

-- 4. Ownership tag on appended lines: which submission put this line on the check. Null for every
--    staff-entered line. Deleting a line (staff edit) simply drops the tag with it.
alter table public.open_check_items add column qr_submission_id uuid;
alter table public.open_check_items
  add foreign key (store_id, qr_submission_id) references public.qr_submissions(store_id, id);
create index open_check_items_by_submission on public.open_check_items(store_id, qr_submission_id) where qr_submission_id is not null;

-- 4b. Persist the catalog option id on a check line's modifier snapshot. closeOpenCheckCore must
--     hand createPaidOrder a real option id (it re-validates every modifier against the catalog);
--     until now it had none, so any open check carrying a modifier could not be closed. Nullable
--     for rows written before this migration (close falls back to its previous behavior for them).
alter table public.open_check_item_modifiers add column option_id uuid;

-- 5. Table lifecycle policy, enforced in the database so every code path (Floor, transfer/merge,
--    checkout, manager edits) is covered: the moment a table stops hosting a party -- cleaned for
--    the next party, dirty after payment, freed by transfer/merge, taken out of service, or
--    deactivated -- every customer session for it is revoked.
create function public.qr_revoke_sessions_on_table_change() returns trigger
language plpgsql as $$
begin
  if (new.status in ('available', 'dirty', 'reserved', 'out_of_service') or new.active = false)
     and (new.status is distinct from old.status or new.active is distinct from old.active) then
    update public.qr_sessions set revoked_at = now()
    where store_id = new.store_id and table_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
create trigger restaurant_tables_qr_revoke after update of status, active on public.restaurant_tables
  for each row execute function public.qr_revoke_sessions_on_table_change();

alter table public.qr_sessions enable row level security;
alter table public.qr_submissions enable row level security;

-- Sessions hold only token hashes: service-role only, explicit deny for client roles.
create policy qr_sessions_service_role_only on public.qr_sessions for all to authenticated, anon using (false);
grant select on public.qr_submissions to authenticated;
create policy qr_submissions_member_read on public.qr_submissions for select to authenticated using (public.is_store_member(store_id));
