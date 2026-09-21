# 03 — Offline and Sync Contract

**Status:** Revision 3 — normative Phase 1 pilot contract. SQL, API and Dexie implementation remain pending.

## 3.1 Operation identity and atomicity

One completed sale creates one immutable order operation:
```json
{
  "operation_id": "order UUID",
  "entity_type": "order",
  "schema_version": 1,
  "payload": {
    "order": {},
    "order_items": [],
    "payment": {},
    "audit_events": []
  }
}
```

order.id equals operation_id. Payment and line IDs are independent client UUIDs; the nested payment has no separate outbox operation. Customer creation has its own operation UUID and stable customer entity UUID.

At the server, check the durable operation ledger before processing. The ledger key is (store_id, operation_id), bound to device_id, entity_type and a canonical payload hash. Reuse with different content returns operation_id_conflict. A duplicate returns the original accepted receipt and acknowledgement checkpoint.

In one PostgreSQL transaction: claim the operation, validate it, insert order/items/payment/audit events, aggregate quantities by product, insert one inventory movement per distinct product, update stock, publish changes and finalize the replay result. Return accepted only after commit.

UNIQUE(store_id, operation_id, product_id) guards sale movements. UUIDs are never regenerated on retry. A rejected paid sale remains visible for reconciliation; do not delete it, silently change its customer, or mutate an already accepted payload.

## 3.2 Local sale and stock projection

Atomic Dexie checkout includes:
orders, order_items, payments, audit_log, stock_adjustments, outbox and sync_metadata.

For each product:
**displayed_stock = server_stock.current_stock + SUM(uncovered stock_adjustments.delta).**

A sale adds a negative adjustment keyed by (operation_id, product_id). It does not modify server_stock and does not create a standalone inventory movement operation.

An accepted push returns accepted_checkpoint, covering the sale's committed stock changes. Store this acknowledgement durably. Retain its local adjustment until last_pull_checkpoint >= accepted_checkpoint. Apply pull data, retire covered adjustments and advance the checkpoint in one local transaction.

On lost push responses, retry idempotently to recover accepted_checkpoint before advancing pull. If accepted outcomes cannot be resolved, defer pulls while keeping local checkout available. Thus a pull never includes a known outstanding sale without enough acknowledgement information to remove its local overlay.

Rejected sales keep their local adjustments until a manager completes an explicit reconciliation workflow; their physical stock effect does not disappear because upload failed. Label this stock as provisional.

## 3.3 Queue lifecycle and crash recovery

Eligible operations:
```text
status = pending
OR (status = failed AND failure_kind = connectivity AND next_attempt_at <= now)
```

New pending rows have failure_kind = NULL. Manual retry clears failure fields and next_attempt_at.

A database lease permits one active sync owner per installation. Claim a batch transactionally with lease_owner and lease_expires_at, then mark rows in_flight. Renew the lease while working. After restart or expired ownership, recover abandoned in_flight rows to pending, preserving operation IDs.

Only rows with explicit accepted/duplicate results become synced. A missing result, malformed response, network interruption, HTTP 429 or transient 5xx remains retryable. Authentication failures pause the queue for credential recovery. Do not classify every non-timeout condition as permanent validation failure.

Use exponential backoff: min(5 * 2^attempt, 300) seconds with ±20% jitter; honor Retry-After. Limit both operations (100 by default, 500 maximum) and encoded request size (1 MiB initially); the server advertises/enforces limits.

## 3.4 Dependencies and customer scope

Phase 1 supports customer creation and lookup only. Names are required; normalized phone is optional and is not a unique identity constraint. Duplicate phone records are permitted and shown as separate selectable customers. Editing, deduplication and merging are deferred.

Persist depends_on operation IDs on order outbox rows. Send customer creation first and wait for accepted/duplicate before sending dependent orders, including across batch boundaries. Server type sorting is only a convenience, not dependency resolution.

A failed dependency marks the order blocked with a visible reason; never silently replace customer_id with NULL. dependency_pending is retryable after its parent succeeds. Permanent parent failure requires explicit reconciliation with an audit trail.

## 3.5 Commit-safe pull feed

Do not use a PostgreSQL sequence allocated by concurrent transactions as a committed high-water mark.

Phase 1 uses a serialized per-store feed:
1. Every transaction publishing store changes first locks that store's sync_feed_state row with SELECT ... FOR UPDATE.
2. It allocates increasing positions by updating that transactional row, writes typed change_feed entries, and commits business rows and feed entries together.
3. It holds the lock until commit. The next writer cannot allocate higher positions until the previous transaction commits or rolls back.
4. This rule applies to catalog administration, employee changes and inventory changes alike. No bypass writes.

This deliberately serializes store writes for the pilot. Measure throughput before expanding deployment.

GET /sync/pull returns entries ordered by position, a next_checkpoint equal to the last returned position, and has_more. An empty page preserves the request checkpoint. Entries include entity_type, entity_id, action (upsert/delete), version and the device-safe payload.

Pull is store-scoped. Upsert payloads are full snapshots, not increments. Tombstones represent deletions. Apply page changes and checkpoint atomically. Parent-before-child event order and an initial consistent snapshot make referenced entities available.

Retain the feed for at least 90 days. If a checkpoint predates retained history, return checkpoint_expired and require a stable paginated snapshot plus subsequent changes. Resolve ambiguous push outcomes first; preserve local orders, blocked operations and stock adjustments during resnapshot.

The bootstrap snapshot is materialized under the same store lock and records its checkpoint; paginated reads use that immutable snapshot, not separately queried live tables. Snapshot expiry restarts bootstrap without deleting unsynced sales.

## 3.6 Replay retention

Keep accepted operation receipts and payload hashes for the lifetime of the associated business records; do not delete the idempotency ledger after 90 days. This also protects customer-create replay.

Synced local outbox payloads may be pruned after 30 days, provided their stock acknowledgement has been covered. Never prune pending, blocked, failed or ambiguous operations. Local sales/history retention is a separate policy.

Transient failures are not stored as permanent operation outcomes. Corrections to permanent rejections use a separately identified, audited reconciliation operation; repeated retry of unchanged invalid content is not a repair.

## 3.7 Device and employee authorization

Provisioning is an online administrator action. It creates an installation identity and device-bound refresh session. Short-lived access tokens authorize only the assigned store. Rotate refresh sessions and support explicit device revocation.

Employee selection plus salted PIN verification unlocks the local terminal. Persist a five-attempt/60-second lockout; also enforce online rate limits. Do not treat UI throttling as protection against extracted offline verifiers.

Session data includes employee_id, permission_version, logged_in_at and last_server_validated_at. Revalidate when online and lock immediately on a pulled deactivation or reduced permissions.

The Phase 1 policy disables manager overrides after 72 hours without server validation and checkout after seven days. Use last successful validation, not a resettable continuous-connectivity timer. Clock rollback must not extend authorization; detect rollback and require online validation. These are browser policy controls, not tamper-proof guarantees.

A current employee's expired or revoked session does not discard historical sales. The device uploads them with their original employee/approval snapshots; the server preserves them and flags authorization discrepancies for review. Explicit device revocation pauses uploads and requires administrator recovery while preserving the outbox.

Expired/invalid refresh credentials trigger online administrator reauthorization. Completed sales stay queued. First-time provisioning and expired offline authorization are explicit exceptions to network-independent checkout.

## 3.8 Errors and reconciliation

| Code/category | Behavior |
|---|---|
| connectivity_timeout, rate_limited, server_unavailable | Backoff and retry |
| authentication_required, device_revoked | Pause; show recovery action |
| dependency_pending | Block until prerequisite accepted |
| validation_failed, total_mismatch, operation_id_conflict, cross_store_reference | Preserve sale; require reviewed correction |
| checkpoint_expired | Resnapshot without clearing local business data |

Sync Center distinguishes pending, in_flight, retryable failure, blocked dependency/authentication, rejected and synced. These are derived UI states from status, failure_kind and reason_code. It must not show Online — Synced while unresolved rows remain.

## 3.9 Catalog, clocks and receipt numbering

Catalog entries are server-owned. Store catalog_version in configuration and snapshot it on each order item at cart insertion; resolve tax_rate_bps through the referenced tax record. Preserve product name, SKU, unit price and tax snapshots for receipt reprinting.

Server timestamps are assigned by the server for audit. They do not replace change-feed positions or optimistic versions. Reports use the captured sale time and store timezone, with clock anomalies flagged.

Receipt format: receipt_prefix + six-digit-minimum sequence. The prefix includes its trailing separator. Increment the installation's sequence in the checkout transaction; never reuse a prefix after reset/reprovisioning. The sequence grows beyond six digits without wrapping.

## 3.10 Required API surface

To be authored in api/openapi.yaml:
- POST /devices/provision; administrator-authorized installation creation.
- POST /auth/login, POST /auth/refresh; explicit employee/device session contracts.
- POST /sync/push; per-operation outcome, payload hash policy, dependencies and accepted_checkpoint.
- GET /sync/pull; typed changes, has_more, checkpoint expiry.
- POST /sync/snapshot and GET /sync/snapshot/:id; stable bootstrap/recovery pages.
- GET /sync/status; server telemetry only; local queue counts come from Dexie.
- GET /devices/:id/orders; authorized restoration of that installation's synced history.

Manual retry is a local queue action; no server /sync/retry endpoint is needed. Refund, merge, adjustment and reconciliation-write endpoints require separately specified contracts before implementation.
