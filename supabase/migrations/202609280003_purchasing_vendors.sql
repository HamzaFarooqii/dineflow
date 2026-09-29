-- Purchasing and vendors.
-- Receiving posts into public.ingredient_batches and public.stock_movements; those remain the
-- inventory source of truth. Purchase receipt lines only link the purchasing document to those
-- existing ledger rows.

-- stock_movements never got a (store_id, id) unique constraint when it was created (only a bare
-- primary key on id), so purchase_receipt_lines.stock_movement_id below cannot reference it as a
-- composite tenant-scoped foreign key without this. Add it here rather than editing the already
-- applied 202609240002 migration.
alter table public.stock_movements add constraint stock_movements_store_id_id_key unique (store_id, id);

create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 160),
  contact_name text check (contact_name is null or length(trim(contact_name)) <= 120),
  email text check (email is null or length(trim(email)) <= 160),
  phone text check (phone is null or length(trim(phone)) <= 40),
  terms text not null default '' check (length(terms) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, name)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  vendor_id uuid not null,
  status text not null default 'draft' check (status in ('draft','sent','partially_received','received','cancelled')),
  reference text check (reference is null or length(trim(reference)) <= 120),
  notes text not null default '' check (length(notes) <= 500),
  sent_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, vendor_id) references public.vendors(store_id, id)
);
create index purchase_orders_by_store_status on public.purchase_orders(store_id, status, created_at desc);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  purchase_order_id uuid not null,
  ingredient_id uuid not null,
  ordered_quantity numeric not null check (ordered_quantity > 0),
  received_quantity numeric not null default 0 check (received_quantity >= 0),
  unit_cost_cents integer not null check (unit_cost_cents >= 0),
  reference text check (reference is null or length(trim(reference)) <= 160),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, purchase_order_id) references public.purchase_orders(store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id)
);
create index purchase_order_lines_by_po on public.purchase_order_lines(store_id, purchase_order_id);

create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  purchase_order_id uuid not null,
  operation_id uuid not null,
  invoice_reference text check (invoice_reference is null or length(trim(invoice_reference)) <= 160),
  received_at timestamptz not null default now(),
  manager_approved boolean not null default false,
  manager_approval_reason text check (manager_approval_reason is null or length(trim(manager_approval_reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, operation_id),
  foreign key (store_id, purchase_order_id) references public.purchase_orders(store_id, id)
);

create table public.purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  purchase_receipt_id uuid not null,
  purchase_order_line_id uuid not null,
  ingredient_id uuid not null,
  received_quantity numeric not null check (received_quantity > 0),
  unit_cost_cents integer not null check (unit_cost_cents >= 0),
  previous_unit_cost_cents integer not null check (previous_unit_cost_cents >= 0),
  cost_variance_cents integer not null,
  batch_id uuid not null,
  stock_movement_id uuid not null,
  over_received boolean not null default false,
  created_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, purchase_receipt_id) references public.purchase_receipts(store_id, id),
  foreign key (store_id, purchase_order_line_id) references public.purchase_order_lines(store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, batch_id) references public.ingredient_batches(store_id, id),
  foreign key (store_id, stock_movement_id) references public.stock_movements(store_id, id)
);

-- Immutable cost history. The API inserts here only when a manager-approved receiving payload
-- explicitly requests reconciliation of ingredients.cost_per_unit_cents.
create table public.ingredient_cost_history (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ingredient_id uuid not null,
  purchase_receipt_line_id uuid not null,
  previous_unit_cost_cents integer not null check (previous_unit_cost_cents >= 0),
  new_unit_cost_cents integer not null check (new_unit_cost_cents >= 0),
  reason text not null check (length(trim(reason)) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, purchase_receipt_line_id) references public.purchase_receipt_lines(store_id, id)
);

alter table public.vendors enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;
alter table public.ingredient_cost_history enable row level security;

grant select on public.vendors, public.purchase_orders, public.purchase_order_lines,
  public.purchase_receipts, public.purchase_receipt_lines, public.ingredient_cost_history to authenticated;

create policy vendors_member_read on public.vendors for select to authenticated using (public.is_store_member(store_id));
create policy purchase_orders_member_read on public.purchase_orders for select to authenticated using (public.is_store_member(store_id));
create policy purchase_order_lines_member_read on public.purchase_order_lines for select to authenticated using (public.is_store_member(store_id));
create policy purchase_receipts_member_read on public.purchase_receipts for select to authenticated using (public.is_store_member(store_id));
create policy purchase_receipt_lines_member_read on public.purchase_receipt_lines for select to authenticated using (public.is_store_member(store_id));
create policy ingredient_cost_history_member_read on public.ingredient_cost_history for select to authenticated using (public.is_store_member(store_id));
