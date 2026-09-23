# Restaurant POS Transformation Blueprint

Source of truth for the multi-day transformation of Dineflow from a generic POS into a
Restaurant Operating System. Referenced by commit `751d798` and `80f7608` before this file
existed; this is that document, written retroactively and kept current going forward.

## 0. Where we actually start from (read this before assuming Day 1 is greenfield)

As of this writing, `develop` already contains:

- **The MISE design system** — `apps/web/src/styles.css` Section E (`--mise-*` tokens: colors,
  radii, spacing, shadows). Applied across *every* screen, not just the shell.
- **The Dineflow rebrand** — copy, local DB name, package names, all renamed end-to-end.
- **The navigation shell** — sidebar with Dashboard, Sell, Menu, Orders, Guests, Reports,
  Settings, Floor & Tables, Kitchen. The last two are placeholder stubs.
- **The restaurant floor-plan schema** — `kitchen_stations`, `floor_areas`, `restaurant_tables`,
  plus additive nullable columns on `pos_products` (`station_id`, `prep_time_seconds`, `course`,
  `kitchen_name`, `is_available`, `unavailable_until`, `sells_directly`). Applied to the live
  Supabase project. Nothing in the app reads or writes any of it yet.
- **CI** — GitHub Actions runs build + full test suite for both apps on every PR/push to `main`
  and `develop`.

So Day 1's "shared foundation" (design tokens, shell, nav skeleton, CI, base schema) is done.
What's left for Day 1 is turning that foundation into working screens: an actual Floor screen
(Bisma) and an actual restaurant-shaped POS/menu experience (Ahmed) — see Sections 3 and 4.

## 1. Design contract (already established — extend, do not replace)

Canonical source: `apps/web/src/styles.css`, Section E, `:root` block. Do not redefine these
values anywhere else; reference the CSS custom properties by name.

| Token | Value | Use |
|---|---|---|
| `--mise-canvas` | `#F2F0EC` | App background |
| `--mise-surface` | `#FFFFFF` | Elevated surfaces / cards |
| `--mise-surface-sunken` | `#E9E6E0` | Recessed panels, hover fill |
| `--mise-border-hairline` / `--mise-border-strong` | `#E0DCD5` / `#C9C3BA` | Borders |
| `--mise-ink` / `--mise-ink-secondary` / `--mise-ink-muted` / `--mise-ink-disabled` | `#1B1917` / `#55504A` / `#6F6860` / `#9C948A` | Text |
| `--mise-action` / `--mise-action-hover` | `#1F1B17` / `#36302A` | Primary buttons |
| `--mise-saffron` / `--mise-saffron-deep` / `--mise-saffron-fill` | `#E5A73C` / `#9A6A12` / `#FBEFD8` | Brand accent, active nav rail, "in progress" |
| `--mise-success` / `--mise-success-fill` | `#1F7A4D` / `#E3F2E9` | Available / synced / positive |
| `--mise-warning` / `--mise-warning-fill` | `#C2600D` / `#FCEBD8` | Needs attention |
| `--mise-danger` / `--mise-danger-fill` | `#B3271F` / `#FBE6E3` | Blocked / out of service |
| `--mise-info` / `--mise-info-fill` | `#1F5C8C` / `#E4EEF6` | Neutral in-progress (seated, reserved) |
| `--mise-service-*` | dark surface set | Sidebar / auth art / cashier terminal chrome |
| `--mise-r1`–`--mise-r4` | `2/4/8/12px` | Radii — small controls to cards, nothing "huge rounded" |
| `--mise-space-2`–`--mise-space-32` | `2/4/8/12/16/24/32px` | Spacing scale |
| `--mise-e1`–`--mise-e3` | shadow scale | Elevation |

Typography: **Archivo** (headings, UI text, buttons) + **IBM Plex Mono** (prices, quantities,
receipt numbers, order IDs — anything numeric that benefits from tabular figures).

Existing reusable pattern to extend, not reinvent: `.order-state` (see `OrderHistoryScreen`/
`styles.css`) is already the status-chip primitive — a fill/ink color pair keyed by state.
Floor table cards and POS status badges should extend this same class family, not invent a
new chip component.

**Rule for Days 2–5:** none of the above changes without Team Lead sign-off. New screens
consume these tokens; they don't add new ones except through the Lead.

## 2. Shared code contracts (new — added in this lead-prep commit)

Two gaps existed that would have let Ahmed and Bisma each invent their own representation:

- `packages/domain/src/order-type.ts` — `OrderType = 'dine_in' | 'takeaway' | 'delivery'`,
  `ORDER_TYPES`, `ORDER_TYPE_LABELS`. Import this; don't declare a local union.
- `packages/domain/src/table-status.ts` — `TableStatus`, mirroring the exact check constraint
  on `restaurant_tables` (`available, seated, ordering, served, bill_requested, dirty, reserved,
  out_of_service`), plus `TABLE_STATUS_LABELS` and `TABLE_STATUS_TONE` (maps each status to a
  `--mise-*` fill/ink pair — success/saffron/info/warning/danger/muted).

Import both by relative path, the same way `apps/web/src/lib/pos-store.ts` already imports
`packages/domain/src/money` — this repo doesn't use package-manager-resolved workspace imports
for `@dineflow/domain` yet.

Note the DB's table-status enum doesn't have a distinct "food ready" value — that granularity
is a kitchen-ticket concept (Day 2's KDS: preparing → ready → served), not a table concept.
Don't fold it into `TableStatus`; don't add a migration for it without Lead coordination.

## 3. Ahmed — Day 1: Restaurant POS + Menu Experience

Branch: `feature/day1-ahmed-restaurant-pos` (from `develop`).

Starting point: `RegisterScreen.tsx` (Sell) and `ProductCatalogScreen.tsx` (Menu) are already
MISE-styled but still structurally generic — a flat product grid with no restaurant semantics.
The new `pos_products` columns (`station_id`, `course`, `kitchen_name`, `is_available`,
`unavailable_until`, `sells_directly`) exist in the DB but aren't selected by
`apps/api/src/routes/catalog.ts`'s snapshot query yet, and nothing in the web app reads them.

1. **Order type.** Add a Dine-In / Takeaway / Delivery selector to the register flow using
   `OrderType` from `packages/domain/src/order-type.ts`. Local/cart state only today (e.g. on
   `usePosStore`) — no DB column on orders exists yet and none should be added today; that's
   Day 2, once kitchen routing needs to persist it.
2. **Menu presentation.** Extend the catalog snapshot query to select the new restaurant
   columns, and adapt `ProductCatalogScreen`/the register's product grid to show dish
   availability (`is_available` / `unavailable_until`) and course/station where present,
   without breaking stores that haven't populated those columns yet (they're all
   nullable/defaulted).
3. **Reusable components** (new, under `apps/web/src/screens/` or a new `restaurant/` folder —
   Ahmed's call, but name it once and keep everything there): `MenuItemCard`,
   `MenuCategoryTabs`, `MenuSearch`, `DishAvailability`, `RestaurantOrderItem`. Build on the
   existing `.catalog-card`/`.categories`/`.search` CSS rather than parallel styling.
4. **Checkout stays working.** `PaymentScreen.tsx` and the cart totals/discount/manager-approval
   flow in `pos-store.ts` are not touched today.
5. Do not touch: `floor_areas`/`restaurant_tables`/`kitchen_stations` tables, the `/floor` or
   `/kitchen` routes, `CustomerScreen.tsx`, `ReportingScreens.tsx`.

## 4. Bisma — Day 1: Front of House + Restaurant Floor

Branch: `feature/day1-bisma-front-of-house` (from `develop`).

Starting point: `/floor` currently renders the generic `Placeholder` component in `App.tsx`
("POS FOUNDATION — Coming next"). The `floor_areas`/`restaurant_tables` tables exist with
member-read RLS policies, but **no API route reads them yet** — `apps/api/src/routes/` has no
floor/table endpoint. This has to be built today, not assumed to exist.

1. **API.** Add a read endpoint (new `apps/api/src/routes/floor.ts`, following the auth pattern
   in `catalog.ts`'s `snapshot` — `requireStoreMember`/`requireCashierTerminal`) that returns a
   store's `floor_areas` and `restaurant_tables`. Register it in `app.ts`/`server.ts` next to
   the other route registrations. Read-only; no writes today (no open-ticket layer exists yet to
   legitimately change a table's status, so leave that for the day a seating flow exists).
2. **Floor screen.** Replace the `/floor` placeholder in `App.tsx` with a real `FloorScreen`.
   Area tabs/filter using `floor_areas`; a table grid using `restaurant_tables`.
3. **Table status.** Use `TableStatus`/`TABLE_STATUS_LABELS`/`TABLE_STATUS_TONE` from
   `packages/domain/src/table-status.ts` — do not invent new status strings or new colors.
4. **TableCard component** (reusable, e.g. `apps/web/src/screens/floor/TableCard.tsx`): table
   label, seat count, status chip (extend `.order-state`'s pattern), and slots for
   waiter/duration/running-total that render empty/placeholder until an open-ticket layer
   exists to populate them (no fake data).
5. **Table detail foundation.** Clicking a table can open a stub detail view (drawer or route)
   with the fields the migration already supports (label, seats, area, status) — add/transfer/
   merge/bill actions are Day 2+, render as visibly disabled today rather than omitted, so the
   contract is visible.
6. **Dashboard (optional, only if cleanly isolated).** `OwnerDashboardScreen` in
   `ReportingScreens.tsx` may gain an "Occupied Tables" stat sourced from the same floor read
   endpoint. Skip if it risks touching shared reporting logic Ahmed or reporting work depends on.
7. Do not touch: `RegisterScreen.tsx`, `ProductCatalogScreen.tsx`, `PaymentScreen.tsx`,
   `pos-store.ts`, checkout/discount/manager-approval logic, the `pos_products` table.

## 5. Team Lead — Day 1

- Git: `develop` prepared and synced; `feature/day1-ahmed-restaurant-pos` and
  `feature/day1-bisma-front-of-house` cut from the same `develop` HEAD (this session).
- Shared contracts landed directly on `develop` before branching (Section 2), so neither
  developer invents `OrderType`/`TableStatus` independently.
- Review both PRs for: correct use of the shared tokens/contracts, no duplicate status-chip or
  menu-card implementations, no changes to checkout/discount logic, no new DB migrations
  without sign-off, clean TypeScript, routes registered correctly, no regressions in existing
  suites.
- Integration: pull both branches, run `apps/api` (`npm run build && npm test && npm run
  test:integration && npm run test:orders`) and `apps/web` (`npm test && npm run build`) plus
  `packages/domain` (`npm test`), verify `/floor`, `/register`, `/products` manually, then merge
  into `develop` and push.

## 6. Branches

| Branch | Owner | Base |
|---|---|---|
| `feature/day1-ahmed-restaurant-pos` | Ahmed | `develop` (this session's HEAD) |
| `feature/day1-bisma-front-of-house` | Bisma | `develop` (this session's HEAD) |

Neither merges directly into `develop`. Both go through PR review by the Team Lead.

## 7. Days 2–5: four implementation days, one stage each

Day 1 was setup and foundation only — design system, nav shell, base schema, CI. That leaves
**four full implementation days** to deliver the entire remaining product vision, one complete
stage per day. Nothing is deferred to a "day 6"; each day below must land its whole stage
end-to-end (schema → API → UI) before the next day's branches are cut. Full per-person task
breakdowns (Ahmed/Bisma/Lead, as separate reviewable markdown files) are produced day-by-day in
`docs/day-plans/` — `day2-ahmed.md`, `day2-bisma.md` and `day2-lead.md` exist now; Day 3–5's
are written once the prior day is merged, so they reflect what actually landed rather than
guessing ahead.

- **Day 2 — Orders + Front of House + Kitchen.** *Ahmed:* persist `order_type`/`table_id` on
  orders, generate kitchen tickets per station on checkout, build the Kitchen Display System.
  *Bisma:* real table-status writes (available→seated→ordering→bill_requested→dirty→available),
  waiter assignment, enabling the Day 1 Add order/Transfer/Merge/Bill actions. *Lead:* the
  `kitchen_tickets`/`kitchen_ticket_items` schema and shared `KitchenTicketStatus` contract,
  landed before either branch starts.
- **Day 3 — Recipes + Ingredient Inventory.** *Ahmed (menu/costing side):* recipes, recipe
  ingredients, portion quantities, recipe costing surfaced on the menu/POS side. *Bisma
  (inventory/ops side):* ingredient-level stock, units, batches/expiry, wastage, stock movements
  tied to the kitchen tickets Day 2 introduced. *Lead:* `ingredients`/`units`/`recipes`/
  `recipe_ingredients`/`stock_movements` schema and the shared costing contract, plus deciding
  exactly how a served kitchen ticket decrements ingredient stock.
- **Day 4 — Customers + Loyalty + Restaurant CRM.** *Ahmed:* loyalty points/tiers and
  reward-rule logic tied to checkout. *Bisma:* visit history, lifetime spend, and
  promotions/discounts surfaced on the guest profile (extends the existing `pos_customers`/
  guests model from `docs/05`) plus table-side "loyalty customer" recognition on the floor.
  *Lead:* loyalty schema (points ledger, tiers, reward rules) and the shared reward-rule
  contract.
- **Day 5 — Reporting + Management + Intelligence Foundation.** *Ahmed:* dish profitability,
  food-cost and kitchen-performance reports, drawing on Day 2's tickets and Day 3's recipe
  costs. *Bisma:* the owner dashboard, sales/customer reporting, wastage and inventory
  reporting, drawing on Day 3's stock movements and Day 4's loyalty data. *Lead:* final
  cross-module integration and polish; demand-forecasting/prep-recommendation groundwork only
  if real operational data already exists by then — no fabricated AI features.

Each day's branches are cut fresh from `develop` **after** the previous day's PRs are merged
and pushed — never from a stale prior-day branch.

## 8. Definition of Done — Day 1

- No broken routes; no TypeScript errors; no build errors in `apps/web` or `apps/api`.
- All existing suites still pass (`apps/web` vitest suites, `apps/api` unit/integration/orders,
  `packages/domain` node test runner).
- `/floor` renders a real screen backed by `floor_areas`/`restaurant_tables`, not the generic
  placeholder.
- The register/menu flow shows an order-type selector and reads the new `pos_products`
  restaurant columns without breaking stores that haven't populated them.
- No new colors/typography/radii introduced outside the `--mise-*` tokens.
- No duplicate status-chip, menu-card, or table-card implementations between the two branches.
- No changes to checkout, discount/manager-approval, or existing catalog/customer/report logic.
- No new DB migrations beyond what a PR explicitly justifies and the Lead approves.
