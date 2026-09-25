# Day 4 — Customers, Loyalty & Promotions (Work Division)

Team: **Hamza** (Team Lead + developer), **Ahmed** (developer), **Bisma** (developer). Core
relationship being built: **Customer → Visit → Spend → Loyalty → Reward → Repeat Visit.**

This is a rebalanced version of the Day 4 sketch in `docs/FIVE_DAY_PLAN.md` — that draft gave
Ahmed one task against two or three each for Hamza and Bisma. This version gives each of the
three people **four real features**, split so the load and the learning are actually even, while
keeping the one convention that's proven itself every day so far: whoever's new schema/domain
logic needs to be wired into checkout-critical code (`RegisterScreen.tsx`, `pos-store.ts`,
`orders.ts`) doesn't wire it in themselves — the Lead does, the same way Hamza wired Ahmed's and
Bisma's Day 3 recipe/ingredient work into `kitchen.ts`'s consumption hook.

**Git ownership, read this first:** Hamza's branches are created and implemented by this session
directly. Ahmed and Bisma each run their own git workflow end to end — branch, commit, push, open
their own PR — independently; nothing here is pre-created for them. The workflow section under
each person's task tells them exactly what to run.

**Sequencing:** Hamza's loyalty schema (task 1) must land in `develop` before Ahmed branches —
his domain math and API read `loyalty_tiers`/`loyalty_accounts`. Bisma's promotions schema is
fully independent and can start immediately in parallel. Bisma's fourth task (the loyalty-tier
badge) is the one place her work depends on Ahmed's, so she does it last, once his PR is merged —
same shape as Day 3's Ahmed-before-Bisma dependency.

---

## Hamza — Lead + developer (4 features)

### 1. Loyalty schema + the one real design decision

The design decision: **point redemption and promotions both become a `LineDiscount`** — the
existing per-line discount type in `packages/domain/src/money.ts` (`{kind:'percent',bps}` or
`{kind:'fixed',cents}`), gated by the existing `discountNeedsManagerApproval` check. No parallel
discount mechanism gets invented for loyalty or promotions; both new modules produce a value that
flows through code that already exists and is already tested.

```sql
-- Loyalty tiers, per store (e.g. Bronze/Silver/Gold). Tier membership is computed from
-- lifetime_points (see loyalty_accounts below), a counter that only ever increases — so
-- redeeming points never demotes a customer's tier, matching how real loyalty programs
-- distinguish "spendable balance" from "earning history".
create table public.loyalty_tiers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 40),
  min_lifetime_points integer not null check (min_lifetime_points >= 0),
  -- 10000 = 1x earn rate, 15000 = 1.5x, etc. -- keeps the multiplier an integer, same bps
  -- convention as tax_rate_bps/discount bps elsewhere in this codebase.
  point_multiplier_bps integer not null default 10000 check (point_multiplier_bps between 10000 and 100000),
  unique (store_id, id),
  unique (store_id, name)
);

-- One loyalty account per customer, created lazily (Ahmed's task 4 decides exactly when).
-- points_balance is spendable currency, decremented on redemption; lifetime_points only grows.
create table public.loyalty_accounts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  customer_id uuid not null,
  points_balance integer not null default 0 check (points_balance >= 0),
  lifetime_points integer not null default 0 check (lifetime_points >= 0),
  enrolled_at timestamptz not null default now(),
  unique (store_id, id),
  unique (store_id, customer_id),
  foreign key (store_id, customer_id) references public.pos_customers(store_id, id)
);

-- Append-only ledger of every point change -- same shape and reasoning as Day 3's
-- stock_movements: points_balance is a denormalized column kept in sync in the same
-- transaction as every ledger insert (no trigger), and this table is the audit trail.
create table public.loyalty_point_ledger (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  account_id uuid not null,
  delta integer not null,
  reason text not null check (reason in ('earned', 'redeemed', 'expired', 'adjustment')),
  order_id uuid,
  created_at timestamptz not null default now(),
  foreign key (store_id, account_id) references public.loyalty_accounts(store_id, id),
  foreign key (store_id, order_id) references public.pos_orders(store_id, id)
);
create index loyalty_point_ledger_by_account on public.loyalty_point_ledger(store_id, account_id, created_at);

-- A configurable "spend N points, get $X off" catalog. Ahmed builds the CRUD/UI for this table
-- (his task 3); this migration only creates it so his branch has something to build against.
create table public.reward_rules (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 60),
  points_cost integer not null check (points_cost > 0),
  discount_cents integer not null check (discount_cents > 0),
  active boolean not null default true,
  unique (store_id, id)
);

-- RLS: same member-read pattern as every other restaurant table; writes go through the API only.
alter table public.loyalty_tiers enable row level security;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_point_ledger enable row level security;
alter table public.reward_rules enable row level security;
grant select on public.loyalty_tiers, public.loyalty_accounts, public.loyalty_point_ledger, public.reward_rules to authenticated;
create policy loyalty_tiers_member_read on public.loyalty_tiers for select to authenticated using (public.is_store_member(store_id));
create policy loyalty_accounts_member_read on public.loyalty_accounts for select to authenticated using (public.is_store_member(store_id));
create policy loyalty_point_ledger_member_read on public.loyalty_point_ledger for select to authenticated using (public.is_store_member(store_id));
create policy reward_rules_member_read on public.reward_rules for select to authenticated using (public.is_store_member(store_id));
```

Apply immediately, record in `supabase/migrations/APPLIED.md` the same day, tell Ahmed the moment
it's live (his branch reads `loyalty_tiers`/`loyalty_accounts`).

### 2. Loyalty + Promotions checkout wiring

The integration point both other modules build toward — reaches into both Ahmed's and Bisma's new
work at once, so it stays a Lead task, same reasoning as Day 3's consumption-wiring hook:
- **Award points on order completion**, idempotently, in `orders.ts`'s checkout path — using
  Ahmed's pure `pointsEarned(orderTotalCents, tierMultiplierBps)` domain function (his task 1),
  writing a `loyalty_point_ledger` row (`reason='earned'`, `order_id` set) and bumping both
  `points_balance` and `lifetime_points` in the same transaction, guarded against double-counting
  a retried/duplicate sync the same way Day 3's consumption hook guards against re-serving.
- **Redeem points or apply a promotion at checkout** — both become a `LineDiscount` on a cart
  line in `pos-store.ts`/`RegisterScreen.tsx`, going through the *existing*
  `discountNeedsManagerApproval` gate exactly like a manual cashier discount does today. Loyalty
  redemption converts a `reward_rules` row into `{kind:'fixed',cents:discount_cents}`; a
  promotion converts Bisma's `promotions` row into a `LineDiscount` directly (her schema is
  intentionally shaped to match `LineDiscount`'s own `percent`/`fixed` vocabulary — see her
  task 1).

### 3. Staff role review

Decide whether "waiter" needs to become a real distinct `store_role`/`terminal_employees.role`
value now that loyalty recognition (which employee enrolled/redeemed for a guest) and floor
assignment both reference employees — or whether today's "any active employee can be an assigned
waiter" convention still holds. Land the decision either way: a small migration if a distinct role
is warranted, or a documented "not yet, here's why" in `MODULE_STATUS.md` if not. Small, contained
— this is a decision task, not a big build.

### 4. Review, merge, keep the docs honest

Review Ahmed's and Bisma's PRs against the checklists in their sections below. **Merge order:
Bisma first** (Promotions + Guest CRM has no dependency on Ahmed), **then Ahmed** (his loyalty
module needs to be live before Hamza's own checkout-wiring task 2 can be finished and before
Bisma's task 4, the tier badge, can start). Run the full verification suite from `RULES.md` §6 on
both, not just their own new tests. Update `day4.md`'s checklist and `MODULE_STATUS.md` to the
true end-of-day state, same as every day so far.

### Files Hamza's tasks touch
`supabase/migrations/` (loyalty schema), `apps/api/src/routes/orders.ts`, `apps/web/src/lib/pos-store.ts`,
`apps/web/src/screens/RegisterScreen.tsx`, `packages/domain/src/money.ts` (read-only — reusing
`LineDiscount`, not changing it), `docs/MODULE_STATUS.md`, `docs/day-plans/day4.md`.

---

## Ahmed — Loyalty Module (4 features)

**Your branch (create it yourself), once Hamza confirms the loyalty schema is live:**
```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feature/ahmed/day4-loyalty
git push -u origin feature/ahmed/day4-loyalty
```
Commit in small working steps, push regularly. Open a PR targeting `develop` (never `main`).
**You do not merge your own PR** — Hamza reviews and merges it.

### 1. Loyalty domain math (`packages/domain/src/loyalty.ts`)
Pure functions, no I/O — mirrors `recipe-cost.ts`'s pattern from Day 3 exactly:
- `pointsEarned(orderTotalCents: number, tierMultiplierBps: number): number` — e.g. 1 point per
  $1 spent, scaled by the customer's tier multiplier. Round consistently (pick one direction and
  document it, the way `recipe-cost.ts` documents rounding once on the exact total).
- `tierForLifetimePoints(lifetimePoints: number, tiers: readonly {minLifetimePoints: number}[]): tier` —
  which configured tier a customer's lifetime points currently qualify for.
- `redemptionValue(pointsCost: number, discountCents: number, accountBalance: number): {kind:'fixed', cents: number} | null` —
  null when the account can't afford the reward; this is what Hamza's checkout-wiring task calls.

### 2. Loyalty API (`apps/api/src/routes/loyalty.ts`)
- `GET /loyalty/accounts/:customerId` — balance, lifetime points, current tier (creates the
  account lazily on first read if your task 4 below decides that's the enrollment moment).
- `GET /loyalty/accounts/:customerId/ledger` — paginated point history, same cursor pattern as
  `inventory.ts`'s `listMovements`.
- `GET /loyalty/tiers` and `GET /loyalty/reward-rules` — read endpoints for the register/guest
  picker to show what's available.

### 3. Reward rules / rewards catalog
CRUD (create/update/deactivate) for `reward_rules` at `/loyalty/reward-rules`, plus a small
management section (owner/manager only, same auth pattern as `requireStoreManager` elsewhere) —
doesn't need its own full screen; a section within an existing settings/loyalty area is enough.

### 4. Loyalty account enrollment + balance display
Decide and document: does every customer get a loyalty account automatically on first purchase,
or only on explicit opt-in from `CustomerScreen.tsx`? Either is defensible — pick one, write the
reasoning in your PR description the way Day 3's PRs documented judgment calls (e.g. the 3-day
expiry-warning window). Then surface the account's points balance and tier in
`CustomerScreen.tsx` and the register's guest picker, so a cashier can see it before checkout.

### Files you may touch
`packages/domain/src/loyalty.ts` (new), `apps/api/src/routes/loyalty.ts` (new),
`apps/web/src/screens/CustomerScreen.tsx`, a new small component for the guest-picker balance
display, your migration file (if a follow-up column is genuinely needed beyond Hamza's schema —
check with Hamza first rather than assuming).

### Do not touch
`apps/web/src/screens/RegisterScreen.tsx`, `apps/web/src/lib/pos-store.ts`,
`apps/api/src/routes/orders.ts` (Hamza's checkout-wiring task lands here),
`apps/web/src/screens/menu/`, `apps/api/src/routes/catalog.ts`, `apps/api/src/routes/kitchen.ts`,
`apps/api/src/routes/floor.ts`, `apps/web/src/screens/floor/`, `apps/api/src/routes/inventory.ts` —
none of these are yours today.

### Before opening your PR
Run the full check from `RULES.md` §6. Add tests for the domain math (pure functions, easiest to
get right and cheapest to verify) and at least one API test per new endpoint.

### Definition of done
A customer has a loyalty account with a real balance and tier; reward rules can be configured;
the balance is visible before checkout. Points aren't earned or redeemed yet — that's Hamza's
checkout-wiring task, which depends on this module existing first.

---

## Bisma — Promotions + Guest CRM (4 features)

**Your branch (create it yourself):**
```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feature/bisma/day4-promotions-crm
git push -u origin feature/bisma/day4-promotions-crm
```
Same rules as Ahmed's: small commits, push regularly, PR to `develop`, Hamza merges it.

### 1. Promotions schema + CRUD screen

```sql
-- discount_kind/discount_value deliberately mirror LineDiscount's own {percent,bps}|{fixed,cents}
-- shape (packages/domain/src/money.ts) -- so turning an active promotion into a LineDiscount at
-- checkout (Hamza's task 2) is a direct mapping, not a translation layer.
create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id),
  name text not null check (length(trim(name)) between 1 and 60),
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_value integer not null check (discount_value > 0), -- bps if percent, cents if fixed
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  unique (store_id, id)
);
alter table public.promotions enable row level security;
grant select on public.promotions to authenticated;
create policy promotions_member_read on public.promotions for select to authenticated using (public.is_store_member(store_id));
```
Apply, then immediately add the `APPLIED.md` row (SHA-256 + the object that confirms it applied).
Name the file with the next unused sequence number — check `supabase/migrations/` yourself.

Build the CRUD screen (create/edit/deactivate a promotion, with `starts_at`/`ends_at` and an
active toggle) the way `screens/floor/`'s "Edit floor" pattern works — a clear owner/manager-only
management view, distinct from the existing per-line cashier discount in the register (this is a
campaign someone configures ahead of time, not something a cashier types in at checkout).

### 2. Promotion eligibility + discount-calculation domain logic (`packages/domain/src/promotions.ts`)
Pure functions Hamza's checkout-wiring task calls into — you don't touch checkout code yourself,
same pattern as Ahmed's `recipe-cost.ts` being consumed by Hamza's Day 3 `kitchen.ts` wiring:
- `activePromotions(promotions: readonly Promotion[], now: Date): Promotion[]` — filters to
  currently-active, within-window, non-deactivated promotions.
- `promotionToLineDiscount(promotion: Promotion): LineDiscount` — the direct mapping mentioned
  above.

### 3. Guest CRM profile
In `CustomerScreen.tsx`: visit history and lifetime spend, aggregated from the existing
`pos_orders` table filtered by `customer_id` — **don't add a duplicate running-total column**,
compute it from orders the same way `loadDailySummary` computes report totals from source data
rather than a cached counter. Show recent visits (date, total) and a lifetime-spend figure on the
customer's profile.

### 4. Loyalty-tier badge on the guest picker (do this last, after Ahmed's PR is merged)
Once a known guest with a loyalty account/tier is attached (register's guest picker or
`TableCard`), show a small tier badge — reuse the existing six-tone status system
(`docs/DESIGN_SYSTEM.md`), don't invent a new color. This is the one place your work depends on
Ahmed's `loyalty_tiers`/`loyalty_accounts` data, so sequence it after his PR lands, same as your
Day 3 `ingredients` migration waited on his `units`/`recipes`.

### Files you may touch
`apps/web/src/screens/CustomerScreen.tsx`, a new promotions management screen under
`apps/web/src/screens/`, `apps/api/src/routes/customers.ts` (or a new `promotions.ts` route file —
your call), `packages/domain/src/promotions.ts` (new), a small addition to the register's guest
picker component for the tier badge (task 4 only), your migration file.

### Do not touch
`apps/web/src/screens/RegisterScreen.tsx`, `apps/web/src/lib/pos-store.ts`,
`apps/api/src/routes/orders.ts` (Hamza's checkout-wiring task lands here),
`apps/web/src/screens/menu/`, `apps/api/src/routes/catalog.ts`, `apps/api/src/routes/kitchen.ts`,
`apps/api/src/routes/floor.ts`, `apps/web/src/screens/floor/`, `apps/api/src/routes/inventory.ts`,
`apps/api/src/routes/loyalty.ts`, `packages/domain/src/loyalty.ts` — none of these are yours today.

### Before opening your PR
Run the full check from `RULES.md` §6. Add a test for the promotion-window/active-filtering logic
and at least one test for the guest lifetime-spend aggregation.

### Definition of done
A promotion can be created and is active within its window; a guest's profile shows real visit
history and lifetime spend; a guest with a loyalty tier shows a badge wherever they're attached.
Promotions aren't applied at checkout yet — that's Hamza's checkout-wiring task.

---

## Day 4 completion checklist (nothing missed)

**Hamza:**
- [x] Loyalty schema (`loyalty_tiers`, `loyalty_accounts`, `loyalty_point_ledger`,
      `reward_rules`) — applied, recorded in `APPLIED.md`, 4 schema-integrity tests passing.
      Pushed on `feature/hamza/day4-loyalty-foundation`, merged.
- [x] Loyalty + Promotions checkout wiring — **done.**
      - **Award**: `orders.ts`'s `push()` now looks up the guest's `loyalty_accounts` row (if
        any — opt-in, per Ahmed's decision) inside the same transaction as the order/items/
        payment insert, computes the tier from lifetime points *before* this order (Ahmed's
        `tierForLifetimePoints`, base 1x when no tier qualifies), awards points via
        `pointsEarned(totalCents, tierMultiplierBps)`, and writes a `loyalty_point_ledger` row —
        idempotent for free, since a retried/replayed `operation_id` already short-circuits
        before this code runs (same `pos_operation_ledger` replay guard the rest of `push()`
        relies on).
      - **Redeem**: a cashier can now pick "Reward" or "Promo" in a cart line's existing discount
        popover (`RestaurantOrderItem.tsx`) — a reward converts via `redemptionValue()`, a
        promotion via `promotionToLineDiscount()`, both producing an ordinary `LineDiscount` that
        goes through the exact same `discountNeedsManagerApproval` gate as a manual discount. The
        cart (`pos-store.ts`) tracks *which* reward/promotion produced a line's discount
        (`CartItem.discountSource`) so the UI can label it honestly and so `checkout.ts` can tell
        the server which `reward_rule_id` to deduct points for. The deduction itself is clamped
        to whatever balance is actually available and never blocks the sale — the same "don't
        reverse a completed, paid sale over a stale local number" reasoning this file already
        uses for oversold stock, now applied to a stale points balance on a device that queued
        the sale while offline.
      - **Gap found and fixed along the way**: Bisma's `/promotions` management endpoints are
        `requireStoreManager`-gated by design (a Supabase session only), which meant a cashier
        terminal had no way to even *read* which promotions are active to apply one. Added a new
        `GET /pos/promotions` (read-only, active-and-in-window only) so terminal checkout can use
        promotions too, not just the web register.
      - **Also found and fixed**: `packages/domain/src/promotions.ts` imported `money.ts` with a
        `.ts`-suffixed specifier, which works for this package's own test runner and for
        apps/web's bundler but is a hard `tsc` error (`TS5097`) under apps/api's NodeNext
        resolution — invisible until this task became the first thing in apps/api to actually
        import that file. Fixed the same way `money.ts`'s own `formatCostPerUnit` already had to
        (see its comment): inline the couple of lines needed (`boundedInteger`/`MAX_CENTS`)
        instead of importing them as values, keep the type-only import (erased before any runtime
        resolution happens either way).
      - New test coverage: `apps/api/test/orders-loyalty.test.ts` (9 subtests, real HTTP against
        PGlite) — no-account guest earns nothing, base-rate earning, tier-multiplier earning,
        redeem-and-earn-on-the-discounted-total in one order, clamped redemption on a
        too-low balance, idempotent retry, redemption-without-a-customer rejected, and the new
        `/pos/promotions` endpoint's active/in-window filter and store isolation.
- [x] Staff role review — **decision: no distinct "waiter" role this sprint.** Reasoning recorded
      in `MODULE_STATUS.md`'s Staff row — "waiter" was never a login/permission role to begin
      with, and Day 4's loyalty feature doesn't create a real need for one either.
- [x] Review and merge Bisma's PR, then Ahmed's PR — merged in the reverse order (Ahmed's #16
      first, then Bisma's #18) after checking both were fully independent except for the tier
      badge, which needed hand-resolving either way; net result is the same either order. Both
      required resolving a real merge conflict in `CustomerScreen.tsx` (both touched the guest
      row) plus, for Bisma's PR, `apps/api/src/app.ts` and `apps/web/src/components/icons.ts`.
      Bisma's own temporary tier-badge lookup (a documented placeholder pending Ahmed's PR) was
      replaced with Ahmed's canonical `LoyaltyBalance`/`LoyaltyTierBadge` during conflict
      resolution, so there's now exactly one loyalty-badge implementation, not two. Full
      `RULES.md` §6 suite re-run on both merges: domain 48/48, api build/test/integration/orders
      all passing (one confirmed pre-existing CI port-reuse flake, documented in Bisma's own PR,
      reproduced and cleared on re-run — not a regression), web 39/39, tsc/build clean.
- [x] `day4.md` and `MODULE_STATUS.md` updated to true end-of-day state.

**Ahmed:**
- [x] Loyalty domain math (`packages/domain/src/loyalty.ts`) with tests (9 domain tests).
- [x] Loyalty API (`/loyalty/accounts/:customerId`, ledger, tiers, reward-rules reads) — also
      mounted under `/pos/loyalty` for terminals.
- [x] Reward rules CRUD — management section on the web Guests screen.
- [x] Enrollment decision documented (explicit opt-in, not automatic-on-first-purchase); balance/
      tier visible in `CustomerScreen.tsx` and the register's guest picker via `<LoyaltyBalance>`.

**Bisma:**
- [x] Promotions schema + CRUD screen, applied and recorded in `APPLIED.md`.
- [x] Promotion eligibility/discount-calculation domain logic with tests (8 domain tests).
- [x] Guest CRM profile (visit history + lifetime spend, aggregated not duplicated).
- [x] Loyalty-tier badge on the guest picker — now rendered via Ahmed's `<LoyaltyBalance>`
      (superseding the temporary direct-Supabase lookup her PR shipped with, per the plan's own
      note that it "may need rework once his PR lands").

**Documentation:**
- [x] `docs/MODULE_STATUS.md` given a final pass now that all three PRs and the checkout-wiring
      task have landed.

**Day 4 is now fully complete.** Every task in this plan — Hamza's, Ahmed's and Bisma's — is done,
tested and on `develop`. Known, deliberately-scoped-out-of-Day-4 follow-ups for later: nobody can
configure a loyalty tier yet (read-only API, no create/update UI); a redeemed-but-insufficient
balance is clamped rather than blocked (see Hamza's checkout-wiring note above).

**Post-Day-4 fix (found via manual testing):** the reward/promotion discounts this task wired up
surfaced a real bug in the pre-existing cashier-discretion cap. `checkout.ts`'s
`completeLocalSale` was unconditionally requiring `ManagerApprovalEvidence` for any discount over
20% of a line's subtotal, but the only UI that can ever supply that evidence
(`ManagerApprovalModal`) is shown exclusively on the terminal path (`RegisterScreen.tsx` gates it
on `terminal`, same as its own `needsApproval`/`approvalValid`). On the web register there is no
such modal to summon — every Supabase session that reaches it already belongs to an owner or
manager, since cashiers only ever authenticate via PIN/terminal session — so any web user,
including the owner, hit "A discount needs manager approval before this sale can complete" with no
way to ever clear it once a reward or promotion discount exceeded 20%. Fixed by adding a `terminal`
parameter to `completeLocalSale` (threaded through from `PaymentScreen.tsx`'s existing `terminal`
prop) and gating the approval requirement on it, so the 20% independent-authority cap now applies
only where a manager PIN can actually raise it — the cashier terminal. Verified via `tsc -b`,
`vite build`, and the full `apps/web` test suite (40/40 passing, including an updated test for the
terminal-gated cap and a new test confirming the web register no longer blocks large discounts).
