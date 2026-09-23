# DineFlow Development Rules

Mandatory reading for every developer (Hammad, Ahmed, Bisma, Hamza) and every future Claude
Code session on this repo. See also `docs/ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`,
`docs/MODULE_STATUS.md`, `docs/FIVE_DAY_PLAN.md`, `docs/10_test_workflow.md`.

## 1. Git — daily start procedure

Every developer, every day, before writing a line of code:

```bash
git fetch origin
git checkout develop
git pull origin develop
git checkout -b feature/<developer>/<day>-<task-name>
git push -u origin feature/<developer>/<day>-<task-name>
```

If a feature branch already exists and you're continuing it: `git checkout` it, then
`git pull origin develop` merged in (not rebase, unless the team agrees otherwise) before
resuming — never build on top of a `develop` you haven't just pulled.

**No feature work directly on `develop` or `main`, ever.**

## 2. Git — the flow

```
Latest develop → pull → feature branch → development → tests → push → PR → Lead review
  → fixes if required → Lead merges into develop → everyone pulls latest develop again
```

**Ahmed, Bisma, and Hamza never merge their own PRs.** The Team Lead (Hammad) owns
integration and merge order. After any merge, every other developer must pull `develop`
again before continuing dependent work — never build Day N+1 from a stale Day N branch.

**PRs target `develop`, never `main`.** Double-check the base branch when opening a PR — this
has already gone wrong once this sprint (two Day 2 PRs opened against `main` by mistake and had
to be retargeted before merge).

## 3. Migrations — this project's actual convention

1. Name new files `YYYYMMDDNNNN_short_description.sql`, using the next unused sequence number
   for that date — check the last file in `supabase/migrations/` first. Two developers picking
   the same number the same day is a known failure mode (it happened on Day 2); if it happens,
   the Lead renumbers during integration.
2. **Additive only.** New tables, new nullable/defaulted columns. Never alter or drop something
   another feature depends on without Lead sign-off first.
3. Every new tenant-scoped foreign key uses the composite `(store_id, id)` form
   (see `docs/ARCHITECTURE.md` §1.4) — not a bare `references other_table(id)`.
4. Apply via `cd apps/api && node scripts/apply-migration.mjs ../../supabase/migrations/<file>.sql`
   (needs `apps/api/.env`'s `DATABASE_URL`).
5. **Immediately** add a row to `supabase/migrations/APPLIED.md` with the file's SHA-256 and
   the object that confirms it applied — a migration without this row is treated as not done.
   This was missed once on Day 2 and had to be fixed during integration.
6. Never edit an already-applied, already-recorded migration file. Write a new one to correct
   it.
7. This is one shared live database. If your migration's FK points into a table your teammate
   owns, you cannot apply (or test) yours until theirs is live — check the day's plan for these
   dependencies and coordinate directly.

## 4. Design consistency

Every UI PR is checked against `docs/DESIGN_SYSTEM.md` before review for anything else.
Inconsistent buttons, cards, radii, colors, or a second modal/toast/drawer implementation are
an automatic "changes requested," not a nitpick.

## 5. Conflict prevention — shared files

Some files are touched by more than one workstream by nature. Treat them with care:

- `apps/web/src/lib/pos-store.ts` — every restaurant feature so far (order type, active table,
  line notes) has needed one small addition here. Add one field, with a comment, and expect the
  Lead to review this file specifically every time. A duplicate-declaration bug from two
  branches both adding the same field independently already happened once (Day 2) — it produced
  a "clean" auto-merge that still failed to compile; the Lead checks this file's *content* after
  every merge, not just whether git reported a conflict.
- `apps/web/src/App.tsx`, `apps/api/src/app.ts` — route registration. Additive line insertions
  only; don't reorder existing routes.
- `supabase/migrations/APPLIED.md` — append-only, see §3.5.
- Shared domain contracts (`packages/domain/src/*.ts`) — introducing a new shared union/enum
  (like `OrderType`, `TableStatus`, `KitchenTicketStatus`) is a Lead task, landed on `develop`
  before dependent feature branches are cut, exactly as Days 1–2 did it.

Do not have two developers repeatedly editing the same large screen file in the same week —
if a day's plan would require that, the Lead re-splits the work before branches are cut.

## 6. Before opening a PR

Run, in order:
```bash
cd packages/domain && npm test
cd apps/api && npm run build && npm test && npm run test:integration && npm run test:orders
cd apps/web && npm test && npx tsc --noEmit -p tsconfig.app.json && npm run build
```
(Full detail, plus the manual walkthrough, in `docs/10_test_workflow.md`.) No lint/formatter is
currently configured in this repo — don't claim to have run one.

No PR should knowingly contain: TypeScript errors, a broken build, console crashes, dead
routes, unhandled promise rejections, placeholder hacks presented as finished, debug `console.log`s, or hard-coded secrets.

## 7. PR template

```markdown
## What changed
## Why
## Screens / UX
## Database changes
## API changes
## Tests
## Risks
## Manual testing performed
## Follow-up work (known gaps, explicitly)
```
"Follow-up work" is not optional filler — Day 2's PRs correctly used it to flag two real
integration gaps instead of hiding them. Keep doing that.

## 8. Code review standards (Lead)

Review for correctness, architecture fit, simplicity, reuse, security (tenant isolation!),
performance, error handling, UX, design consistency, type safety, and test coverage. "It works
on my machine" is not a review pass. If a PR's own checklist items aren't verifiable from the
diff, ask for the verification, don't assume it.

## 9. No fake features

No dashboard populated with arbitrary numbers. Missing data gets a real empty state or is
connected to a real query — never a plausible-looking placeholder presented as live.

## 10. Error handling

No silent `catch(() => {})`. Every async operation gets a loading/success/empty/error state.
Never surface a raw `PostgrestError` or `Cannot read properties of undefined` to a user —
translate it; keep the technical detail in server logs only.

## 11. Type safety

No unnecessary `any`. No `@ts-ignore` to force a build green — fix the type error or, if it's
genuinely a library gap, comment exactly why the suppression is safe.

## 12. Daily reporting

At the end of each day, the Lead updates `docs/MODULE_STATUS.md` and `docs/FIVE_DAY_PLAN.md`
(mark complete/partial/blocked/moved/newly-discovered) and produces a short report: Completed
(by person), PRs merged/pending, blockers, bugs found, architecture decisions made,
performance findings, tomorrow's plan. Don't keep following a plan the repository has already
outgrown — update the doc, then keep working.

## 13. Final-day discipline

The last scheduled day reserves real capacity for integration, bug-fixing, security/RLS
review, responsive testing, design-consistency pass, and build/migration verification — not
100% new feature work.
