-- Real menu modifier groups and immutable per-sale snapshots.
-- Every relationship is store-scoped so one restaurant can never attach another store's option.

create table public.modifier_groups (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 60),
  selection text not null check (selection in ('single', 'multi')),
  required boolean not null default false,
  unique (store_id, id)
);

create table public.modifier_options (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  group_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  price_delta_cents integer not null default 0 check (price_delta_cents between -1000000000 and 1000000000),
  active boolean not null default true,
  unique (store_id, id),
  foreign key (store_id, group_id) references public.modifier_groups(store_id, id) on delete cascade
);

create table public.product_modifier_groups (
  store_id uuid not null references public.stores(id),
  product_id uuid not null,
  group_id uuid not null,
  sort_order integer not null default 0,
  primary key (store_id, product_id, group_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id) on delete cascade,
  foreign key (store_id, group_id) references public.modifier_groups(store_id, id) on delete cascade
);

alter table public.pos_order_items
  add constraint pos_order_items_store_id_id_key unique (store_id, id);

create table public.pos_order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  order_item_id uuid not null,
  snapshot_group_name text not null check (length(trim(snapshot_group_name)) between 1 and 60),
  snapshot_option_name text not null check (length(trim(snapshot_option_name)) between 1 and 60),
  price_delta_cents integer not null check (price_delta_cents between -1000000000 and 1000000000),
  foreign key (store_id, order_item_id) references public.pos_order_items(store_id, id)
);

create index modifier_options_by_group on public.modifier_options(store_id, group_id);
create index product_modifier_groups_by_product on public.product_modifier_groups(store_id, product_id, sort_order);
create index pos_order_item_modifiers_by_item on public.pos_order_item_modifiers(store_id, order_item_id);

alter table public.modifier_groups enable row level security;
alter table public.modifier_options enable row level security;
alter table public.product_modifier_groups enable row level security;
alter table public.pos_order_item_modifiers enable row level security;

grant select on public.modifier_groups, public.modifier_options, public.product_modifier_groups, public.pos_order_item_modifiers to authenticated;
create policy modifier_groups_member_read on public.modifier_groups for select to authenticated using (public.is_store_member(store_id));
create policy modifier_options_member_read on public.modifier_options for select to authenticated using (public.is_store_member(store_id));
create policy product_modifier_groups_member_read on public.product_modifier_groups for select to authenticated using (public.is_store_member(store_id));
create policy pos_order_item_modifiers_member_read on public.pos_order_item_modifiers for select to authenticated using (public.is_store_member(store_id));
