# API authorization matrix (Day 1, API security)

Source of truth for what each terminal/owner endpoint requires, produced while implementing
server-side role enforcement (`requireCashierCapability`, `packages/domain/src/staff-role.ts`'s
`roleHasCapability`) and online manager approval (`apps/api/src/terminal-auth/manager-approval.ts`).
Read the actual role/capability matrix in `packages/domain/src/staff-role.ts` rather than trusting
a copy of it here going stale — this file names *which* capability each endpoint requires and why,
not the capability-to-role mapping itself.

Legend: **Auth** = who can call it at all. **Capability** = the terminal-role capability required
in addition to a valid session (`-` means none — every logged-in role passes). **Tenant check** =
how cross-store access is prevented. **Sync** = whether the endpoint participates in offline
replay/historical sync (and therefore cannot have an interactive-only role check applied blindly).

## Floor (`floor.ts` / `terminalFloorRouter`)

| Endpoint | Auth | Capability | Tenant check | Sync |
|---|---|---|---|---|
| `GET /pos/floor` | Terminal session | `floor` | `session.storeId === storeId` | Interactive only |
| `PATCH /pos/floor/tables/:id/status` | Terminal session | `floor` | same | Interactive only |
| `PATCH /pos/floor/tables/:id/transfer`, `/merge` | Terminal session | `floor` | same | Interactive only |
| `PATCH /floor/tables/:id/status` (manager-only transitions incl. `ordering→served`) | `requireStoreManager` | owner/manager | `store_memberships` | n/a |
| Floor structure CRUD (`/floor/areas`, `/floor/tables`) | `requireStoreManager` | owner/manager | `store_memberships` | n/a |

A plain `cashier` never calls the terminal Floor endpoints in the shipped UI (`RegisterScreen`
receives an already-assigned table from Floor's own "Add order" action; confirmed by inspection —
no `lib/floor.ts` import in `RegisterScreen.tsx`), so gating to `floor` does not regress checkout.

## Kitchen (`kitchen.ts` / `terminalKitchenRouter`)

| Endpoint | Auth | Capability | Tenant check | Sync |
|---|---|---|---|---|
| `GET /pos/kitchen/tickets` | Terminal session | `kitchen` | storeId match | Interactive only |
| `PATCH /pos/kitchen/tickets/:id/items/:itemId` | Terminal session | `kitchen` | storeId match | Interactive only |
| `POST /pos/kitchen/tickets/:id/courses/:course/fire`, `/hold` | Terminal session | `kitchen` | storeId match | Interactive only |
| `GET /pos/kitchen/stations/summary` | Terminal session | `kitchen` | storeId match | Interactive only |
| `GET /kitchen/tickets/history` | `requireStoreManager` | owner/manager | `store_memberships` | n/a |

## Inventory (`inventory.ts` / `terminalInventoryRouter`)

| Endpoint | Auth | Capability | Manager authority | Tenant check |
|---|---|---|---|---|
| Reads (`GET .../ingredients`, `/batches`, `/movements`, `/summary`) | Terminal session | `inventory` | — | storeId match |
| Writes (create/update/deactivate/reactivate ingredient, receive batch, record wastage) | Terminal session | `inventory` | **Preferred:** `manager_approval_token`, verified live via `consumeManagerApproval` against a PIN checked moments ago by the server. **Legacy fallback (documented gap, see below):** client-supplied `manager_id` + `manager_approved_at` — existence-checked only, never proves a PIN was entered for *this* action. | storeId match |
| Owner/manager web writes | `requireStoreManager` | owner/manager | n/a (the signed-in user is both actor and authority) | `store_memberships` |

**Known, explicitly-flagged limitation:** inventory writes are online-only (no offline queue —
`requireTerminalWriter` always does a live DB round-trip), so requiring `manager_approval_token`
outright would have been the clean fix. It isn't yet hard-required because the shipped Inventory
screens (`InventoryScreen.tsx`, `WastageForm.tsx`, `ReceiveStockForm.tsx`, `InventoryDetailHeader.tsx`)
still send the legacy `manager_id` + `manager_approved_at` fields and don't yet call
`POST /pos/manager-approvals`. Both paths are accepted so the feature keeps working; closing the
gap for good means updating those four files to request a token instead. **This is the top
follow-up item from this PR**, not a hidden or silently-ignored gap.

## Open checks (`open-checks.ts` / `terminalOpenChecksRouter`)

| Endpoint | Auth | Capability | Tenant check | Sync |
|---|---|---|---|---|
| Create / list / get / edit / void / close | Terminal session | `register` | storeId match | **Online-only by design** (MODULE_STATUS.md row A) — no offline-replay case to preserve |
| Manager approval on edit (discount over the cashier's own authority) | same session | — | Same token-or-legacy-fallback pattern as inventory, via the new `resolveManagerApproval` helper | n/a |
| `voided_by_employee_id` | — | — | **Fixed this PR:** now always `access.employeeId` (the authenticated session), never the client-supplied body field — see "Actor attribution fixes" below | n/a |

## Orders (`orders.ts` / `terminalOrdersRouter`)

| Endpoint | Auth | Capability | Tenant check | Sync |
|---|---|---|---|---|
| `POST /pos/orders/push` | `requireDeviceTerminal` always; `requireCashierCapability(..., 'register')` **additionally**, only when a live cashier session exists | `register`, interactive-only | storeId match | **Yes — device-only replay of a queued offline sale must keep working after logout.** A 401 (no active session) falls through to the historical path unchanged; a 403 (wrong role) is a hard rejection, never silently downgraded to "treat as historical." |
| `GET /pos/orders/:id` (receipt detail) | Terminal session | `register` | storeId match | Interactive only |
| `POST /orders/:id/refund` | `requireStoreManager` | owner/manager | `store_memberships` | n/a — **unchanged**, no terminal route exists for refunds |
| Employee attribution on push | — | — | **Unchanged, already correct:** a live cashier session's own id always overrides a client-supplied `employee_id`; a device-only push falls back to the client value with a best-effort existence check. Proven by the existing `orders-employee-attribution.test.ts`. |

**Documented limitation (register/checkout discount approval):** a discount approved while the
terminal is genuinely offline is verified client-side against a cached PIN verifier
(`ManagerApprovalModal`/`verifyOffline`) and travels as `manager_id` + `manager_approved_at` —
this is historical, client-asserted evidence, not independently provable by the server, and stays
that way here. Making this fully server-verified would require a larger protocol change (e.g.
queuing the approval itself for later online verification) that is out of scope for this task;
flagging it rather than claiming it's solved, per this task's own instruction.

## Customers / customer profile / loyalty / promotions (checkout-adjacent reads)

| File | Endpoint(s) | Capability | Why |
|---|---|---|---|
| `customers.ts` | `GET /pos/customers` (search), `GET /pos/customers/:id/summary` | `register` | Guest lookup during checkout |
| `customers.ts` | `POST /pos/customers/push` | — (device-only, `requireDeviceTerminal`) | **Unchanged** — named alongside order upload in the offline constraint; no active-employee concept to gate |
| `customer-profile.ts` | `GET /pos/customers/:id/preferences` | `register` | Same checkout-adjacent reasoning; writes/merge stay owner/manager-only, unchanged |
| `loyalty.ts` | `GET /pos/loyalty/tiers`, `/accounts/:id`, `/accounts/:id/ledger`, `/reward-rules`, `POST /accounts/:id/enroll` | `register` | Balance lookup before checkout |
| `promotions.ts` | `GET /pos/promotions` | `register` | Applying a promotion at checkout |

## Reservations / waitlist (`reservations.ts`)

| Endpoint | Capability | Why |
|---|---|---|
| All terminal routes (list, create, update, arrive/cancel/no-show, seat) | `register` | **Evidence-based choice, not guessed:** `reservations-seat.test.ts` already has a plain `cashier` role seating a reservation through this exact path and asserts success — gating to `floor` (my first instinct, since `seat()` calls `floor.ts`'s `applyTableStatusTransition`) would have silently broken that shipped, tested behavior. `register` (cashier/waiter/manager) matches the demonstrated intent. |

## Delivery (`delivery.ts`) — already correct, no change needed

Rider-only terminal routes (`GET /pos/delivery/mine`, `PATCH /pos/delivery/:id/status`) already had
their own `requireRiderTerminal` role check before this PR (closed in a prior `cc793ee` fixup).
Simplified this PR to read the role off `requireCashierTerminal`'s own result (see below) instead
of a second query — a reuse cleanup, not a behavior change.

## Shifts / timekeeping (`shifts.ts`, `timekeeping.ts`) — deliberately ungated, unchanged

Clock-in/out and break start/end have **no capability gate**, by explicit existing design
(`shifts.ts`'s own header comment: "every terminal role can clock in/out"). Confirmed still true
after this PR by `terminal-role-authorization.test.ts`'s clock-in loop over all six roles. Manager
corrections and CSV export remain owner/manager-only (`requireStoreManager`), unchanged.

## Catalog (`catalog.ts`) — out of scope, flagged

`catalog.ts`'s terminal route also calls the old `requireCashierTerminal` with no capability check.
It was not in this task's inspected file list and touching it risked scope creep into an
unreviewed file; flagging here as a follow-up rather than silently leaving it undocumented.

## The shared guard

`requireCashierCapability(req, pool, capability)` (`apps/api/src/terminal-auth/routes.ts`) wraps
`requireCashierTerminal` (which now also returns the session's server-verified `role`, read fresh
from `terminal_employees` on every call — never a client-supplied value) and checks
`roleHasCapability(session.role, capability)`, throwing `403 authorization_failed` on a miss. Every
route above that previously called `requireCashierTerminal` alone and treated "some employee is
logged in" as sufficient now calls this instead wherever the action is role-sensitive, not just
store-sensitive.

## Manager approval: the new online-verified mechanism

`POST /pos/manager-approvals` (`apps/api/src/terminal-auth/manager-approval.ts`): a manager types
their own PIN on the terminal, without switching the active cashier session, verified against the
same PBKDF2 primitive `/auth/login` uses. Returns a single-use, 2-minute token bound to
`{store, device, action, payload_hash}` (new `public.terminal_manager_approvals` table,
`202610010001_terminal_manager_approvals.sql`). `consumeManagerApproval` redeems it, recomputing
the payload hash server-side from data the caller already holds — never trusting a client-supplied
hash — and marking it consumed in the same statement it reads it (replay-proof). PIN lockout
mirrors `/auth/login`'s (5 attempts, 60-second lock), reusing `terminal_employees.failed_attempts`/
`locked_until`, and the PIN itself is never logged or stored.

## Actor attribution fixes (client-provided identity was not authenticated identity)

- **Open-check void** (`open-checks.ts`): `voided_by_employee_id` was read directly from the
  request body — a forged value could attribute a void to any employee, or none. Now always
  `access.employeeId`, the value `requireCheckAccess` derived from the authenticated session.
  Regression-tested in `terminal-role-authorization.test.ts`.
- **Order push employee attribution** (`orders.ts`): already correct before this PR — verified,
  not re-derived, via the existing `orders-employee-attribution.test.ts`.
