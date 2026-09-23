-- Restaurant POS Transformation — Day 2: order persistence + Kitchen Display System
-- (Blueprint docs/09, "Day 2 — Orders + Front of House + Kitchen", Ahmed's half).
-- Additive only: two new columns on pos_orders, two new tables. Does not touch pos_stock,
-- pos_payments, pos_refunds, or any existing checkout constraint beyond the two additions below.
-- References Day 1's restaurant_tables/kitchen_stations (202609210001) — no dependency on
-- Bisma's Day 2 work, which only starts writing to restaurant_tables.status.

-- 1. Order type + table on pos_orders. order_type mirrors packages/domain/src/order-type.ts's
-- OrderType exactly — do not add a value here without updating that file, and vice versa.
-- Defaults to 'dine_in' so every historical order (all pre-dating order-type awareness) and any
-- offline sale already queued in a cashier's outbox from before this deploy still validates and
-- syncs unchanged. table_id is nullable and only meaningful for dine-in; the check constraint
-- enforces that invariant at the database level, not just in application/API code.
alter table public.pos_orders
  add column order_type text not null default 'dine_in' check (order_type in ('dine_in', 'takeaway', 'delivery')),
  add column table_id uuid,
  add constraint pos_orders_table_only_for_dine_in check (table_id is null or order_type = 'dine_in'),
  add constraint pos_orders_table_fkey foreign key (store_id, table_id) references public.restaurant_tables(store_id, id);

-- 2. Kitchen tickets — one per order. Carries table_id redundantly (also on pos_orders) so the
-- KDS can render "which table" without joining back through pos_orders for the common case.
create table public.kitchen_tickets (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  order_id uuid not null,
  table_id uuid,
  status text not null default 'queued' check (status in ('queued', 'preparing', 'ready', 'served', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, order_id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id),
  foreign key (store_id, table_id) references public.restaurant_tables(store_id, id)
);
create index kitchen_tickets_by_store_status on public.kitchen_tickets(store_id, status);

-- 3. Kitchen ticket items — one per order line, tagged with the line's kitchen station (from
-- Day 1's pos_products.station_id) so the KDS can group/filter by station. station_id is
-- nullable for the same reason pos_products.station_id is: not every item has one assigned yet.
-- order_item_id references pos_order_items(id) as a plain (non-composite) FK: pos_order_items
-- has no (store_id, id) unique constraint to hang a tenant-scoped FK off, and every ticket item
-- here is created server-side in the same transaction as its order — from a store_id we already
-- validated — so adding a new constraint to the checkout-critical pos_order_items table isn't
-- justified just for this.
create table public.kitchen_ticket_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ticket_id uuid not null,
  order_item_id uuid not null references public.pos_order_items(id),
  station_id uuid,
  status text not null default 'queued' check (status in ('queued', 'preparing', 'ready', 'served', 'cancelled')),
  fired_at timestamptz,
  ready_at timestamptz,
  served_at timestamptz,
  unique (store_id, order_item_id),
  foreign key (store_id, ticket_id) references public.kitchen_tickets(store_id, id),
  foreign key (store_id, station_id) references public.kitchen_stations(store_id, id)
);
create index kitchen_ticket_items_by_ticket on public.kitchen_ticket_items(store_id, ticket_id);
create index kitchen_ticket_items_by_station on public.kitchen_ticket_items(store_id, station_id);

-- 4. RLS — same member-read pattern as every other Day 1/2 restaurant table; writes go through
-- the API only (service-role connection), matching the existing convention for these tables.
alter table public.kitchen_tickets enable row level security;
alter table public.kitchen_ticket_items enable row level security;
grant select on public.kitchen_tickets, public.kitchen_ticket_items to authenticated;
create policy kitchen_tickets_member_read on public.kitchen_tickets for select to authenticated using (public.is_store_member(store_id));
create policy kitchen_ticket_items_member_read on public.kitchen_ticket_items for select to authenticated using (public.is_store_member(store_id));
