# Day 3 — Bisma's Brief: Ingredient Inventory (full stack)

**Branch:** `feature/bisma/day3-ingredient-inventory` (already created, pushed, based on
latest `develop`). Follow `RULES.md` §1–3 for the git and migration mechanics — not repeated
here.

**Context:** Days 1–2 are done and merged — you built the Floor & Tables screen and the whole
table-status lifecycle. Today is a different module: the ingredient-level inventory layer that
sits underneath the menu (Ahmed is building recipes on top of it in parallel). This is new
ground, not an extension of your existing floor/table files — treat it as a fresh module.

**Dependency:** your `ingredients`/`recipe_ingredients` migration has a foreign key into
`recipes`, which Ahmed is creating today. **Wait for Ahmed to confirm his `units`/`recipes`
migration is applied before you run yours** — don't guess at timing.

## 1. Migration — write now, apply once Ahmed confirms his is live

```sql
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

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  ingredient_id uuid not null,
  batch_id uuid,
  delta numeric not null,
  reason text not null check (reason in ('purchase', 'consumption', 'wastage', 'adjustment')),
  kitchen_ticket_item_id uuid,
  created_at timestamptz not null default now(),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, batch_id) references public.ingredient_batches(store_id, id),
  foreign key (kitchen_ticket_item_id) references public.kitchen_ticket_items(id)
);
create index stock_movements_by_ingredient on public.stock_movements(store_id, ingredient_id, created_at);

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
```

RLS: same member-read pattern as every other table so far. Also add the shared contract
`packages/domain/src/stock-movement-reason.ts` — the `reason` union
(`purchase`/`consumption`/`wastage`/`adjustment`) plus display labels, mirroring how
`table-status.ts` and `kitchen-ticket-status.ts` are structured. This union will also be used
by Hamza's consumption-wiring task later today, so land it as its own small commit early if you
can, rather than buried at the end of a large PR.

Name the file with the next unused sequence number after Ahmed's (check
`supabase/migrations/` directly — don't assume a specific number, Day 2 had two people
independently pick the same one).

## 2. Backend

CRUD for ingredients (create/update/deactivate), record an incoming batch, list stock
movements for an ingredient, record a manual wastage entry (a `stock_movements` row with
`reason='wastage'` and a negative `delta`).

## 3. UI — new screen

A new `/inventory` route. **Ask Hamza before adding the nav entry** — nav changes need Lead
sign-off per the design system convention (`docs/DESIGN_SYSTEM.md`). Contents:
- Ingredient list: name, unit, current stock, reorder threshold, a low-stock indicator when
  `current_stock <= reorder_threshold` (reuse the six-tone status system in
  `docs/DESIGN_SYSTEM.md` — `warning` tone for low stock, don't invent a new color).
- Per-ingredient batch list with expiry highlighting (`danger` tone once past `expires_at`,
  `warning` tone within some reasonable window before it — pick something sensible like 3 days
  and note the choice in your PR so it can be adjusted).
- Stock movement ledger (read-only list, most recent first).
- A wastage-entry form (ingredient, quantity, reason note).

Build this the same way `screens/floor/` is structured — a screen file plus small focused
components in the same folder, styled entirely from existing `--mise-*` tokens, no new colors.

## 4. Do not touch

`apps/web/src/screens/ProductCatalogScreen.tsx` (Ahmed's recipe UI), `apps/web/src/screens/kitchen/`
and `apps/api/src/routes/kitchen.ts` (Hamza is wiring the consumption hook there later today —
your job is to make sure `ingredients`/`stock_movements` exist and are queryable, not to call
into his file yourself).

## 5. Before opening your PR

Run `RULES.md` §6's full check. Add a test for at least the low-stock/reorder-threshold logic
and the wastage-entry validation.

## Definition of done

Ingredients, batches, and stock movements exist and are fully manageable through a real screen
— creating an ingredient, receiving a batch, and recording wastage all work end-to-end. Nothing
consumes stock automatically yet — that's Hamza's follow-up task once your migration is live.
