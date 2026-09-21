# Terminal provisioning and cashier PIN access

## Scope and routes

- `/settings/terminals`: owner/manager store selection, provision this browser, view and revoke terminals.
- `/settings/employees`: employee name, PIN, active state and POS role. These employees are separate from email memberships and invitations.
- `/pos/login`: employee selection, online PIN verification, offline unlock and terminal lock.

The owner authentication functions and existing Settings invitation form are unchanged. Register, cart, payment, catalog and order-history components are unchanged. Terminal access ends at its own session screen; it does not bypass the existing Supabase guard on `/register` or assert that checkout bootstrap is complete.

`apps/api/src/app.ts` is a new minimal Express entry point because no API existed on the merged base. All endpoint logic is in `apps/api/src/terminal-auth/`. The web route registry adds three lazy-loaded routes. Vite adds a same-origin API proxy and cashier offline shell. The HTML document now includes the viewport metadata required for mobile layouts.

## Run locally

1. Install dependencies with `npm ci` in both `apps/api` and `apps/web`.
2. Apply the existing owner/store migration, then `supabase/migrations/202609150001_terminal_employee_access.sql` and `supabase/migrations/202609150002_terminal_device_sessions.sql` in order. If the first terminal migration is already applied, apply only the `...0002...` follow-up. Do not apply or merge PR 2's draft migration.
3. Supply the API process with the variables documented in `apps/api/.env.example`. Keep the database connection string on the server. The API requires a database role with access to the terminal tables and permission to read/lock store memberships. The migration grants terminal operations to Supabase's server `service_role`; browser roles have no table access. Do not send this connection string or any server key to Vite.
4. Start the API from `apps/api`: `node --env-file=.env --import tsx src/server.ts`. The example file is a template; create the ignored `.env` locally with your environment's values.
5. Start the frontend from `apps/web`: `npm run dev`. Existing Supabase frontend configuration remains as documented for owner login.
6. Sign in as an owner/manager. Open `/settings/employees`, create an active employee with a PIN, then `/settings/terminals` and provision the current browser. Open `/pos/login` and select that employee.

Offline reload requires the **production build** served over HTTPS (localhost is allowed). Vite's development server does not install this service worker. Route `/api/*` to the API, removing the `/api` prefix, and route web navigations to `index.html`. Production must use the same origin for web/API, exact `WEB_ORIGIN`, and `NODE_ENV=production` so cookies are Secure. Do not enable wildcard CORS. The cashier service worker caches build assets and only handles `/pos/login` navigation; it does not cache API responses or owner account pages.

## Security and cache behavior

- Provisioning allocates a fresh installation UUID and globally unique UUID receipt prefix with a trailing hyphen. Reprovisioning never reuses a prefix. Receipt sequence allocation belongs to the future checkout transaction.
- Device access cookies expire in 15 minutes. Refresh credentials live in separate, revocable device-session records with rotation lineage and a 30-day expiry. Rotation invalidates the previous access token immediately and keeps its refresh credential usable for a fixed 60-second retry window. Retrying replaces an unreachable child created by a lost response.
- Provisioning with a valid refresh credential revokes the browser's previous installation and all its sessions, including when a manager moves the browser to another store.
- Cashier session cookies expire in 15 minutes. Refresh extends only a valid current cashier session whose employee is still active and whose permission version matches. PIN/role/active changes increment the version and expire existing server sessions.
- Online wrong attempts are serialized with PostgreSQL locks, counted per device and employee, and persisted: five attempts trigger 60 seconds of lockout. Refresh preserves counters. Local unlock counts attempts before doing crypto so tab closure cannot erase an attempt; Web Locks serialize access across tabs.
- PIN verifiers use a random 16-byte salt, version 1 PBKDF2-HMAC-SHA256, 600,000 iterations and a 32-byte result. This matches the project contract and [OWASP's PBKDF2 guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- IndexedDB database `counterline-terminal-access` stores only terminal identity, active employee names/roles/IDs/permission versions/PIN verifiers, validation timestamps, cashier session metadata and lockout/clock state. No plain PIN, email credentials, access token or refresh token is stored there. Browser storage is not tamper-proof.
- Connected cashier pages refresh every minute and on reconnection. A refresh replaces the active employee projection, removing deactivated employees. HTTP authentication rejection never falls back to cached PIN access. Device revocation clears cached employee authorization on the next rejected refresh.
- Offline access expires seven days after server validation; manager approval expires after 72 hours. Clock rollback requires online validation. Local lock/logout is preserved even when an older HttpOnly cashier cookie still exists.
- An offline device cannot learn revocation immediately. Its previously issued offline window still applies. Extracted low-entropy PIN verifiers remain susceptible to brute force; use controlled pilot terminals, as required by the existing plan.

## Verification commands

From `apps/api`:

```powershell
npm run build
npm test
npm run test:integration
npm run test:browser
```

From `apps/web`:

```powershell
npm run build
```

The integration suite applies the new migration unchanged to PGlite's embedded PostgreSQL engine. It applies the existing owner/store migration with its `CREATE EXTENSION pgcrypto` statement omitted because the embedded engine already provides UUID generation. Supabase's auth schema/roles and identity service are test fixtures. This verifies SQL execution and API behavior locally, not a deployed Supabase migration or a multi-connection PostgreSQL load test.

The browser test builds with local test-only Supabase configuration, runs the real terminal handlers against the migrated embedded database, and generates synthetic employees. It writes screenshots under `screenshots/`. Run the ordinary web build afterward to replace the test build configuration before deployment. The browser test uses local ports 3178/3179 and requires Playwright Chromium (`npx playwright install chromium` from `apps/api` if absent).

## Review checklist and deployment limits

Local verification on 2026-09-15 (Windows, Node 24.19.0, Playwright Chromium): API build passed; three PIN/policy tests passed; ten OpenAPI/migration/API test results passed; the browser workflow passed. API integration checks include refresh lost-response recovery and cross-store reprovisioning. Browser checks cover all three new screens at 375, 390, 768 and 1440 pixels, actual offline app reload, persisted lockout, clock rollback, local lock surviving reconnection, and connected employee deactivation. The web build passes with Vite's main-bundle size warning (approximately 517 kB); terminal modules are separate lazy-loaded chunks.

| Screen | Laptop | Mobile |
|---|---|---|
| Employees | [1440 px](screenshots/employees-1440.png) | [390 px](screenshots/employees-390.png) |
| Terminals | [1440 px](screenshots/terminals-1440.png) | [390 px](screenshots/terminals-390.png) |
| Cashier login | [1440 px](screenshots/cashier-1440.png) | [390 px](screenshots/cashier-390.png) |
| Offline lockout | — | [390 px](screenshots/offline-lockout-390.png) |

1. Verify unauthorized users and cashier email memberships cannot provision/edit employees; owners/managers are limited to their active stores.
2. Create and edit an employee; change PIN, role and active state; verify a connected cashier locks after changed permissions are refreshed.
3. Provision, sign in, lock, refresh and revoke a terminal. Verify a new provision gets a different receipt prefix.
4. Load the production cashier page online, disconnect and reload. Verify correct PIN unlock, five wrong attempts and lockout retained across reload.
5. Check mobile widths 375/390, tablet 768 and laptop 1440; keyboard focus, labels and error announcements.

Before live rollout, apply the focused migration to the intended Supabase environment, verify real Supabase owner authentication and production cookie routing, benchmark PBKDF2 on the reference terminal, and exercise PostgreSQL concurrency on the deployment database. The test suite does not authorize or claim a live migration. Catalog bootstrap, checkout authorization consumers, receipt counters, sales and sync integration remain with their assigned feature work. Employee projection updates currently arrive through terminal refresh; future sync work must integrate its change-feed contract without bypassing permission-version invalidation.
