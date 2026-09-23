# Day 2 — Orders + Front of House + Kitchen (DRAFT — pending Team Lead review)

Implementation day 1 of 4 (Day 1 was setup only). Core relationship being built:
**Table → Order → Kitchen → Service**. Follow `docs/day-plans/_workflow.md` for every git and
migration step below — it isn't repeated here.

Right now: choosing an order type at the register does nothing after checkout, `/kitchen` is
still a placeholder, and every table sits frozen at `available`. By the end of today none of
that is true.

---

## Team Lead — your tasks today

Your job today is **review and merge only** — you are not writing schema or feature code.

1. Confirm `develop` is up to date and tell Ahmed and Bisma to branch from it (they each pull
   it themselves per `_workflow.md`).
2. When Ahmed's PR (`feature/day2-ahmed-kitchen-orders`) is open, review against his checklist
   below.
3. When Bisma's PR (`feature/day2-bisma-table-service`) is open, review against her checklist
   below.
4. **Merge order matters:** merge Bisma's first (Ahmed's register code reads the table context
   her branch introduces), then pull `develop` again before reviewing/merging Ahmed's so you can
   test his against her already-merged work, not against his own branch in isolation.
5. After both are merged, run `docs/10_test_workflow.md` in full against `develop` itself — the
   one thing neither branch could test alone is a dine-in order placed from a real table
   actually creating a ticket and moving that table's status.
6. Push `develop`. Tell both to pull it before starting Day 3.

**Ahmed's PR checklist:**
- [ ] `order_type` and `table_id` actually reach `pos_orders` (check a row after a real checkout)
- [ ] a kitchen ticket + one ticket item per order line is created, grouped by `station_id`
- [ ] an order item with no `station_id` still gets a ticket item, not a silent drop
- [ ] `/kitchen` shows real tickets and the status buttons actually call the API
- [ ] `RegisterScreen.tsx`'s checkout/discount/manager-approval logic is untouched otherwise
- [ ] his migration has an `APPLIED.md` row

**Bisma's PR checklist:**
- [ ] table status actually changes in the DB when the UI buttons are used, not just visually
- [ ] the transition endpoint rejects an invalid status jump (e.g. `available` straight to
  `dirty`), not just an arbitrary value
- [ ] the four Day 1 buttons are either wired for real or still disabled — nothing half-wired
- [ ] waiter name shows on `TableCard` once assigned
- [ ] her migration has an `APPLIED.md` row

---

## Instructions for Ahmed — Order Persistence + Kitchen Display System

**Branch:** `feature/day2-ahmed-kitchen-orders`

### 1. Migration (yours to write and apply)
Add to `pos_orders`: `order_type text` (values: `dine_in`/`takeaway`/`delivery`, matching
`packages/domain/src/order-type.ts` — don't invent new values), `table_id uuid references
restaurant_tables(id)` (nullable — only set for dine-in). Create `kitchen_tickets` (id, store_id,
order_id → `pos_orders`, table_id nullable, status, created_at) and `kitchen_ticket_items` (id,
ticket_id, order_item_id → `pos_order_items`, station_id → `kitchen_stations`, status, fired_at,
ready_at, served_at). Ticket-item status: `queued → preparing → ready → served` (+ `cancelled`).
Add the matching shared contract `packages/domain/src/kitchen-ticket-status.ts` (union + labels
+ tone), same pattern as `table-status.ts`. This migration only references Day 1 tables — no
dependency on Bisma's work, apply it whenever you're ready.

### 2. Persist order type and table
Include the register's `orderType` (already in `usePosStore` from Day 1) in the checkout
payload; the orders API stores it. For the table id: Bisma's Day 2 work sets an
`activeTableId`-style field somewhere the register can read when it was opened from her "Add
order" button — **this one field in `apps/web/src/lib/pos-store.ts` is a shared touch-point**;
keep your addition to it to a single small field, and if you get a trivial merge conflict there
against Bisma's branch, that's expected, not a bug. Don't build a table-picker inside the
register itself — that duplicates what the Floor screen already does.

### 3. Kitchen ticket creation
On order placement, create the ticket + one item per order line, grouped by the item's
`station_id` from Day 1's `pos_products` columns.

### 4. Kitchen Display System screen
Replace the `/kitchen` placeholder in `App.tsx` with a real `KitchenScreen`
(`apps/web/src/screens/kitchen/`, mirror `screens/floor/`'s structure). Cards grouped/filterable
by station: order/table reference, items, elapsed time, and controls to advance
`queued → preparing → ready → served` via the shared contract.

### 5. Kitchen ticket API
`GET /kitchen/tickets?store_id=…` (+ `/pos/kitchen/tickets` terminal variant, mirror
`apps/api/src/routes/floor.ts`'s pattern exactly) and
`PATCH /kitchen/tickets/:id/items/:itemId`.

### Files you may touch
`apps/api/src/routes/kitchen.ts` (new), `apps/api/src/app.ts` (register the route),
`apps/web/src/screens/kitchen/` (new), `apps/web/src/lib/kitchen.ts` (new),
`apps/web/src/lib/pos-store.ts` (the one small addition above), `apps/web/src/App.tsx` (swap the
`/kitchen` placeholder), `apps/api/src/routes/orders.ts` (accept `order_type`/`table_id`),
`packages/domain/src/kitchen-ticket-status.ts` (new), your migration file.

### Do not touch
`apps/web/src/screens/floor/`, `apps/api/src/routes/floor.ts`, `RegisterScreen.tsx`'s
discount/manager-approval code, `PaymentScreen.tsx`. If a fully-served ticket should flip a
table's status, call Bisma's status-update endpoint from your code — don't write to
`restaurant_tables` directly.

### Definition of done
A dine-in order placed from a table creates a real kitchen ticket, visible and advanceable on
`/kitchen`, grouped by station.

---

## Instructions for Bisma — Front of House Table Lifecycle

**Branch:** `feature/day2-bisma-table-service`

### 1. Migration (yours to write and apply)
Add `assigned_waiter_id uuid references terminal_employees(id)` (nullable) to
`restaurant_tables`. That's the only new column you need — Day 1 already added the `status`
column and its check constraint with every value this day's transitions use. Independent of
Ahmed's migration; apply whenever you're ready.

### 2. Real table status transitions
Wire real writes for the floor-controlled statuses: `available → seated` (host seats a party),
`seated → ordering` ("Add order" pressed), `* → bill_requested` ("Bill" pressed),
`bill_requested → dirty` (bill settled — this may end up triggered from the payment flow instead
of the floor; if so, flag it to the Lead rather than guessing), `dirty → available` (cleaned).
New `PATCH /floor/tables/:id/status` (+ terminal variant, mirroring your own `floor.ts`
patterns), validating the transition is one of the allowed ones — reject an arbitrary jump.

### 3. Enable the Day 1 action buttons
*Add order* → moves the table to `ordering`, sets the shared `activeTableId`-style field in
`apps/web/src/lib/pos-store.ts` (coordinate with Ahmed — see his Task 2), and navigates to the
register. *Bill* → `bill_requested`. *Transfer*/*Merge* need an existing open order, which only
exists once Ahmed's kitchen-ticket work is merged — if his isn't ready yet when you reach this,
leave these two disabled with an updated tooltip rather than half-wiring them; don't let it
block the rest of your day.

### 4. Waiter assignment
Show `assigned_waiter_id`'s name on `TableCard` in place of Day 1's "—" placeholder (you'll need
a small lookup against `terminal_employees` — reuse whatever the app already uses to display a
cashier/employee name elsewhere rather than writing a new one).

### 5. Link a table to its open order
Once Ahmed's order/table link is merged, `TableCard` and the detail panel should show the real
running total and elapsed time instead of "—". Don't fabricate these before the data exists.

### Files you may touch
`apps/api/src/routes/floor.ts`, `apps/web/src/screens/floor/`, `apps/web/src/lib/floor.ts`,
`apps/web/src/lib/pos-store.ts` (the one small addition above), your migration file.

### Do not touch
`apps/web/src/screens/menu/`, `apps/web/src/screens/kitchen/`, `RegisterScreen.tsx`'s cart/
checkout logic, `apps/api/src/routes/kitchen.ts`.

### Definition of done
A host can seat a party, send them to the register, and watch the table move through
`available → seated → ordering → bill_requested → dirty → available` for real, with a waiter
name and (once Ahmed's side is merged) a live order total on the card.
