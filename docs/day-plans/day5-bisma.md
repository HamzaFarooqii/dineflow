# Day 5 — Bisma's Work (Hand-off)

Written by Hamza for Bisma to execute independently. `FIVE_DAY_PLAN.md`'s original Day 5 sketch
already gave you the single largest scope of the sprint for one person (owner dashboard + customer
reporting + inventory reporting) and flagged that explicitly as the most likely place the plan
slips. Given that, this session's gap-filling pass deliberately added nothing new to your plate
except one closely-related item (Floor terminal mode, item 2 below) and a small addition to your
existing reporting scope (hours-worked, item 3) — everything else from the owner's review went to
Hamza or Ahmed instead, specifically so your day doesn't get heavier.

**Git ownership:** you run your own workflow end to end — branch, commit, push, open your own PR.
Branch name: `feature/bisma/day5-reports` (matches `FIVE_DAY_PLAN.md`'s original naming).

**Priority order if the day is tight** (per the original plan's own guidance, still true): owner
dashboard and customer/loyalty reporting first; inventory reporting can slip a day since it's the
newest module with the least existing report precedent to build from. Floor terminal mode (item 2)
is small and self-contained — do it whenever, it doesn't block or get blocked by the reports.

---

## 1. Owner Dashboard + Customer/Loyalty Reporting + Inventory Reporting

Unchanged from `FIVE_DAY_PLAN.md`'s original Day 5 sketch. The read-side data already exists:
`pos_orders`/`pos_order_items` for revenue, `loyalty_point_ledger` for loyalty activity,
`ingredient_batches`/`stock_movements` for wastage/expiry/low-stock. `reports.ts`'s existing
`loadDailySummary`/`loadOrdersPage`/`loadOversold` are the pattern to follow (timezone-correct,
tested against real Postgres via PGlite) — new report queries should match that shape rather than
introducing a different one.

---

## 2. Floor terminal mode (closes a real gap the "waiter" role review found)

**The gap:** while reviewing the new `waiter`/`chef`/`inventory_manager`/`rider` terminal roles
(`packages/domain/src/staff-role.ts`, landed this session), I found that `FloorScreen.tsx` has no
`terminal` mode at all — it only works from the owner/manager web app (`requireSupabase`-based),
even though the API is already ready for it (`terminalFloorRouter`/`/pos/floor`,
`fetchFloorPlan(storeId, terminal)` already takes a `terminal` flag in `apps/web/src/lib/floor.ts`
— you built that flag's plumbing yourself in an earlier day). This means a `waiter` role, once
created, has nowhere to go on the actual terminal to seat guests or manage tables — the one thing
that role most obviously needs.

**What to build:**
- Add a `terminal` prop to `FloorScreen.tsx` (`apps/web/src/screens/floor/FloorScreen.tsx`, 384
  lines — this is your own screen from Day 1/2, so you know its structure better than anyone).
  Branch store-id resolution the same way `RegisterScreen.tsx`/`InventoryScreen.tsx` already do:
  `terminal ? (await currentAccess())?.cache.device.store_id : ...` instead of
  `requireSupabase()`. Every write action already calls through `fetchFloorPlan`/
  `updateTableStatus`/etc. with a `terminal` flag those functions already accept — this is
  primarily about which auth path resolves the store id and which credentials mode
  (`credentials: 'include'` vs a bearer token) each fetch call uses, not new business logic.
  Area/table CRUD ("Edit floor" toggle) is arguably an owner/manager-only action even from a
  terminal — if you want to keep table *editing* manager-gated on a terminal (via the existing
  `ManagerApprovalModal` pattern Inventory already uses) while still letting a waiter *use* the
  floor (seat/add order/bill/settle/transfer/merge), that's a reasonable split; your call, since
  you know this screen's real usage pattern best.
- Add a `/pos/floor` route in `apps/web/src/App.tsx`, wrapped in `CashierTerminalRoute` +
  `CashierPosLayout`, same shape as every other `/pos/*` route.
- Add a "Floor" nav item to `CashierPosLayout.tsx`'s `navigation` array
  (`apps/web/src/terminal-auth/CashierPosLayout.tsx`) with `capability: 'floor'` — the capability
  matrix and `roleHasCapability` helper already exist and already gate the other nav items
  (Sell/Products/Orders/Customers need `'register'`, Inventory needs `'inventory'`); you're adding
  one more row using the same pattern.

**Acceptance:** an employee logged in with the `waiter` role sees a "Floor" tab (and "Sell", since
waiter also has the `register` capability) on the terminal nav, and it shows the real Floor screen
with working Seat/Add order/Bill/Settle/Clean actions.

---

## 3. Hours-worked report (small addition to your reporting scope)

**Context:** Hamza built the clock-in/out feature end to end this session (`shifts` table,
`POST /pos/shifts/clock-in`/`/clock-out`/`GET /pos/shifts/current` on the terminal, a `ClockButton`
in the cashier topbar) and `GET /shifts?store_id=&from=&to=` (owner/manager-gated) for reading the
raw rows — see `apps/api/src/routes/shifts.ts` and `apps/api/test/shifts.test.ts`. The report UI
itself was deliberately left to you, since it's naturally part of the same reporting work you're
already doing rather than a separate feature with its own owner.

**What to build:** a small "Hours worked" view (could live on the owner dashboard or as its own
report page, your call) reading `GET /shifts` for a date range, grouped by employee, summing
`clocked_out_at - clocked_in_at` for closed shifts (an employee still clocked in has no
`clocked_out_at` yet — show them as "on shift now" rather than a zero or a crash). No new schema or
API work needed; this is a read + aggregate + display task on top of what already exists.

---

**Documentation:** update `docs/MODULE_STATUS.md` row L (Reports) and row B (Front of House /
Tables) with your day's real end state, same as every prior day's closing step.
