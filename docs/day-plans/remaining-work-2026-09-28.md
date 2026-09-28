# Remaining Application Work — Three-Person Split

Date: **2026-09-28**
Baseline: five-day scope complete on `develop`; this plan owns only the explicit backlog in
`docs/MODULE_STATUS.md`.

The backlog is larger than one safe development day. Today's target is the first shippable slice
for each developer; later slices are already assigned so nothing becomes ownerless. Every branch
must preserve the Ember system, tenant-scoped database pattern, existing APIs, and offline order
invariants.

## Shared workflow

1. Branch from freshly pulled `develop`; do not branch from another person's feature branch.
2. One migration sequence owner at a time. Add the checksum and live verification to
   `supabase/migrations/APPLIED.md` in the same delivery.
3. Keep payment/order/kitchen transitions server-authoritative and idempotent.
4. Add automated tests for every state transition and cross-store rejection.
5. Run API build/tests, web build/tests, and the affected browser fixture before PR.
6. Update `MODULE_STATUS.md` with actual results, not intended results.

## Ahmed — Menu, Kitchen, and Intelligence

Branch: `feature/ahmed/operations-depth`

### Today

1. **Kitchen SLA indicators:** derive elapsed time from `fired_at` and product prep target; add
   calm/warning/late Ember badges, station summary counts, and tests for boundary timing.
2. **Ticket history:** add a manager-only completed/cancelled history filter using existing ticket
   data; do not introduce standalone ticket creation.
3. **Combo design and schema proposal:** document bundle pricing, component stock behavior and
   kitchen routing before writing the migration.

### Next slices

- Course-based firing with explicit appetizer/main/dessert transitions.
- Sellable combos/bundles after Hamza approves checkout and stock semantics.
- Restaurant Intelligence data contracts only after sufficient production history exists; no
  decorative forecasting with fake data.

### Acceptance

A late ticket is obvious without opening it, station counts are accurate, history never appears
on the active board, and existing prepare/ready/serve behavior is unchanged.

## Bisma — Front of House, CRM, and Purchasing

Branch: `feature/bisma/guest-operations`

### Today

1. **Customer favorites/preferences:** store-scoped schema/API/UI with create/remove controls on
   the guest profile and a compact read-only summary in the register picker.
2. **Reservations + waitlist foundation:** schema, tenant-safe API, and a clean Floor-side drawer
   for create/edit/cancel/seat. Seating must reuse the existing atomic table transition.
3. **Purchasing discovery:** map vendor, purchase-order, receiving and batch-cost fields onto the
   existing ingredient/batch model; produce the migration/API contract before implementation.

### Next slices

- Wait-time estimates and reservation conflict handling.
- Vendor directory, purchase orders, goods receiving and invoice/reference reconciliation.
- Open-table display after Hamza's running-check foundation lands.

### Acceptance

Favorites never leak across stores; a reservation can become a seated table exactly once; no
reservation action bypasses current Floor status rules.

## Hamza — Transaction Core, Payments, Staff, and Integration

Branch: `feature/hamza/transaction-depth`

### Today

1. **Running/open-check architecture and hold/resume:** define the durable server model, offline
   ownership and idempotent resume rules, then implement the smallest complete hold/resume flow.
2. **Discount stacking policy:** choose and enforce one documented rule for manual discounts,
   promotions and rewards; validate it on both client and server and retain manager approval.
3. **Integration ownership:** review Ahmed/Bisma migrations and checkout/floor touchpoints, run the
   Day 5 lifecycle test after every merge, and keep `MODULE_STATUS.md` current.

### Next slices

- True multi-tender/itemized/per-seat split payments, including refund allocation.
- Tips and tip reporting without floating-point money.
- Rider capability plus delivery assignment/status tracking.
- Browser E2E as a required CI gate and explicit bundle/performance budgets.

### Acceptance

A held order survives reload and terminal reconnection without duplication; resuming it cannot
create two paid orders; discount combinations are deterministic and server-validated; existing
offline checkout remains green.

## Dependency order

1. Hamza's running-check model precedes Bisma's live open-table presentation.
2. Ahmed's combo proposal precedes any checkout or inventory implementation.
3. Bisma's reservation seating reuses Floor transitions and can proceed independently.
4. Purchasing can proceed after its contract review; it must post into existing ingredient
   batches/stock movements rather than creating a second inventory ledger.
5. True split payment remains isolated until its payment/refund migration and replay semantics
   are approved.

## End-of-day merge order

1. Bisma's CRM/reservation work if it does not depend on the running-check layer.
2. Ahmed's Kitchen work.
3. Hamza's transaction-core work last, followed by the full lifecycle and browser regression
   checks and a final `MODULE_STATUS.md` update.
