# Day 5 — Ahmed's Work (Hand-off)

Written by Hamza for Ahmed to execute independently. This replaces `FIVE_DAY_PLAN.md`'s original
Day 5 sketch for you (kitchen + food-cost reports) — it's still in here, plus three items that came
out of the owner's "fill these gaps" review of the whole sprint. Your total load is heavier than
originally planned; that review added real scope, not busywork, and it's split three ways as
evenly as the dependencies allow.

**Git ownership:** you run your own workflow end to end — branch, commit, push, open your own PR.
Nothing here is pre-created for you. Branch name: `feature/ahmed/day5-loyalty-modifiers-reports`
(or split into smaller branches per task if you prefer — your call).

**Sequencing:** none of your four tasks below block each other or Bisma's work. Land them in
whatever order you like; a natural one is tier-config UI (smallest, warms you up) → modifiers
(schema-first, same "land your own migration" pattern every prior day has used) → Kitchen terminal
mode → reports.

---

## 1. Loyalty tier-configuration UI

**The gap:** `loyalty_tiers` can only be read via the API, never created or edited — every store
shows "No tier" until someone inserts a row by hand in the database. You already built the
identical CRUD pattern for `reward_rules` (create/edit/deactivate/reactivate) on the Guests screen
— this is the same shape, one table over.

**What to build:**
- API: `POST /loyalty/tiers`, `PATCH /loyalty/tiers/:id` in `apps/api/src/routes/loyalty.ts`,
  owner/manager-only (`requireStoreManager`), mirroring `reward_rules`' existing create/update
  handlers in the same file almost line for line. Validate `name` (1–40 chars, unique per store —
  `loyalty_tiers` already has that constraint from my Day 4 migration), `min_lifetime_points`
  (non-negative integer), `point_multiplier_bps` (positive integer, no arbitrary cap needed but
  sanity-check it's not absurd, e.g. ≤ 100,000 = 10x).
- Web: a "Tiers" section on the Guests screen next to your existing `RewardRulesSection`
  (`apps/web/src/screens/customers/` or wherever that component lives now) — same list/edit-form
  pattern, same `ManagerApprovalEvidence`-free flow since this is web-only (owner/manager Supabase
  session, no terminal path needed — tier config was never terminal-facing).
- No schema change needed — `loyalty_tiers` already has every column this needs.

**Tests:** a domain/API test for the create/update validation (mirror your existing
`reward-rules`-shaped test), a web test for the tier-form draft parsing (mirror your existing
reward-rule draft test).

**Acceptance:** a manager can create "Gold" at 2,000 lifetime points / 1.5x from the Guests screen,
without touching SQL.

---

## 2. Menu modifiers (real groups) — schema is yours to write, same as your Day 3 `units`/`recipes`

**The gap:** Menu variants/modifiers are a visible placeholder only — no way to sell "Size: Large"
or "Add extra cheese" with a price change. The owner picked the real-modifier-groups option over a
free-text-note-only one: per-product groups (e.g. "Size", required, single-select; "Add-ons",
optional, multi-select), each option carrying its own price delta, shown on the register and the
kitchen ticket.

**Suggested schema** (land it as your own migration, `202609270001_modifiers.sql` or whatever date
you actually run it, same convention every prior migration has used — composite
`unique(store_id, id)` + `foreign key (store_id, x)` tenant-scoping on every table, matching
`docs/ARCHITECTURE.md` §1.4):

```sql
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
  price_delta_cents integer not null default 0,
  active boolean not null default true,
  unique (store_id, id),
  foreign key (store_id, group_id) references public.modifier_groups(store_id, id)
);
create table public.product_modifier_groups (
  store_id uuid not null references public.stores(id),
  product_id uuid not null,
  group_id uuid not null,
  sort_order integer not null default 0,
  primary key (store_id, product_id, group_id),
  foreign key (store_id, product_id) references public.pos_products(store_id, id),
  foreign key (store_id, group_id) references public.modifier_groups(store_id, id)
);
```

You'll also need `unique (store_id, id)` added to `pos_order_items` (it doesn't have one yet — only
a bare `primary key (id)`) before you can FK a per-sale modifier-selection table to it:

```sql
alter table public.pos_order_items add constraint pos_order_items_store_id_id_key unique (store_id, id);
create table public.pos_order_item_modifiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  order_item_id uuid not null,
  snapshot_group_name text not null,
  snapshot_option_name text not null,
  price_delta_cents integer not null,
  foreign key (store_id, order_item_id) references public.pos_order_items(store_id, id)
);
```

**Where this touches checkout (read this before you start):** a modifier's price delta changes a
line's `subtotal_cents`, which flows into everything `packages/domain/src/money.ts` computes (tax,
discount base, service charge base). `orders.ts`'s `validateOperation` re-derives every total from
the line items and rejects any mismatch — so a line item's `snapshot_price_cents` needs to already
be the item's base price plus every selected modifier's delta by the time it reaches
`calculateDiscountedLine`, not something layered on afterward. Talk to me (Hamza) before you touch
`orders.ts`, `checkout.ts`, or `pos-store.ts` directly — reaching into checkout-critical code is
the one thing every prior day has kept as a Lead-reviewed step, same reasoning as why I wired your
Day 3 recipes and Day 4 loyalty into their consumption/checkout hooks myself rather than you doing
it solo. You own the product-editor UI, the register's modifier-picker UI, and the kitchen ticket
display end to end; the actual price-delta wiring into checkout math is a short pairing session,
not a solo change.

**Acceptance:** a "French Toast" product can have a required "Size" group (Regular/Large, Large
+$2.00) and an optional "Add-ons" group (Extra syrup +$0.50, multi-select); the register shows the
picker, the line price reflects the selection, and the kitchen ticket shows which options were
chosen.

---

## 3. Kitchen terminal mode (closes a real gap the "chef" role review found)

**The gap:** while reviewing the new `chef`/`waiter`/`inventory_manager`/`rider` terminal roles
(`packages/domain/src/staff-role.ts`, landed this session), I found that `KitchenScreen.tsx` has no
`terminal` mode at all — it only works from the owner/manager web app
(`requireSupabase`-based). The API is already ready for this
(`terminalKitchenRouter`/`/pos/kitchen/tickets`, `fetchKitchenTickets(storeId, terminal)` already
takes a `terminal` flag in `apps/web/src/lib/kitchen.ts`) — nothing calls it from a terminal
context yet. This means a `chef` role, once created, has nowhere to go on the actual terminal.

**What to build:**
- Add a `terminal` prop to `KitchenScreen.tsx` (`apps/web/src/screens/kitchen/KitchenScreen.tsx`,
  93 lines, small file), branching store-id resolution the same way `RegisterScreen.tsx` already
  does: `terminal ? (await currentAccess())?.cache.device.store_id : ...` instead of
  `requireSupabase()`. Pass `terminal` through to `fetchKitchenTickets`/whatever else it calls.
- Add a `/pos/kitchen` route in `apps/web/src/App.tsx`, wrapped in `CashierTerminalRoute` +
  `CashierPosLayout`, same shape as every other `/pos/*` route.
- Add a "Kitchen" nav item to `CashierPosLayout.tsx`'s `navigation` array
  (`apps/web/src/terminal-auth/CashierPosLayout.tsx`) with `capability: 'kitchen'` — the capability
  matrix and `roleHasCapability` helper already exist and already gate the other nav items the same
  way; you're just adding one more row using the same pattern, not inventing new gating logic.

**Acceptance:** an employee logged in with the `chef` role sees a "Kitchen" tab (and only that tab,
plus Dashboard/Settings) on the terminal nav, and it shows the real KDS board.

---

## 4. Dish profitability, food-cost report, kitchen performance by station

Unchanged from the original `FIVE_DAY_PLAN.md` Day 5 sketch. `packages/domain/src/recipe-cost.ts`
already has the costing math (including this session's new unit-conversion support — a recipe line
in grams now costs correctly against an ingredient stocked in kilograms, so your food-cost report
doesn't need to special-case units at all, just call `costRecipe`/`costSavedRecipe` the same way
the product editor does). `kitchen_tickets`/`kitchen_ticket_items` already have every timestamp a
kitchen-performance-by-station report needs (`fired_at`, status transitions) — this data exists,
it's just never been surfaced in a report per `docs/MODULE_STATUS.md` row L.

Branch/PR: your own workflow, reviewed by Hamza same as every prior day.
