# Dineflow Final Application Work Plan — 40 / 40 / 20 Split

Date: **2026-09-28**  
Baseline: **`develop` at `d387696`**  
Status at planning time: **Days 1–5 complete; `develop` matches `origin/develop`**

This is the assignment source of truth for all work remaining after the five-day delivery. It
supersedes `remaining-work-2026-09-28.md` for team assignment. The earlier file remains useful as
historical context, but it only assigned first slices and did not represent the requested
40% / 40% / 20% split.

The existing Ember artifact in `docs/ember-artifact/` is read-only. New work must use the current
Ember tokens and shared components; nobody should redesign or overwrite the reference artifact.

## 1. What is already finished

Do not rebuild these areas unless a regression is found:

- Owner/manager authentication and offline-capable PIN terminal authentication.
- Register cart, order types, modifiers, notes, discounts, promotions, loyalty, service charge,
  manager approval, offline checkout, receipts and refunds.
- Floor areas/tables, service-state transitions, transfer/merge and waiter terminal mode.
- Menu/category/product CRUD, recipes, ingredient creation, units and food costing.
- Kitchen tickets, station grouping, prepare/ready/serve lifecycle, recipe consumption and Chef
  terminal mode.
- Ingredient inventory, batches, wastage, adjustments, ledger and expiry/stock states.
- Customer creation/search/profile summary, loyalty enrollment, tiers and reward rules.
- Dashboard and current Sales, Orders, Refunds, Customer, Inventory, Hours, Food Cost and Kitchen
  Performance reports.
- Ember application shell, shared tokens, responsive foundations, lazy routes, tenant RLS,
  migrations ledger, offline outbox and current CI build/test jobs.

## 2. Remaining scope found by the audit

### Operational and commercial features

1. Durable open checks with hold/resume and real running table totals.
2. True multi-payment, split-tender, itemized/per-seat settlement and refund allocation.
3. Tips and tip reporting.
4. Reservations and waitlist.
5. Sellable combos/bundles and a dedicated variant model beyond modifier-based sizes.
6. Kitchen SLA alerts, course firing and completed/cancelled ticket history.
7. Vendor directory, purchase orders, receiving, invoices and ingredient-cost reconciliation.
8. Customer editing, safe deactivation/merge, favorites and preference history.
9. Delivery assignment/status tracking and a real Rider workspace.
10. Shift breaks and payroll-ready CSV export.
11. A deterministic discount-stacking policy across manual discounts, promotions and rewards.
12. Server-backed receipt detail/reprint when a check was closed on another device.

### Release hardening and visual completion

1. Make real browser E2E flows a required CI gate rather than manual scripts.
2. Add measurable performance budgets and production error/health monitoring.
3. Run an Ember visual, responsive and accessibility pass across every owner and terminal route.
4. Replace stale documentation that still tells contributors to use the old Counterline palette;
   `docs/rules.md` currently conflicts with `docs/DESIGN_SYSTEM.md`.
5. Update API/runbook/module-status documentation and produce final manual acceptance workflows.

### Explicitly gated future scope

- Restaurant Intelligence—forecasting, anomaly detection and demand recommendations—must not be
  presented as complete until enough real production history exists. The final sprint may define
  data-readiness criteria and contracts, but it must not ship decorative forecasts using fake data.
- Integrated EMV/card-provider processing, wallets/store credit, accounting payroll processing
  and direct printer sockets require vendor/product decisions. They are not silently included in
  the implementation estimates below.
- Standalone kitchen-ticket creation remains excluded: tickets continue to derive from orders.

## 3. Workload allocation

Engineering scope is measured as **100 delivery points**. Review meetings are lead duties and do
not move feature points from Ahmed or Bisma to Hamza.

| Owner | Development share | Delivery points | Primary ownership |
|---|---:|---:|---|
| **Ahmed** | **40%** | **40** | Transaction depth, payments, kitchen and sellable menu structures |
| **Bisma** | **40%** | **40** | Guest/floor operations, purchasing, delivery and staff operations |
| **Hamza** | **20%** | **20** | Cross-cutting policy, test/release engineering, monitoring and documentation |
| **Total** | **100%** | **100** | Complete remaining committed backlog |

This is approximately **8–12 parallel working days**, depending on migration review and browser
QA. It is not safe to claim the complete backlog can be implemented and verified in one day.
Section 8 defines the highest-value work to start tomorrow.

---

## 4. Ahmed — 40 points

Ahmed owns the server-authoritative sales lifecycle and the menu/KDS work that depends on it.

### A1. Open checks, hold/resume and cross-device receipt detail — 10 points

Branch: `feat/open-checks`

Deliver:

- Design a durable, store-scoped open-check model with optimistic/versioned updates.
- Create, hold, resume, edit and void an unpaid check without issuing a receipt or changing loyalty.
- Preserve a held check across reload, terminal restart and network loss.
- Enforce one successful close operation per check; repeated or concurrent close requests must be
  idempotent and must not create two paid orders.
- Link dine-in checks to tables and expose a real running total to the Floor screen.
- Add server-backed order/receipt detail so authorized managers can view or reprint a check closed
  on another device. Historical snapshots, not the current catalog, must drive the receipt.
- Keep completed orders immutable; never convert the existing paid-order table into a mutable cart.

Acceptance:

- A held check survives reload and can be resumed once from an authorized terminal.
- Two simultaneous close attempts produce one paid order, one inventory effect and one receipt.
- KDS, inventory consumption, loyalty and reports are affected only at their documented transition,
  never merely because a check was held.
- Cross-store and unauthorized-device reads/writes are rejected.

### A2. Split settlement, tips and refund allocation — 10 points

Branch: `feat/split-settlement`

Dependency: A1 contract approved by Hamza.

Deliver:

- Replace the one-payment-per-order assumption with multiple payment rows while retaining replay
  safety and a unique client operation for each tender.
- Support cash + external card split tender and equal, itemized and per-seat allocation.
- Require the allocated amounts to reconcile exactly in integer cents before closing.
- Store external references per card tender and calculate cash change only against cash received.
- Add tips as explicit integer-cent values, separate from taxable sales and service charge.
- Allocate full and partial refunds back to the original tenders with an auditable balance.
- Update receipt, Orders, dashboard and report payment breakdowns.

Acceptance:

- Payments plus approved discount equal the amount due exactly; no floating-point money exists.
- Offline retry cannot duplicate a tender or tip.
- A refund cannot exceed the remaining refundable amount for any tender.
- Existing single-cash and single-card workflows remain unchanged for users who do not split.

### A3. Kitchen operations depth — 8 points

Branch: `feat/kitchen-operations`

Deliver:

- SLA states derived from fired time and snapshotted preparation target: calm, warning and late.
- Station-level due/late summaries and accessible visual/text indicators.
- Manager ticket history with date, station and status filters and pagination.
- Course-based firing for appetizer/main/dessert/side/beverage without re-creating ticket items.
- Clear hold/fire controls and an audit record of who fired each course.

Acceptance:

- Boundary-time tests prove each SLA state.
- Completed/cancelled history never pollutes the active board.
- Repeated course-fire requests are idempotent.
- Current prepare/ready/serve, ingredient consumption and table synchronization stay green.

### A4. Sellable combos and variants — 8 points

Branch: `feat/menu-combos-variants`

Deliver:

- Store-scoped combo/bundle schema with fixed or derived price, selectable components and limits.
- Immutable component and price snapshots on the sale.
- Stock/recipe consumption and KDS routing for every selected component.
- A dedicated variant model only where modifier-based sizes are insufficient; avoid duplicating the
  existing modifier feature under different names.
- Ember product-editor and register pickers with loading, empty, validation and error states.

Acceptance:

- A combo cannot reference another store, an inactive product or itself.
- Price, tax, discount, stock and refund tests cover fixed and selectable combos.
- Historical receipts remain correct after a combo or component changes.

### A5. Ahmed-owned regression and Ember QA — 4 points

Branch: use each feature branch; do not create one broad cleanup PR.

- API/domain tests for every money and state transition.
- Browser flows for open-check recovery, split payment, KDS course firing and combo checkout.
- Screenshots at 390 px, tablet and desktop for every new UI surface.
- Fix visual issues only in Ahmed-owned screens, using current Ember tokens/components.
- Provide migrations, `APPLIED.md` entries, manual verification and limitations in each PR.

---

## 5. Bisma — 40 points

Bisma owns guest-facing operations, supply-side operations and staff workflows.

### B1. Reservations, waitlist and live Floor presentation — 9 points

Branch: `feat/reservations-waitlist`

Deliver:

- Store/timezone-scoped reservations and waitlist entries with guest size, contact, notes, expected
  time, status and optional assigned area/table.
- Create/edit/cancel/arrive/seat/no-show flows in a clean Floor drawer or side panel.
- Conflict warnings, wait-duration calculation and filters for today/upcoming/waiting.
- Seating must call the existing atomic table transition and happen exactly once.
- After A1 lands, replace last-completed-order context on occupied tables with the live open-check
  total and duration; retain an honest fallback when no open check exists.

Acceptance:

- Store timezone controls day boundaries.
- Two staff members cannot seat the same reservation or table twice.
- Reservation actions never bypass Floor status rules.
- Mobile Floor controls remain usable without horizontal page scrolling.

### B2. Purchasing and vendors — 12 points

Branch: `feat/purchasing-vendors`

Deliver:

- Vendor CRUD with contacts, terms, active state and tenant isolation.
- Purchase orders with draft/sent/partially-received/received/cancelled lifecycle.
- Ingredient line items, ordered/received quantities, integer-cent unit costs and references.
- Partial and complete goods receiving into the existing ingredient batch and stock-movement ledger.
- Invoice/reference capture and cost variance against the previous ingredient cost.
- Update ingredient cost only under a documented manager-approved rule; keep history immutable.
- Purchasing list/detail/create/receive UI and vendor/spend/variance report slices.

Acceptance:

- Receiving the same operation twice does not duplicate a batch or stock movement.
- Over-receipt requires an explicit manager-approved path.
- Cancelling a PO never reverses stock already received.
- Purchasing extends the current inventory ledger; it must not create a second stock source.

### B3. CRM completion: edit, merge, favorites and preferences — 7 points

Branch: `feat/customer-profile-tools`

Deliver:

- Edit guest name/phone and safely deactivate/reactivate a profile.
- Merge duplicate guests with an immutable merge audit, moving loyalty/order associations once.
- Favorites and structured/free-text preferences with history and author attribution.
- Compact preference/favorite summary in the register guest picker.
- Conflict-safe offline behavior: creation can remain offline-first; merge must require confirmed
  online authority and must never silently merge by phone number.

Acceptance:

- Duplicate phone numbers remain valid until a manager deliberately merges profiles.
- Cross-store profiles/favorites/preferences are never visible or writable.
- Merge preserves order history, lifetime totals and loyalty ledger balance exactly once.

### B4. Delivery and Rider workspace — 7 points

Branch: `feat/delivery-operations`

Deliver:

- Snapshot delivery customer/contact/address/instructions on delivery orders.
- Assign/unassign a Rider and support accepted/picked-up/out-for-delivery/delivered/failed states.
- Give the Rider role a dedicated terminal route and only the capabilities it needs.
- Add dispatch view, status timeline and delivery KPIs without exposing financial admin screens.
- Define offline behavior explicitly; stale assignments must produce a visible conflict.

Acceptance:

- Only delivery orders enter dispatch.
- State transitions are server-authoritative, audited and idempotent.
- A Rider cannot view another store or perform manager-only actions.

### B5. Breaks, payroll-ready export and Bisma-owned QA — 5 points

Branch: `feat/staff-timekeeping`

Deliver:

- Paid/unpaid break start/end records against an open shift, with overlap prevention.
- Manager corrections with reason and audit entry.
- Timezone-correct hours and break totals plus payroll-ready CSV export; do not build a payroll
  calculation engine.
- Add tip totals to staff reporting after A2 lands.
- Browser tests and Ember responsive/accessibility QA for Bisma-owned features.

Acceptance:

- A staff member cannot have overlapping shifts or breaks.
- Open breaks/shifts are visibly distinguished from closed totals.
- CSV totals match the screen and retain integer-minute/integer-cent source values.

---

## 6. Hamza — 20 points development plus lead review/finalization

Hamza owns cross-cutting behavior and the release bar. Hamza must review Ahmed and Bisma; review
responsibility is not permission to rewrite their branches wholesale.

### H1. Discount stacking contract and enforcement — 4 points

Branch: `feat/discount-policy`

- Decide and document precedence/compatibility for manual discount, promotion and reward.
- Enforce the same rule in register UI, checkout domain logic and server validation.
- Preserve manager approval when the exact cart signature is unchanged; invalidate it otherwise.
- Snapshot the applied source(s) so receipts and reports explain the final price.
- Add abuse, stale-offline and rounding tests.

### H2. Required browser E2E CI gate — 5 points

Branch: `chore/browser-e2e-ci`

- Convert the most valuable existing browser scripts into deterministic Playwright projects.
- Gate owner auth/onboarding, terminal provisioning/PIN, menu/edit, floor/table, checkout/receipt,
  customer sync, inventory, KDS and reporting smoke flows in CI.
- Add trace/screenshot/video artifacts on failure and document local execution.
- Keep secrets out of CI and use isolated disposable test data.

### H3. Performance, accessibility and monitoring — 4 points

Branch: `chore/release-guardrails`

- Add JS/CSS chunk budgets and fail CI on agreed regressions.
- Add automated accessibility checks for critical owner and terminal routes.
- Add production-safe client/API error reporting, request correlation and health checks with no
  customer secrets or payment data in logs.
- Verify PWA/service-worker upgrades preserve pending local sales.

### H4. Documentation and release automation — 3 points

Branch: `docs/final-release-runbook`

- Correct `docs/rules.md` to reference the Ember graphite/ivory/orange system.
- Update OpenAPI/runbooks for new endpoints and state transitions.
- Keep `MODULE_STATUS.md`, migration `APPLIED.md`, environment/setup and manual workflow docs true.
- Define Restaurant Intelligence data-readiness criteria; leave the module deferred until met.

### H5. Final cross-device receipt/reconciliation and polish support — 4 points

Branch: `fix/final-operational-gaps`

- Review and close remaining cross-device receipt/reprint and reconciliation gaps not covered in A1.
- Standardize actionable errors for rejected sync, expired sessions and ambiguous external card
  payments without deleting browser data.
- Fix only verified cross-cutting Ember/accessibility regressions found during final route QA.
- Produce the release candidate and rollback checklist.

### Hamza review duties outside the 20 development points

For every Ahmed/Bisma PR, Hamza must verify:

- Business invariants and backwards compatibility.
- Integer-cent math and deterministic timezone handling.
- Tenant-composite foreign keys, least-privilege grants, RLS and cross-store rejection tests.
- Idempotency, offline retry, duplicate submission and partial-failure behavior.
- Migration filename/order, live application and `APPLIED.md` checksum.
- Ember conformity, keyboard/focus behavior and 390 px/tablet/desktop screenshots.
- API/web builds, automated tests and the affected browser journey.

Hamza either approves with evidence or returns a precise defect list. A green build alone is not
approval for payment, inventory, loyalty, staff or tenant-security changes.

---

## 7. Dependency and merge order

### Contracts Hamza must lock before implementation

1. Open-check state machine and the exact point where KDS/inventory/loyalty become active.
2. Payment/tip/refund allocation rules.
3. Discount stacking precedence.
4. Reservation-to-table and delivery state machines.
5. Ingredient-cost update rule during PO receiving.

Record these decisions in the relevant PR or architecture note; do not leave them in chat only.

### Feature dependency order

1. **A1 open checks** before B1 live table totals and A2 split settlement.
2. **A2 tips** before B5 tip-by-staff reporting.
3. **B2 purchasing contract** before receiving UI; receiving must use existing inventory writes.
4. **A4 combo contract** before UI; component snapshot/stock semantics are reviewed first.
5. B1 reservation creation/waitlist and B3 CRM may proceed independently of A1.
6. A3 SLA/history may proceed independently; course firing integrates after A1.

### PR rules

- Branch from fresh `develop`; never branch from another contributor's feature branch.
- One feature per PR. Use the branch names listed above or a narrower `feat/` branch.
- Only one contributor allocates migration timestamps at a time.
- Do not edit an applied migration. Add a new timestamped migration and ledger entry.
- Do not mix unrelated visual cleanup into a data/transaction PR.
- Hamza merges approved PRs into `develop`; nobody pushes feature work directly to `develop`.

Recommended merge sequence for each wave:

1. Independent Bisma CRM/reservation schema work.
2. Independent Ahmed kitchen SLA/history work.
3. Ahmed open-check core.
4. Bisma live Floor integration, Ahmed payment integration and dependent reporting.
5. Purchasing, combo and delivery modules after their contracts pass review.
6. Hamza release guardrails/documentation, then final regression fixes.

---

## 8. Tomorrow's executable assignment

The complete backlog above spans more than one safe day. Tomorrow should produce reviewable,
shippable foundations rather than several half-working modules.

### Ahmed tomorrow

1. Write the A1 open-check state/API/schema contract and review it with Hamza.
2. Implement the smallest complete hold/resume vertical slice with idempotency and cross-store
   tests; do not begin split settlement until A1 review passes.
3. If A1 is awaiting review, implement A3 SLA classification and boundary tests on a separate
   focused branch.

### Bisma tomorrow

1. Implement B3 customer edit/deactivate plus favorites/preferences first; keep merge as a
   manager-only online follow-up if the audit contract is not ready.
2. Implement the independent reservation/waitlist schema and create/edit/cancel drawer from B1.
3. Prepare the B2 purchasing data/API contract for Hamza review; do not create a parallel stock
   ledger or start receiving before approval.

### Hamza tomorrow

1. Lock the five contracts in Section 7 and allocate migration timestamps.
2. Implement H1 discount policy and start H2 browser CI conversion.
3. Review Ahmed/Bisma schemas and first PRs the same day.
4. Correct the stale design instruction in `docs/rules.md` before contributors use it.
5. Run the current Day 5 lifecycle test after every merge and update `MODULE_STATUS.md` with facts.

### Tomorrow end-of-day evidence

Each developer hands off:

- Branch and commit/PR links.
- Changed-file list and migration list.
- Exact automated commands and results.
- Manual click workflow.
- 390 px and desktop screenshots for UI work.
- Known limitations and dependencies.

Hamza publishes one combined status: merged, changes requested, blocked with reason, and next
owner. “Almost done” is not a status.

---

## 9. Definition of final application completion

The remaining-work program is complete only when all of the following are true:

- Modules A–L have no undeclared functional gaps; Module M is either data-ready and implemented or
  explicitly remains gated with measurable criteria.
- All new state transitions are tenant-safe, audited, idempotent and covered by tests.
- Offline checkout and pending-sale preservation still pass after every database/PWA change.
- Every route has intentional loading, empty, error, success, disabled, hover, pressed and focus
  states using the Ember system.
- Owner and terminal routes work at 390 px, tablet and desktop without unintended horizontal scroll.
- Critical workflows pass as required browser E2E checks in CI.
- API and web builds/tests pass; migration verification and ledger checks pass against the target
  environment.
- Manual acceptance covers owner, manager, cashier, waiter, chef, inventory manager and rider.
- `MODULE_STATUS.md`, setup/runbooks, OpenAPI and release notes match what is actually shipped.
- No feature is called complete if it uses mock data, has an unapplied migration or lacks an
  end-to-end verification path.

## 10. Final manual journey Hamza must approve

1. Create/sign in to an owner account and complete onboarding.
2. Configure store, terminals, all staff roles, tables, menu, modifiers, combo, recipe and stock.
3. Create/edit a guest, preference, loyalty enrollment, reservation and waitlist entry.
4. Seat the guest, open/hold/resume a table check and confirm its live Floor total.
5. Fire courses, observe SLA escalation and complete the Kitchen lifecycle.
6. Settle with split cash/card plus tip, issue/reprint the receipt from another authorized device,
   then test a correctly allocated refund.
7. Create a vendor/PO, partially receive it and confirm the existing batch/stock ledger/report.
8. Assign and complete a delivery through the Rider workspace.
9. Clock a shift and break; verify hours, tips and payroll-ready export.
10. Verify dashboard/reports, tenant isolation, offline recovery, sync-center handling and all Ember
    responsive/accessibility states.

Only after this journey and all required automated checks pass should Hamza mark the application
finalized for release.
