# Module Status

> **Current baseline: `develop`, 2026-09-29.** Days 1-5 are closed. Ahmed's four Day 5
> deliverables and Bisma's three Day 5 deliverables are present on `develop`. Since the
> 2026-09-28 baseline, five more PRs merged same-day (reservations/waitlist, staff timekeeping,
> customer-profile tools, purchasing/vendors, delivery/rider — `docs/day-plans/
> final-application-work-split.md`'s B1-B5). **A same-day regression pass (2026-09-29) found and
> fixed one real, build-breaking defect from that merge batch**: `apps/web/src/App.tsx` ended up
> with two duplicate `function App()` declarations (the delivery and purchasing PRs each added
> their own full copy instead of extending the existing one) — `tsc -b` correctly refused to
> build, but nobody had run the *combined* build since both PRs landed, since each was only
> verified in isolation against its own base commit. Fixed by merging both PRs' routes into one
> function. The other four merged PRs were individually audited (composite-FK tenant isolation,
> transactional idempotency, real vs. happy-path tests) and found solid, with one cosmetic bug
> fixed (a break-start race returned checkout's error copy instead of its own — see row K).

This is the living source of truth required by `RULES.md`. It separates implemented behavior
from explicitly deferred product work; a partial module is operational, but still has named
future capabilities below. The detailed remaining-work ownership is in
`docs/day-plans/final-application-work-split.md`.

Status legend: ✅ complete for the agreed scope · 🟡 operational with explicit backlog ·
🔴 not started/deferred · ⚠️ release/process attention

## Five-day delivery closeout

| Owner | Status | Delivered |
|---|---|---|
| Ahmed | ✅ 4/4 | Loyalty-tier CRUD, real modifier groups and immutable sale snapshots, Kitchen terminal mode, Food Cost and Kitchen Performance reports |
| Bisma | ✅ 3/3 | Floor terminal mode, owner/customer/inventory reporting, hours-worked reporting and dashboard operational detail |
| Hamza | ✅ 6/6 | Cross-module lifecycle acceptance, RLS/tenant review, performance pass, Ember consistency pass, final status documentation, branch review/integration |

Hamza closeout evidence:

- `apps/api/test/day5-e2e.test.ts` proves one dine-in transaction reaches the kitchen, recipe
  consumption, stock ledger, table lifecycle, loyalty, and all affected report surfaces.
- `apps/api/scripts/verify-day5-closeout.mjs` confirms the live modifier schema/RLS/policies,
  all four tenant-composite inventory attribution foreign keys, and RLS on every public table
  carrying `store_id`.
- `202609280001_inventory_terminal_tenant_fks.sql` fixes the final known bare employee/manager
  references; it is applied to the configured database and recorded in `APPLIED.md`.
- Route-level lazy loading plus stable vendor chunks reduced the configured-browser build's
  976.63 kB main bundle to 108.86 kB; its largest chunk is 469.87 kB and Vite no longer warns.
- The Ember artifact under `docs/ember-artifact/` remains unchanged. Shared tokens, compact
  layouts, dialogs/drawers, states, and operational typography remain the application standard.

## Product modules

| Module | Status | Done now | Explicitly left |
|---|---|---|---|
| **A. POS / Register** | 🟡 | Dine-in/takeaway/delivery, cart and notes, guest requirement, inventory warning, discounts, rewards, promotions, service charge, manager approval, modifiers, offline checkout, receipts, refund flow, equal-split calculator. **Discount-stacking is a decided policy, not an open gap**: a line carries exactly one discount source (manual/reward/promotion), whichever was applied last — documented as a permanent invariant next to `LineDiscount` in `packages/domain/src/money.ts`, confirmed by audit to already hold structurally (every write site replaces the field, none accumulate) | Hold/resume; true multiple-payment/itemized/per-seat split settlement; tips |
| **B. Front of House / Tables** | 🟡 | Areas/tables CRUD in an Ember dialog, Seat/Add order/Bill/Settle/Clean, Transfer/Merge, waiter terminal mode, atomic status transitions, reservation/waitlist drawer with conflict warnings and seat-once table assignment. Audited 2026-09-29: `seat()` correctly reuses the shared atomic `applyTableStatusTransition` inside a transaction with a row lock and replays idempotently on a duplicate `operation_id` — sound by code inspection, but `reservations.test.ts` doesn't yet exercise that HTTP path's idempotency/cross-store rejection directly (only 2 tests, neither hits `seat()` over HTTP) | True running/open table tabs rather than last-completed-order context; a dedicated `seat()` idempotency/tenant-isolation test |
| **C. Menu** | 🟡 | Product/category CRUD, availability, kitchen routing, recipe builder, unit conversion, food cost, ingredient creation dialog, modifier group/option CRUD and checkout/KDS/receipt snapshots | Sellable bundles/combos; a dedicated variant matrix beyond modifier-based sizes |
| **D. Kitchen / KDS** | 🟡 | Order-derived tickets, station grouping, preparing/ready/served lifecycle, Chef terminal mode, modifiers, recipe consumption, table synchronization, performance reporting | Delay/SLA alerts; course-based firing; ticket history view. Standalone ticket creation remains intentionally excluded |
| **E. Recipes** | ✅ | Recipe CRUD, yields, units, conversion-aware costing, searchable ingredient selector, inline ingredient creation | No committed gap |
| **F. Restaurant Inventory** | ✅ | Ingredient/batch CRUD, receipt/wastage/adjustment/consumption ledger, expiry and low/out-of-stock states, terminal manager approval, edit/deactivate/reactivate, tenant-composite attribution | No committed gap; purchasing is tracked separately in Module G |
| **G. Purchasing & Vendors** | 🟡 | Vendor CRUD (contacts/terms/active state), purchase orders (draft/sent/partially-received/received/cancelled), ingredient line items with integer-cent costs, partial/complete receiving into the existing batch/stock-movement ledger with real insert-level idempotency (`on conflict (store_id, operation_id) do nothing`, row-locked), invoice/reference capture, cost-variance history, vendor/spend/variance report slices. Audited 2026-09-29: composite-FK tenant isolation and RLS correct on all 6 new tables, cancel never reverses already-received stock, real tests cover the idempotency/tenant claims (not just happy-path CRUD) | Full UX/completeness pass not yet done — the audit covered correctness/security/idempotency, not every screen state |
| **H. Customers / CRM** | ✅ | Guest CRUD/search/profile, visit and lifetime-spend aggregation, loyalty enrollment/balance/tier, guest edit, safe deactivate/reactivate, manager-controlled merge (row-locked, ledger-based loyalty transfer, idempotent retry, never silently merges by phone, audit-immutable), favorites and structured/free-text preferences with author attribution, compact summary in the register guest picker | No committed gap |
| **I. Loyalty** | ✅ | Account enrollment, tiers CRUD, reward rules, earning/redemption, immutable ledger, terminal and web paths | No committed gap |
| **J. Promotions** | ✅ | Manager CRUD, scheduling/activation, terminal availability and line-discount application | Product decision for stacking priority; current last-applied discount wins and remains data-safe |
| **K. Staff** | 🟡 | Owner/manager web access; Cashier/Manager/Waiter/Chef/Inventory Manager/Rider terminal roles; capability navigation; employees; clock-in/out and hours report; paid/unpaid breaks (DB-enforced no-overlap via a partial unique index plus a `before insert` trigger, immutable manager corrections) and payroll-ready CSV export; Rider terminal route and dispatch/delivery workspace (state-machine-enforced transitions, rider-scoped authorization — a `cc793ee` fixup closed a real gap where any capability-superset role, not just `rider`, could pass the terminal gate). Fixed 2026-09-29: a break-start race returning checkout's `receipt_number_conflict` copy instead of `break_already_open` — the pre-check was select-then-insert and couldn't catch a concurrent second request; the insert's own unique-violation now maps to the right error, regression test added (`apps/api/test/timekeeping-breaks.test.ts`, two genuinely concurrent requests) | Tips (blocked on split-settlement/A2 landing first) |
| **L. Reports** | ✅ | Sales, orders, refunds, customer/loyalty, inventory/wastage/expiry, hours, food cost/dish profitability, kitchen performance, dashboard floor/kitchen pulse | No committed report gap; new modules must add their own reporting slices |
| **M. Restaurant Intelligence** | 🔴 | — | Forecasting, anomaly detection, demand planning and recommendation surfaces; start only after sufficient production data exists |

Current count: **6 complete modules, 6 operational/partial modules, 1 deliberately deferred
module**. The five-day scope is complete; the partial/missing items above are the next product
backlog, not hidden failures. Purchasing & Vendors moved from 🔴 to 🟡 and Customers/CRM moved
from 🟡 to ✅ this same day (2026-09-29), alongside Staff picking up breaks/payroll and the Rider
workspace — see the header note above for what was independently audited/fixed before trusting
these.

## Cross-cutting foundation

| Area | Status | Current truth |
|---|---|---|
| Authentication | ✅ | Supabase owner/manager auth plus offline-capable PIN terminal auth; intentionally separate |
| Tenant isolation / RLS | ✅ | Every public store-scoped table has RLS; Day 5 live verification passes; inventory terminal attribution is composite-scoped |
| Offline and synchronization | ✅ | Dexie outbox, idempotent operation ledger, dependency ordering, reconnect sync and clear pending/blocked/rejected states |
| Ember design system | ✅ | `docs/DESIGN_SYSTEM.md` is the binding reference (this row is a pointer, not a duplicate spec — it previously drifted out of sync with the real tokens and named the wrong palette/font, now corrected): deep warm-linen canvas, near-black warm ink, a deep oxblood-rust accent, Fraunces (headings/numerals) over Archivo (UI text) over IBM Plex Mono (money/quantities), compact cards/tables/forms/dialogs, accessible focus and responsive states |
| Performance | ✅ | Route screens are lazy loaded; React, Supabase, offline and icon vendors are stable chunks; no chunk exceeds Vite's 500 kB threshold |
| CI | ✅ | Builds and automated tests run on PR/push workflows |
| Testing | 🟡 | Strong domain/API/web coverage plus the Day 5 cross-module lifecycle test; browser fixtures exist, but full browser E2E is not yet a required CI gate |
| Migration ledger | ✅ | Modifier and inventory closeout migrations are applied, checksummed and recorded; `verify-day5-closeout.mjs` is the repeatable live audit |

## What remains

The next work is intentionally prioritized rather than treated as one unsafe mega-change.
Reservations/waitlist, favorites, discount-stacking, delivery/rider, and purchasing/vendors moved
out of this list on 2026-09-29 (now rows B/H/G/K above) — they are not multi-day features that got
half-shipped; each was independently audited for tenant isolation, transactional idempotency, and
real test coverage before being trusted here.

1. **Operational depth:** open checks/hold-resume, sellable combos/variants, kitchen SLA
   classification and course firing, ticket history/pagination.
2. **Commercial depth:** true multi-payment/split-tender/itemized-per-seat settlement, tips
   (blocks Staff's tip reporting).
3. **Scale hardening:** make browser E2E a CI gate, then add performance budgets and monitoring.
4. **Data-dependent future:** Restaurant Intelligence only after real operational history exists.

A same-day (not multi-day) slice of item 1 — Kitchen SLA classification only (calm/warning/late
per ticket, station due/late summary, boundary-time tests) — is scoped as a genuinely completable
one-day unit in `docs/day-plans/final-application-work-split.md`'s tomorrow-executable assignment;
the rest of item 1 and all of item 2 are correctly multi-day and not attempted in one sitting.
