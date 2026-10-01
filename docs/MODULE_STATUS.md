# Module Status

> **Day 1 of the next sprint, 2026-10-01: `feature/hamza/day1-api-security` and
> `feature/bisma/day1-qr-ordering` reviewed and merged into `develop` in that order**, per
> `RULES.md`'s "security foundations before features that depend on them." Both were independently
> rebuilt and re-run from their own PRs (not trusted on reported test counts alone): packages/domain
> 90/90, apps/api build clean, `npm test` 9/9, `test:integration` 55/55, `test:orders` 127/127,
> `test:browser:core-loop` 6/6 for the security branch standalone; 3/3, 48/48, 152/152 (25 of them
> QR-specific), `test:browser:qr` pass for the QR branch standalone. The QR branch's own
> `test:browser:core-loop` failure was confirmed to be a real, pre-existing bug on `develop` (a
> `getByText('Open check')` strict-mode locator ambiguity in the Register cart aside, unrelated to
> either branch) that the security branch happened to fix while adding its own, unrelated fix (the
> core-loop's demo employee needed `manager`, not `cashier`, once role capability enforcement went
> live) — both fixes compose cleanly post-merge, confirmed by a full 6/6 core-loop pass on the
> merged branch.
>
> **Integration fix required and made**: `feature/bisma/day1-qr-ordering` shipped its public
> surface (`qr-ordering.ts`) behind hook points (`qr-security-hooks.ts`) that default to allow-all
> by design, explicitly for the security branch to wire — `qr-security-integration.ts` (new) builds
> the real hooks from the security branch's own primitives (`requireCashierCapability` for staff
> role enforcement on confirm/reject/list, `checkRateLimit`/`RATE_LIMIT_BUDGETS` for the public
> session/order/poll limits) rather than a parallel QR-specific copy, and `server.ts` installs them
> once before the app starts listening. A pre-existing grep-based test
> (`rate-limit.test.ts`, "nothing in this codebase mounts [the limiter] on an authenticated route")
> had to be narrowed to allow this file and `qr-ordering.ts`/`qr-security-hooks.ts` by name — it
> still fails for every other route file. A new test
> (`apps/api/test/qr-security-integration.test.ts`) proves the real wiring by HTTP request: a
> `chef`/`rider` terminal session gets `403 authorization_failed` confirming/rejecting/listing QR
> submissions (no `register` capability), a `cashier` succeeds, and both the session-creation and
> order-submission public endpoints return real `429 rate_limited` once their budget is exceeded.
> Full suite re-run clean after the fix: `test:integration` 56/56, `test:orders` 152/152,
> `test:browser:core-loop` 6/6, `test:browser:qr` pass, apps/web 57/57 + clean typecheck + clean
> build.
>
> **Not done as part of this merge, by design**: the QR migration
> (`202609300001_qr_table_ordering.sql`) is not applied to any live database and has no
> `APPLIED.md` row — merging code into `develop` does not apply a live migration (see `RULES.md`
> §3), and `QR_ORDERING_ENABLED` must stay unset in every environment until that migration is
> applied there. The security branch's own two migrations
> (`202610010001_terminal_manager_approvals.sql`, `202610010002_public_rate_limits.sql`) carry
> `APPLIED.md` rows claiming they were applied and verified against "the configured database" at
> authoring time; this review had no live database credentials to independently re-confirm that
> claim (only isolated PGlite fixtures, per every automated test above) — re-run
> `apps/api/scripts/verify-migrations.mjs` against the real database before trusting those two rows.
> Separately, `lib/rate-limit.ts`'s own public-endpoint key (`byStoreAndRemoteAddress`/the plain
> remote-address key `qr-security-integration.ts` uses for session issuance) reads the raw TCP
> peer address and deliberately never trusts `X-Forwarded-For` without `app.set('trust proxy', ...)`
> being configured (that file's own comment explains why) — correct as shipped, but on `01_tech_stack
> .md`'s documented Railway API hosting, a reverse proxy sits in front of the app, so every guest at
> a store would collapse onto one shared bucket (the proxy's own address) unless whoever deploys QR
> ordering also sets `trust proxy` to match Railway's actual hop count and updates the key to use
> `req.ip`. This degrades to an overly-strict, store-wide shared limit (fails safe, not open) rather
> than a security hole, but is a real deployment prerequisite, not yet done.
>
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
> **A second same-day wave merged Ahmed's four remaining PRs** (`feat/open-checks`,
> `feat/split-settlement`, `feat/kitchen-operations`, `feat/menu-combos-variants` — A1-A4 of
> `docs/day-plans/final-application-work-split.md`), each cut before the first wave above and so
> each needing a real conflict-resolution merge back onto `develop`, not just a fast-forward. The
> same class of bug as the App.tsx one recurred at every step (two branches each extending a
> shared `orders.ts`/`App.tsx`/`MODULE_STATUS.md`/`APPLIED.md`) and was hand-merged rather than
> auto-resolved blindly; a real regression was also found and fixed each time a branch's
> `orders.ts` changes met the other three PRs' PGlite test fixtures, whose hardcoded migration
> chains didn't yet include the new migration each branch introduced. Two genuine, narrow
> integration gaps between features built in parallel were found and documented rather than
> silently patched (see rows A and D): combo components don't yet carry their own kitchen
> course/prep-time target, and an open check can't yet hold a combo line. All four PRs are green
> against the full test suite post-merge (127 API route tests, 48 integration tests, 53 web
> tests, both typechecks, both builds).
>
> **A third same-day pass (2026-09-29) fixed real bugs found by hands-on use of the newly-merged
> modules**, not just code review: a genuine crash (not a style nit) where one malformed recipe
> blanked both the Food Cost report and the entire Menu product list, since `costRecipe`/
> `costSavedRecipe` throw rather than degrade and neither call site caught it; the Hours report's
> on-screen total silently disagreed with its own payroll CSV export (missing an unpaid-break
> subtraction the CSV already had); Delivery orders had no way to be created through the Register
> UI at all despite Dispatch/Rider being fully built underneath; and 12 CSS rules across 5 files
> referenced `--mise-orange`/`--mise-orange-soft`/`--mise-surface-soft`, tokens that were never
> defined — the most visible casualty being that selecting a Combo/Modifier option showed **no
> visual feedback whatsoever**. Vendors and Dispatch also picked up a visual pass onto the shared
> `<StatusBadge>`/`EmptyState`/token system instead of bespoke hardcoded-hex styling, and the
> owner Dashboard gained a live "what's new" strip (Open Checks, Reservations/Waitlist, active
> Deliveries, Purchasing, Guests) so today's newer modules are actually visible from the homepage,
> not just reachable by knowing the nav link exists. Per explicit instruction this pass verified
> with `tsc -b`/`tsc --noEmit` and a production build on both apps, not the full PGlite/browser
> suites — normal test coverage for these changes is still owed as a follow-up.

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
- **Manual click-through of the core POS loop (item 7), 2026-09-29:** `apps/api/test/
  core-loop-browser-check.ts` (`npm run test:browser:core-loop`) drives real headless Chromium
  through the actual built app end to end — seat a table, start its order, add a dish, attach a
  guest, pay cash, mark the kitchen ticket ready and served, then bill/settle/clean the table back
  to available — asserting on the real rendered screens at every step, with zero uncaught browser
  errors. Screenshots in `docs/core-loop-screenshots/`. Two things this run surfaced along the way,
  neither a defect in today's app: kitchen ticket items are created straight into `preparing`
  rather than `queued` (already an intentional, commented choice in `orders.ts`); and replaying
  every migration from a clean database (needed to seed this fixture) fails at
  `202609180006_stores_country_column.sql`, because the "drifted production database" state its
  own comment describes no longer matches `202609180002_store_business_details.sql` as currently
  committed — worth a follow-up migration to make the fix-up idempotent, but out of scope to touch
  today.

## Product modules

| Module | Status | Done now | Explicitly left |
|---|---|---|---|
| **A. POS / Register** | 🟡 | Dine-in/takeaway/delivery, cart and notes, guest requirement, inventory warning, discounts, rewards, promotions, service charge, manager approval, modifiers, offline checkout, receipts, refund flow, equal-split calculator, **open checks: durable versioned create/hold/resume/edit/void, cross-device server-backed receipt detail (`feat/open-checks`, Ahmad's A1)**, **split settlement and tips: equal/itemized/per-seat/custom cash+card allocation, tips on both the single- and split-payment paths (`feat/split-settlement`, Ahmad's A2)**, **sellable combos: added to the cart and checkout through the same flow as any product (`feat/menu-combos-variants`, Ahmad's A4)**. **Discount-stacking is a decided policy, not an open gap**: a line carries exactly one discount source (manual/reward/promotion), whichever was applied last — documented as a permanent invariant next to `LineDiscount` in `packages/domain/src/money.ts`, confirmed by audit to already hold structurally (every write site replaces the field, none accumulate). **Clarified 2026-09-29:** Hold/Resume's own logic hadn't changed, but "Hold" was a small text-link crammed next to "Void check," easy to miss and easy to read as automatic — the cart now explains inline that items stay local until Hold is tapped, and the button is a real, clearly labeled action | An open check's own create/edit/void/close calls are online-only by design (see `apps/web/src/lib/open-checks.ts`), not queued through the offline outbox like a completed sale. **Integration note (2026-09-29):** open checks (A1) and sellable combos (A4) were built in parallel and were never integrated — a combo product can't yet be added as an open-check line (`apps/api/src/routes/open-checks.ts` always writes `combo_selection: null`); combos only currently work through the direct register-cart checkout path |
| **B. Front of House / Tables** | ✅ | Areas/tables CRUD in an Ember dialog, Seat/Add order/Bill/Settle/Clean, Transfer/Merge, waiter terminal mode, atomic status transitions, reservation/waitlist drawer with conflict warnings and seat-once table assignment, **a table's open check shows a real live running total on the Floor screen, not just its last completed order (`feat/open-checks`, Ahmad)**. Audited 2026-09-29: `seat()` correctly reuses the shared atomic `applyTableStatusTransition` inside a transaction with a row lock and replays idempotently on a duplicate `operation_id`. **Gap closed 2026-09-29** (`apps/api/src/routes/reservations-seat.test.ts`): the HTTP path itself is now proven, not just the underlying function — duplicate-`operation_id` replay, an already-seated booking rejecting a different operation id, a cross-store booking id returning `not_found` rather than acting on another store's row, and a session claiming a different store's `store_id` outright rejected with `cross_store_reference` | No committed gap |
| **C. Menu** | ✅ | Product/category CRUD, availability, kitchen routing, recipe builder, unit conversion, food cost, ingredient creation dialog, modifier group/option CRUD and checkout/KDS/receipt snapshots, **sellable combos: store-scoped fixed/derived-price bundles built from other real, already-sellable products, with per-component stock consumption and KDS routing and self-reference/inactive/nested-combo rejection (`feat/menu-combos-variants`, Ahmad's A4)** | No dedicated variant model was built: modifier-based sizes already cover a price-only variant (e.g. Regular/Large) sharing one stock count, and a stock-distinct variant (e.g. Can vs. Bottle) is already just two separate products — a genuinely new variant structure would duplicate one of those two existing mechanisms under a different name, which A4 explicitly warned against. Revisit only if a real request needs neither shape |
| **D. Kitchen / KDS** | 🟡 | Order-derived tickets, station grouping, preparing/ready/served lifecycle, Chef terminal mode, modifiers, recipe consumption, table synchronization, performance reporting, **SLA calm/warning/late states from a snapshotted prep-time target, per-station due/late summary, manager ticket history (date/station/status filters, paginated), course-based firing (appetizer/side/beverage fire immediately, main/dessert held for an explicit fire) with hold/fire controls and an audit log of who fired each course (`feat/kitchen-operations`, Ahmad's A3)**. **Integration note (2026-09-29):** a combo's real dish components don't yet carry their own course/prep-time target when fired to the kitchen (only the top-level product catalog query feeds `courseByProduct`/`prepTimeByProduct` in `apps/api/src/routes/orders.ts`) — they safely fall back to no-course/default-prep-time (fire immediately) rather than erroring, but a component that should hold for course-firing won't yet. Needs a product decision (use the component's own course, or the parent combo's) before it's a real gap rather than a safe default | Standalone ticket creation remains intentionally excluded |
| **E. Recipes** | ✅ | Recipe CRUD, yields, units, conversion-aware costing, searchable ingredient selector, inline ingredient creation | No committed gap |
| **F. Restaurant Inventory** | ✅ | Ingredient/batch CRUD, receipt/wastage/adjustment/consumption ledger, expiry and low/out-of-stock states, terminal manager approval, edit/deactivate/reactivate, tenant-composite attribution | No committed gap; purchasing is tracked separately in Module G |
| **G. Purchasing & Vendors** | 🟡 | Vendor CRUD (contacts/terms/active state), purchase orders (draft/sent/partially-received/received/cancelled), ingredient line items with integer-cent costs, partial/complete receiving into the existing batch/stock-movement ledger with real insert-level idempotency (`on conflict (store_id, operation_id) do nothing`, row-locked), invoice/reference capture, cost-variance history, vendor/spend/variance report slices. Audited 2026-09-29: composite-FK tenant isolation and RLS correct on all 6 new tables, cancel never reverses already-received stock, real tests cover the idempotency/tenant claims (not just happy-path CRUD). **Updated 2026-09-29:** Vendors tab redesigned (an active/inactive count header, an icon and contact rows per card, an `EmptyState` first-vendor prompt) and its hardcoded hex status/variance colors replaced with the shared `--mise-*` tokens; receiving stock now shows an explicit confirmation naming that it recorded against the ingredient's balance and stock ledger, linking straight to Inventory — the data was always written correctly (verified by code, not a bug), this closes the visibility gap between doing it and seeing it | Full UX/completeness pass not yet done — the audit covered correctness/security/idempotency, not every screen state |
| **H. Customers / CRM** | ✅ | Guest CRUD/search/profile, visit and lifetime-spend aggregation, loyalty enrollment/balance/tier, guest edit, safe deactivate/reactivate, manager-controlled merge (row-locked, ledger-based loyalty transfer, idempotent retry, never silently merges by phone, audit-immutable), favorites and structured/free-text preferences with author attribution, compact summary in the register guest picker | No committed gap |
| **I. Loyalty** | ✅ | Account enrollment, tiers CRUD, reward rules, earning/redemption, immutable ledger, terminal and web paths | No committed gap |
| **J. Promotions** | ✅ | Manager CRUD, scheduling/activation, terminal availability and line-discount application | Product decision for stacking priority; current last-applied discount wins and remains data-safe |
| **K. Staff** | ✅ | Owner/manager web access; Cashier/Manager/Waiter/Chef/Inventory Manager/Rider terminal roles; capability navigation; employees; clock-in/out and hours report; paid/unpaid breaks (DB-enforced no-overlap via a partial unique index plus a `before insert` trigger, immutable manager corrections) and payroll-ready CSV export; Rider terminal route and dispatch/delivery workspace (state-machine-enforced transitions, rider-scoped authorization — a `cc793ee` fixup closed a real gap where any capability-superset role, not just `rider`, could pass the terminal gate). **Gap closed 2026-09-29:** the Register now captures recipient name/phone/address/notes whenever "Delivery" is selected (a `deliveryDetails` field on `pos-store.ts`, a new inline form in `RegisterScreen.tsx`), validated client-side before checkout and sent as `order.delivery` the same way `apps/api/src/routes/orders.ts` already required — a real delivery order can now be created end to end through the shipped UI, not just via a direct API call. Holding a delivery-type check is deliberately blocked (open checks have no column for these details yet — the Hold button disables with an explicit reason). Dispatch/Rider also moved off a bespoke hardcoded-hex status-badge system onto the shared `<StatusBadge>` component and `DELIVERY_STATUS_TONE` map, matching every other status chip in the app. Fixed 2026-09-29: a break-start race returning checkout's `receipt_number_conflict` copy instead of `break_already_open` — the pre-check was select-then-insert and couldn't catch a concurrent second request; the insert's own unique-violation now maps to the right error, regression test added (`apps/api/test/timekeeping-breaks.test.ts`, two genuinely concurrent requests). **Fixed 2026-09-29:** the Hours report's on-screen totals were showing gross shift duration despite the panel's own subtitle claiming "net of unpaid breaks" — `groupHoursWorked` (`ReportingScreens.tsx`) never actually subtracted unpaid break time, so it silently disagreed with the payroll CSV export, which already computed this correctly server-side. The on-screen total now matches the CSV **Added 2026-10-01:** server-time potential missed-clock-out warnings at the documented 16-hour boundary (advisory only, never auto-close); per-employee sale-attributed tips net of tip refunds; explicit unattributed-sales bucket; and once-only per-shift/unallocated CSV allocation with screen/export parity. | No committed gap |
| **L. Reports** | ✅ | Sales, orders, refunds, customer/loyalty, inventory/wastage/expiry, hours, food cost/dish profitability, kitchen performance, dashboard floor/kitchen pulse. **Fixed 2026-09-29 (real crash):** `costRecipe`/`costSavedRecipe` throw on a non-positive line quantity or yield rather than returning a costable/uncostable status like every other outcome — one malformed recipe anywhere in the store blanked the entire Food Cost report (`apps/api/src/routes/reports.ts`'s `loadFoodCostReport` called it with no guard) and, separately, crashed the whole Menu product list (`ProductCatalogScreen.tsx` called `costSavedRecipe` unguarded during every row's render, with no error boundary to catch it — the literal "black screen" symptom). Both call sites now catch and treat that one dish as "needs review" instead of failing everything around it | No committed report gap; new modules must add their own reporting slices |
| **M. Restaurant Intelligence** | 🔴 | — | Forecasting, anomaly detection, demand planning and recommendation surfaces; start only after sufficient production data exists |

Current count: **9 complete modules, 3 operational/partial modules, 1 deliberately deferred
module**. The five-day scope is complete; the partial/missing items above are the next product
backlog, not hidden failures. Purchasing & Vendors moved from 🔴 to 🟡 and Customers/CRM moved
from 🟡 to ✅ this same day (2026-09-29), alongside Staff picking up breaks/payroll and the Rider
workspace — see the header note above for what was independently audited/fixed before trusting
these. Front of House / Tables moved 🟡 to ✅ the same day once the `seat()` HTTP idempotency and
cross-store gap the audit found was closed with a real test. Menu moved 🟡 to ✅ once sellable
combos landed (Ahmad's A4) — the "no dedicated variant model" note in its row is a deliberate scope
decision (modifier-based sizes and separate products already cover both variant shapes a new model
would duplicate), not outstanding backlog, the same framing Promotions' stacking-priority note
already used.

## Cross-cutting foundation

| Area | Status | Current truth |
|---|---|---|
| Authentication | ✅ | Supabase owner/manager auth plus offline-capable PIN terminal auth; intentionally separate |
| Tenant isolation / RLS | ✅ | Every public store-scoped table has RLS; Day 5 live verification passes; inventory terminal attribution is composite-scoped |
| Offline and synchronization | ✅ | Dexie outbox, idempotent operation ledger, dependency ordering, reconnect sync and clear pending/blocked/rejected states |
| Ember design system | ✅ | `docs/DESIGN_SYSTEM.md` is the binding reference (this row is a pointer, not a duplicate spec — it previously drifted out of sync with the real tokens and named a palette/font pairing, oxblood-rust with Fraunces/Archivo/IBM Plex Mono, that turned out to have never actually shipped; corrected 2026-09-29 by reading `ember.css`/`styles.css` directly instead of trusting an earlier session's summary of them): warm-linen canvas, near-black warm ink, a vivid orange accent (`--mise-saffron`, `#F97316`), Inter for both headings and UI text over JetBrains Mono for money/quantities, compact cards/tables/forms/dialogs, accessible focus and responsive states. **Also fixed 2026-09-29 (real, widespread bug):** 12 CSS rules across 5 files (`styles.css`, `kitchen.css`, `loyalty.css`, `product-catalog.css`) referenced `--mise-orange`/`--mise-orange-soft`/`--mise-surface-soft` — tokens that were never defined anywhere, a leftover from a token rename that was never fully propagated. The most visible casualty: the Combo/Modifier picker's "selected" state had **no visual feedback at all** — no border color, no fill, no accent-colored checkbox — a real, previously-unnoticed contributor to "the combo picker is confusing." All 12 now point at the real `--mise-saffron`/`--mise-saffron-fill`/`--mise-surface-sunken` tokens |
| Performance | ✅ | Route screens are lazy loaded; React, Supabase, offline and icon vendors are stable chunks; no chunk exceeds Vite's 500 kB threshold |
| CI | ✅ | Builds and automated tests run on PR/push workflows |
| Testing | 🟡 | Strong domain/API/web coverage plus the Day 5 cross-module lifecycle test; browser fixtures exist, but full browser E2E is not yet a required CI gate |
| Migration ledger | ✅ | Modifier and inventory closeout migrations are applied, checksummed and recorded; `verify-day5-closeout.mjs` is the repeatable live audit |

## What remains

The next work is intentionally prioritized rather than treated as one unsafe mega-change.
Reservations/waitlist, favorites, discount-stacking, delivery/rider, purchasing/vendors, open
checks/hold-resume, split settlement/tips, kitchen SLA/course-firing/ticket-history, and sellable
combos all moved out of this list across 2026-09-29 (now rows A/B/C/D/G/H/K above) — none were
multi-day features that got half-shipped; each was independently audited or verified against this
codebase's own invariants (tenant isolation, transactional idempotency, real test coverage) before
being trusted here.

1. **Two narrow, real integration gaps** between Ahmed's four features (A1/A2/A3/A4), each built in
   parallel without knowledge of the others, found and documented rather than silently patched: a
   combo's dish components don't carry their own kitchen course/prep-time target (row D), and an
   open check can't yet hold a combo line (row A). Neither errors or corrupts data; both default
   safely. Closing them is a product decision (whose course/prep-time should a combo component use;
   should open checks support combo lines at all) before it's implementation work.
2. **A small, real gap found during manual-test-workflow authoring:** wire a recipient/address
   dialog into the Register's Delivery order type so checkout can actually send the `delivery`
   details the API already requires — right now Dispatch/Rider work correctly on rows created
   directly via the API, but the UI has no way to create one.
3. **Per-employee tip reporting** on the Hours report (row K) — tips are captured and reported
   store-wide, just not yet joined to which employee rang up the sale.
4. **Scale hardening:** make browser E2E a CI gate, then add performance budgets and monitoring.
5. **Data-dependent future:** Restaurant Intelligence only after real operational history exists.

Items 1-3 are each a small, bounded fix, not a multi-day feature; item 4 is correctly multi-day and
not attempted in one sitting.
