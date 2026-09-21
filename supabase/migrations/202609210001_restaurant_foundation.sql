-- Restaurant POS Transformation — Foundation (Blueprint Section D, migration groups 1-2).
-- Additive only: kitchen stations, floor areas, restaurant tables, and new nullable columns on
-- pos_products for station routing and 86-ing. Does not touch pos_stock, pos_orders,
-- pos_order_items, or any checkout/refund write path. Ingredients, recipes, the ingredient
-- ledger and the open-ticket layer are deliberately NOT part of this migration — they're
-- separate, larger pieces of work assigned to the team (see the blueprint's Section H).

-- 1. Kitchen stations. Referenced by pos_products.station_id below.
create table public.kitchen_stations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 80),
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (store_id, id),
  unique (store_id, name)
);

-- 2. Floor areas and tables. A table's status is display/coordination state only for now —
-- nothing writes to it yet (no open-ticket layer exists in this migration), so it always starts
-- and stays 'available' until a later feature actually seats a party.
create table public.floor_areas (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 80),
  sort_order integer not null default 0,
  active boolean not null default true,
  unique (store_id, id),
  unique (store_id, name)
);

create table public.restaurant_tables (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  floor_area_id uuid not null,
  label text not null check (length(trim(label)) between 1 and 40),
  seats integer not null check (seats > 0),
  status text not null default 'available' check (status in
    ('available', 'seated', 'ordering', 'served', 'bill_requested', 'dirty', 'reserved', 'out_of_service')),
  pos_x integer,
  pos_y integer,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, label),
  foreign key (store_id, floor_area_id) references public.floor_areas(store_id, id)
);
create index restaurant_tables_by_area on public.restaurant_tables(store_id, floor_area_id);

-- 3. Menu-item restaurant columns on pos_products. All nullable/defaulted so every existing row
-- keeps behaving exactly as it does today; sells_directly defaults true so nothing existing
-- becomes hidden from the register. is_available is deliberately separate from the existing
-- `active` column — active is a catalog-management concept (soft delete), is_available is a
-- shift-to-shift 86 toggle a cashier or kitchen might flip several times a day.
alter table public.pos_products
  add column station_id uuid,
  add column prep_time_seconds integer check (prep_time_seconds is null or prep_time_seconds > 0),
  add column course text check (course is null or course in ('appetizer', 'main', 'dessert', 'side', 'beverage')),
  add column kitchen_name text check (kitchen_name is null or length(trim(kitchen_name)) <= 80),
  add column is_available boolean not null default true,
  add column unavailable_until timestamptz,
  add column sells_directly boolean not null default true;

alter table public.pos_products
  add constraint pos_products_station_fkey
  foreign key (store_id, station_id) references public.kitchen_stations(store_id, id);

-- 4. RLS: same member-read pattern as pos_categories/pos_tax_rates/pos_products — every active
-- store member can read the floor plan and stations; writes go through the API only (no insert/
-- update/delete policy is added here, matching the existing convention for these tables).
alter table public.kitchen_stations enable row level security;
alter table public.floor_areas enable row level security;
alter table public.restaurant_tables enable row level security;
grant select on public.kitchen_stations, public.floor_areas, public.restaurant_tables to authenticated;
create policy kitchen_stations_member_read on public.kitchen_stations for select to authenticated using (public.is_store_member(store_id));
create policy floor_areas_member_read on public.floor_areas for select to authenticated using (public.is_store_member(store_id));
create policy restaurant_tables_member_read on public.restaurant_tables for select to authenticated using (public.is_store_member(store_id));
