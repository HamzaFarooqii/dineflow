# DineFlow Architecture

See `docs/MODULE_STATUS.md` for feature-level completeness; this document is about structure,
not features.

## 1. Current architecture (as of Day 2)

```
apps/web    — React + Vite PWA. Offline-first: Dexie (IndexedDB) is the source of truth for
              the register; Supabase/the API are synced to, not read from, on the hot path.
apps/api    — Express + node-postgres, talking directly to the Supabase Postgres instance
              (not through PostgREST) for anything that needs a transaction or server-side
              validation. Stateless; one Pool per process.
packages/domain — Framework-free TypeScript, imported by relative path from both apps (no
              package-manager-resolved workspace yet). Pure functions and shared unions only —
              money math, OrderType, TableStatus, KitchenTicketStatus. No I/O.
supabase/migrations — Hand-written SQL, applied manually via apps/api/scripts/apply-migration.mjs
              and tracked in migrations/APPLIED.md (this project does not use the Supabase CLI's
              own migration tracking — see that file for why).
```

No monorepo tooling (no Turborepo/Nx, no npm workspaces) — three independently-installed
packages linked by relative imports. This is a known simplification, not an oversight; don't
"fix" it by introducing workspace tooling without a concrete reason.

### 1.1 Authentication — two systems, by design

- **Supabase Auth**, for owners/managers using the main web app (`App.tsx`'s routes). Session
  lives in Supabase's client SDK; `SessionProvider` resolves it once at the root.
- **Terminal auth** (`apps/api/src/terminal-auth/`), for cashiers on a shared POS terminal:
  salted-PIN login, device-bound sessions, offline-capable, with a manager-approval flow for
  actions a cashier can't authorize alone (e.g. large discounts). This is deliberately separate
  from Supabase Auth — a terminal must keep working when the internet (and therefore Supabase)
  is unreachable.

Do not merge these two systems. Every new restaurant feature that needs both a manager-web and
a cashier-terminal surface (Floor, Kitchen so far) exposes **two routers**: one behind
`requireStoreMember`/`requireStoreManager`, one behind `requireCashierTerminal`, following
`floor.ts`/`kitchen.ts`'s existing pattern.

### 1.2 State management

- **Zustand** (`apps/web/src/lib/pos-store.ts`) for register/cart/session-scoped UI state
  (cart items, order type, active table, manager approval). Single store, not split by feature —
  keep it that way; a second store would fragment state that genuinely needs to be read together
  at checkout time.
- **Dexie** (`apps/web/src/lib/db.ts`) for anything that must survive offline and outlive a
  browser session: catalog, orders, customers, the sync outbox. Schema is versioned
  (`this.version(n).stores(...)`) — never mutate an existing version, only add new ones.
- No React Query / SWR / similar — data fetching is hand-rolled per screen (`useEffect` +
  `useState`), matching the existing screens. Introducing a query library is an architectural
  change requiring Lead sign-off, not a Day 3–5 task.

### 1.3 Realtime / sync

No Supabase Realtime subscriptions exist yet — the outbox pattern (write locally, queue,
push, reconcile) is the only sync mechanism. The Floor and Kitchen screens currently poll on
mount only; they do not live-update if another terminal changes a table or ticket. This is a
real UX gap for a multi-terminal restaurant floor, not yet flagged as a module task — see
`FIVE_DAY_PLAN.md` Day 5 for where to raise it.

### 1.4 Security boundaries

- RLS on every table: member-read policies (`is_store_member(store_id)`), no client-side insert/
  update/delete policies — all writes go through the API using the service-role connection,
  which re-validates authorization itself (`requireStoreMember`/`requireStoreManager`/
  `requireCashierTerminal`). The browser never has write access to Postgres directly.
- Every new restaurant table's foreign keys into another tenant-scoped table use the
  **composite `(store_id, id)`** form (e.g. `restaurant_tables_assigned_waiter_fkey` on
  `(store_id, assigned_waiter_id) references terminal_employees(store_id, id)`), not a bare
  `references other_table(id)` — a bare FK would let a store assign a resource that belongs to
  a different tenant. This is now the established convention; new migrations must follow it.

## 2. Target DineFlow architecture (through Day 5)

Structurally unchanged — the same three-package layout, the same offline-first pattern, the
same dual-auth model, the same composite-FK tenant isolation. What's added is depth within
existing module boundaries:

```
Customer → Order → Table → Kitchen → Menu Item → Recipe → Ingredient → Inventory → Cost
Customer → Visits → Spending → Loyalty → Rewards → Promotions → Retention
Historical Sales → Demand Patterns → (Purchasing/Intelligence — beyond this sprint's DB work)
```

New schema by day (full detail in `FIVE_DAY_PLAN.md`):
- **Day 3**: `units`, `ingredients`, `recipes`, `recipe_ingredients`, `ingredient_batches`,
  `stock_movements` — additive, references `pos_products`/`kitchen_ticket_items`.
- **Day 4**: `loyalty_accounts`, `loyalty_point_ledger`, `loyalty_tiers`, `reward_rules`,
  `promotions` — additive, references `pos_customers`/`pos_orders`.
- **Day 5**: no new schema expected — reporting reads Days 2–4's tables.

## 3. Module boundaries (who owns which files — full detail in `RULES.md` §Conflict Prevention)

- **Kitchen domain** (tickets, KDS, station routing): `apps/api/src/routes/kitchen.ts`,
  `apps/web/src/screens/kitchen/`, `packages/domain/src/kitchen-ticket-status.ts`.
- **Floor domain** (areas, tables, status lifecycle): `apps/api/src/routes/floor.ts`,
  `apps/web/src/screens/floor/`, `packages/domain/src/table-status.ts`.
- **Menu/POS domain** (register, catalog, menu components): `apps/web/src/screens/RegisterScreen.tsx`,
  `apps/web/src/screens/menu/`, `apps/api/src/routes/catalog.ts`, `packages/domain/src/order-type.ts`.
- **Shared cart state**: `apps/web/src/lib/pos-store.ts` — the one file every domain above has
  needed to touch (order type, active table, line notes all live here). Treat any addition to it
  as touching shared infrastructure: additive fields only, one field per feature, expect the Lead
  to review it specifically every time.

## 4. Key architectural decisions (log — add to this, don't rewrite history)

| Decision | Why | Date |
|---|---|---|
| Two separate auth systems (Supabase Auth + terminal PIN) | Terminal must work offline; owner/manager web app needs full Supabase Auth features (password reset, invites) | Pre-existing |
| Kitchen ticket status is separate from table status | Table status is coarse floor-coordination state; ticket status is per-item kitchen progress. Conflating them would make the table-status enum need kitchen-internal values | Day 1 (docs/09) |
| Ingredient inventory is additive to, not a replacement of, `pos_stock` | `pos_stock` already tracks finished/sellable items correctly; ingredients are a different granularity (a dish consumes ingredients, not itself) | Day 3 planning |
| No monorepo tooling | Three packages, relative imports, low complexity for a small team; revisit only if import paths become genuinely unmanageable | Pre-existing |
