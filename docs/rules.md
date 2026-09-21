# Counterline POS — Team and Coding Agent Rules

These rules apply to every contributor, reviewer, automation, and coding agent.

## 1. Branch and pull-request workflow

- `main` is the protected, stable branch. Do not push directly to it.
- `develop` is the shared integration branch for the current sprint.
- Every task starts from the latest `develop` branch:

  ```powershell
  git checkout develop
  git pull origin develop
  git checkout -b feat/short-task-name
  ```

- Use `feat/` for features, `fix/` for bugs, `docs/` for documentation, and `chore/` for tooling or configuration.
- Do not use the name `Codex` (in any capitalization) in branch names, file or folder names, pull-request titles or descriptions, or commit messages. Use a project- or task-specific name instead.
- Push the task branch and open a pull request into `develop`.
- Only the team lead merges into `develop` or `main`.
- Merge `develop` into `main` only after the agreed demo flow works and the build passes.
- Keep each pull request focused on one feature. Do not mix unrelated cleanup, formatting, or redesign work into it.

## 2. Required checks before a pull request

From the frontend directory:

```powershell
cd apps/web
npm run build
```

Every pull request must include:

- A short description of what changed.
- Steps a reviewer can use to test it.
- Screenshots for UI changes at laptop and mobile widths.
- Any Supabase migration file required for the feature.
- Known limitations or unfinished behavior.

Do not claim a feature is complete when it only works with mock data, when its migration has not been run, or when it has not been tested.

## 3. Ownership and integration boundaries

- Work only in the files and feature area assigned to you.
- Do not rewrite, remove, rename, or reformat another member’s work unless the task explicitly requires it and the team lead has agreed.
- Do not revert unrelated changes shown by `git status`.
- Before modifying a shared file such as `apps/web/src/App.tsx`, `apps/web/src/styles.css`, `SETUP.md`, or a shared migration, pull the latest `develop` and check for recent changes.
- If two features need the same file, make the smallest compatible change and tell the team lead in the pull request.
- Prefer new feature modules and small components over large edits to shared files.
- Keep the current routes working while adding new routes. Do not replace working screens with placeholders.

## 4. Coding rules

- Use TypeScript. Do not introduce `any` to bypass type errors.
- Use integer cents for every price, tax, payment, tender, change, and order total. Never use floating-point money calculations.
- Validate user input and show useful loading, empty, and error states.
- Keep interfaces responsive at 375px, 390px, tablet, and desktop widths. Do not introduce horizontal page scrolling on mobile.
- Preserve the Counterline visual system: parchment backgrounds, deep evergreen navigation, muted gold details, coral actions, editorial serif headings, and accessible contrast.
- Keep components small and name them for the user-facing feature they provide.
- Do not hardcode secrets, API keys, passwords, real customer data, or production credentials.
- Keep `.env.local` local. Commit `.env.example` only.

## 5. Supabase and data rules

- All schema changes must be a new timestamped file in `supabase/migrations/`. Do not manually create production tables in the Supabase Table Editor.
- Never edit an already-applied migration. Create a new migration for a change.
- Enable Row Level Security on every exposed application table.
- Write least-privilege grants and explicit RLS policies for each allowed operation.
- Every business table must be scoped to a store. A user must never be able to read or write another store’s data.
- Never expose a database password, Supabase service-role key, secret key, access token, or refresh token in the frontend, Git history, screenshots, or pull requests.
- Browser code may use only the Supabase Project URL and publishable key with RLS enabled.
- Use server-side code or an Edge Function for actions that need a service-role key, such as sending Supabase Auth invitations.

## 6. Coding-agent instructions

Coding agents must follow these additional rules:

- Read this file, the assigned task, and relevant documents in `docs/` before editing.
- Work only on the active assigned branch. Never commit directly to `main` or `develop`.
- Begin from the current `develop` branch unless the team lead explicitly names another base branch.
- Inspect existing code before editing. Preserve public interfaces and behavior outside the assigned task.
- Do not disturb another member’s functionality, remove their code, overwrite their uncommitted changes, or perform broad rewrites to make a small change.
- Do not use destructive Git commands such as `git reset --hard`, `git checkout --`, force pushes, or history rewrites.
- Do not alter Supabase security policies, migrations, authentication behavior, or environment configuration outside the assigned feature without team-lead approval.
- Run the relevant build or test command after changes. Report failures honestly and include the exact command used.
- Keep commits focused and use conventional messages, for example: `feat(register): add cart quantity controls`.
- Before handing off, report changed files, validation performed, and any limitations that require another team member’s work.
