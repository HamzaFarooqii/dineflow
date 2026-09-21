import { posDb, type OutboxEntry } from './db'

// FEAT-STAT-02: five distinct sync states, derived from the same OutboxEntry fields the sync
// engine already tracks (status, failure_kind, lease). Connectivity failures are folded into
// 'pending' because the engine keeps retrying them automatically; only 'rejected' needs a human.
export type SyncState = 'pending' | 'in_flight' | 'blocked' | 'rejected' | 'synced'

export function classifySyncState(entry: Pick<OutboxEntry, 'status' | 'failure_kind' | 'lease_owner' | 'lease_expires_at'>, now = Date.now()): SyncState {
  if (entry.status === 'synced') return 'synced'
  if (entry.lease_owner && entry.lease_expires_at && Date.parse(entry.lease_expires_at) > now) return 'in_flight'
  if (entry.failure_kind === 'dependency') return 'blocked'
  if (entry.failure_kind === 'validation' || entry.failure_kind === 'authentication') return 'rejected'
  return 'pending'
}

export const SYNC_STATE_LABELS: Record<SyncState, string> = {
  pending: 'Pending sync',
  in_flight: 'Syncing…',
  blocked: 'Blocked — waiting on dependency',
  rejected: 'Rejected — needs review',
  synced: 'Synced',
}

// The 'rejected' SyncState covers two different failure_kinds that the retry engine treats
// differently: 'validation' is a genuine, permanent server rejection (retrying resends the same
// invalid data), while 'authentication' just needs the cashier to sign back in — retryOrderForStore
// already allows it. Mirror that exact rule here so the UI never disables a retry the engine supports.
export function canRetrySync(entry: Pick<OutboxEntry, 'status' | 'failure_kind'>): boolean {
  return entry.status !== 'synced' && entry.failure_kind !== 'validation'
}

export type PushReply = {
  ok: boolean
  status: number
  body: { status?: string; operation_id?: string; accepted_checkpoint?: string; code?: string; message?: string }
}
export type SendOperation = (entry: OutboxEntry) => Promise<PushReply>

const owner = crypto.randomUUID()
function nextAttempt(attempt: number): string {
  const delaySeconds = Math.min(300, 5 * 2 ** Math.min(attempt, 6))
  return new Date(Date.now() + delaySeconds * 1000).toISOString()
}
async function claimOne(storeId: string): Promise<OutboxEntry | undefined> {
  return posDb.transaction('rw', posDb.outbox, posDb.orders, async () => {
    const now = new Date().toISOString()
    const entries = await posDb.outbox.where('store_id').equals(storeId).toArray()
    const byOperation = new Map(entries.map(row => [row.operation_id, row]))
    const ordered = entries.sort((a, b) => (a.entity_type === 'customer' ? 0 : 1) - (b.entity_type === 'customer' ? 0 : 1) || a.created_at.localeCompare(b.created_at))
    let entry: OutboxEntry | undefined
    for (const row of ordered) {
      if (!(row.status === 'pending' || row.failure_kind === 'connectivity' || row.failure_kind === 'dependency') ||
          row.next_attempt_at > now || (row.lease_expires_at && row.lease_expires_at >= now)) continue
      const parent = (row.depends_on ?? []).map(id => byOperation.get(id))
      // Only wait if there is a dependency that is still pending or retrying.
      // If a dependency failed server validation permanently, do not block the sale:
      // the server will accept the order without the customer link so the sale is not lost.
      const pendingParent = parent.filter(dependency => !dependency || (dependency.status !== 'synced' && dependency.failure_kind !== 'validation'))
      if (pendingParent.length > 0) {
        if (row.id && row.entity_type !== 'customer') {
          const reason = 'Waiting for customer to sync before this sale can proceed.'
          await posDb.outbox.update(row.id, {
            failure_kind: 'dependency',
            reason_code: 'dependency_pending',
            failure_reason: reason,
            next_attempt_at: nextAttempt(row.attempt_count),
          })
          await posDb.orders.update(row.order_id, { sync_status: 'pending', failure_reason: reason })
        }
        continue
      }
      entry = row
      break
    }
    if (!entry?.id) return undefined
    const claimed = { ...entry, lease_owner: owner, lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      attempt_count: entry.attempt_count + 1 }
    await posDb.outbox.put(claimed)
    return claimed
  })
}
async function finish(entry: OutboxEntry, accepted: boolean, code: string | null, message: string | null,
  checkpoint: string | null, failureKind: OutboxEntry['failure_kind']) {
  await posDb.transaction('rw', posDb.outbox, posDb.orders, posDb.customers, posDb.stock_adjustments, posDb.sync_metadata, async () => {
    const current = await posDb.outbox.get(entry.id!)
    if (!current || current.lease_owner !== owner) return
    await posDb.outbox.put({ ...current, status: accepted ? 'synced' : 'failed', failure_kind: failureKind,
      reason_code: code, failure_reason: message, accepted_checkpoint: checkpoint,
      lease_owner: null, lease_expires_at: null,
      next_attempt_at: failureKind === 'connectivity' ? nextAttempt(current.attempt_count) : current.next_attempt_at })
    if (entry.entity_type === 'customer') {
      const payload = JSON.parse(entry.payload) as { customer: { id: string } }
      await posDb.customers.update(payload.customer.id, { sync_status: accepted ? 'synced' : failureKind === 'validation' ? 'failed' : 'pending', failure_reason: message })
    } else await posDb.orders.update(entry.order_id, { sync_status: accepted ? 'synced' : failureKind === 'validation' ? 'failed' : 'pending',
      accepted_checkpoint: checkpoint, failure_reason: message })
    if (accepted) {
      const adjustments = await posDb.stock_adjustments.where('operation_id').equals(entry.operation_id).toArray()
      for (const adjustment of adjustments) await posDb.stock_adjustments.put({ ...adjustment, accepted_checkpoint: checkpoint })
      // FEAT-SET-01: the terminal settings screen needs a "last successful sync" timestamp,
      // scoped per store since one browser's IndexedDB can hold data for a device that
      // moved between stores after reprovisioning.
      await posDb.sync_metadata.put({ key: `last_synced_at:${current.store_id}`, value: new Date().toISOString() })
    } else if (failureKind === 'validation') {
      // A permanently-rejected sale never gets an accepted_checkpoint, so loadCatalog's
      // checkpoint-based cleanup (catalog.ts) would never purge its optimistic stock delta.
      // Roll it back explicitly so displayed stock doesn't drift from a sale that never happened.
      await posDb.stock_adjustments.where('operation_id').equals(entry.operation_id).delete()
    }
  })
}

export async function pushOrdersForStore(storeId: string, send: SendOperation): Promise<number> {
  if (!navigator.onLine) return 0
  let accepted = 0
  for (let count = 0; count < 100; count++) {
    const entry = await claimOne(storeId)
    if (!entry) break
    try {
      const response = await send(entry)
      const body = response.body
      if (response.ok && (body.status === 'accepted' || body.status === 'replayed') && body.operation_id === entry.operation_id &&
        typeof body.accepted_checkpoint === 'string' && /^\d+$/.test(body.accepted_checkpoint)) {
        await finish(entry, true, null, null, body.accepted_checkpoint, null)
        accepted += 1
      } else if (response.status === 401 || response.status === 403) {
        await finish(entry, false, body.code ?? 'authentication_required', body.message ?? 'Sign in to resume sync.', null, 'authentication')
        break
      } else if ([400, 409, 422].includes(response.status)) {
        await finish(entry, false, body.code ?? 'validation_failed', body.message ?? 'Sale needs review.', null, 'validation')
      } else {
        await finish(entry, false, body.code ?? 'server_unavailable', body.message ?? 'Sync will retry later.', null, 'connectivity')
        break
      }
    } catch {
      await finish(entry, false, 'connectivity_timeout', 'Could not reach the server. Sync will retry.', null, 'connectivity')
      break
    }
  }
  return accepted
}

export async function retryOrderForStore(operationId: string, storeId: string, send: SendOperation) {
  const entry = (await posDb.outbox.where('operation_id').equals(operationId).first())
    ?? (await posDb.outbox.where('order_id').equals(operationId).first())
  // Allow retry for connectivity, authentication, and dependency failures.
  // Do NOT allow retry for genuine server-side validation failures (the server will reject again).
  if (!entry || entry.store_id !== storeId || entry.status === 'synced') return
  if (entry.failure_kind === 'validation') return
  await posDb.outbox.update(entry.id!, { status: 'pending', failure_kind: null, reason_code: null,
    failure_reason: null, next_attempt_at: new Date().toISOString(), lease_owner: null, lease_expires_at: null })
  if (entry.entity_type === 'customer') {
    const payload = JSON.parse(entry.payload) as { customer: { id: string } }
    await posDb.customers.update(payload.customer.id, { sync_status: 'pending', failure_reason: null })
  } else {
    await posDb.orders.update(entry.order_id, { sync_status: 'pending', failure_reason: null })
    if (entry.depends_on?.length) {
      for (const parentOpId of entry.depends_on) {
        const parentEntry = await posDb.outbox.where('operation_id').equals(parentOpId).first()
        if (parentEntry && parentEntry.status !== 'synced') {
          await posDb.outbox.update(parentEntry.id!, {
            status: 'pending', failure_kind: null, reason_code: null, failure_reason: null,
            next_attempt_at: new Date().toISOString(), lease_owner: null, lease_expires_at: null,
          })
          if (parentEntry.entity_type === 'customer') {
            try {
              const payload = JSON.parse(parentEntry.payload) as { customer: { id: string } }
              await posDb.customers.update(payload.customer.id, { sync_status: 'pending', failure_reason: null })
            } catch { /* ignore parse error */ }
          }
        }
      }
    }
  }
  await pushOrdersForStore(storeId, send)
}
