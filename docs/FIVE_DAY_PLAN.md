# Five-Day Plan

Team: **Hamza** (Team Lead + developer), **Ahmed**, **Bisma**. Three people, not four — an
earlier draft of this plan briefly assumed a fourth developer; reverted. Update this file at
the end of every day (`RULES.md` §12) — mark complete/partial/blocked/moved, don't keep
executing a stale plan.

## Days 1–2 — already complete (retrospective)

Full detail: `docs/09_restaurant_pos_blueprint.md` (Day 1), `docs/day-plans/day2.md` (Day 2).
Summary for context, not to be redone:

- **Day 1** (Ahmed + Bisma): MISE design system, app shell/nav, Dine-In/Takeaway/Delivery order
  type on the register, restaurant menu columns, Floor & Tables screen + read API. Later
  audited by Ahmed for gaps (order-line notes, modifiers placeholder, availability on
  back-of-house screens) — closed and merged.
- **Day 2** (Ahmed + Bisma): order-type/table persistence into `pos_orders`, kitchen tickets +
  Kitchen Display System, real table-status lifecycle (Seat/Add order/Bill/Settle/Clean) with
  waiter assignment. Merged into `develop` with Lead integration fixes (wrong PR base branch,
  a duplicate-declaration bug from two branches independently adding the same store field, a
  missing migration ledger entry, a same-day migration numbering collision).

`docs/MODULE_STATUS.md` has the full per-module state.

---

## Day 3 — Food Operations

Full work division, exact migration SQL, file ownership and workflow steps:
**`docs/day-plans/day3.md`.** Summary:

Core relationship: **Dish → Recipe → Ingredients → Inventory**. Three people means this day
stays sequential-by-module — Ahmed and Bisma each take one half of Food Operations, and Hamza
both closes the two gaps left from Day 2 and does the schema/integration work only the Lead
should own. Ahmed's `units`/`recipes` migration must be applied before Bisma's
`ingredients`/`stock_movements` (the latter's `recipe_ingredients` references both).

**Day 3 is complete — all three workstreams merged into `develop`.**

- **Hamza:** ✅ both Day 2 gaps closed. ✅ Manual QA surfaced four more real gaps plus two
  long-standing placeholders — stock-oversell warning at checkout, mandatory guest selection, a
  bill showing guest name/phone/order type, kitchen tickets auto-firing to `preparing`, full
  floor area/table CRUD, and Transfer/Merge actually implemented — all merged. ✅ Reviewed and
  merged Ahmed's and Bisma's PRs. ✅ Consumption-wiring hook: a served kitchen item now decrements
  its recipe's ingredients, allowed to go negative (never blocks service) with a new "Out of
  stock" indicator making that reconciliation signal visible. ✅ Two session UX bugs found during
  manual QA fixed (Reports-nav flash, tab-refocus loading flash). Full-scratch "Ticket CRUD" was
  scoped out deliberately — a ticket is derived 1:1 from a paid order, so standalone creation
  would break that invariant. Two small non-blocking follow-ups deferred: a composite-FK fix on
  `ingredients`/`stock_movements.manager_id`, and edit/deactivate controls for ingredients in the
  Inventory UI (API supports both, no UI hookup yet).
- **Ahmed:** ✅ Recipes + menu-side costing, reviewed and merged.
- **Bisma:** ✅ Ingredient inventory, full stack, reviewed and merged — went beyond the brief with
  cashier-terminal writes gated behind manager-PIN approval.

### Day 3 Definition of Done — met
Hamza: both Day 2 gaps closed, checkout-integrity fixes and floor CRUD/Transfer/Merge merged,
recipe/inventory schema reviewed, consumption hook wired and merged. Ahmed: a menu item can have
a costed recipe. Bisma: ingredients, batches, and stock movements exist and are manageable via a
real screen.

---

## Day 4 — Customers, Loyalty & Promotions

Core relationship: **Customer → Visit → Spend → Loyalty → Reward → Repeat Visit.**

### Hamza — Lead + developer
1. **Loyalty schema + the one real design decision:** point redemption must reuse the existing
   `LineDiscount`/manager-approval mechanism in `pos-store.ts`, not add a parallel discount
   path. Land `loyalty_accounts`, `loyalty_point_ledger`, `loyalty_tiers`, `reward_rules`
   before Ahmed's branch starts.
2. **Developer task:** staff-role review — decide whether "waiter" needs to become a real
   distinct role (vs. today's "any active employee") now that loyalty recognition and floor
   assignment both reference employees. Small, contained; document the decision either way in
   `docs/MODULE_STATUS.md` rather than leaving it ambiguous.
3. Review Ahmed's and Bisma's PRs. Merge order: Bisma (promotions + guest CRM, independent of
   Ahmed) → Ahmed (loyalty checkout — touches checkout-critical code; run the existing
   checkout/discount suite explicitly, not just new tests).

### Ahmed — Loyalty at Checkout
Award points on order completion (idempotent), redeem points through the existing discount
path. **Branch:** `feature/ahmed/day4-loyalty-checkout`. Individual brief written the same way
as Day 3's once Day 3 is merged — not drafted yet, per `RULES.md`'s "don't plan too far ahead
of repository reality."

### Bisma — Promotions + Guest CRM
Promotions CRUD screen (`promotions` table, independent migration), guest profile (visit
history/lifetime spend — this was originally going to be pulled into Day 3 under a 4-person
plan; reverted to Day 4 since a 3-person team doesn't have the spare capacity to parallelize
across day boundaries without displacing Day 3's own scope), and a loyalty-tier badge on
`TableCard` once a known guest is attached. **Branch:** `feature/bisma/day4-promotions-crm`.

### Day 4 Definition of Done
A returning guest can earn and redeem loyalty points through the existing approval-safe
discount flow; promotions can be created; a guest's profile shows real visit/spend history.

---

## Day 5 — Reporting, Integration, Hardening

Per `RULES.md` §13: not 100% new feature work. Real capacity to integration, bug-fixing,
security review, polish.

### Hamza — Lead + final integration
1. Cross-module end-to-end pass: dine-in order → recipe ingredients consume → stock movement
   recorded → kitchen ticket served → table freed → loyalty points awarded → every report
   below reflects it. This chain, observed once manually start to finish, is the sprint's real
   acceptance test.
2. Security/RLS review: every table added Days 1–4 uses the composite-FK tenant-isolation
   pattern (`docs/ARCHITECTURE.md` §1.4) — spot-check, don't assume.
3. Performance pass on the bundle-size warning flagged in `docs/MODULE_STATUS.md` — measure
   first, fix only if it's a real problem.
4. Design-consistency pass against `docs/DESIGN_SYSTEM.md` across everything shipped.
5. Update `docs/MODULE_STATUS.md` to its true final state, including what isn't actually done.
6. Review Ahmed's and Bisma's report PRs (read-only, low conflict risk — merge in either order).

### Ahmed — Kitchen + Food-Cost Reports
Dish profitability, food-cost report, kitchen performance by station. **Branch:**
`feature/ahmed/day5-kitchen-food-cost-reports`.

### Bisma — Owner Dashboard + Customer + Inventory Reporting
With no fourth developer to split inventory reporting off to, Bisma covers the owner
dashboard, customer/loyalty reporting, *and* wastage/expiry/low-stock reporting — the largest
single scope of the sprint for one person. If Day 5 is tight, the owner dashboard and
customer reporting are the priority; inventory reporting can slip a day if it must, since it's
the newest module and has the least existing precedent to build from. **Branch:**
`feature/bisma/day5-reports`.

### Day 5 Definition of Done
The end-to-end chain in Hamza's task 1 works, observed once. All report surfaces show real
data with correct empty states. `docs/MODULE_STATUS.md` reflects reality, not the plan.

---

## Note on scope (unchanged conclusion from the 4-person draft, now re-grounded at 3 people)

Day 2 alone needed real Lead integration effort even with two careful developers. Recipes+
Inventory (Day 3) and Loyalty+Promotions (Day 4) are each comparably large. With three people
and no cross-day pull-forward, Day 5's Bisma workload (dashboard + customer + inventory
reporting in one day) is the most likely place this plan slips — flagged here explicitly
rather than discovered on Day 5 itself. If it does slip, inventory reporting is the piece to
move, not the owner dashboard.
