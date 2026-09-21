# Owner onboarding wizard

## Scope and routes

- `/onboarding`: mandatory 3-step wizard (store profile, terminal, staff) shown once, right after a new owner's store is created.
- `Signup()`/`Login()` in `apps/web/src/App.tsx` route to `/onboarding` instead of `/dashboard` when the signed-in owner's store has not finished onboarding.
- `ProtectedRoute`/`PublicRoute` also redirect to `/onboarding` for an existing session whose store is unfinished, so the wizard cannot be skipped by navigating directly to `/dashboard`, `/register`, etc.

Existing settings screens (`/settings/terminals`, `/settings/employees`), the email invitation flow, and cashier PIN login (`/pos/*`) are unchanged. `ManagerSetup.tsx` now calls the shared `provisionTerminal` helper (`apps/web/src/terminal-auth/cache.ts`) instead of inlining it, so the settings terminal-provisioning form and the wizard's terminal step share one implementation.

## Run locally

1. Apply `supabase/migrations/202609190001_store_onboarding_status.sql` (after the existing `202609130001_auth_and_stores.sql`). It adds `stores.onboarding_completed_at`, backfills existing stores as already onboarded, and adds the `update_store_profile` / `complete_store_onboarding` RPCs (owner/manager only, same `is_store_admin` guard as `invite_store_member`).
2. Sign up a brand-new owner account. You should land on `/onboarding` instead of `/dashboard`.
3. Complete all three steps. The wizard calls `loadCatalog()` on completion, so `store_config`/catalog data is seeded before you reach the dashboard.
4. Confirm an existing store (created before the migration) signs in straight to `/dashboard` with no redirect, and that a non-owner (manager/cashier) session is never sent to `/onboarding`.

## Automated check

`docs/owner-onboarding/browser-check.mts` is an isolated Playwright acceptance test that mocks Supabase REST/RPC and the `/api` terminal-auth routes, then drives the wizard end to end and asserts the finish step lands on `/dashboard` and does not bounce back to `/onboarding`. Run it with:

```
cd apps/api && node --import tsx ../../docs/owner-onboarding/browser-check.mts
```
