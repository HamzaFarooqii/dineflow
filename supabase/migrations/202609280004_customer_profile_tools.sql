-- CRM completion (B3): edit, soft-deactivate, merge, favorites/preferences with history.
--
-- Design notes:
-- * pos_customers gains `active` (soft delete -- order/loyalty history must never be orphaned by
--   a hard delete) and `updated_at` (bumped on every edit, matching the vendors/purchase_orders
--   convention in 202609280003_purchasing_vendors.sql).
-- * Favorites/preferences are an append-only event log (customer_preference_events), not a mutable
--   JSON blob -- the same "ledger, not a counter you overwrite" shape as loyalty_point_ledger and
--   stock_movements. Current state is derived by taking the latest event per (kind, label). Every
--   event records who added/removed it and when, satisfying "author attribution, immutable log".
-- * Merge is a single, explicit, manager-only action naming both profiles (never automatic on a
--   phone match): customer_merges is an immutable audit row (source, target, actor, reason, time),
--   unique on (store_id, source_customer_id) so a guest can only ever be merged away once --
--   that's what makes "moves loyalty balance and order associations exactly once" a database
--   guarantee, not just an application convention. The source profile is deactivated by the same
--   transaction; it is never deleted, so its order/loyalty history stays intact and attributable.

alter table public.pos_customers add column active boolean not null default true;
alter table public.pos_customers add column updated_at timestamptz not null default now();

-- Append-only favorites/preferences log. kind='favorite' is a short tag (e.g. a dish or drink);
-- kind='preference' is free text (e.g. allergy or seating note). action='add' rows are the
-- current entries; action='remove' rows record that a manager/staff member retired one, without
-- ever deleting the original row -- so "who added what, when" always stays answerable.
create table public.customer_preference_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  customer_id uuid not null,
  kind text not null check (kind in ('favorite', 'preference')),
  label text not null check (length(trim(label)) between 1 and 120),
  note text check (note is null or length(note) <= 500),
  action text not null check (action in ('add', 'remove')),
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, customer_id) references public.pos_customers(store_id, id)
);
create index customer_preference_events_by_customer on public.customer_preference_events(store_id, customer_id, created_at);

-- Immutable merge audit. A row here is the *only* way loyalty balance/orders ever move between
-- guests -- there is no trigger or automatic process that merges on a phone match.
create table public.customer_merges (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  source_customer_id uuid not null,
  target_customer_id uuid not null check (target_customer_id <> source_customer_id),
  actor_user_id uuid not null references auth.users(id),
  reason text not null check (length(trim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  -- A guest can be the *source* of a merge exactly once -- this is what makes the balance/order
  -- move "exactly once" a constraint the database enforces, not just application discipline.
  unique (store_id, source_customer_id),
  foreign key (store_id, source_customer_id) references public.pos_customers(store_id, id),
  foreign key (store_id, target_customer_id) references public.pos_customers(store_id, id)
);
create index customer_merges_by_target on public.customer_merges(store_id, target_customer_id);

alter table public.customer_preference_events enable row level security;
alter table public.customer_merges enable row level security;

-- Same "member read, write only through the API's service-role connection" convention as every
-- other restaurant table (see purchase_receipts, loyalty_point_ledger, ingredient_cost_history).
-- No update/delete grant is given at all -- these rows are immutable at the database level, not
-- merely by application convention.
grant select on public.customer_preference_events, public.customer_merges to authenticated;
create policy customer_preference_events_member_read on public.customer_preference_events for select to authenticated using (public.is_store_member(store_id));
create policy customer_merges_member_read on public.customer_merges for select to authenticated using (public.is_store_member(store_id));
