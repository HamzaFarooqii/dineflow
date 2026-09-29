-- Sellable combos (Ahmad's A4 work): a combo is a real pos_products row (so it lives in the
-- existing menu grid/cart/checkout/KDS pipeline unchanged), configured with one or more
-- selectable groups, each offering a choice among other already-sellable products in the same
-- store. Deliberately a separate structure from modifier_groups: a modifier option is a flat
-- name + price delta with no product identity, so it cannot drive stock consumption or its own
-- kitchen routing the way a combo component (a real product, with its own recipe and station)
-- needs to -- see packages/domain/src/combo.ts's header comment for the full reasoning.
--
-- No new snapshot table is needed at sale time: a combo's selected components become additional
-- pos_order_items rows (product_id = the component, snapshot_price_cents = 0 since the money is
-- charged once on the combo's own line), reusing every existing stock-decrement, kitchen-ticket
-- and refund loop completely unchanged. combo_parent_item_id is the only new column those existing
-- flows need to carry.

create table public.combos (
  product_id uuid primary key,
  store_id uuid not null references public.stores(id),
  pricing_mode text not null check (pricing_mode in ('fixed', 'derived')),
  unique (store_id, product_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id) on delete cascade
);

create table public.combo_groups (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  combo_product_id uuid not null,
  name text not null check (length(trim(name)) between 1 and 60),
  min_select integer not null check (min_select >= 0),
  max_select integer not null check (max_select >= 1),
  sort_order integer not null default 0,
  check (min_select <= max_select),
  unique (store_id, id),
  foreign key (store_id, combo_product_id) references public.combos(store_id, product_id) on delete cascade
);

create table public.combo_group_options (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  group_id uuid not null,
  component_product_id uuid not null,
  price_delta_cents integer not null default 0 check (price_delta_cents between -1000000000 and 1000000000),
  sort_order integer not null default 0,
  unique (store_id, id),
  unique (store_id, group_id, component_product_id),
  foreign key (store_id, group_id) references public.combo_groups(store_id, id) on delete cascade,
  foreign key (store_id, component_product_id) references public.pos_products(store_id, id)
);

create index combo_groups_by_combo on public.combo_groups(store_id, combo_product_id);
create index combo_group_options_by_group on public.combo_group_options(store_id, group_id);

-- Marks a component row (or, for a partial refund's bookkeeping, any auto-generated child row) as
-- belonging to a specific combo line rather than being its own independently-priced sale. Nullable
-- and self-referencing: a plain, non-combo pos_order_items row leaves this null exactly as before.
alter table public.pos_order_items
  add column combo_parent_item_id uuid,
  add constraint pos_order_items_combo_parent_fkey
    foreign key (store_id, combo_parent_item_id) references public.pos_order_items(store_id, id);

alter table public.combos enable row level security;
alter table public.combo_groups enable row level security;
alter table public.combo_group_options enable row level security;
grant select on public.combos, public.combo_groups, public.combo_group_options to authenticated;
create policy combos_member_read on public.combos for select to authenticated using (public.is_store_member(store_id));
create policy combo_groups_member_read on public.combo_groups for select to authenticated using (public.is_store_member(store_id));
create policy combo_group_options_member_read on public.combo_group_options for select to authenticated using (public.is_store_member(store_id));
