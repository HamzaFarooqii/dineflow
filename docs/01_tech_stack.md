# 01 — Tech Stack Decisions

**Status:** Revised Phase 1 pilot contract; implementation and verification pending.
**Target:** Seven-day development pilot for three developers. Production release requires the gates in document 06.

## 1. Selected stack

| Layer | Phase 1 decision | Contract |
|---|---|---|
| Client | React, Vite, TypeScript, Tailwind CSS | Installable PWA on explicitly tested hardware/browser combinations. |
| Local database | IndexedDB through Dexie.js | Versioned object stores, application validation, and atomic checkout. SQLite constraints do not apply automatically. |
| Client state | Zustand for transient UI state | Committed sales and the outbox live in Dexie, not UI memory. |
| Offline app shell | Service worker through vite-plugin-pwa | Offline launch after successful online provisioning and cache installation; upgrades must preserve queued data. |
| Printing | Browser print dialog with 80mm CSS | Requires a compatible OS/browser print path and printer driver. Printing success is independent of sale commit. |
| Scanning | HID keyboard scanner | Camera scanning is optional after the core pilot passes. |
| API | Node.js, TypeScript, Express | One framework for Phase 1; stateless handlers with durable state in PostgreSQL. |
| Central database | Managed PostgreSQL on Supabase | Authoritative catalog, orders, inventory, device authorization, and serialized per-store change feed. |
| Server queries | pg with parameterized SQL | Plain SQL migrations; avoid introducing a second query abstraction during the pilot. |
| API contract | REST with a versioned OpenAPI contract | The specification must be created before parallel endpoint implementation. |
| Hosting | Vercel client; Railway API | Validate connection limits, HTTPS, allowed origins, and deployment configuration before pilot use. |
| Authentication | Provisioned device credential plus employee sessions | Device upload authorization is separate from the current employee's interactive session. See document 03. |
| Money | Integer minor units in validated JavaScript safe integers and PostgreSQL BIGINT | JSON numbers only within the explicit domain below. Decimal currency fractions never enter arithmetic. |

## 2. Money and quantity domain

Phase 1 supports one configured store currency with exactly two fractional digits and whole-unit quantities.
Use integer minor units, internally named *_cents. Store currency explicitly in store configuration and each order snapshot.

- Monetary inputs, line amounts, and order amounts: integers from 0 through 1,000,000,000 cents.
- Quantity: integer from 1 through 10,000; reject any product whose calculated line amount exceeds the monetary limit.
- Tax rate: integer basis points from 0 through 10,000.
- Validate intermediate arithmetic with Number.isSafeInteger before accepting it. Bounded tax products are at most 10^13.
- PostgreSQL monetary fields use BIGINT with matching range constraints. Convert pg BIGINT strings to numbers only after range validation.
- Do not use arbitrary 64-bit JSON numbers or rely on implicit numeric coercion.
- Parse decimal display/input strings into cents; format cents for display. See document 05 for rounding and reconciliation.

## 3. Security and browser boundary

Use employee selection plus PIN, not lookup by an unsalted PIN hash. Provision unique salted, versioned PBKDF2-HMAC-SHA-256 verifiers for offline use; use 600,000 iterations as the initial work factor, benchmark on reference hardware, and do not weaken it to meet an arbitrary 80ms target. Offline four-digit PINs remain vulnerable to exhaustive search if storage is extracted; the pilot requires controlled terminals and explicitly accepted local-unlock risk. Never claim browser storage provides hardware-backed credential protection.

Use the same reviewed verifier parameters on client and server, a random salt of at least 16 bytes, rate limiting, and device-scoped authorization. Do not ship example/default employee PINs. Device refresh credentials use Secure, HttpOnly cookies; configure same-site deployment routing or explicitly tested cookie/CORS/CSRF behavior. Never put server or Supabase service credentials in client assets.

## 4. Deferred scope

React Native, SQLite/SQLCipher, direct ESC/POS, integrated card terminals, wallets, store credit, refunds, customer merging/editing, local catalog edits, stock adjustment UI, and local hub relay are outside Phase 1.
Native migration can reuse domain contracts but requires a separate storage adapter, migrations, UI and hardware validation. It is not a configuration-only conversion.

## 5. Artifact status

This workspace currently contains six design documents only. Referenced SQL, Dexie code, OpenAPI, and test results are deliverables, not existing verified artifacts. No database constraint, trigger, performance target, or hardware capability is claimed as tested.
