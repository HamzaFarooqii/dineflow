-- Store-scoped, create-only customers and an optional same-store sale reference.
create table public.pos_customers (
  id uuid primary key,
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 30),
  phone_normalized text check (phone_normalized ~ '^[1-9][0-9]{3,14}$'),
  client_generated_at timestamptz not null,
  server_received_at timestamptz not null default now(),
  unique (store_id, id)
);
-- This index is intentionally nonunique: a phone is not a customer identity.
create index pos_customers_phone_lookup on public.pos_customers(store_id, phone_normalized, id);
create index pos_customers_listing on public.pos_customers(store_id, server_received_at, id);

alter table public.pos_orders add column customer_id uuid;
alter table public.pos_orders add constraint pos_orders_customer_store_fk
  foreign key (store_id, customer_id) references public.pos_customers(store_id, id);
create index pos_orders_customer on public.pos_orders(store_id, customer_id) where customer_id is not null;

alter table public.pos_change_feed drop constraint pos_change_feed_entity_type_check;
alter table public.pos_change_feed add constraint pos_change_feed_entity_type_check
  check (entity_type in ('order', 'stock', 'customer'));
alter table public.pos_operation_ledger add column entity_type text not null default 'order'
  check (entity_type in ('order', 'customer'));

alter table public.pos_customers enable row level security;
revoke all on public.pos_customers from anon, authenticated;
grant select on public.pos_customers to authenticated;
create policy pos_customers_member_read on public.pos_customers for select to authenticated
  using (public.is_store_member(store_id));
