# Day 3 — Food Operations (Work Division)

Team: **Hamza** (Team Lead + developer), **Ahmed** (developer), **Bisma** (developer). Core
relationship being built: **Dish → Recipe → Ingredients → Inventory**.

**Git ownership, read this first:** Hamza's branches are created and implemented by this
session directly. Ahmed and Bisma each run their own git workflow end to end — branch, commit,
push, open their own PR — independently; nothing here is pre-created for them. The workflow
section under each person's task tells them exactly what to run.

---

## Hamza — Lead + developer

### ✅ Merged into `develop` already

Both were genuine Day 2 gaps, now closed:

1. **Table order total on the Floor screen.** `GET /floor` now joins each table's most recent
   *completed* order. Deliberately labeled **"Last order"**, not a live running tab — this
   codebase creates `pos_orders` rows only at checkout, after payment, so there is no
   in-progress-order concept to source a true running total from while a table is still
   `ordering`. A bigger feature (an open-ticket layer), not a Day 3 fixup.
2. **Ticket-served → table sync, with a manager override.** A fully-served dine-in kitchen
   ticket now flips its table to `served` automatically (`kitchen.ts` calls `floor.ts`'s
   `applyTableStatusTransition` directly). A manager can also trigger the same transition by
   hand from the Floor screen's **"Mark served"** button — for when the kitchen isn't a
   reliable enough source of truth (an item never rang through the KDS, a side dish added
   without a ticket). A cashier terminal cannot trigger either path.

Full detail in commits `3896502`/`400a352` on `develop` and `docs/MODULE_STATUS.md`.

### 📦 Pushed, awaiting merge into `develop` (two more branches, from manual QA)

Manual testing after the above surfaced four more real gaps, plus two features (Table CRUD,
Transfer/Merge) that had been sitting as placeholders since Day 1. Per the git-ownership rule,
these are pushed and tested but **not self-merged** — they're branches for you to review/merge
the same way Ahmed's and Bisma's PRs will be.

**`feature/hamza/day3-checkout-integrity`** (commit `0fdf468`):
3. **Stock check, not a silent oversell.** A cart line exceeding its last-synced stock now
   shows an inline warning and a summary banner requiring explicit "Proceed anyway" before
   checkout — re-required if the oversold quantity changes again. A confirmation gate, not a
   hard block: `pos_stock` is allowed to go negative by design (`loadOversold` already reports
   it for reconciliation), and rejecting an already-in-progress paid sale would be worse than a
   rare oversell.
4. **Guest is now mandatory** on every check, wherever the register can actually resolve one
   (gated on `customerAuthorized` specifically, so an offline non-terminal session isn't
   permanently blocked from checking out at all — that would have broken this app's
   offline-first guarantee).
5. **The bill shows the guest's name, phone number, and order type** — sourced from data
   already on the order, no new schema.
6. **Kitchen tickets fire straight to `preparing`** (`fired_at = now()`) instead of sitting in
   `queued` — a paid order is definitionally ready for the kitchen, so the manual "Fire" click
   on every brand-new ticket was pure friction.

**`feature/hamza/day3-floor-crud`** (commit `7b8cc04`):
7. **Full CRUD for floor areas and tables** (create/edit/delete), behind a new "Edit floor"
   toggle on the Floor screen so day-to-day service view stays exactly as clean as before.
   Deletes are soft and refuse to orphan or interrupt anything in use.
8. **Transfer and Merge, actually implemented** — not placeholders anymore. Both move a
   table's open kitchen tickets to another table through a transaction-locked, deadlock-safe
   `moveTableParty` primitive, with real precondition checks. 6 new tests against real PGlite
   transactions.
9. Fixed a real, unrelated bug found while building this: `.secondary-cta` had no base CSS
   rule anywhere in the app (used on a dozen screens, rendering unstyled outside one narrow
   selector) — added the missing base style to `styles.css`.

**Deliberately not built:** full "Ticket CRUD" (create/edit a ticket's contents from
scratch) — a kitchen ticket is derived 1:1 from a paid order
(`unique(store_id, order_id)` on `kitchen_tickets`), so standalone creation would duplicate
what checkout already does and break that invariant. Dropped per your instruction rather than
guessed at.

### ✅ Ahmed's PR reviewed and merged

10. **Schema review — done.** Ahmed's `units`/`recipes` migration (`202609240001`) uses the
    composite `(store_id, id)` tenant-scoping convention correctly, is additive-only, and
    doesn't touch `pos_stock`. Applied to the live database and recorded in `APPLIED.md` before
    the PR was even opened.
11. **PR review — done, merged into `develop`** (commit `3f9e171`). Every "do not touch"
    boundary was respected; every task in his brief was complete — migration, pure costing math
    in `packages/domain` (reused by the UI and API, ready for Day 5's food-cost report), the
    `/catalog` recipe/unit endpoints (correctly probing for Bisma's not-yet-existing
    `ingredients`/`recipe_ingredients` tables via `to_regclass` instead of assuming), and the
    recipe builder UI — plus a per-dish Recipe drawer for *existing* dishes that wasn't
    explicitly asked for but was clearly needed (the product editor had no edit path for one).
    Tests across all three layers (7 new domain, 4 new API, 4 new web) all pass, on top of the
    full existing suite. One process note, not a code issue: the PR was opened against `main`
    again (same mistake as Day 2's PRs #2/#3) — retargeted to `develop` before merging.

### ⏳ Still to do today (blocked on Bisma)

12. **Schema review of Bisma's migration**, once it exists — same checklist as above.
13. **Consumption-wiring integration** — blocked until Bisma's `ingredients`/`stock_movements`
    migration is live. Once it is: wire `kitchen.ts`'s item-served transition (the same code
    path that now calls `applyTableStatusTransition`) to also insert `stock_movements` rows for
    the served item's recipe ingredients, using Ahmed's now-merged `recipes`/`recipe_ingredients`
    data. This reaches into both new modules at once, so it stays a Lead task.
12. **Review Ahmed's and Bisma's PRs** against the checklists in their sections below, and
    merge them (Ahmed's first — Bisma's migration has an FK into his `recipes` table). Neither
    has started as of this writing — nothing to review yet.

---

## Ahmed — Recipes + Menu-Side Costing

**Your branch (create it yourself):** `feature/ahmed/day3-recipes-costing`, from the latest
`develop` (`95c2b75` as of this writing — pull fresh before you branch, don't assume that's
still current by the time you start).

### Your workflow
```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feature/ahmed/day3-recipes-costing
git push -u origin feature/ahmed/day3-recipes-costing
```
Commit in small working steps, push regularly. When done, open a PR targeting `develop` (never
`main` — this has gone wrong once already this sprint). **You do not merge your own PR** —
Hamza reviews and merges it.

### 1. Migration — write and apply this first, today

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
RLS: same member-read pattern as every other restaurant table (`kitchen_stations`,
`floor_areas` are good templates) — enable RLS, grant select to authenticated, one member-read
policy per table. Writes go through the API only.

Name the file with the next unused sequence number in `supabase/migrations/` — check the
directory yourself when you get there, don't assume a number (two people picked the same one
independently on Day 2; don't repeat that). Apply it via
`cd apps/api && node scripts/apply-migration.mjs ../../supabase/migrations/<file>.sql`, then
**immediately** add its row to `supabase/migrations/APPLIED.md` (SHA-256 + the object that
confirms it applied — copy the existing rows' format exactly).

**Apply and confirm to Bisma the moment it's live** — her `ingredients` migration has a foreign
key into a table (`recipe_ingredients` → `recipes`) that only exists once yours does.

### 2. Recipe builder UI

New "Recipe" section on the existing product editor in `ProductCatalogScreen.tsx` — not a
separate screen. Ingredient lines (ingredient, quantity, unit), add/remove lines, a yield
quantity/unit for the recipe as a whole. The ingredient picker and the `recipe_ingredients`
join table are Bisma's — your UI reads from and writes to them, you don't own their schema.

### 3. Recipe costing

Sum each line's `quantity × ingredient.cost_per_unit_cents` (require the recipe line's unit to
match the ingredient's stored unit for now — flag full unit conversion as a follow-up rather
than building a conversion table today). Display the cost and an estimated food-cost %
(cost ÷ menu price) in the product editor. This can't show real numbers until Bisma's
`ingredients` table is live — build the UI regardless, expect zeros until then, don't block on
it.

### 4. API

Create/update a recipe and replace its ingredient lines for a product — a full replace-on-save
is simpler and safer than incremental line CRUD, matching how `ProductCatalogScreen` already
handles category/tax-rate edits.

### 5. Files you may touch
`apps/web/src/screens/ProductCatalogScreen.tsx`, a new recipe editor component under
`apps/web/src/screens/menu/`, `apps/api/src/routes/catalog.ts`, your migration file.

### 6. Do not touch
`apps/web/src/screens/floor/`, `apps/web/src/screens/kitchen/`, `apps/api/src/routes/floor.ts`
(now substantially bigger than Day 2 left it — full area/table CRUD plus Transfer/Merge),
`apps/api/src/routes/kitchen.ts` (Hamza's consumption-wiring task lands here once your and
Bisma's schemas exist), `pos-store.ts`, `RegisterScreen.tsx` and `apps/api/src/routes/orders.ts`
(both gained real logic today — stock-oversell warning, mandatory guest, ticket auto-fire — on
top of the checkout/discount logic that was already off-limits). If your costing UI ever needs
to reference the register's stock-warning pattern for consistency (e.g. a future low-stock
badge on `MenuItemCard`), reuse the `--mise-warning` treatment already established in
`RestaurantOrderItem.tsx`'s `.cart-line-stock-warning` rather than inventing a new one.

### 7. Before opening your PR
Run the full check from `RULES.md` §6 (domain/api/web test+build+typecheck). Add at least one
test for the recipe costing calculation — if it's a pure function, put it in `packages/domain`
so Day 5's food-cost report can reuse it later instead of it being trapped in a component.

### Definition of done
A menu item can have a recipe with costed ingredient lines, and its estimated food-cost % is
visible where its price is set.

---

## Bisma — Ingredient Inventory (full stack)

**Your branch (create it yourself):** `feature/bisma/day3-ingredient-inventory`, from the
latest `develop` — pull fresh before you branch.

### Your workflow
Same as Ahmed's above: `fetch` → `checkout develop` → `pull` → `checkout -b
feature/bisma/day3-ingredient-inventory` → push → commit in small steps → PR to `develop` →
Hamza reviews and merges, you don't merge your own PR.

**Dependency — cleared.** Ahmed's `units`/`recipes` migration (`202609240001`) is applied and
merged into `develop`. You can apply yours now.

### 1. Migration — write now, apply once Ahmed confirms his is live

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
(`purchase`/`consumption`/`wastage`/`adjustment`) plus display labels, mirroring
`table-status.ts`/`kitchen-ticket-status.ts`. Hamza's consumption-wiring task reuses this union
later today, so land it as its own small commit early if you can rather than buried at the end
of a large PR.

Name the file with the next unused sequence number after Ahmed's (check
`supabase/migrations/` directly). Apply, then **immediately** add its `APPLIED.md` row, same as
Ahmed's instructions above.

### 2. Backend
CRUD for ingredients (create/update/deactivate), record an incoming batch, list stock
movements for an ingredient, record a manual wastage entry (a `stock_movements` row with
`reason='wastage'` and a negative `delta`).

### 3. UI — new screen
A new `/inventory` route. **Ask Hamza before adding the nav entry** — nav changes need Lead
sign-off (`docs/DESIGN_SYSTEM.md`). Contents:
- Ingredient list: name, unit, current stock, reorder threshold, a low-stock indicator when
  `current_stock <= reorder_threshold` (reuse the six-tone status system in
  `docs/DESIGN_SYSTEM.md` — `warning` tone for low stock, don't invent a new color).
- Per-ingredient batch list with expiry highlighting (`danger` tone once past `expires_at`,
  `warning` tone within some reasonable window before it — pick something sensible like 3 days
  and note the choice in your PR so it can be adjusted).
- Stock movement ledger (read-only, most recent first).
- A wastage-entry form (ingredient, quantity, reason note).

Build this the way `screens/floor/` is structured — a screen file plus small focused
components in the same folder, styled entirely from existing `--mise-*` tokens, no new colors.

### 4. Do not touch
`apps/web/src/screens/ProductCatalogScreen.tsx` (Ahmed's recipe UI), `apps/web/src/screens/kitchen/`
and `apps/api/src/routes/kitchen.ts` (Hamza wires the consumption hook there later today — note
that file now also contains the Day 2 ticket→table-status sync, so read it before assuming its
shape; your job is to make sure `ingredients`/`stock_movements` exist and are queryable, not to
call into that file yourself), `apps/web/src/screens/floor/` and `apps/api/src/routes/floor.ts`
(Hamza built full area/table CRUD and Transfer/Merge there today — unrelated to your module, but
don't touch it), `RegisterScreen.tsx` and `apps/api/src/routes/orders.ts` (gained stock-warning,
mandatory-guest, and ticket-auto-fire logic today).

### 5. Before opening your PR
Run the full check from `RULES.md` §6. Add a test for at least the low-stock/reorder-threshold
logic and the wastage-entry validation.

### Definition of done
Ingredients, batches, and stock movements exist and are fully manageable through a real screen
— creating an ingredient, receiving a batch, and recording wastage all work end-to-end. Nothing
consumes stock automatically yet — that's Hamza's follow-up once your migration is live.

---

## Day 3 completion checklist (nothing missed)

**Hamza:**
- [x] Table order total on the Floor screen — merged.
- [x] Ticket-served → table sync, automatic + manager override — merged.
- [x] Stock-oversell warning at checkout — pushed (`feature/hamza/day3-checkout-integrity`),
      awaiting your merge.
- [x] Mandatory guest selection at checkout — pushed, same branch.
- [x] Bill shows guest name/phone/order type — pushed, same branch.
- [x] Kitchen tickets auto-fire to `preparing` — pushed, same branch.
- [x] Floor area/table CRUD — merged.
- [x] Transfer and Merge, actually implemented — merged.
- [x] Schema review of Ahmed's migration — done, correct.
- [x] Review and merge Ahmed's PR — done (`3f9e171`), retargeted from `main` to `develop` first.
- [ ] Schema review of Bisma's migration, once it exists.
- [ ] Consumption-wiring hook in `kitchen.ts`, once Bisma's schema is live.
- [ ] Review and merge Bisma's PR, once it exists.
- [ ] Deliberately dropped: full Ticket CRUD (create/edit ticket contents from scratch) — see
      the reasoning above; not tracked as outstanding, it's an intentional scope decision.

**Ahmed — done:**
- [x] `units` + `recipes` schema, applied and recorded in `APPLIED.md`.
- [x] Recipe builder UI + costing display, plus a Recipe drawer for existing dishes.

**Bisma** (not started as of this writing):
- [ ] `ingredients` + `ingredient_batches` + `stock_movements` + `recipe_ingredients` schema,
      applied and recorded in `APPLIED.md`.
- [ ] Ingredient inventory screen: list, batches, ledger, wastage.

**Documentation:**
- [ ] `docs/MODULE_STATUS.md` and `docs/FIVE_DAY_PLAN.md` given a final pass once Ahmed's and
      Bisma's work lands too, reflecting the true end-of-day state including anything that
      slipped.
