# Team Lead Setup

## 1. Create the GitHub repository

1. On GitHub, create a private repository named `counterline-pos`. Do not initialize it with a README, `.gitignore`, or license because this workspace already contains those files.
2. The repository root holds shared documentation and project-wide configuration. The React application is in `apps/web`.
3. In the repository root, run:

   ```powershell
   git init
   git add .
   git commit -m "chore: bootstrap Counterline POS"
   git branch -M main
   git remote add origin https://github.com/YOUR-ORG/counterline-pos.git
   git push -u origin main
   ```

3. In GitHub settings, invite team members, protect `main`, require pull requests and one approval, and require the `build` check once CI is added.
4. Give each member a branch: `feat/auth-shell`, `feat/register`, `feat/catalog`, `feat/sync-client`, or `feat/api`.

## 2. Create Supabase project

1. Create an organization and a new Supabase project. Choose the production region closest to the store and save the database password in a password manager.
2. In **Project Settings → API**, copy the Project URL and publishable key into `apps/web/.env.local`, based on `apps/web/.env.example`.
3. Never add `.env`, the database password, service-role key, or refresh tokens to GitHub.
4. In the Supabase SQL Editor, run `supabase/migrations/202609130001_auth_and_stores.sql`. It creates the owner/admin onboarding base: profiles, stores, staff roles, invitations, and Row Level Security. Do not create these tables manually in the Table Editor.
5. Enable email/password authentication in **Authentication → Providers** and set the Site URL to your local development URL while developing.
6. For this POS design, the browser accesses a dedicated API for order sync. It should not receive the Supabase service-role key or write directly to order tables.

## 3. Run the web app locally

```powershell
cd apps/web
npm install
npm run dev
```

The current routes are `/login`, `/invite`, and `/register`. The sign-in form currently opens the register preview; replace that handler with the shared authentication service when the backend is ready.

## 4. Team contracts

- Build web pages as route modules in `apps/web/src/pages/` and keep shared UI in `apps/web/src/components/` once those folders are introduced.
- Do not bypass the order repository or write directly to IndexedDB from components.
- Read `docs/03_sync_architecture.md` before touching sync behavior and `docs/05_product_requirements.md` before implementing checkout math.
- Keep API contracts in a committed `api/openapi.yaml`; frontend work should use typed mock adapters until endpoints are complete.
