# 06 — Integration, Delivery and Verification

**Status:** Revised against PRD v3.0. Pilot implementation plan; no production sign-off.
**Evidence:** Only these six documents are currently present. SQL migrations, Dexie implementation, OpenAPI and executable verification must still be created.

## 1. Source ownership

| Document | Owns |
|---|---|
| 01 | Stack, numeric representation and platform boundary |
| 02 | Components, trust boundaries and deployment lifecycle |
| 03 | Operation, queue, dependency, cursor and authentication protocols |
| 04 | Central/local data models and transaction scopes |
| 05 | User behavior, exact money rules, scope and acceptance targets |
| 06 | Integration sequence, deliverables and release evidence |

A change to a contract must update its owning document and dependent references in the same review. Do not maintain independent contradictory copies of sync pseudocode.

## 2. End-to-end flows

### 2.1 Provision and unlock

Administrator provisions online; the server assigns installation identity, receipt prefix and device session. Client installs the cached app shell and obtains a stable snapshot containing store configuration, employee verifiers, catalog and stock. It applies changes after the snapshot checkpoint and marks bootstrap complete.

Employee selects their identity and enters a PIN. Local verification unlocks only within the authorization window. Successful online validation refreshes permissions and last_server_validated_at. Offline limits are 72 hours for manager approval and seven days for checkout, both Phase 1 MUST requirements.

### 2.2 Complete a sale

Capture line snapshots and manager evidence where necessary. Validate totals. In one Dexie transaction allocate the receipt sequence and write orders, order_items, payments, audit_log, stock_adjustments and outbox.

After commit show receipt completion. Print failure offers reprint. Optional WhatsApp opens a prepared message; it does not establish delivery or work without the required external connectivity.

For external card: present total, process on the independent terminal, record approved reference when available, then explicitly confirm in the POS. If recording fails after approval, preserve recovery context and reconcile the already charged payment; never automatically charge again.

### 2.3 Push

Acquire/renew the sync lease. Resolve device authentication. Recover stale in_flight rows. Select pending rows or due connectivity failures. Flush customer prerequisites and await acceptance before their orders.

Claim rows with a lease, send the immutable operations, and process each response independently. The server commits complete business records, grouped product movements, audit evidence, feed positions and operation receipt before returning accepted_checkpoint.

Persist accepted/duplicate results and stock acknowledgement positions atomically. Unanswered operations remain retryable with their original IDs. Authentication and dependency blocks are distinct from invalid content.

### 2.4 Pull and converge

Recover all ambiguous push results before pulling. Fetch the store-scoped committed feed after the local checkpoint.

In one Dexie transaction apply full cache snapshots/tombstones, retire local stock adjustments covered by accepted_checkpoint, and advance last_pull_checkpoint. Repeat while has_more.

If feed history expired, request a stable snapshot. Preserve unsynced business records, dependencies and stock adjustments while replacing server-owned caches. Restore historical synced orders separately where required.

### 2.5 Reconcile

Sync Center exposes unresolved paid orders without allowing deletion. Retry transient failures automatically and unchanged validation failures only on explicit action after a relevant fix.

Permanent data/authorization discrepancies require administrator review. A dedicated audited correction contract must be specified before building any feature that alters a rejected sale. Until then, retain/export the record and mark the pilot case unresolved; do not label it synced.

## 3. Required implementation artifacts

| Deliverable | Purpose | Current evidence |
|---|---|---|
| api/openapi.yaml | Exact request/result types, limits, authorization, checkpoints and error codes | Not present |
| db/postgres/migrations | Tables, composite references, money constraints, store lock/feed publication, stock projection and replay ledger | Not present |
| Client Dexie schema/migrations | Stores, indexes, safe upgrade path and transaction scopes | Not present |
| Shared domain validation | Money calculation, snapshot checks and approval rules | Not present |
| Seed/import tooling | Store, employees with unique credentials, catalog and opening stock through controlled publication | Not present |
| Integration test suite | Failures, replay, concurrent commit/pull and recovery | Not present |
| Hardware test record | Exact OS/browser/scanner/printer combinations | Not present |
| Operational runbook | Credentials, backup/restore, storage loss, rejected sales and deployment rollback | Not present |

Do not paste SQL from a machine-specific file URL or invent success checkmarks. Run committed migrations through a repeatable command once available. Table existence alone does not verify constraints, triggers or behavior.

## 4. Seven-day pilot plan

Dates are relative to the agreed sprint start. The schedule assumes three developers and may move when acceptance reveals defects.

| Day | Developer 1 — UI | Developer 2 — local persistence | Developer 3 — API/database |
|---|---|---|---|
| 1 | Shell, employee selection, reference hardware print/scanner spike | Dexie schema, migrations, provisioning persistence | OpenAPI, SQL migrations, device authorization, feed lock design |
| 2 | Cart and exact totals | Repository validation, shared math, local customer creation | Stable snapshot, catalog publication, safe seed/import |
| 3 | Payment, manager modal and receipt recovery | Atomic checkout, receipt sequence, stock adjustments and audit | Atomic order push, grouped movements, durable replay result |
| 4 | Sync Center and failure states | Queue lease, dependency handling and crash recovery | Pull feed, token refresh, authorization boundaries |
| 5 | Local history, reports and diagnostics | Stock acknowledgement convergence and resnapshot | History recovery, oversell visibility and concurrent write tests |
| 6 | Named browser/hardware checks | Storage-full, upgrade, restart and quota-denial scenarios | Deploy pilot environment, backup/restore and load checks |
| 7 | Complete scenario walkthrough | Offline backlog and cross-terminal reconciliation | End-to-end evidence review; pilot go/no-go |

Service-worker offline installation and printing are validated early, not left until the final day. Optional camera scanning and WhatsApp are added only after the critical flow passes.

## 5. Release gates

Record automated results or reproducible manual steps and observations for each gate. A planned test is not a passed test.

| Gate | Required result |
|---|---|
| Atomicity | Inject failure at each checkout write; no partial order/payment/outbox/sequence effect remains. |
| Duplicate completion | Double-click, reload and retry do not create a second sale. |
| First push | A new pending row with failure_kind NULL is selected and accepted. |
| Crash recovery | Kill the tab after claim, after server commit and before response persistence; eventual replay produces one sale and one stock effect. |
| Tab ownership | Two tabs cannot simultaneously own checkout/sync; expired owner can be recovered. |
| Partial batch | Missing responses retry; accepted rows remain accepted; transient and permanent failures remain distinguishable. |
| Dependencies | Customer/order in different batches and rejected parent preserve references and block visibly without silent data loss. |
| Repeated product | Multiple lines for one product yield one movement with the summed negative quantity. |
| Stock convergence | Local sale during sync, partial push and lost acknowledgement never erase an uncovered deduction or double-apply a covered one. |
| Concurrent feed | Hold writer A open, start B, pull during both and after commits/rollback; no published update is skipped by checkpoint advancement. |
| Pull atomicity | Crash between cache write and checkpoint attempt leaves both committed or neither; retries converge. |
| Snapshot recovery | Paginated bootstrap under concurrent writes and expired-checkpoint recovery preserve all later changes and unsynced records. |
| Replay longevity | Retry an old accepted operation after feed/local outbox retention; original outcome remains recoverable. |
| Arithmetic | Half-cent rounding, discount limit, amount bounds, payment mismatch and historical-price acceptance agree client/server. |
| Tenant boundary | Device from store A cannot read/write/reference store B entities or recover B history. |
| Authorization | Inactive cashier, reduced permission, expired refresh, revoked device and 72h/7d windows have defined visible results; existing paid sales are retained. |
| Audit | Required manager evidence commits with the order, survives push replay and cannot authorize an altered cart. |
| Storage | Denied persistence, quota exhaustion and storage loss show correct recovery and never claim an uncommitted sale succeeded. |
| External payment | Card approval followed by local write failure leads to reconciliation without a second automatic charge. |
| Upgrade | App and Dexie upgrade with queued orders preserves operation IDs and payloads and does not clear storage. |
| Receipts | Approved printer path passes offline print/reprint; reprovisioning generates a new prefix and avoids collisions. |
| Reporting | Local midnight/timezone boundaries and delayed upload do not move a sale into upload-day totals. |
| Operations | Restore a server backup; document unresolved local-data-loss exposure and tested recovery procedure. |

## 6. Decision rule

The seven-day outcome is a controlled pilot only if the core checkout, sync, authorization, hardware and recovery gates pass. Unresolved paid-sale reconciliation and unsynced-data-loss recovery must be explicitly addressed before production use.

Remove unsupported claims such as “every ambiguity resolved,” “all printers compatible,” or “verified in live schemas” until corresponding evidence is checked in. No production readiness approval is granted by this document.
