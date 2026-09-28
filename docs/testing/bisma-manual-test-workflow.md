# Manual test workflow — Bisma's merged modules (2026-09-29)

Covers the five PRs merged into `develop` this weekend under Bisma's ownership
(`docs/day-plans/final-application-work-split.md`'s B1–B5): reservations/waitlist,
purchasing & vendors, customer-profile tools, delivery/rider, and staff timekeeping (breaks +
payroll export). Each section is a click-through you can run yourself against a real dev store.
Screen names, button labels, and routes below are copied from the actual component source, not
from the PR descriptions.

Prerequisites: one store with at least two floor tables, one **owner/manager** web login
(`/login`), and one **cashier terminal** device unlocked with an employee PIN signed in
(`/pos/login`) for the terminal-side checks. A few steps need a second employee with the `rider`
role — create one from **Settings → Employees** first if you don't have one yet.

---

## 1. Reservations & Waitlist

Lives inside the existing Floor screen, not a separate page — owner/manager at **Floor & Tables**
(`/floor`), waiter terminal at `/pos/floor`. Look for the **"Reservations & Waitlist"** panel.

1. Click **New reservation** → fill guest name, phone, party size, expected time, optionally
   assign a table now → **Save**. Confirm it appears under the "Reservations" column with status
   `booked`.
2. Click **Add waitlist** → same form, labelled "Arrival time" instead of "Expected time" → Save.
   Confirm it appears under "Waitlist" with status `waiting` and a live "N min waiting" counter.
3. On the reservation, click **Arrive** → status should move `booked` → `arrived`. (Waitlist
   entries have no Arrive button — only reservations do.)
4. Select a free table on the floor plan, then on the arrived reservation (or a waiting entry)
   click **Seat** → confirm the table flips to occupied and the booking disappears from both
   lists. If no table is selected first, the Seat button should be disabled with the tooltip
   "Select a table or assign one first."
5. Create a second waitlist entry and click **No-show** on it → confirm it drops out of the
   active list (don't expect a "cancelled" list view — just confirm it's gone and doesn't
   reappear on refresh).
6. Create a third entry and click **Cancel** → same check.
7. **Known automated-test gap (flagged in the current plan, not yet closed):** there is no
   HTTP-level test that seats a booking twice with the same idempotency key, or from a different
   store's session, even though the code path (`seat()` → `applyTableStatusTransition`, row-locked,
   replay-safe by inspection) looks correct. Worth doing once by hand: seat the same booking twice
   in a row (double-click, or retry after a slow network) and confirm the table doesn't end up in
   a broken state or double-decrement anything.

## 2. Staff timekeeping — breaks and payroll

Clock/break controls live in the cashier terminal topbar (visible on every `/pos/*` screen, not
a separate page); the report is on the owner/manager side.

1. On the cashier terminal, sign in as an employee (`/pos/login`) and confirm the topbar shows a
   **Clock In** button. Click it → button becomes **Clock Out** (styled as clocked-in).
2. Once clocked in, a break control appears next to it: two buttons, **Paid Break** and
   **Unpaid Break**. Click **Paid Break** → it collapses into a single **End Paid Break** button.
3. Click **End Paid Break** → back to the two-button choice.
4. Regression check for the bug fixed today (`apps/api/test/timekeeping-breaks.test.ts`): this
   can't be triggered by clicking once, but if you have two terminal tabs signed in as the same
   employee, click **Paid Break** on both at nearly the same time — exactly one should succeed;
   the other should show an error mentioning "break is already in progress," never a
   payment/receipt-flavored error message.
5. Clock out (**Clock Out**). Confirm the button reverts to **Clock In**.
6. As owner/manager, go to **Reports → Hours** tab. Confirm the employee you just clocked
   in/out appears with a row under "Hours worked," with non-zero **Hours**, and paid/unpaid break
   columns reflecting what you just did. "On shift now" / "Closed shifts" KPI tiles at the top
   should match.
7. Click **Correct…** next to an employee's row while their shift is still open → a "Correct
   shift" dialog should require a reason before "Save correction" is enabled. Try saving without
   a reason — it should refuse ("A reason is required for every correction.").
8. Click **Export payroll CSV** → confirm a CSV file downloads and opens with sensible per-employee
   totals for the selected date range.

## 3. Customer-profile tools (CRM)

Owner/manager at **Guests** (`/customers`); the same screen also opens at `/pos/customers` for
the cashier terminal register-side guest picker.

1. Create or open an existing guest, click **View profile**.
2. Under **Favorites & preferences**, add one of each: pick "Favorite" from the dropdown, type a
   label (e.g. "Extra spicy"), Save; then "Preference (allergy, seating, etc.)" with a label like
   "Peanut allergy" plus a note. Confirm both show in the list, favorites marked with a ★.
3. Remove one of them and confirm it disappears from the current list (the history view below it
   should still show the add + remove as separate attributed events — that's the point of this
   module, it's an immutable log, not just an edit-in-place field).
4. Back at the register/guest picker (cashier terminal), pick this same guest and confirm the
   compact favorites/preferences summary line shows up next to their name.
5. On the profile, click **Deactivate guest** → confirm the button flips to **Reactivate guest**
   and the guest no longer appears in an active-guest search from the register picker. Reactivate
   it again and confirm it's searchable again.
6. Create a second, throwaway guest profile for a merge test. On the throwaway guest's profile,
   click **Merge into another guest…**, search for and pick your main guest as the target, type a
   reason (required — try submitting blank first, it should refuse), then **Confirm merge**.
   Confirm: the throwaway guest is now deactivated, its past orders/loyalty balance now show
   under the main guest, and repeating the exact same merge action again doesn't double-count the
   balance (the idempotent-retry guarantee — safe to actually click twice to check).

## 4. Purchasing & vendors

Owner/manager only, at **Purchasing** (`/purchasing`) — three tabs: **Purchase orders**,
**Vendors**, **Report**.

1. **Vendors tab** → **New vendor** → fill name/contact/terms → Save. Edit it once (click the
   vendor row) to confirm updates persist.
2. **Purchase orders tab** → **New purchase order** → pick the vendor you just made, add one or
   more ingredient lines with quantity and unit cost → Save. It should land in the list with
   status **Draft**.
3. Open it, click **Send to vendor** → status flips to **Sent**, and "Send to vendor" disappears
   (replaced by **Receive stock**).
4. Click **Receive stock** → a receiving form opens showing each line's ordered vs. received-so-far
   quantity. Receive a partial quantity on one line only, submit → status should become
   **Partially received**, and the line you didn't touch should still show as open.
5. Open **Receive stock** again and receive the remainder → status becomes **Received**, and the
   receiving form's open-lines list should now be empty (nothing left to receive).
6. Check **Inventory** separately — the ingredient(s) you received should show increased stock,
   and their stock ledger should list this purchase-order receipt as a line item (this is the
   "real insert-level idempotency" the audit checked — the numbers should match exactly what you
   received, once, not doubled).
7. Create a second purchase order, send it, then click **Cancel order** — confirm the browser
   confirmation text warns that already-received stock (from other orders) is never reversed, and
   that a cancelled order can't then be sent or received.
8. **Report tab** → confirm vendor spend and cost-variance figures reflect the orders you just
   ran through steps 2–7.

## 5. Delivery & rider

Dispatch (owner/manager) is at **Dispatch** (`/delivery`, under the "Operate" nav group). The
rider-facing screen is a separate terminal route (`/pos/delivery`) reachable only by signing in
to a terminal device as an employee with the **rider** role.

**Read this before you start:** placing a real "Delivery" order end-to-end through the Register
screen does **not currently work**. The Register's order-type selector does have a **Delivery**
option, and it's wired into `orderType` state, but the checkout code
(`apps/web/src/lib/checkout.ts`) never collects or sends the recipient name / phone / address that
the API requires for a delivery order (`apps/api/src/routes/orders.ts` throws
`validation_failed` — "recipient_name must be 1-120 characters" — the moment `order_type` is
`delivery` and no `delivery` object is attached). This is a genuine, currently-shipped gap, not a
test-environment quirk — there's no address-capture dialog anywhere in the Register flow yet. Use
one of these instead to get a delivery order onto the board so you can test Dispatch/Rider:

- Run the existing test/seed path: `apps/api/src/routes/delivery.test.ts` shows the exact request
  shape (`recipient_name`, `contact_phone`, `address`, optional `delivery_instructions` inside an
  order's `delivery` object) if you want to POST one by hand with `curl`/Postman against a running
  dev API.
- Or treat this as a known blocker and test Dispatch/Rider purely against whatever delivery order(s)
  already exist in your dev database from earlier testing/seed data.

Once you have at least one delivery order to work with:

1. On **Dispatch**, confirm the order appears with status **Pending**, its recipient/phone/address,
   and an **Unassigned** rider dropdown. Confirm the status KPI tiles across the top (Pending /
   Accepted / Picked up / Out for delivery / Delivered / Failed / Avg time to delivered) are
   present and update as you go.
2. Assign it to your rider-role employee from the dropdown.
3. On the terminal device, sign in as that rider employee at `/pos/delivery`. Confirm you land on
   **"My deliveries"** and see exactly this one order (not any other store's or rider's) — no
   financial totals should be visible on this screen, only receipt/recipient/address/instructions.
4. As the rider, work it through the lifecycle one button at a time: **Accept delivery** → **Mark
   picked up** → **Start delivering** → **Mark delivered**. After each click, confirm the status
   badge updates immediately on the rider screen, and that Dispatch (refresh or wait ~20s for its
   poll) shows the same status.
5. Create/seed a second order, assign it to the same rider, and this time click the manual **Fail**
   action if present, or use Dispatch's own force-status control with a reason — confirm a failure
   reason is required and gets recorded, and that the delivery ends in **Failed** rather than
   silently vanishing.
6. Conflict check: open the same delivery in two terminal tabs (or Dispatch + rider terminal at
   once), advance it from one, then try to advance it again from the other still showing the old
   status — confirm you get a clear "this delivery changed since it was last loaded" message
   rather than a silent overwrite or a crash, and that the screen then shows the true current
   status once you retry.
7. Confirm a **non-rider** employee (e.g. a waiter or cashier) cannot reach `/pos/delivery` at all
   on a terminal device — this closes the gap a real fixup commit (`cc793ee`) already fixed, where
   any role with the `delivery` capability (managers included) could previously pass the gate
   instead of only the `rider` role itself.

---

## What this workflow does not cover

Anything already listed as explicitly deferred in `docs/MODULE_STATUS.md` — true open
tabs/hold-resume, split-tender settlement, tips, kitchen SLA/course-firing, combos — since none of
that shipped this weekend and isn't part of Bisma's merged scope. If everything above checks out,
the honest remaining risk in her slice is the delivery-checkout gap in Section 5 and the
reservations `seat()` idempotency test gap noted in Section 1 — both are already tracked, not new
surprises.
