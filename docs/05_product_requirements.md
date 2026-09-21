# 05 — Product Requirements — v3.0

**Status:** Revised pilot contract. Production approval pending implementation and acceptance tests.
**Scope:** One store, multiple independently provisioned terminals, one currency with two fractional digits, whole-unit retail products.
**Planning target:** Seven-day pilot for three developers; a date is not a production readiness guarantee.

## 1. Product invariants

1. After successful provisioning and within the seven-day offline authorization window, cash checkout does not wait for the server.
2. A completed sale, receipt sequence, payment, approval evidence, stock adjustment and outbox entry commit atomically.
3. Money uses bounded integer cents and deterministic rounding shared by client and server.
4. Order operation IDs and receipt identities survive retries; one accepted sale affects central stock once.
5. Displayed stock combines a server base and uncovered local adjustments. Stock may be provisional and negative.
6. Paid sales rejected by sync remain visible for reconciliation. No automatic deletion or silent mutation is allowed.
7. Printing and WhatsApp delivery are separate from successful recording of the sale.

## 2. Screens and required behavior

| Screen / feature | Phase 1 behavior |
|---|---|
| 1 Login — FEAT-AUTH-01 | Select employee, enter PIN, verify provisioned salted verifier. Persist five-attempt/60-second lockout. Inactive employees cannot unlock. Online validation refreshes permissions. |
| Manager modal — FEAT-AUTH-02 | Cashiers require manager approval for discounts above 20%. Bind approval to exact order, amount and permission version; changing the cart invalidates approval. Persist evidence with checkout. Discarding an unpaid cart needs no manager override in Phase 1. |
| Offline policy — FEAT-AUTH-03 | MUST: Disable manager approvals 72 hours after last server validation; disable checkout after seven days. Preserve all data and offer reconnect/reauthorization. |
| 2 Dashboard — FEAT-DASH-01 | Current register's local daily sales, order count, cashier and shortcut to register. Explicitly label register-local totals. |
| Global status — FEAT-STAT-02 | Show connectivity separately from pending, in-flight, blocked/rejected and synced state. Failed rows prevent an all-synced indication. |
| 3 Register — FEAT-CART-01 | HID barcode/SKU lookup, name search, category filter, quantity editing and cart totals. Resolve duplicate barcode matches visibly; do not silently pick a product. |
| Cart calculation — FEAT-CART-02 | Exact rules in section 3. Disable completion for invalid quantities, discounts, missing references or overflow. |
| Price snapshots — FEAT-CART-03 | Snapshot name, SKU, unit price, resolved tax rate and catalog version on each line when added. Later catalog updates do not modify that line or historical receipts. |
| 4 Payment — FEAT-PAY-01 | One cash or manually confirmed external card tender. Cash received must cover total. Card confirmation requires a deliberate approved-payment action and optional external reference. |
| Commit — FEAT-PAY-02 | One atomic sale transaction defined in document 04. Prevent duplicate completion from double-clicks or UI recovery. Show success only after commit. |
| Receipt identity — FEAT-PAY-03 | Installation-specific prefix plus monotonic sequence, minimum six digits. Increment in sale transaction. New installation/prefix after storage reset. |
| Receipt output — FEAT-PAY-04 | Required print/reprint with store, currency, line snapshots, totals and receipt number. Reprints say DUPLICATE RECEIPT. Optional WhatsApp handoff normalizes phone to international digits and requires user Send plus connectivity. |
| 5 Products — FEAT-CAT-01 | Read-only catalog and projected stock. Allow selling at zero/negative stock; label stale/provisional values. Inactive products cannot be newly added. |
| 6 Orders — FEAT-HIST-01 | Register-local receipt/date lookup, payment details, sync/reconciliation state, reprint. Synced history restoration is online. |
| 7 Reports — FEAT-REP-01 | Register-local calendar-day summary in cached store timezone; definitions below. Show pending/rejected amounts separately. |
| 8 Settings — FEAT-SET-01 | Installation identity, storage persistence result, last successful sync, printer/scanner tests and online administrator reprovisioning. Never expose reset as a routine sync fix. |
| 9 Sync Center — FEAT-SYNC-01/02 | Local queue inspection, machine-readable failures, retry/backoff state, dependencies, authorization recovery and export of unresolved diagnostic records. No dismiss/delete action for paid unsynced sales. |
| Customers — FEAT-CRM-01 | Create and lookup by normalized phone; allow multiple customers with the same phone. Customer creation and its outbox record commit together. Order waits for its customer dependency during push. |
| Inventory — FEAT-INV-01 | Derive one central movement per distinct product per sale; display central oversell flags to an operator through server status tooling. Resolution is recorded centrally. |

## 3. Deterministic money rules

Use document 01 limits. Phase 1 uses tax-exclusive prices and whole-unit quantities.

For each line:
- line_subtotal = unit_price_cents * quantity.
- Fixed discount is an integer amount from zero through line_subtotal.
- Percentage discount is rounded half up: floor((line_subtotal * discount_bps + 5000) / 10000).
- taxable_cents = line_subtotal - discount_applied_cents.
- tax_cents = floor((taxable_cents * tax_rate_bps + 5000) / 10000).
- line_total_cents = taxable_cents + tax_cents.

One discount per line; no order-wide allocation or stacked promotions in Phase 1.
Order subtotal, discount and tax are sums of their line fields. Order total is the sum of line totals and must equal subtotal - discount + tax.
Payment amount equals order total. Cash change equals tendered - total. Card tender equals total and change is zero.

Example: two units at 199 cents, a 10% discount, and 5% tax yield subtotal 398, discount 40, taxable 358, tax 18, total 376 cents. A 500-cent cash tender yields 124 cents change. A 10-cent taxable line at 5% tax rounds 0.5 cents to 1 cent.

The server recomputes from submitted historical snapshots, validates bounds and required approvals, and does not substitute current catalog prices for an offline sale. Suspicious or stale snapshots may be flagged for review without rewriting the receipt.

## 4. Reports and time

Cache store timezone/currency during bootstrap and snapshot them on the order.
Select the local calendar day using client_generated_at interpreted in that store timezone, not the UTC server upload day.
- Gross sales = sum of subtotals before discount and tax.
- Net sales = sum of subtotal minus discount.
- Tax collected = sum of tax.
- Cash/card takings = sum of payment amounts, excluding cash change.
- Display unresolved sync amounts/counts alongside totals; completed local paid sales remain counted.
Server receipt time is audit metadata, not the date of a sale made days earlier. Detect and flag device clock anomalies.

## 5. Hardware and recovery boundary

Publish the exact tested OS, browser version, scanner and printer model for the pilot. Browser printing support is not universal, and a PWA cannot guarantee continued background execution when closed.

Request persistent storage and display whether it was granted. On quota/write failure roll back checkout and do not issue a completed receipt. If an external card charge was already approved, show a recovery screen with the charge reference and require operator reconciliation before charging again.

Storage loss can destroy unsynced sales. Require controlled terminal operation, online restore/reprovisioning procedures, and an explicit pilot decision on whether an external backup/export procedure is required. A persistence request alone does not satisfy production durability.

## 6. Scope priorities

MUST: cash/core card recording, HID scanning, atomic checkout, exact totals, print/reprint on approved hardware, secure provisioning, bounded offline authorization, manager discount evidence, customer-create dependencies, commit-safe sync, stock overlays, local reports and visible recovery.

Optional after core acceptance: camera scanning, WhatsApp handoff and visual polish.
Deferred: refunds, wallets, store credit, integrated EMV, shifts/floats/Z-reports, customer editing/merging/loyalty, POS catalog edits, adjustment UI and direct printer sockets.
Local hub relay remains Phase 5.

## 7. Performance and acceptance

Targets are provisional until measured on named reference hardware:
- Barcode to cart: p95 <= 100ms.
- Local checkout commit: p95 <= 150ms under a defined 20-line basket and 10,000-order dataset.
- Offline launch after provisioning: p95 <= 2 seconds.
- PIN verification: benchmark the required work factor and show progress; do not weaken security to meet a fixed latency.
- 100-operation server push: p95 <= 2 seconds, subject to serialized store-write load testing.

Run the release gates in document 06. Simulated 30-day/10,000-order workloads validate backlog handling; they do not override seven-day employee checkout authorization or prove 30 days of real-world endurance.
