-- Feature B4 — Delivery and Rider workspace. Additive only: one 1:1 details table keyed off
-- pos_orders (delivery-type orders only), an append-only status-transition audit trail, and a
-- store-scoped composite FK from the rider assignment into terminal_employees, same convention
-- restaurant_tables.assigned_waiter_id already uses (202609230002_table_waiter_assignment.sql).
--
-- Customer/contact/address/instructions are stored as an immutable snapshot taken at order time
-- (delivery_orders.*_snapshot columns below), never a live join to pos_customers — a customer's
-- address can change after the order is placed, and the delivery record must keep showing what
-- was true when the order was dispatched, matching pos_order_items' own snapshot_* convention.

create table public.delivery_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  order_id uuid not null,

  -- Immutable snapshot, captured once at creation and never rewritten by later customer edits.
  recipient_name_snapshot text not null check (length(trim(recipient_name_snapshot)) between 1 and 120),
  contact_phone_snapshot text not null check (contact_phone_snapshot ~ '^[1-9][0-9]{3,14}$'),
  address_snapshot text not null check (length(trim(address_snapshot)) between 1 and 400),
  delivery_instructions_snapshot text check (delivery_instructions_snapshot is null or length(delivery_instructions_snapshot) <= 500),

  rider_id uuid,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'picked_up', 'out_for_delivery', 'delivered', 'failed')),
  failure_reason text check (failure_reason is null or length(failure_reason) <= 300),

  -- Optimistic-concurrency / idempotency marker: the operation_id of the last transition request
  -- that was actually applied to this row. A replay of that exact request (same operation_id) is
  -- recognized as already-done and returns the current state instead of double-applying or
  -- erroring; a different operation_id targeting a status the row has already moved past is a
  -- genuine stale-write conflict (see delivery.ts's applyDeliveryTransition). Mirrors the
  -- operation-id idempotency pattern used elsewhere in this codebase for exactly-once writes
  -- (pos_operation_ledger), applied here directly on the row rather than a separate ledger table,
  -- since a delivery only ever has one transition "in flight" at a time.
  last_operation_id uuid,

  accepted_at timestamptz,
  picked_up_at timestamptz,
  out_for_delivery_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (store_id, id),
  unique (store_id, order_id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id),
  foreign key (store_id, rider_id) references public.terminal_employees(store_id, id)
);
create index delivery_orders_store_status on public.delivery_orders(store_id, status);
create index delivery_orders_rider on public.delivery_orders(store_id, rider_id) where rider_id is not null;

-- Append-only audit trail: who/when for every transition and every assign/unassign, satisfying
-- the "server-authoritative, audited" requirement independently of the mutable row above. Never
-- updated or deleted.
create table public.delivery_status_events (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  delivery_order_id uuid not null,
  from_status text,
  to_status text not null,
  actor_type text not null check (actor_type in ('rider', 'manager', 'system')),
  -- actor_id is a terminal_employees.id for actor_type='rider', an auth.users.id for 'manager',
  -- and null for 'system'. Not a single FK (it references two different tables depending on
  -- actor_type), matching how audit_log.actor_id already documents a similarly loose reference.
  actor_id uuid,
  operation_id uuid not null,
  note text check (note is null or length(note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (store_id, delivery_order_id) references public.delivery_orders(store_id, id)
);
create index delivery_status_events_by_order on public.delivery_status_events(store_id, delivery_order_id, created_at);

-- RLS: same member-read / API-service-role-write convention as every other restaurant table
-- (restaurant_foundation.sql, shifts, etc). No client role gets insert/update/delete.
alter table public.delivery_orders enable row level security;
alter table public.delivery_status_events enable row level security;
grant select on public.delivery_orders, public.delivery_status_events to authenticated;
create policy delivery_orders_member_read on public.delivery_orders for select to authenticated using (public.is_store_member(store_id));
create policy delivery_status_events_member_read on public.delivery_status_events for select to authenticated using (public.is_store_member(store_id));

-- 'delivery' capability: extend terminal_employees.role's already-open set (rider exists since
-- 202609260002_staff_roles_and_shifts.sql, with zero capabilities). No schema change needed for
-- the capability itself -- that mapping lives in packages/domain/src/staff-role.ts, not the
-- database, exactly as that migration's own comment says.
