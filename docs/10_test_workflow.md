# Local Test Workflow

Repeatable checklist for verifying a day's work — your own, or a branch you're reviewing —
before merging into `develop`, and again after merging to confirm the integration.

## 0. One-time setup

- Copy `apps/web/.env.example` → `apps/web/.env.local`. Fill in the real project's
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`; leave `VITE_API_URL=/api`.
- Copy `apps/api/.env.example` → `apps/api/.env.local`. Fill in `DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`; `WEB_ORIGIN`, `PORT` and `NODE_ENV` can stay at their example
  values for local dev.
- Install dependencies separately in each package (this repo has no root workspace):
  `apps/web`, `apps/api`, `packages/domain`.

## 1. Automated checks — run these first, every time

```
cd packages/domain && npm test

cd apps/api && npm run build && npm test && npm run test:integration && npm run test:orders

cd apps/web && npm test && npx tsc --noEmit -p tsconfig.app.json && npm run build
```

This is exactly what `.github/workflows/ci.yml` runs on every PR/push to `develop` and `main`
(minus the domain package, which CI doesn't run separately but every other suite covers
indirectly). If these pass locally, CI will pass.

## 2. Start both dev servers

- Terminal 1: `cd apps/api && npm run dev` → API on `http://127.0.0.1:3001`
- Terminal 2: `cd apps/web && npm run dev` → App on `http://127.0.0.1:5173` (dev server proxies
  `/api` to the API automatically — see `apps/web/vite.config.ts`)

## 3. Manual walkthrough

- Sign in (or sign up and complete onboarding).
- **Register** (`/register`): the Dine-In / Takeaway / Delivery selector sits above "Open
  check" — confirm switching it highlights the active pill. Add a menu item, type a kitchen
  note into the line's note field ("no onions"), notice the disabled "+ Modifiers" affordance
  (placeholder only — not wired to anything yet). Apply a discount, proceed to payment, and
  complete checkout — confirm it still works exactly as before any restaurant-POS work.
- **Floor & Tables** (`/floor`): on a store with no floor data yet, it correctly shows "No floor
  areas or tables are set up for this restaurant yet." — see the seed snippet below to populate
  it. After seeding, reload and confirm area tabs, table cards and status colors render.
- **Table lifecycle** (Day 2, now real — not just disabled buttons): click an `available`
  table. Optionally pick a waiter from the "Assign a waiter (optional)" dropdown (needs at
  least one employee under Settings → Team first), then **Seat** — status moves to `seated`
  and the waiter's name appears on the card. Click **Add order** — this sends you to
  `/register` with the table attached; complete a Dine-In checkout there. Back on `/floor`,
  the table should show `ordering`. Click **Bill**, then **Bill settled**, then **Cleaned** —
  confirm the table walks `ordering → bill_requested → dirty → available` and the waiter
  clears once it's back to `available`. **Transfer** and **Merge** are still intentionally
  disabled (need the table–order linking that isn't built yet) — confirm they say so, not
  just "disabled" with no explanation.
- **Kitchen Display System** (`/kitchen`, new this round): after the checkout above, a ticket
  card should appear here for that order, showing its item(s) and elapsed time. Click **Fire**
  (queued → preparing), then **Mark ready** (→ ready), then **Serve** (→ served) — once every
  item on a ticket is served, the ticket disappears from the board (it's an active-tickets-only
  view, not a history). Place a Takeaway or Delivery order too and confirm it also produces a
  ticket — kitchen tickets are created for every order type, not just dine-in.
- **Ticket → table sync (Day 3):** serve every item on a dine-in ticket from `/kitchen`, then
  check `/floor` — the table should now read `served` on its own, without touching the Bill
  button. This only fires if the table was still in `ordering` when the last item was served;
  if staff already clicked Bill early, the sync is a silent no-op (by design — see
  `apps/api/src/routes/kitchen.ts`'s comment). From `served`, Bill/Bill settled/Cleaned work as
  before.
- **Manager override for the same transition:** open a table that's at `ordering` and click
  **Mark served** in the detail panel — it should move straight to `served`, the same as the
  kitchen doing it automatically. This is manager/owner-only by design (this whole screen
  already requires that role to open); there's no cashier-terminal equivalent of this button.
- **Table card total (Day 3):** once a table has a completed order against it, its card and
  detail panel show that order's total, labeled "Last order" — this is the most recent
  *completed* order, not a live running tab (the codebase has no in-progress-order concept yet,
  so a table still at `ordering` correctly shows "—" until checkout finishes).

## 4. Seeding floor data for testing

No admin UI creates floor areas or tables yet — Day 1's migration only added the schema. Insert
test rows once, directly in the Supabase SQL editor:

```sql
insert into floor_areas (store_id, name, sort_order)
select id, area, ord from stores, (values ('Main Hall', 1), ('Outdoor', 2)) as v(area, ord)
where stores.name = 'YOUR STORE NAME HERE';

insert into restaurant_tables (store_id, floor_area_id, label, seats)
select fa.store_id, fa.id, t.label, t.seats
from floor_areas fa, (values ('T1', 4), ('T2', 2), ('T3', 6)) as t(label, seats)
where fa.name = 'Main Hall';
```

Replace `'YOUR STORE NAME HERE'` with the exact restaurant name used at signup. Re-run with
different area names/table labels as needed.

## 5. CI

After pushing, check the **Actions** tab on GitHub for the same build+test matrix, run
automatically on the pushed branch or PR.

## 6. Reviewing someone else's branch specifically

```
git fetch origin
git checkout feature/<branch-name>
git pull
```

Then repeat Sections 1–3 against that branch before approving it for merge into `develop`.
