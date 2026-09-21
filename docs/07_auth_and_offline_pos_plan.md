# Authentication and Offline POS Delivery Plan

## Goal

Deliver a secure, accessible owner web experience first, then build an online-and-offline point-of-sale foundation. Owners and managers authenticate online with Supabase. Provisioned terminals retain the data and employee PIN verifiers needed to operate offline within the approved authorization window.

## Delivery 1: Authentication and accessibility

- Branch: `fix/auth-accessibility`; pull request target: `develop`.
- Guard every POS and settings route with the Supabase session and return unauthenticated visitors to sign-in.
- Redirect authenticated users away from public authentication screens.
- Add password visibility, requirements, confirmation validation, reset, email confirmation and resend flows.
- Remove misleading session controls; show useful loading, success and failure states; prevent duplicate submissions.
- Make controls semantic and keyboard accessible, with focus treatment, labels and minimum touch targets.
- Repair route anchors, mobile navigation, settings loading states and connection wording.

## Delivery 2: Offline POS foundation

- Branch: `feat/offline-pos-foundation`; pull request target: `develop` after Delivery 1 merges.
- Add a TypeScript Express API and versioned OpenAPI contract for provisioning, employee sessions, order push/pull, snapshots and history restoration.
- Keep Supabase for owner authentication and managed PostgreSQL. Add only new timestamped migrations for terminal, employee, order, payment, outbox, stock and change-feed records.
- Add shared integer-cents money logic, Dexie local persistence, Zustand terminal state and a PWA app shell.
- Persist checkout, receipts, stock adjustments and the outbox atomically. Sync immutable operation IDs through the API and preserve rejected paid sales for reconciliation.
- Support employee PIN lockout, 72-hour manager-approval expiry and seven-day checkout authorization expiry after online provisioning.

## Verification

- Delivery 1: test signup, email confirmation/resend, password reset, login, invites, route redirects, keyboard navigation, screen-reader announcements, and 375 px through desktop layouts.
- Delivery 2: test provisioning, offline launch, PIN lockout, cart calculations, cash/card checkout, duplicate completion prevention, reload recovery, print/reprint, queued sync and rejected-sale visibility.
- Run `npm run build` for the web app and the relevant API/domain tests before each pull request.

## Constraints

- Do not modify existing applied migrations.
- Do not use floating-point money calculations.
- Do not put private credentials in browser code or Git history.
- Do not use the prohibited assistant name in branches, files, folders, commits or pull requests.
