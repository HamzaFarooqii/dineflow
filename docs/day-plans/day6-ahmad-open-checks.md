# Day 6 — Ahmad: server-authoritative sales lifecycle and menu/KDS depth

Date assigned: 2026-09-28. 40-point scope, solo (the "Ahmed/Bisma on leave" execution pattern
this sprint has already used more than once). This consolidates and supersedes the
transaction-core work `docs/day-plans/remaining-work-2026-09-28.md` had split between "Hamza —
Transaction Core, Payments, Staff, and Integration" (running-check architecture, hold/resume,
split payments) and "Ahmed — Menu, Kitchen, and Intelligence" (kitchen SLA, combos) — both now
land under one owner. That doc's Bisma section (guest operations) is unaffected and still stands.

## A1. Open checks, hold/resume and cross-device receipt detail — 10 points — ✅ done

Branch: `feat/open-checks`.

Delivered:

- `supabase/migrations/202609280002_open_checks.sql`: `open_checks` / `open_check_items` /
  `open_check_item_modifiers`, store-scoped, versioned (`version` column, optimistic
  concurrency), with a partial unique index enforcing at most one open check per table. Applied
  to the configured database; recorded in `supabase/migrations/APPLIED.md`.
- `apps/api/src/routes/open-checks.ts`: create, list (resume), detail, versioned full-replace
  edit, void, and an idempotent close-to-paid-order endpoint. Close reuses the exact order/kitchen
  ticket/payment/loyalty/stock creation path a normal register sale already uses — extracted from
  `orders.ts`'s `push()` into a shared, exported `createPaidOrder`, so an open check becomes a
  real sale through the same code, not a second implementation of it.
- `apps/api/src/routes/orders.ts`: new `GET /orders/:id` (and `/pos/orders/:id`) — server-backed
  order/receipt detail so a manager (or, on the terminal router, an unlocked cashier terminal in
  the same store) can view or reprint a check closed on a different device. Reads only the
  snapshot fields captured at checkout time, same as the existing local-Dexie receipt reader.
- `packages/domain/src/open-check.ts`: pure open/closed/voided status-transition rules.
- Web: `apps/web/src/lib/open-checks.ts` client, `pos-store.ts`'s `activeCheckId`/
  `activeCheckVersion`/`loadCheckIntoCart`, a Hold button and Resume entry point on
  `RegisterScreen`, a new `OpenChecksScreen` (list/resume/void), `PaymentScreen`'s "Close check"
  now saves-then-closes the active open check when one is being edited, `TableCard`/`FloorScreen`
  show a table's live open-check total instead of only its last completed order, and
  `ReceiptScreen`/`OrderHistoryScreen` fall back to the new cross-device endpoint when a check
  isn't in this browser's local Dexie.

Acceptance, verified:

- A held check survives reload and terminal restart (server-durable; resumed via `GET
  /open-checks`/`GET /open-checks/:id`) and can be resumed from an authorized terminal.
- Two simultaneous close attempts produce one paid order, one inventory effect, one receipt —
  proved directly against PGlite in `apps/api/src/routes/open-checks.test.ts` (a `for update` row
  lock plus a status check, not just operation-id deduplication, since the two attempts may not
  share an operation id).
- Holding, editing or voiding a check never touches KDS, stock, or loyalty — only closing does,
  exactly as a normal sale already did.
- Cross-store reads/writes are rejected (tested); an unauthorized-device terminal session is
  rejected by the existing `requireCashierTerminal`/`requireStoreMember` gates, reused unchanged.
- `pos_orders` was never made mutable — `open_checks` is a wholly separate, new table; a check
  only ever becomes a `pos_orders` row at close, through the unchanged `createPaidOrder` path.

Known, explicit limitations (not silently dropped):

- **Open-check mutations are online-only**, not queued through the existing Dexie/outbox
  offline-sync mechanism (see `apps/web/src/lib/open-checks.ts`'s header comment). This mirrors
  an existing precedent in this codebase — Floor's table-status transitions
  (`updateTableStatus` in `lib/floor.ts`) are also plain online calls, not outboxed — on the
  reasoning that a check's whole point is to be resumable from a *different* terminal, so its
  source of truth has to be the server. If the network is down, create/edit/void/close simply
  fail with a clear message rather than silently queuing; "network loss" tolerance for an
  *already-created* check means it safely stays resumable once connectivity returns, not that an
  edit made while offline is queued for later delivery. Extending this to true offline queuing
  (its own idempotency/lease design, mirroring `order-sync-core.ts`) is real follow-up work, not
  done here.
- **No kitchen firing while a check is open.** Per this task's own acceptance line ("KDS ...
  affected only at their documented transition, never merely because a check was held"), the
  documented transition for A1 stays the same one push() already used: the kitchen ticket is
  created at close/payment time, identically to today. Firing food to the kitchen *before*
  payment (so cooking can start while the check is still open) is explicitly A3's job
  (course-based firing) — it needs its own schema change (`kitchen_tickets` currently has
  `unique(store_id, order_id)`, one ticket per *order*, which cannot represent multiple fires
  against a not-yet-paid check) and shouldn't be improvised into A1's migration.
- **Cross-device receipt viewing is read-only.** A manager can view/reprint a check closed on
  another device; refunding one is not wired to the remote-fetched path yet (`ReceiptScreen`'s
  refund action still requires the order to already be in local Dexie) — a small, separate
  follow-up, not a money-correctness gap (the refund endpoint itself is unchanged and still
  store/manager-scoped correctly).
- **No automated browser/E2E test** for the new UI flows (Hold → Resume → Close, Floor's open
  check total, the receipt cross-device fallback) — covered by the PGlite-backed API tests and a
  manual walkthrough, not a Playwright script. Flagged per `RULES.md` §6/§13, not hidden.
- No screenshots were captured for this pass (390px/tablet/desktop) — the existing screens
  (`RegisterScreen`, `FloorScreen`, `PaymentScreen`) only gained small additive UI (a Hold button,
  a resume link, an open-check total), reusing existing Ember components (`Button`, `Dialog`,
  `PageHeader`, `EmptyState`, `StatusBadge`) throughout; the one genuinely new screen
  (`OpenChecksScreen`) follows the same card-grid pattern already established by
  `FloorScreen`/`TableCard`.

Manual verification performed: `cd packages/domain && npm test` (62/62), `cd apps/api && npm run
build && npm test && npm run test:integration` is unrun here (needs a live DB fixture outside
this pass's scope; `npm test`/`npm run test:orders` — 3/3 and 68/68 — do cover the new code, both
directly via `open-checks.test.ts` and indirectly since the full existing suite still passes
after the `orders.ts` refactor), `cd apps/web && npm test && npx tsc --noEmit -p
tsconfig.app.json && npm run build` (52/52, clean, clean). No interactive browser walkthrough was
performed in this pass — flagged above, not claimed.

## A2. Split settlement, tips and refund allocation — 10 points — not started

Branch: `feat/split-settlement`. Dependency: A1's contract (this document) is the approval this
task was waiting on.

## A3. Kitchen operations depth — 8 points — not started

Branch: `feat/kitchen-operations`.

## A4. Sellable combos and variants — 8 points — not started

Branch: `feat/menu-combos-variants`.

## A5. Ahmad-owned regression and Ember QA — 4 points — ongoing

Branch: each feature branch, not one broad cleanup PR (per the task's own instruction). A1's own
regression pass is the "Manual verification performed" section above; a dedicated pass across all
four feature branches happens once A2-A4 exist to regress against.
