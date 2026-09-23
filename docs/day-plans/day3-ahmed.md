# Day 3 — Ahmed's Brief: Recipes + Menu-Side Costing

**Branch:** `feature/ahmed/day3-recipes-costing` (already created, pushed, based on latest
`develop`). Follow `RULES.md` §1–3 for the git and migration mechanics — not repeated here.

**Context:** Days 1–2 are done and merged — the register has order types, the menu has
restaurant columns (station, availability), and the Kitchen Display System is live. Today adds
the first piece of Food Operations: a menu item can have a recipe, and that recipe has a real
cost.

## 1. Migration — write and apply this first, today

Two new tables, additive only, no dependency on anything Bisma builds:

```sql
create table public.units (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 40),
  abbreviation text not null check (length(trim(abbreviation)) between 1 and 10),
  kind text not null check (kind in ('mass', 'volume', 'count')),
  unique (store_id, id),
  unique (store_id, name)
);

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
```

RLS: same member-read pattern as every other restaurant table so far (`kitchen_stations`,
`floor_areas` are good templates) — enable RLS, grant select to authenticated, one member-read
policy per table. Writes go through the API only.

Name the file `202609240001_recipes_units.sql` (confirm the actual next-unused sequence number
against what's in `supabase/migrations/` when you get there — Day 2 had two people pick the
same number independently, don't repeat that).

**Apply it, then tell Bisma it's live** — her `ingredients` migration has a foreign key into a
table (`recipe_ingredients` → `recipes`) that only exists once yours does.

## 2. Recipe builder UI

New "Recipe" section on the existing product editor in `ProductCatalogScreen.tsx` — not a
separate screen. A list of ingredient lines (ingredient, quantity, unit), add/remove lines, and
a yield quantity/unit for the recipe as a whole. The ingredient picker and the
`recipe_ingredients` join table itself are Bisma's `ingredients`/`recipe_ingredients` tables —
your UI reads from and writes to them, but you don't own their schema.

## 3. Recipe costing

Once a recipe has ingredient lines, compute its cost: sum each line's
`quantity × ingredient.cost_per_unit_cents` (converting units if the recipe line's unit differs
from the ingredient's stored unit — if unit conversion turns out to be non-trivial, keep it
simple for now: require the recipe line to use the same unit the ingredient is priced in, and
flag unit conversion as a follow-up rather than building a full conversion table today).
Display the resulting cost and an estimated food-cost % (cost ÷ menu price) in the product
editor. This part of the UI can't show real numbers until Bisma's `ingredients` table
(with `cost_per_unit_cents`) is live — build the UI regardless, but expect it to show zeros or
be visually incomplete until then; don't block on it.

## 4. API

Endpoints to create/update a recipe and replace its ingredient lines for a product (a full
replace-on-save is simpler and safer than incremental line CRUD for a first pass — matches how
`ProductCatalogScreen` already handles category/tax-rate edits).

## 5. Files you may touch

`apps/web/src/screens/ProductCatalogScreen.tsx`, a new recipe editor component under
`apps/web/src/screens/menu/`, `apps/api/src/routes/catalog.ts` (recipe endpoints), your
migration file.

## 6. Do not touch

`apps/web/src/screens/floor/`, `apps/web/src/screens/kitchen/`, `apps/api/src/routes/floor.ts`,
`apps/api/src/routes/kitchen.ts` (Hamza is working in both of those today), `pos-store.ts`,
`RegisterScreen.tsx`'s checkout logic.

## 7. Before opening your PR

Run `RULES.md` §6's full check (domain/api/web test+build+typecheck). Add at least one test for
the recipe costing calculation — if it's a pure function, put it in `packages/domain` so it's
reusable later (e.g. by Day 5's food-cost report) rather than trapped inside a component.

## Definition of done

A menu item can have a recipe with costed ingredient lines, and its estimated food-cost % is
visible where its price is set.
