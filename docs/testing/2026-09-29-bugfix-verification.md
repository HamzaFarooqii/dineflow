# Manual verification — 2026-09-29 bug-fix and UX pass

This covers only what changed in today's follow-up pass (see
`docs/day-plans/2026-09-29-session-summary.md` for the full list). It's meant to be run *in
addition to* the three per-person workflows in this folder, not instead of them — those still
cover the underlying features; this covers what got fixed on top.

**Important:** this pass was verified with typecheck and a production build only, not the full
automated test suite or a browser click-through (an explicit instruction, to conserve session
limits). Every step below is genuinely unverified until you run it yourself.

---

## 1. Food Cost report no longer crashes

1. Go to **Reports → Food cost** tab. Confirm the report loads normally (KPI tiles + a dish table),
   not a blank/black screen.
2. Go to **Menu** (`/products`). Confirm every dish with a recipe shows a "Food cost X%" link under
   its price, not a blank area or a crashed screen.
3. **To actually exercise the fix** (optional, needs a deliberately bad recipe): if you can edit a
   recipe line's quantity to `0` directly in the database (not through the UI — the editor itself
   still correctly blocks a zero/negative quantity), reload Food Cost and the Menu list. That one
   dish should now show **"Recipe needs review"** / an "Incomplete" badge instead of taking down
   the whole screen.

## 2. Hours report totals now match the payroll CSV

1. Clock an employee in, take a **paid** break and an **unpaid** break of different lengths, end
   both, then clock out.
2. Go to **Reports → Hours**. Note the employee's **Hours** column value.
3. Click **Export payroll CSV** and open it. Find that employee's row — compare `net_paid_minutes`
   (converted to hours) against the on-screen **Hours** value.
4. Confirm they now match. Before this fix, the on-screen number was higher than the CSV's by
   exactly the unpaid break duration.

## 3. Delivery orders can be created through Register

1. At **Sell**, select **Delivery** as the order type. Confirm a new form appears: **Recipient
   name**, **Phone**, **Delivery address**, **Note for the rider (optional)**.
2. Try **Proceed to payment** with these fields empty — confirm it's blocked (same as the existing
   guest-required gating).
3. Fill in a name, a phone number (with country code), and an address. Confirm **Proceed to
   payment** becomes available.
4. Complete the sale (cash, exact amount, close check).
5. Go to **Dispatch** (`/delivery`). Confirm the order you just placed appears with status
   **Pending**, showing the recipient/phone/address you entered.
6. Assign it to a rider and confirm the existing Dispatch/Rider workflow (see Bisma's manual test
   workflow, section 5) works against this order exactly as it would against a seeded one.
7. Back at Register, add an item and switch order type to **Delivery** again — click **Hold**.
   Confirm it's disabled with a tooltip explaining delivery orders can't be held yet (this is
   intentional — open checks have no column for delivery details today).

## 4. Combo/Modifier picker selection is now visible

1. At **Sell**, add a product that has modifiers configured (any existing modifier-enabled dish).
   Open its modifier picker and select an option. Confirm the selected option now shows a visible
   **orange border and light orange background**, and the checkbox/radio itself is orange-accented
   — not the browser's default blue, and not invisible.
2. If you have a combo configured, open its picker (see Ahmed's manual test workflow, section 4)
   and confirm the same visible selected-state now appears there too.
3. This was previously **completely invisible** — if you recall combo/modifier selection feeling
   unresponsive or confusing before, this is why.

## 5. Dispatch and Rider status colors

1. Go to **Dispatch**. Confirm each delivery's status badge now renders through the same rounded
   pill style used everywhere else in the app (Floor, Kitchen, Orders), not a differently-styled
   chip.
2. Cycle a delivery through a few statuses (Pending → Accepted → Picked up, etc. — see Bisma's
   workflow section 5) and confirm each status has a distinct, sensible color (pending = amber/
   warning, in-transit = info/blue-ish, delivered = green/success, failed = red/danger).

## 6. Vendors tab redesign

1. Go to **Purchasing → Vendors**. Confirm a header line shows "N active vendors" (and "M
   inactive" if any exist).
2. Confirm each vendor card now shows a small truck icon, and mail/phone icons next to the email
   and phone fields where present.
3. If you have no vendors yet (a fresh store), confirm you see a proper empty-state message
   ("No vendors yet... Add a vendor to start...") with an **Add your first vendor** button, not a
   bare one-line hint.

## 7. Purchasing receive confirmation

1. Go to **Purchasing → Purchase orders**, open an order in **Sent** or **Partially received**
   status, click **Receive stock**, enter a quantity, and submit.
2. Confirm a confirmation message now appears: "Stock received and recorded against each
   ingredient's balance and stock ledger." with a **View in Inventory →** link.
3. Click that link and confirm the ingredient's stock actually increased (it always did — this
   step just confirms the new visibility, not new behavior).

## 8. Dashboard "what's new" module strip

1. Go to the owner **Dashboard**. Below the Floor pulse / Kitchen tickets row, confirm a new row of
   5 compact cards: **Open checks held**, **Reservations & waitlist**, **Deliveries in progress**,
   **Purchasing**, **Guests**.
2. Confirm the first three show a real live number (0 is fine if nothing's open) rather than a
   dash, once the page has loaded fully.
3. Click each card and confirm it navigates to the right screen (Open Checks, Floor, Dispatch,
   Purchasing, Guests respectively).
4. Hold a check, then return to Dashboard — confirm the "Open checks held" count increases within
   ~30 seconds (the panel refreshes on the same interval as Floor/Kitchen pulse already did).

---

## What this doesn't cover

Everything in `docs/day-plans/final-application-work-split.md`'s existing backlog, and the
already-documented combo/kitchen and combo/open-checks integration gaps (unchanged today, see the
session summary). If any step above doesn't behave as described, that's genuinely new information
this session didn't have — the whole point of asking you to run this by hand.
