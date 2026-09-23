# Module Status

Living document — update at the end of every development day (`RULES.md` §Daily Completion).
Reflects the repository as of `develop@bac7077` (end of Day 2). Status legend:
✅ Complete · 🟡 Partial · 🔴 Missing · 🔵 Needs redesign · 🟠 Needs refactor · ⚠️ Buggy/risky · ♻️ Reusable as-is

| Module | Status | UI | Backend | DB | Tests | Action |
|---|---|---|---|---|---|---|
| **A. POS / Register** | 🟡 | Order-type pills, menu grid, cart, discounts ✅. Modifiers/split bill/service charge 🔴 (visible placeholder only) | Checkout, discount/manager-approval, refunds ✅. order_type/table_id persist ✅ | `pos_orders`(+order_type,table_id), `pos_order_items`, `pos_payments` ✅ | Strong (checkout, discount, order-sync, duplicate-submit, employee-attribution) | Day 4: loyalty redemption into existing discount path. Split bill/service charge/hold-resume: not yet scheduled — flag if needed |
| **B. Front of House / Tables** | 🟡 | Floor screen, area tabs, table cards, Seat/Add order/Bill/Settle/Clean ✅. Transfer/Merge 🔴 (disabled, correctly labeled) | `/floor` read + atomic status-transition PATCH ✅ | `floor_areas`, `restaurant_tables`(+assigned_waiter_id) ✅ | floor.ts covered by manual QA only — no automated route test yet | Day 3+: table↔open-order total on TableCard (data now exists via Ahmed's table_id, wiring doesn't); reservations/waitlist not scheduled |
| **C. Menu** | 🟡 | Category tabs, search, availability badge ✅ (register + back-of-house). Variants/sizes/add-ons/combos 🔴 | Catalog snapshot includes restaurant columns ✅ | `pos_products`(+station_id, course, kitchen_name, is_available, unavailable_until, prep_time_seconds) ✅. No `description`/variant columns | Existing catalog tests pass; no restaurant-column-specific test yet | Recipe attachment is Day 3. Variants/modifiers data model not yet scheduled — needs a migration + Lead sign-off when prioritized |
| **D. Kitchen / KDS** | 🟡 | KDS board, Fire/Mark ready/Serve ✅ | Ticket creation on every order, station grouping, item transitions ✅ | `kitchen_tickets`, `kitchen_ticket_items` ✅ | orders.test.ts + kitchen-ticket-status.test.ts ✅ | **Known gap:** a fully-served ticket doesn't flip its table's status — needs a design decision, see `FIVE_DAY_PLAN.md` Day 3 Lead task. Delay/SLA tracking and course-based firing not built |
| **E. Recipes** | 🔴 | none | none | none | none | Day 3 — full module, ground-up |
| **F. Restaurant Inventory** | 🟡 | Finished-item stock/oversold reporting ♻️ reusable as-is. Ingredient-level stock, batches, expiry, wastage: 🔴 | `pos_stock` (finished items only) ✅ | `pos_stock` ✅; `ingredients`/`ingredient_batches`/`stock_movements`: 🔴 | loadOversold covered | Day 3 — new ingredient layer, additive to existing `pos_stock` (don't touch it) |
| **G. Purchasing & Vendors** | 🔴 | none | none | none | none | Beyond the 5-day sprint per original scope note — do not start until Days 3–5 core modules land |
| **H. Customers / CRM** | 🟡 | Guest directory, search, create ✅. Visit history/lifetime spend/favorites: 🔴 | Customer CRUD, search ✅ | `pos_customers` ✅ | customer-api, customer-migration tests ✅ | Day 4 — profile aggregation (visits/spend from existing `pos_orders`, don't duplicate counters) |
| **I. Loyalty** | 🔴 | none | none | none | none | Day 4 — full module |
| **J. Promotions** | 🔴 | Line-level discounts exist (different concept: cashier-applied, not campaign-configured) | none | none | none | Day 4 — full module, distinct from existing discount mechanism |
| **K. Staff** | 🟡 | Owner/Manager (web) + Cashier/Manager (terminal) roles ✅, employee management (Settings→Team) ✅. Waiter/Chef/Inventory-manager/Rider as distinct roles: 🔴. Clock-in/shifts/tips: 🔴 | terminal-auth (PIN, sessions, approval) ✅ | `store_memberships`, `terminal_employees` ✅ | terminal-auth security tests ✅ (strong — salted PIN hashing, rollback/expiry) | "Waiter" today = any active employee, no distinct role. Shifts/clock-in not scheduled this sprint |
| **L. Reports** | 🟡 | Owner/cashier dashboards, daily summary, order history, oversold ✅. Dish profitability/food-cost/kitchen-performance/wastage/loyalty reports: 🔴 | loadDailySummary/loadOrdersPage/loadOversold ✅, timezone-correct | reads existing tables | reports.test.ts (DST-aware, PGlite-backed) ✅ | Day 5 — new reports layer on top of Days 3–4's data. Kitchen-performance data already exists (`kitchen_tickets` timestamps), just unsurfaced |
| **M. Restaurant Intelligence** | 🔴 | none | none | none | none | Correctly not started — no real operational data volume yet to forecast from. Revisit after Day 5 |

## Cross-cutting infrastructure (not a "module" but load-bearing)

| Area | Status | Note |
|---|---|---|
| Auth | ✅ | Two systems by design: Supabase Auth (owner/manager, web) + PIN-based terminal auth (cashier, offline-capable). Don't merge them. |
| RLS / tenant isolation | ✅ | Consistent member-read pattern across every restaurant table added so far; writes go through the API (service-role) only. |
| Offline/sync | ✅ | Dexie outbox pattern, well-tested (order-sync-core, duplicate-submit). Don't introduce a second sync mechanism for new modules — extend this one. |
| Design system | ✅ | MISE tokens (`styles.css` Section E), applied everywhere. See `docs/DESIGN_SYSTEM.md`. |
| CI | ✅ | GitHub Actions, build+test on every PR/push to `develop`/`main`. |
| Testing | 🟡 | Strong unit/integration coverage on money math, checkout, sync, terminal-auth. No component-level or E2E/browser test runs in CI (browser-check scripts exist but are manual-only). |
| Performance | ⚠️ | Single JS bundle is 800KB+ (Vite's own build warning) — no code-splitting beyond three lazy-loaded routes. Flagged for Day 5 hardening, not urgent before then. |
| Migration ledger discipline | 🟠 | `APPLIED.md` process works but has already needed one Lead fixup (Day 2) for a missed entry and a numbering collision between two same-day migrations. `RULES.md` tightens this. |
