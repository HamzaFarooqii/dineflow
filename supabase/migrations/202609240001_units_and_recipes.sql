-- Restaurant POS Transformation — Day 3: units + recipes (docs/day-plans/day3.md, Ahmed's half).
-- Additive only: two new tables, no change to any existing table or constraint. Bisma's
-- ingredients/recipe_ingredients migration (applied after this one) references both tables, so
-- neither may be renamed or dropped without coordinating with that module.

-- 1. Units of measure, per store. `kind` groups units that could convert into each other later
-- (mass/volume/count); no conversion factor is stored yet — recipe costing currently requires a
-- recipe line's unit to match its ingredient's unit exactly, and full conversion is a follow-up.
create table public.units (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 40),
  abbreviation text not null check (length(trim(abbreviation)) between 1 and 10),
  kind text not null check (kind in ('mass', 'volume', 'count')),
  unique (store_id, id),
  unique (store_id, name)
);

-- 2. Recipes — at most one per menu item (unique (store_id, product_id)). Ingredient lines live
-- in Bisma's recipe_ingredients table, which FKs into (store_id, id) here.
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  product_id uuid not null,
  yield_quantity numeric not null check (yield_quantity > 0),
  yield_unit_id uuid not null,
  unique (store_id, id),
  unique (store_id, product_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id),
  foreign key (store_id, yield_unit_id) references public.units(store_id, id)
);

-- 3. RLS — same member-read pattern as every other restaurant table; writes go through the API
-- only (service-role connection), matching the existing convention for these tables.
alter table public.units enable row level security;
alter table public.recipes enable row level security;
grant select on public.units, public.recipes to authenticated;
create policy units_member_read on public.units for select to authenticated using (public.is_store_member(store_id));
create policy recipes_member_read on public.recipes for select to authenticated using (public.is_store_member(store_id));
