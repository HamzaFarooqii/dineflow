-- Restaurant POS Transformation — Day 3: ingredient inventory (docs/day-plans/day3.md, Bisma's
-- half). Additive only: four new tables, no change to any existing table or constraint.
-- Depends on Ahmed's units/recipes (202609240001) and Day 2's kitchen_ticket_items
-- (202609230001), both already applied. current_stock on ingredients is a live denormalized
-- column, kept in sync by the API inside the same transaction as each stock_movements insert —
-- no trigger maintains it, matching this schema's existing convention (restaurant_tables.status
-- is updated the same way). Nothing consumes stock automatically yet; that hookup into kitchen
-- tickets is a follow-up once this migration is live.

-- 1. Ingredients — one row per store-scoped stock-keeping unit.
create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 120),
  unit_id uuid not null,
  cost_per_unit_cents integer not null check (cost_per_unit_cents >= 0),
  current_stock numeric not null default 0,
  reorder_threshold numeric,
  active boolean not null default true,
  unique (store_id, id),
  unique (store_id, name),
  foreign key (store_id, unit_id) references public.units(store_id, id)
);

-- 2. Ingredient batches — one row per received purchase batch, so expiry and per-batch cost can
-- be tracked separately from the ingredient's running average.
create table public.ingredient_batches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ingredient_id uuid not null,
  quantity numeric not null check (quantity > 0),
  received_at timestamptz not null default now(),
  expires_at timestamptz,
  cost_per_unit_cents integer not null check (cost_per_unit_cents >= 0),
  unique (store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id)
);

-- 3. Stock movements — append-only ledger of every change to an ingredient's stock. batch_id is
-- nullable: wastage/adjustment entries aren't necessarily tied to a specific batch. Postgres'
-- default MATCH SIMPLE FK semantics mean a null batch_id always satisfies the FK below,
-- regardless of store_id, which is what's wanted here. note is a free-text field for a manual
-- wastage entry's reason (the inventory screen's wastage form) — optional everywhere else.
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ingredient_id uuid not null,
  batch_id uuid,
  delta numeric not null,
  reason text not null check (reason in ('purchase', 'consumption', 'wastage', 'adjustment')),
  note text check (note is null or length(trim(note)) <= 500),
  kitchen_ticket_item_id uuid,
  created_at timestamptz not null default now(),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, batch_id) references public.ingredient_batches(store_id, id),
  foreign key (kitchen_ticket_item_id) references public.kitchen_ticket_items(id)
);
create index stock_movements_by_ingredient on public.stock_movements(store_id, ingredient_id, created_at);

-- 4. Recipe ingredients — the ingredient lines of a recipe (Ahmed's recipes table, 202609240001).
create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  recipe_id uuid not null,
  ingredient_id uuid not null,
  quantity numeric not null check (quantity > 0),
  unit_id uuid not null,
  foreign key (store_id, recipe_id) references public.recipes(store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, unit_id) references public.units(store_id, id)
);

-- 5. RLS: same member-read pattern as every other restaurant table; writes go through the API
-- only (service-role connection), matching the existing convention for these tables.
alter table public.ingredients enable row level security;
alter table public.ingredient_batches enable row level security;
alter table public.stock_movements enable row level security;
alter table public.recipe_ingredients enable row level security;
grant select on public.ingredients, public.ingredient_batches, public.stock_movements, public.recipe_ingredients to authenticated;
create policy ingredients_member_read on public.ingredients for select to authenticated using (public.is_store_member(store_id));
create policy ingredient_batches_member_read on public.ingredient_batches for select to authenticated using (public.is_store_member(store_id));
create policy stock_movements_member_read on public.stock_movements for select to authenticated using (public.is_store_member(store_id));
create policy recipe_ingredients_member_read on public.recipe_ingredients for select to authenticated using (public.is_store_member(store_id));
