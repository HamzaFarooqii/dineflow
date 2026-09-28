-- Reservations and waitlist for store-scoped Floor operations.
-- Seating is coordinated by the API with restaurant_tables' existing atomic status transition.

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  guest_name text not null check (length(trim(guest_name)) between 1 and 120),
  guest_phone text check (guest_phone is null or guest_phone ~ '^[1-9][0-9]{3,14}$'),
  guest_size integer not null check (guest_size > 0 and guest_size <= 99),
  notes text not null default '' check (length(notes) <= 500),
  expected_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked','arrived','seated','cancelled','no_show')),
  floor_area_id uuid,
  restaurant_table_id uuid,
  seated_at timestamptz,
  seated_table_id uuid,
  seated_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, seated_operation_id),
  foreign key (store_id, floor_area_id) references public.floor_areas(store_id, id),
  foreign key (store_id, restaurant_table_id) references public.restaurant_tables(store_id, id),
  foreign key (store_id, seated_table_id) references public.restaurant_tables(store_id, id),
  constraint reservations_seating_consistent check (
    (status = 'seated' and seated_at is not null and seated_table_id is not null and seated_operation_id is not null)
    or (status <> 'seated' and seated_at is null and seated_table_id is null)
  )
);

create index reservations_by_store_expected on public.reservations(store_id, expected_at);
create index reservations_by_store_status on public.reservations(store_id, status, expected_at);

create table public.waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  guest_name text not null check (length(trim(guest_name)) between 1 and 120),
  guest_phone text check (guest_phone is null or guest_phone ~ '^[1-9][0-9]{3,14}$'),
  guest_size integer not null check (guest_size > 0 and guest_size <= 99),
  notes text not null default '' check (length(notes) <= 500),
  expected_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting','seated','cancelled','no_show')),
  floor_area_id uuid,
  restaurant_table_id uuid,
  seated_at timestamptz,
  seated_table_id uuid,
  seated_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, seated_operation_id),
  foreign key (store_id, floor_area_id) references public.floor_areas(store_id, id),
  foreign key (store_id, restaurant_table_id) references public.restaurant_tables(store_id, id),
  foreign key (store_id, seated_table_id) references public.restaurant_tables(store_id, id),
  constraint waitlist_seating_consistent check (
    (status = 'seated' and seated_at is not null and seated_table_id is not null and seated_operation_id is not null)
    or (status <> 'seated' and seated_at is null and seated_table_id is null)
  )
);

create index waitlist_by_store_expected on public.waitlist_entries(store_id, expected_at);
create index waitlist_by_store_status on public.waitlist_entries(store_id, status, expected_at);

alter table public.reservations enable row level security;
alter table public.waitlist_entries enable row level security;

grant select on public.reservations, public.waitlist_entries to authenticated;

create policy reservations_member_read on public.reservations
  for select to authenticated using (public.is_store_member(store_id));
create policy waitlist_entries_member_read on public.waitlist_entries
  for select to authenticated using (public.is_store_member(store_id));
