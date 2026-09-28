# Module Status

> **Current baseline: `develop`, 2026-09-28.** Days 1-5 are closed. Ahmed's four Day 5
> deliverables and Bisma's three Day 5 deliverables are present on `develop`. Hamza's final
> integration, security, performance, design-consistency, migration-ledger, and documentation
> pass is complete on local `develop` and recorded below.

This is the living source of truth required by `RULES.md`. It separates implemented behavior
from explicitly deferred product work; a partial module is operational, but still has named
future capabilities below. The detailed remaining-work ownership is in
`docs/day-plans/remaining-work-2026-09-28.md`.

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
| **A. POS / Register** | 🟡 | Dine-in/takeaway/delivery, cart and notes, guest requirement, inventory warning, discounts, rewards, promotions, service charge, manager approval, modifiers, offline checkout, receipts, refund flow, equal-split calculator, **open checks: durable versioned create/hold/resume/edit/void, cross-device server-backed receipt detail (`feat/open-checks`, Ahmad)** | True multiple-payment/itemized/per-seat split settlement (A2); an open check's own create/edit/void/close calls are online-only by design (see `apps/web/src/lib/open-checks.ts`), not queued through the offline outbox like a completed sale |
| **B. Front of House / Tables** | 🟡 | Areas/tables CRUD in an Ember dialog, Seat/Add order/Bill/Settle/Clean, Transfer/Merge, waiter terminal mode, atomic status transitions, **a table's open check shows a real live running total on the Floor screen, not just its last completed order (`feat/open-checks`, Ahmad)** | Reservations and waitlist |
| **C. Menu** | 🟡 | Product/category CRUD, availability, kitchen routing, recipe builder, unit conversion, food cost, ingredient creation dialog, modifier group/option CRUD and checkout/KDS/receipt snapshots | Sellable bundles/combos; a dedicated variant matrix beyond modifier-based sizes |
| **D. Kitchen / KDS** | 🟡 | Order-derived tickets, station grouping, preparing/ready/served lifecycle, Chef terminal mode, modifiers, recipe consumption, table synchronization, performance reporting | Delay/SLA alerts; course-based firing; ticket history view. Standalone ticket creation remains intentionally excluded |
| **E. Recipes** | ✅ | Recipe CRUD, yields, units, conversion-aware costing, searchable ingredient selector, inline ingredient creation | No committed gap |
| **F. Restaurant Inventory** | ✅ | Ingredient/batch CRUD, receipt/wastage/adjustment/consumption ledger, expiry and low/out-of-stock states, terminal manager approval, edit/deactivate/reactivate, tenant-composite attribution | No committed gap; purchasing is tracked separately in Module G |
| **G. Purchasing & Vendors** | 🔴 | — | Vendor directory, purchase orders, goods receiving, invoice/reference workflow and ingredient-cost reconciliation |
| **H. Customers / CRM** | 🟡 | Guest CRUD/search/profile, visit and lifetime-spend aggregation, loyalty enrollment/balance/tier | Favorites and preference history |
| **I. Loyalty** | ✅ | Account enrollment, tiers CRUD, reward rules, earning/redemption, immutable ledger, terminal and web paths | No committed gap |
| **J. Promotions** | ✅ | Manager CRUD, scheduling/activation, terminal availability and line-discount application | Product decision for stacking priority; current last-applied discount wins and remains data-safe |
| **K. Staff** | 🟡 | Owner/manager web access; Cashier/Manager/Waiter/Chef/Inventory Manager/Rider terminal roles; capability navigation; employees; clock-in/out and hours report | Tips; breaks/payroll export; Rider delivery capability and delivery-tracking screen |
| **L. Reports** | ✅ | Sales, orders, refunds, customer/loyalty, inventory/wastage/expiry, hours, food cost/dish profitability, kitchen performance, dashboard floor/kitchen pulse | No committed report gap; new modules must add their own reporting slices |
| **M. Restaurant Intelligence** | 🔴 | — | Forecasting, anomaly detection, demand planning and recommendation surfaces; start only after sufficient production data exists |

Current count: **5 complete modules, 6 operational/partial modules, 2 deliberately deferred
modules**. The five-day scope is complete; the partial/missing items above are the next product
backlog, not hidden Day 5 failures.

## Cross-cutting foundation

| Area | Status | Current truth |
|---|---|---|
| Authentication | ✅ | Supabase owner/manager auth plus offline-capable PIN terminal auth; intentionally separate |
| Tenant isolation / RLS | ✅ | Every public store-scoped table has RLS; Day 5 live verification passes; inventory terminal attribution is composite-scoped |
| Offline and synchronization | ✅ | Dexie outbox, idempotent operation ledger, dependency ordering, reconnect sync and clear pending/blocked/rejected states |
| Ember design system | ✅ | Shared graphite/ivory/orange/amber/blue tokens, Inter + operational mono data, compact cards/tables/forms/dialogs, accessible focus and responsive states |
| Performance | ✅ | Route screens are lazy loaded; React, Supabase, offline and icon vendors are stable chunks; no chunk exceeds Vite's 500 kB threshold |
| CI | ✅ | Builds and automated tests run on PR/push workflows |
| Testing | 🟡 | Strong domain/API/web coverage plus the Day 5 cross-module lifecycle test; browser fixtures exist, but full browser E2E is not yet a required CI gate |
| Migration ledger | ✅ | Modifier and inventory closeout migrations are applied, checksummed and recorded; `verify-day5-closeout.mjs` is the repeatable live audit |

## What remains

The next work is intentionally prioritized rather than treated as one unsafe mega-change:

1. **Operational depth:** reservations/waitlist, combos, kitchen SLA and course firing, favorites,
   discount-stacking policy. (Open checks/hold-resume shipped -- see Module A/B above and
   `docs/day-plans/day6-ahmad-open-checks.md`.)
2. **Commercial depth:** true split tender, tips, delivery/rider workflow, purchasing/vendors.
3. **Scale hardening:** make browser E2E a CI gate, then add performance budgets and monitoring.
4. **Data-dependent future:** Restaurant Intelligence only after real operational history exists.
