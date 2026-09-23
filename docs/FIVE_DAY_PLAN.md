# Five-Day Plan

Team: **Hammad** (Team Lead + developer), **Ahmed**, **Bisma**, **Hamza** (joining Day 3).
Update this file at the end of every day (`RULES.md` §12) — mark complete/partial/blocked/
moved, don't keep executing a stale plan.

## Days 1–2 — already complete (retrospective)

Full detail: `docs/09_restaurant_pos_blueprint.md` (Day 1), `docs/day-plans/day2.md` (Day 2).
Summary for context, not to be redone:

- **Day 1** (Ahmed + Bisma): MISE design system, app shell/nav, Dine-In/Takeaway/Delivery order
  type on the register, restaurant menu columns, Floor & Tables screen + read API. Later
  audited by Ahmed for gaps (order-line notes, modifiers placeholder, availability on
  back-of-house screens) — closed and merged.
- **Day 2** (Ahmed + Bisma): order-type/table persistence into `pos_orders`, kitchen tickets +
  Kitchen Display System, real table-status lifecycle (Seat/Add order/Bill/Settle/Clean) with
  waiter assignment. Merged into `develop` with Lead integration fixes (wrong PR base branch,
  a duplicate-declaration bug from two branches independently adding the same store field, a
  missing migration ledger entry, a same-day migration numbering collision).
- **Two known gaps carried into Day 3** (see Day 3 §Hammad below): a served kitchen ticket
  doesn't yet flip its table's status, and `TableCard` doesn't yet show a live order total.

`docs/MODULE_STATUS.md` has the full per-module state.

---

## Day 3 — Food Operations (+ a head start on Day 4)

**Why this split:** Module H (Customers) depends only on existing `pos_orders`/`pos_customers`
— nothing from Day 3's new schema. Pulling it forward removes it from Day 4's critical path
instead of stacking every remaining module strictly one-per-day, which is how a 4-day runway
for POS+Kitchen+Recipes+Inventory+Loyalty+Promotions+Staff+Reports actually fits — see the
Lead's note at the bottom of this file on why the original per-day split was too tight for 3
people and why a 4th person changes the math.

**Sequencing:** Ahmed's `recipes`/`units` migration must be applied before Hamza's
`ingredients`/`stock_movements` migration (the latter's `recipe_ingredients` table references
both). Ahmed applies first thing and confirms to Hamza before Hamza applies his.

### Hammad — Lead + critical integration

1. **Close Day 2 gap — table order total.** `apps/api/src/routes/floor.ts`: join `pos_orders`
   (by `table_id`, latest non-refunded order) to surface a running total/order id on
   `GET /floor`. `TableCard.tsx`: replace the "—" placeholder. *Files:* `routes/floor.ts`,
   `screens/floor/TableCard.tsx`. *DB:* none (read-only join). *Tests:* none currently exist
   for `floor.ts` — add one. *Branch:* `feature/hammad/day3-floor-order-total`.
2. **Close Day 2 gap — ticket served → table status.** Design decision: when every item on a
   dine-in ticket reaches `served`, call the existing `PATCH /floor/tables/:id/status`
   (`ordering`/`seated` → `served`) from `kitchen.ts`'s `patchItem`. Requires deciding whether
   `TRANSITIONS` in `floor.ts` needs a new edge into `served` reachable only from
   system-triggered calls, not the UI — don't just loosen it for everyone. *Files:*
   `apps/api/src/routes/kitchen.ts`, `apps/api/src/routes/floor.ts`. *Tests:* extend
   `orders.test.ts`/add a kitchen route test covering the trigger. *Branch:*
   `feature/hammad/day3-ticket-to-table-status`.
3. **Recipe/inventory schema coordination.** Review Ahmed's and Hamza's migrations before
   either applies (composite-FK convention, additive-only, no overlap with `pos_stock`).
4. **Consumption-wiring integration** (after both Ahmed's and Hamza's schema are live): wire
   `kitchen.ts`'s item-served transition to insert `stock_movements` rows for the served item's
   recipe ingredients (Ahmed's `recipe_ingredients` × Hamza's `ingredients`). This is the one
   piece that only the Lead should own, since it reaches into both new modules at once. *Files:*
   `apps/api/src/routes/kitchen.ts`. *Branch:* `feature/hammad/day3-consumption-wiring` (or
   folded into task 2's branch if timing allows — Lead's call).
5. Review Ahmed's, Hamza's and Bisma's PRs (checklists below); merge order: Ahmed → Hamza →
   Bisma → Hammad's own integration branches last (they depend on the others' schema/endpoints).

### Ahmed — Recipes + Menu-Side Costing

**Branch:** `feature/ahmed/day3-recipes-costing`
- **Migration** (apply first, today): `units` (id, store_id, name, abbreviation, kind:
  mass/volume/count), `recipes` (id, store_id, product_id → `pos_products`, yield_quantity,
  yield_unit_id → `units`). Confirm to Hamza once live.
- **Backend:** recipe CRUD endpoints (create/update a recipe + its ingredient lines — the
  ingredient-line table itself is Hamza's `recipe_ingredients`, created in his migration once
  `units`/`recipes` exist; Ahmed's API writes to it).
- **UI:** recipe builder section on `ProductCatalogScreen.tsx`'s product editor; estimated
  food-cost % display (needs `ingredients.cost_per_unit_cents` — Hamza's column — so this part
  of the UI lands after his migration).
- **DB:** `units`, `recipes` (this branch); reads `recipe_ingredients`/`ingredients` (Hamza's).
- **Tests:** recipe costing math (pure function in `packages/domain` if the calculation is
  reusable — check before duplicating it inline).
- **Dependencies:** none to start (units/recipes are self-contained); costing display depends
  on Hamza's ingredient migration.
- **Files:** `ProductCatalogScreen.tsx`, new recipe editor under `screens/menu/`,
  `apps/api/src/routes/catalog.ts`, migration file.
- **Do not touch:** `screens/floor/`, `screens/kitchen/`, `screens/CustomerScreen.tsx`.
- **PR must state:** whether costing display shipped in this PR or is a fast-follow once
  Hamza's schema lands.

### Hamza — Ingredient Inventory (new module, full stack)

**Branch:** `feature/hamza/day3-ingredient-inventory`

Welcome to the codebase — read `docs/ARCHITECTURE.md` and `docs/DESIGN_SYSTEM.md` first;
`docs/10_test_workflow.md` for how to run everything locally.

- **Migration** (after Ahmed's `units`/`recipes` are live): `ingredients` (id, store_id, name,
  unit_id → `units`, cost_per_unit_cents, current_stock, reorder_threshold, active),
  `ingredient_batches` (id, ingredient_id, store_id, quantity, received_at, expires_at,
  cost_per_unit_cents), `stock_movements` (id, store_id, ingredient_id, batch_id nullable,
  delta, reason, kitchen_ticket_item_id nullable → `kitchen_ticket_items`, created_at),
  `recipe_ingredients` (id, recipe_id → `recipes`, ingredient_id, quantity, unit_id). Shared
  contract `packages/domain/src/stock-movement-reason.ts`
  (`purchase`/`consumption`/`wastage`/`adjustment` + labels).
- **Backend:** ingredient CRUD, batch recording, stock-movement ledger read, manual wastage
  entry.
- **UI:** new `/inventory` screen (ask Hammad to approve the nav entry per
  `docs/DESIGN_SYSTEM.md`/nav-change convention) — ingredient list with current stock/reorder
  threshold, batch entry with expiry highlighting, movement ledger, wastage form. Use
  `TABLE_STATUS_TONE`-style tone mapping for low-stock/expiring badges (reuse the six-tone
  system in `docs/DESIGN_SYSTEM.md`, don't invent new colors).
- **DB:** `ingredients`, `ingredient_batches`, `stock_movements`, `recipe_ingredients`.
- **Tests:** ingredient CRUD validation; a movement-ledger aggregation test if any math is
  involved (mirror `reports.test.ts`'s PGlite pattern if it needs real query testing).
- **Dependencies:** Ahmed's `units`/`recipes` migration must be live first.
- **Files:** `apps/web/src/screens/inventory/` (new), `apps/api/src/routes/inventory.ts` (new),
  migration file, `packages/domain/src/stock-movement-reason.ts` (new).
- **Do not touch:** `ProductCatalogScreen.tsx` (Ahmed's recipe UI), `screens/kitchen/` (Hammad
  wires the consumption hook there, not you — expose the data he needs, don't call into his
  file yourself).

### Bisma — Customer / CRM Profile (pulled forward from Day 4)

**Branch:** `feature/bisma/day3-guest-crm`

No dependency on anything else happening today — this only reads `pos_orders`/`pos_customers`,
which already exist. Independent of Ahmed's and Hamza's work.

- **Backend:** aggregation query for a customer's visit count, lifetime spend, last visit,
  favorite category/dish — from existing `pos_orders`/`pos_order_items`, not a new counter
  table that could drift from the source data.
- **UI:** extend `CustomerScreen.tsx` (or a new detail view) with this profile data.
- **DB:** none new — read-only against existing tables.
- **Tests:** the aggregation query, mirroring `reports.test.ts`'s approach if it needs
  timezone-correct date bucketing.
- **Dependencies:** none.
- **Files:** `apps/web/src/screens/CustomerScreen.tsx`, `apps/api/src/routes/customers.ts`.
- **Do not touch:** `RegisterScreen.tsx`'s checkout logic, `pos-store.ts`, floor/kitchen
  screens (even though you own Floor — this task doesn't need it).

### Day 3 Definition of Done
- Ahmed: a menu item can have a costed recipe.
- Hamza: ingredients, batches, and stock movements exist and are manageable via a real screen;
  no consumption wiring yet (that's Hammad's task, likely finishing early Day 4).
- Bisma: a guest's profile shows real visit/spend history.
- Hammad: both Day 2 gaps closed; recipe/inventory schema reviewed and consistent.

---

## Day 4 — Loyalty, Promotions, Staff (+ a head start on Day 5)

**Why this split:** Reporting's raw data (kitchen timing, stock movements) already exists by
now — Hamza can start the inventory/wastage report queries in parallel with Loyalty work
elsewhere, the same forward-pull pattern as Day 3.

### Hammad — Lead + critical integration
1. Finish/verify Day 3's consumption-wiring if it slipped.
2. **Loyalty schema + the one real design decision:** how point redemption interacts with the
   existing `LineDiscount`/manager-approval system in `pos-store.ts` — it must reuse that
   mechanism, not add a parallel discount path. Land `loyalty_accounts`,
   `loyalty_point_ledger`, `loyalty_tiers`, `reward_rules` before Ahmed's branch starts.
3. Review Ahmed's, Bisma's, Hamza's PRs. Merge order: Bisma (promotions, independent) → Hamza
   (report-query groundwork, independent) → Ahmed (loyalty checkout — touches
   checkout-critical code, review this one hardest, run the existing checkout/discount test
   suite explicitly, not just the new tests).

### Ahmed — Loyalty at Checkout
**Branch:** `feature/ahmed/day4-loyalty-checkout`
- **Backend:** award points on order completion per the active reward rule (idempotent —
  no double-award on a retried request); redeem points through the existing discount path.
- **UI:** "Redeem points" action in the register cart.
- **DB:** none new (Hammad's loyalty migration).
- **Tests:** ledger idempotency; existing checkout/discount tests must still pass unmodified.
- **Dependencies:** Hammad's loyalty schema live first.
- **Files:** `apps/api/src/routes/orders.ts`, `apps/web/src/lib/pos-store.ts` (additive only),
  `RegisterScreen.tsx` (redeem UI only).
- **Do not touch:** `CustomerScreen.tsx`, floor/kitchen/inventory screens.

### Bisma — Promotions + Loyalty Recognition on the Floor
**Branch:** `feature/bisma/day4-promotions`
- **Migration:** `promotions` (id, store_id, name, discount_kind, discount_value, starts_at,
  ends_at, active) — independent of Hammad's loyalty tables, apply any time.
- **UI:** owner/manager promotions list/create screen (manages data only — Ahmed's checkout
  code applies it); a small loyalty-tier badge on `TableCard`/floor detail panel once a known
  guest is attached to a table.
- **DB:** `promotions`.
- **Tests:** promotion CRUD validation.
- **Dependencies:** none for the promotions screen; the floor badge needs Day 3's guest-profile
  work (your own) and Hammad's loyalty tables for tier data.
- **Files:** new promotions screen, `apps/api/src/routes/customers.ts` or a new
  `routes/promotions.ts`, `screens/floor/` (badge only), migration file.
- **Do not touch:** `RegisterScreen.tsx`'s checkout logic, `pos-store.ts`.

### Hamza — Inventory Polish + Report-Query Groundwork (pulled forward from Day 5)
**Branch:** `feature/hamza/day4-inventory-reports-groundwork`
- Finish any Day 3 inventory rough edges first.
- **Backend:** the query functions Day 5 will need — low-stock list, ingredients nearing
  expiry, wastage cost over a period — as reusable functions in `apps/api/src/routes/reports.ts`
  or a new `lib/inventory-reports.ts`, mirroring `reports.ts`'s existing timezone-correct
  patterns. Not wired to a UI yet — that's Day 5.
- **Tests:** these queries, PGlite-backed like `reports.test.ts`.
- **Dependencies:** your own Day 3 schema.
- **Files:** `apps/api/src/routes/inventory.ts`, `apps/api/src/lib/` (new query helpers).
- **Do not touch:** loyalty/promotions files.

### Day 4 Definition of Done
- A returning guest can earn and redeem loyalty points through the existing approval-safe
  discount flow.
- Promotions can be created and (badge-level) recognized on the floor.
- Day 5's inventory report queries exist and are tested, just not yet surfaced in a screen.

---

## Day 5 — Reporting, Integration, Hardening

Per `RULES.md` §13: this is not 100% new feature work. Real capacity goes to integration,
bug-fixing, security review, and polish.

### Hammad — Lead + final integration
1. Cross-module integration pass: place a real dine-in order → recipe ingredients consume →
   stock movement recorded → kitchen ticket served → table freed → loyalty points awarded →
   all four reports (below) reflect it. This end-to-end chain is the actual acceptance test for
   the whole sprint, not any single day's isolated DoD.
2. Security/RLS review: every table added Days 1–4 uses the composite-FK tenant-isolation
   pattern (`docs/ARCHITECTURE.md` §1.4) — spot-check, don't assume.
3. Performance pass: the JS bundle warning flagged in `docs/MODULE_STATUS.md` — at minimum,
   measure it; fix it only if it's a real user-facing problem, not for its own sake.
4. Design-consistency pass against `docs/DESIGN_SYSTEM.md` across everything shipped this
   sprint.
5. Update `docs/MODULE_STATUS.md` to its true final state — including whatever isn't actually
   done. Do not mark the sprint "complete" if core flows are still rough.
6. Review Ahmed's, Bisma's, Hamza's report PRs; merge in any order (all read-only).

### Ahmed — Kitchen + Food-Cost Reports
**Branch:** `feature/ahmed/day5-kitchen-food-cost-reports`
- Dish profitability (price − Day 3 recipe cost × sales volume), food-cost report
  (`stock_movements` where `reason='consumption'` vs. revenue), kitchen performance
  (`kitchen_tickets` timestamps by station).
- **Files:** new report screens/section, `apps/api/src/routes/reports.ts`.
- **Do not touch:** owner dashboard, customer/inventory reports.

### Bisma — Owner Dashboard + Customer Reporting
**Branch:** `feature/bisma/day5-owner-dashboard`
- Today's sales/orders/occupied tables/average order value, repeat-visit rate, loyalty point
  liability, top guests by spend. Real empty states for anything with no data yet.
- **Files:** `ReportingScreens.tsx`, `apps/api/src/routes/reports.ts`.
- **Do not touch:** kitchen/food-cost/inventory reports.

### Hamza — Inventory + Wastage Reporting
**Branch:** `feature/hamza/day5-inventory-reports`
- Wire Day 4's query groundwork into an actual screen: low-stock list, expiring batches,
  wastage cost over time.
- **Files:** new inventory-reports screen, `apps/api/src/routes/inventory.ts`.
- **Do not touch:** kitchen/customer reports.

### Day 5 Definition of Done
- The end-to-end chain in Hammad's task 1 works, observed once, manually, start to finish.
- All four report surfaces show real data with correct empty states.
- `docs/MODULE_STATUS.md` reflects reality, not the plan.

---

## Note on scope (why the split changed from the original 3-person, 1-module-per-day plan)

Day 2 alone — with two careful developers — needed a Lead integration pass to fix a wrong PR
base branch, a compiling-but-broken duplicate-field merge, a missed migration ledger entry, and
a numbering collision, plus it left two honestly-flagged gaps. Recipes+Inventory (Day 3) and
Loyalty+Promotions+Staff (Day 4) are each at least as large. Cramming the full original scope
into 4 remaining calendar days with 3 people wasn't realistic for genuine completion, not
partial scaffolding. Adding Hamza and deliberately pulling work forward across day boundaries
where there's no real dependency (Customers into Day 3, report-query groundwork into Day 4) is
the fix — it's still an aggressive schedule, but now it's aggressive-and-plausible rather than
aggressive-and-fictional.
