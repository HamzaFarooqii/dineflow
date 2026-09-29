-- Open checks: a durable, store-scoped, pre-payment running tab. Until now every pos_orders row
-- was created already paid, in one transaction (see orders.ts's push()) -- there was no concept
-- of an in-progress, unpaid, editable sale (docs/09 and floor.ts both flag this gap explicitly).
-- This migration adds that layer without touching pos_orders/pos_payments/kitchen_tickets at
-- all: an open check only ever becomes a real order at close time, through the exact same
-- creation path push() already uses (same kitchen-ticket-fire, stock-decrement, loyalty timing).
-- Holding a check never fires the kitchen, moves stock, or touches loyalty -- only closing one
-- does, same as today.

create table public.open_checks (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  status text not null default 'open' check (status in ('open', 'closed', 'voided')),
  order_type text not null default 'dine_in' check (order_type in ('dine_in', 'takeaway', 'delivery')),
  table_id uuid,
  customer_id uuid,
  employee_id uuid,
  manager_id uuid,
  manager_approved_at timestamptz,
  version integer not null default 1 check (version > 0),
  subtotal_cents bigint not null default 0 check (subtotal_cents between 0 and 1000000000),
  discount_cents bigint not null default 0 check (discount_cents between 0 and 1000000000),
  tax_cents bigint not null default 0 check (tax_cents between 0 and 1000000000),
  service_charge_cents bigint not null default 0 check (service_charge_cents between 0 and 1000000000),
  total_cents bigint not null default 0 check (total_cents between 0 and 1000000000),
  notes text check (notes is null or length(notes) <= 500),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_order_id uuid,
  voided_at timestamptz,
  voided_by_employee_id uuid,
  check (table_id is null or order_type = 'dine_in'),
  check (total_cents = subtotal_cents - discount_cents + tax_cents + service_charge_cents),
  check ((manager_id is null) = (manager_approved_at is null)),
  check ((status = 'closed') = (closed_at is not null)),
  check ((status = 'closed') = (closed_order_id is not null)),
  check ((status = 'voided') = (voided_at is not null)),
  unique (store_id, id),
  foreign key (store_id, table_id) references public.restaurant_tables(store_id, id),
  foreign key (store_id, customer_id) references public.pos_customers(store_id, id),
  foreign key (store_id, employee_id) references public.terminal_employees(store_id, id),
  foreign key (store_id, manager_id) references public.terminal_employees(store_id, id),
  foreign key (store_id, voided_by_employee_id) references public.terminal_employees(store_id, id),
  foreign key (store_id, closed_order_id) references public.pos_orders(store_id, id)
);

-- At most one open check per table at a time -- prevents two staff from independently opening a
-- second tab against a table that already has a running one. Partial: closed/voided rows, and
-- takeaway/delivery checks (table_id null), are unconstrained.
create unique index open_checks_one_open_per_table on public.open_checks(store_id, table_id)
  where status = 'open' and table_id is not null;
create index open_checks_by_store_status on public.open_checks(store_id, status);

create table public.open_check_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  check_id uuid not null,
  product_id uuid not null,
  snapshot_name text not null check (length(trim(snapshot_name)) between 1 and 160),
  snapshot_sku text not null check (length(trim(snapshot_sku)) between 1 and 80),
  snapshot_price_cents bigint not null check (snapshot_price_cents between 0 and 1000000000),
  snapshot_tax_bps integer not null check (snapshot_tax_bps between 0 and 10000),
  catalog_version bigint not null check (catalog_version > 0),
  quantity integer not null check (quantity between 1 and 10000),
  discount_kind text check (discount_kind in ('percent', 'fixed')),
  discount_value integer check (discount_value >= 0),
  subtotal_cents bigint not null check (subtotal_cents between 0 and 1000000000),
  discount_applied_cents bigint not null default 0 check (discount_applied_cents between 0 and 1000000000),
  taxable_cents bigint not null check (taxable_cents between 0 and 1000000000),
  tax_cents bigint not null check (tax_cents between 0 and 1000000000),
  total_cents bigint not null check (total_cents between 0 and 1000000000),
  added_at timestamptz not null default now(),
  check (total_cents = taxable_cents + tax_cents),
  check ((discount_kind is null) = (discount_value is null)),
  unique (store_id, id),
  foreign key (store_id, check_id) references public.open_checks(store_id, id) on delete cascade,
  foreign key (store_id, product_id) references public.pos_products(store_id, id)
);
create index open_check_items_by_check on public.open_check_items(store_id, check_id);

create table public.open_check_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  check_item_id uuid not null,
  snapshot_group_name text not null check (length(trim(snapshot_group_name)) between 1 and 60),
  snapshot_option_name text not null check (length(trim(snapshot_option_name)) between 1 and 60),
  price_delta_cents integer not null check (price_delta_cents between -1000000000 and 1000000000),
  foreign key (store_id, check_item_id) references public.open_check_items(store_id, id) on delete cascade
);
create index open_check_item_modifiers_by_item on public.open_check_item_modifiers(store_id, check_item_id);

alter table public.open_checks enable row level security;
alter table public.open_check_items enable row level security;
alter table public.open_check_item_modifiers enable row level security;

grant select on public.open_checks, public.open_check_items, public.open_check_item_modifiers to authenticated;
create policy open_checks_member_read on public.open_checks for select to authenticated using (public.is_store_member(store_id));
create policy open_check_items_member_read on public.open_check_items for select to authenticated using (public.is_store_member(store_id));
create policy open_check_item_modifiers_member_read on public.open_check_item_modifiers for select to authenticated using (public.is_store_member(store_id));
