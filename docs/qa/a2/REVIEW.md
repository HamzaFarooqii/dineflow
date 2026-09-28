# A2 split settlement review — 2026-09-28

## What changed

Continued Claude's uncommitted A2 work on `feat/split-settlement`, based on the pushed A1 commit `e5cd137`. The user confirmed A1 has no PR yet. `git fetch origin` succeeded and the feature branch already contains the latest `origin/develop` (`d387696`). No merge or A1 approval is claimed.

Checkout now persists multiple cash/external-card tenders and explicit tips in the same local transaction and outbox operation. Each tender retains its UUID across offline retries. Equal allocations distribute remainder cents deterministically; item/seat allocations use exact integer weighted division. Dexie version 6 removes the one-payment-per-order index without removing existing receipts. The single-payment path remains available.

Refunds reject duplicate item/tender IDs, enforce remaining quantities and original-tender balances, and serialize through the existing store transaction lock. Optional client operation IDs make retries replay-safe; the new UI always supplies one. Partial refunds include proportional service charge and proportional original-tender tips. The final refund returns rounding remainders. Tax, merchandise, service charge and tips have explicit audit amounts. Paid orders and payments remain immutable.

Receipts display every tender, tip, reference and cash change. Remote detail reads supply aggregate refund balances. Managers can refund remote receipts or selected item quantities. Orders use a single aggregated payment summary per order, avoiding duplicate rows and broken pagination. Reports attribute refunds to actual tender allocations and keep tips separate from sales.

Related A1 defects fixed: list requests now join query parameters correctly; close requests provide payment IDs; receipt caching uses the server's winning sale rather than the losing terminal's attempted tender/receipt; failed remote receipt loads leave the loading state; saved check versions and manager approval evidence are retained during checkout.

## Database changes

- `202609280003_split_settlement.sql`: inherited from Claude; its existing applied ledger entry was preserved. The read-only verification script independently confirmed the live payment columns, uniqueness change and refund-tender table.
- `202609280004_refund_settlement_integrity.sql`: **not applied to the shared database**. Adds refund operation/hash and financial component fields, refund-tender tips, and backfills legacy single-tender refund allocations. Isolated PostgreSQL fixture replay passes. Automatic approval review rejected shared application because persistent schema changes and legacy backfills need explicit authorization. Its SHA-256 and pending status are in `APPLIED.md`.
- Deploy the API changes only after the follow-up migration is applied. Do not edit the already-applied `003` migration.

## Tests

- Domain: 69 passing.
- API authentication: 3 passing.
- API integration: 47 passing, including existing order replay, cashier attribution, loyalty and the Day 5 lifecycle.
- API routes: 75 passing. Focused re-run of open checks, settlement, refunds and reports: 33 passing, including partial/full refunds, tip remainders, service charge, duplicate refund input, replay conflict and tenant scoping.
- Web: 53 passing; TypeScript and production build pass.
- Browser: `cd apps/api && node --import tsx test/split-settlement-browser-check.ts`. Uses the real payment screen, Dexie checkout and receipt renderer with synthetic data. Proves a $30.01 equal split is $15.01 + $15.00, cash tip/change, external card reference/approval gating, and a saved multi-tender receipt.
- Screenshots: `payment-390.png`, `payment-768.png`, `payment-1440.png`, and corresponding `receipt-*.png`. Mobile horizontal overflow is checked. Visual inspection found and fixed a nested receipt layout issue.

## Manual verification and limitations

The browser test is a component/checkout fixture, not an authenticated full application journey. No real payment processor or live financial transaction was used. No manual live-store checkout/refund was performed. The new partial-refund controls still need browser coverage and responsive screenshots in the full authenticated receipt screen. Itemized/per-seat allocation needs an end-to-end browser flow; the domain math is covered.

Allocations group whole cart lines per seat; splitting units from one line between seats requires separate cart lines. The allocation editor produces the tenders; seat assignments are not yet durable historical receipt metadata. At most 20 tenders are supported. A zero-sale tender cannot carry a tip. Legacy refund clients without operation IDs retain balance protection but do not have request-level retry identity.

Local offline reports retain the older per-order refund timestamp model; multiple refund dates require the server report for accurate day-by-day attribution. Original paid-sale snapshots remain correct. Tip refunds are accounting records for external card reconciliation; no card gateway refund is executed.

Hamza's A1 contract approval, feature PR creation/review, the pending migration, full refund UI QA and the remaining A1 browser recovery coverage are outstanding. GitHub CLI was unauthenticated and no connected browser was available for PR review. A3 kitchen operations and A4 combos/variants remain unimplemented and must stay in their specified feature branches; A5 is only partially complete.
