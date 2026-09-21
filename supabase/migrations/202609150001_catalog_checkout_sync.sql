-- Catalog and completed-sale MVP. No terminal, employee or auth schema is changed.

create table public.pos_categories (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 120), active boolean not null default true,
  unique (store_id, id), unique (store_id, name)
);
create table public.pos_tax_rates (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id),
  name text not null, rate_bps integer not null check (rate_bps between 0 and 10000),
  active boolean not null default true, unique (store_id, id)
);
create table public.pos_products (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id),
  sku text not null check (length(trim(sku)) between 1 and 80), barcode text,
  name text not null check (length(trim(name)) between 1 and 160),
  category_id uuid, tax_rate_id uuid, unit_price_cents bigint not null check (unit_price_cents between 0 and 1000000000),
  active boolean not null default true, revision bigint not null default 1 check (revision > 0),
  unique (store_id, id), unique (store_id, sku),
  foreign key (store_id, category_id) references public.pos_categories(store_id, id),
  foreign key (store_id, tax_rate_id) references public.pos_tax_rates(store_id, id)
);
create index pos_products_listing on public.pos_products(store_id, active, category_id);
create index pos_products_barcode on public.pos_products(store_id, barcode) where barcode is not null;
create index pos_products_name_search on public.pos_products(store_id, lower(name));

create table public.pos_stock (
  store_id uuid not null, product_id uuid not null, current_stock integer not null default 0,
  updated_at timestamptz not null default now(), primary key (store_id, product_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id)
);
create table public.pos_orders (
  id uuid primary key, store_id uuid not null references public.stores(id),
  receipt_number text not null check (length(receipt_number) between 1 and 100),
  currency char(3) not null, store_name_snapshot text not null, timezone_snapshot text not null,
  subtotal_cents bigint not null check (subtotal_cents between 0 and 1000000000),
  tax_cents bigint not null check (tax_cents between 0 and 1000000000),
  total_cents bigint not null check (total_cents between 0 and 1000000000),
  catalog_version bigint not null default 1, client_generated_at timestamptz not null,
  server_received_at timestamptz not null default now(), schema_version integer not null default 1,
  check (total_cents = subtotal_cents + tax_cents),
  unique (store_id, id), unique (store_id, receipt_number)
);
create index pos_orders_history on public.pos_orders(store_id, client_generated_at desc);
create table public.pos_order_items (
  id uuid primary key, store_id uuid not null, order_id uuid not null, product_id uuid not null,
  snapshot_name text not null, snapshot_sku text not null,
  snapshot_price_cents bigint not null check (snapshot_price_cents between 0 and 1000000000),
  snapshot_tax_bps integer not null check (snapshot_tax_bps between 0 and 10000),
  catalog_version bigint not null check (catalog_version > 0),
  quantity integer not null check (quantity between 1 and 10000),
  subtotal_cents bigint not null check (subtotal_cents between 0 and 1000000000),
  tax_cents bigint not null check (tax_cents between 0 and 1000000000),
  total_cents bigint not null check (total_cents between 0 and 1000000000),
  check (total_cents = subtotal_cents + tax_cents),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id)
);
create index pos_order_items_order on public.pos_order_items(store_id, order_id);
create table public.pos_payments (
  id uuid primary key, store_id uuid not null, order_id uuid not null,
  method text not null check (method in ('cash', 'card')),
  amount_cents bigint not null check (amount_cents between 0 and 1000000000),
  tendered_cents bigint not null check (tendered_cents between 0 and 1000000000),
  change_cents bigint not null check (change_cents between 0 and 1000000000),
  reference text, client_generated_at timestamptz not null, server_received_at timestamptz not null default now(),
  unique (store_id, order_id), foreign key (store_id, order_id) references public.pos_orders(store_id, id),
  check ((method = 'cash' and tendered_cents = amount_cents + change_cents) or
         (method = 'card' and tendered_cents = amount_cents and change_cents = 0))
);
create table public.pos_sync_feed_state (
  store_id uuid primary key references public.stores(id), last_position bigint not null default 0
);
create table public.pos_change_feed (
  store_id uuid not null references public.stores(id), position bigint not null,
  entity_type text not null check (entity_type in ('order', 'stock')),
  entity_id uuid not null, action text not null default 'upsert', payload jsonb not null,
  created_at timestamptz not null default now(), primary key (store_id, position)
);
create table public.pos_operation_ledger (
  store_id uuid not null references public.stores(id), operation_id uuid not null,
  payload_hash text not null, status text not null check (status in ('accepted', 'rejected')),
  result_json jsonb not null, accepted_checkpoint bigint,
  processed_at timestamptz not null default now(), primary key (store_id, operation_id)
);
create table public.pos_inventory_movements (
  id uuid primary key default gen_random_uuid(), store_id uuid not null, product_id uuid not null,
  order_id uuid, operation_id uuid not null, delta integer not null check (delta <> 0),
  reason text not null check (reason in ('sale', 'opening_stock')),
  server_received_at timestamptz not null default now(),
  unique (store_id, operation_id, product_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id)
);

-- Browser clients may read their own catalog only. Business writes go through the API transaction.
do $$ declare tab text; begin
  foreach tab in array array['pos_categories','pos_tax_rates','pos_products','pos_stock','pos_orders',
    'pos_order_items','pos_payments','pos_sync_feed_state','pos_change_feed','pos_operation_ledger','pos_inventory_movements'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on public.%I from anon, authenticated', tab);
  end loop;
end $$;
grant select on public.pos_categories, public.pos_tax_rates, public.pos_products, public.pos_stock to authenticated;
create policy pos_categories_member_read on public.pos_categories for select to authenticated using (public.is_store_member(store_id));
create policy pos_tax_rates_member_read on public.pos_tax_rates for select to authenticated using (public.is_store_member(store_id));
create policy pos_products_member_read on public.pos_products for select to authenticated using (public.is_store_member(store_id));
create policy pos_stock_member_read on public.pos_stock for select to authenticated using (public.is_store_member(store_id));

-- Demo catalog is created for existing and newly created stores. Opening stock is movement-backed.
create function public.pos_seed_demo_catalog(p_store_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cat_home uuid; cat_apparel uuid; cat_food uuid; tax_id uuid; seed_op uuid;
  row_data record; product_id uuid;
begin
  if exists (select 1 from public.pos_categories where store_id = p_store_id) then return; end if;
  insert into public.pos_categories(store_id,name) values (p_store_id,'Home') returning id into cat_home;
  insert into public.pos_categories(store_id,name) values (p_store_id,'Apparel') returning id into cat_apparel;
  insert into public.pos_categories(store_id,name) values (p_store_id,'Food & Drink') returning id into cat_food;
  insert into public.pos_tax_rates(store_id,name,rate_bps) values (p_store_id,'Demo tax',800) returning id into tax_id;
  insert into public.pos_sync_feed_state(store_id) values (p_store_id) on conflict do nothing;
  seed_op := gen_random_uuid();
  for row_data in select * from (values
    ('MUG-001','2000000000001','Ceramic Mug',cat_home,1800,24), ('TOTE-001','2000000000002','Canvas Tote',cat_apparel,3200,12),
    ('CANDLE-001','2000000000003','Scented Candle',cat_home,2800,4), ('SOAP-001','2000000000004','Hand Soap',cat_home,2000,18),
    ('OIL-001','2000000000005','Olive Oil',cat_food,2200,14), ('TEA-001','2000000000006','Tea Blend',cat_food,1600,30),
    ('SCARF-001','2000000000007','Wool Scarf',cat_apparel,4800,5), ('SHIRT-001','2000000000008','T-Shirt',cat_apparel,3600,9)
  ) as p(sku,barcode,name,category_id,price_cents,opening_stock) loop
    insert into public.pos_products(store_id,sku,barcode,name,category_id,tax_rate_id,unit_price_cents)
    values (p_store_id,row_data.sku,row_data.barcode,row_data.name,row_data.category_id,tax_id,row_data.price_cents)
    returning id into product_id;
    insert into public.pos_inventory_movements(store_id,product_id,operation_id,delta,reason)
    values (p_store_id,product_id,seed_op,row_data.opening_stock,'opening_stock');
    insert into public.pos_stock(store_id,product_id,current_stock) values (p_store_id,product_id,row_data.opening_stock);
  end loop;
end $$;
revoke all on function public.pos_seed_demo_catalog(uuid) from public, anon, authenticated;
create function public.pos_seed_new_store() returns trigger language plpgsql security definer set search_path = '' as $$
begin perform public.pos_seed_demo_catalog(new.id); return new; end $$;
create trigger pos_demo_catalog_after_store after insert on public.stores
for each row execute function public.pos_seed_new_store();
do $$ declare s record; begin for s in select id from public.stores loop perform public.pos_seed_demo_catalog(s.id); end loop; end $$;
