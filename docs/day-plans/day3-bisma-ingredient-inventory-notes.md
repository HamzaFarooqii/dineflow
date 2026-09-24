# Day 3 — Ingredient Inventory (Bisma)

Branch: `feature/bisma/day3-ingredient-inventory` → PR into `develop`.

## What's in this PR

### Database
- `202609240002_ingredient_inventory.sql` — `ingredients`, `ingredient_batches`,
  `stock_movements`, `recipe_ingredients`. Member-read RLS, writes go through the API only.
  Depends on Ahmed's `units`/`recipes` (`202609240001`, already merged).
- `202609240003_inventory_audit_columns.sql` — `created_by_user_id` on `ingredients` and
  `stock_movements`, for web (owner/manager) writes.
- `202609240004_inventory_terminal_audit.sql` — `created_by_employee_id`, `manager_id`,
  `manager_approved_at` on both tables, for cashier-terminal writes (see below).
- `packages/domain/src/stock-movement-reason.ts` — shared `purchase | consumption | wastage |
  adjustment` contract, mirrors `stock_movements`'s check constraint.

### Backend (`apps/api/src/routes/inventory.ts`)
- Owner/manager web API at `/inventory`: CRUD for ingredients (create/update/deactivate),
  receive a batch, list stock movements (paginated), record wastage.
- Cashier-terminal API at `/pos/inventory`: same endpoints, but every write additionally
  requires manager-approval evidence (see below). Reads only need a valid terminal session.
- `current_stock` is a denormalized column on `ingredients`, updated in the same DB transaction
  as every `stock_movements` insert — no trigger, matching how `restaurant_tables.status` is
  already handled in this codebase.
- A wastage entry that would take stock below zero is rejected (422).
- Every write records who did it: `created_by_user_id` (web) or `created_by_employee_id` +
  `manager_id` + `manager_approved_at` (terminal). Ingredient/movement API responses include a
  `created_by_name` field ("Full Name (owner)" or "Manager Name (manager)").

### Frontend
- `/inventory` — owner/manager screen, now in the sidebar nav (Settings moved to the end of
  the nav to make room).
- `/pos/inventory` — the same screen, reused for the cashier terminal via a `terminal` prop.
  **Cashiers can view inventory, but every write (add ingredient, receive batch, wastage)
  requires a manager to approve with their PIN** — this reuses the exact
  `ManagerApprovalModal`/offline-PIN-verification flow already used for over-20% discounts at
  the register; the PIN itself is never sent to the server, only `manager_id` +
  `manager_approved_at` travel with the request, validated server-side against an active
  manager for that store.
  - The manager dropdown never pre-selects, even with only one manager — the approving manager
    must actively choose themselves.
  - The terminal's local employee cache auto-refreshes when the screen loads (and has a manual
    "Refresh access" button), so a manager added moments ago shows up without a re-login.
- Low-stock badge (`current_stock <= reorder_threshold`), batch expiry tones (danger past
  `expires_at`, warning within 3 days — adjustable, flagged as a judgment call), read-only
  stock-movement ledger.
- Selecting a different ingredient now clears the batch/wastage form fields instead of leaving
  stale input behind.

## Explicitly out of scope (per the original task)
- Nothing consumes stock automatically yet — no hookup into kitchen tickets/orders. That's a
  follow-up once this is live.
- `apps/web/src/screens/ProductCatalogScreen.tsx`, `screens/kitchen/`, `apps/api/src/routes/kitchen.ts`,
  `screens/floor/`, `apps/api/src/routes/floor.ts`, `RegisterScreen.tsx`, `apps/api/src/routes/orders.ts`
  were not touched.

## Testing
- `apps/api`: `npm run build` + `npm run test:orders` (30/30 pass, includes 3 new
  low-stock/wastage-validation tests).
- `apps/web`: `npm run build` + `npm run test` (32/32 pass, includes 7 new
  low-stock/expiry-tone tests).
- Manually verified end-to-end against a real store: create ingredient → receive batch →
  confirm stock increments → record wastage → confirm stock decrements and rejects
  over-quantity → confirm low-stock/expiry tones render → confirm cashier-terminal writes are
  blocked without manager PIN and recorded with the manager's name once approved.

## Migration apply status
All four migrations above are applied and confirmed live (see `supabase/migrations/APPLIED.md`
for the exact SHA-256/confirmation rows).
