# Manual test workflow — Hamza's slice (2026-09-29)

Covers Hamza's own plan items (H1, H5) that produced a real, click-through-able change: the core
POS loop end to end, the discount-stacking policy (verified, not newly built), and the sidebar
navigation fix. The rest of Hamza's slice (H2 browser-E2E-as-CI-gate, H3 perf/accessibility/
monitoring, H4 docs/runbook) is documentation or deferred infrastructure work with no UI surface
to click through — see `docs/MODULE_STATUS.md` for what those cover instead.

Prerequisites: same as the other two workflows — one store, one floor table, a menu item with a
real price, and a cashier terminal signed in at `/pos/login`.

---

## 1. The core POS loop, end to end

This is the same sequence `apps/api/test/core-loop-browser-check.ts` (`npm run
test:browser:core-loop`) drives automatically in a real headless browser — do it by hand once to
see it yourself; the automated version is what re-proves it on every future change.

1. **Floor**: at `/pos/floor`, click your table, then **Seat**. Confirm its status badge flips to
   **Seated**.
2. Click the table again, then **Add order**. Confirm you land on **Sell** (`/pos/register`) and
   the table is now in **Ordering** status if you check Floor from another tab.
3. **Register**: click a menu item to add it to the cart. Click **Select or add a guest
   (required)**, type a guest name, click **Save guest** — confirm the guest is now attached to
   the check.
4. Click **Proceed to payment**.
5. **Payment**: click **Cash**, click **Exact amount**, click **Close check**. Confirm you land on
   a receipt screen showing the order you just placed.
6. **Kitchen**: go to `/pos/kitchen`. Confirm your dish appears on a ticket already in
   **Preparing** (checkout fires items straight to preparing, not `queued` — there's no "Fire"
   button to look for here unless the item has a course requiring an explicit fire, see Ahmed's
   workflow section 3). Click **Mark ready**, then **Serve**. Confirm the ticket disappears from
   the board once every item on it is served.
7. **Floor** again: confirm the table's status badge now reads **Food Served** — automatically,
   with no manual step — proving the kitchen-to-floor status sync fires on its own.
8. Click the table, then **Bill** → confirm status becomes **Bill Requested**.
9. Click the table, then **Bill settled** → confirm status becomes **Needs Cleaning**.
10. Click the table, then **Cleaned** → confirm status returns to **Available**, and that **Seat**
    is enabled again (ready for the next guest).

If every step above works, the entire seat → order → pay → prep → serve → bill → settle → clean
cycle is intact end to end — this is this codebase's own stated real acceptance test, and it's the
one most exposed to regression when five-plus modules merge into the same code on the same day, as
happened today.

## 2. Discount-stacking policy (verifying existing behavior, not new UI)

This isn't a new feature — H1 was confirming and documenting that the existing system already
behaves correctly, not building new enforcement. Worth a quick manual confirmation anyway:

1. Add an item to the cart at **Sell**. Apply a manual **% Discount** to it (e.g. 10%). Confirm the
   line total drops accordingly.
2. Attach a guest who's enrolled in loyalty with enough points to redeem a reward, and redeem that
   reward on the same line. Confirm the discount shown on the line is now the **reward's** discount,
   not the sum of the manual discount plus the reward — a line carries exactly one discount source
   at a time, and whichever was applied most recently replaces the previous one rather than
   stacking with it.
3. Apply the manual discount again on top of the reward. Confirm it now shows only the manual
   discount — same replace-not-stack behavior, just in the other order.
4. If an active promotion also applies to this item, trigger it and confirm the same rule holds:
   whichever of (manual discount / reward / promotion) was applied last is the only one shown,
   never a combination of two.

## 3. Sidebar navigation (visual regression fix)

This one really is "look at it" — a genuine bug your own screenshot caught, now fixed.

1. Sign in as owner/manager on the web app (`/login`) and look at the left sidebar.
2. Confirm there is exactly **one** "Operate" group and exactly **one** "Manage" group — not two of
   either. "Operate" should contain Sell, Open Checks, Orders, Floor & Tables, Kitchen, and
   Dispatch, all in one list. "Manage" should contain Menu, Inventory, Purchasing, Guests, and
   Promotions, also in one list.
3. Confirm every one of those links actually navigates to a real, working screen (not a
   placeholder) — this was the practical symptom of the bug: half of these entries were missing
   from whichever copy of the group happened to render.

---

## What this workflow does not cover

H2 (making browser E2E a required CI gate rather than manual scripts like this one), H3
(performance budgets and production monitoring), and H4 (API/runbook documentation) are
infrastructure and documentation work, correctly scoped as multi-day and not attempted in this
session — there's no screen to click through for any of them. The reservations `seat()`
idempotency/cross-store test and the break-start race fix, also part of Hamza's slice, are
exercised as part of Bisma's workflow (Sections 1 and 2) since they're regression fixes to her
shipped features, not new surfaces of their own.
