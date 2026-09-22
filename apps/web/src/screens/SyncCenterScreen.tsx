/**
 * SyncCenterScreen — /pos/sync
 * SYNC-01/02: the full local outbox queue for this store, with each entry's exact status,
 * failure reason, retry action, and a diagnostic JSON export. A fuller view of the same
 * outbox data the cashier dashboard's Sync Outbox tile summarizes (FEAT-STAT-02).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { posDb, type OutboxEntry } from '../lib/db'
import { retryOrder } from '../lib/order-sync'
import { classifySyncState, canRetrySync, SYNC_STATE_LABELS, type SyncState } from '../lib/order-sync-core'
import { receiptStore, useReceiptStore } from '../receipts/useReceiptStore'
import '../receipts/receipts.css'

function entryLabel(entry: OutboxEntry): string {
  try {
    const payload = JSON.parse(entry.payload) as { order?: { receipt_number?: string }; customer?: { name?: string } }
    if (entry.entity_type === 'customer') return payload.customer?.name ? `Guest: ${payload.customer.name}` : 'Guest record'
    return payload.order?.receipt_number ? `Check ${payload.order.receipt_number}` : 'Check'
  } catch { return entry.entity_type === 'customer' ? 'Guest record' : 'Check' }
}

export function SyncCenterScreen({ terminal = false }: { terminal?: boolean }) {
  const scope = useReceiptStore(terminal)
  const [entries, setEntries] = useState<OutboxEntry[]>()
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<SyncState | 'all'>('all')
  const [busyId, setBusyId] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setEntries(undefined); setLoadError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => posDb.outbox.where('store_id').equals(scope.storeId).toArray())
      .subscribe({
        next: rows => setEntries(rows.sort((a, b) => b.created_at.localeCompare(a.created_at))),
        error: reason => setLoadError(reason instanceof Error ? reason.message : 'Unable to load the sync queue.'),
      })
    return () => subscription.unsubscribe()
  }, [scope.storeId])

  const retry = async (entry: OutboxEntry) => {
    if (!scope.storeId || busyId !== null) return
    setBusyId(entry.id ?? -1); setNotice(''); setError('')
    try {
      if (!navigator.onLine) { setNotice('You are offline. This entry stays queued and will retry automatically once reconnected.'); return }
      if (await receiptStore(terminal) !== scope.storeId) throw new Error('Restaurant access changed. Reload before retrying.')
      await retryOrder(entry.operation_id, scope.storeId, terminal)
      setNotice(`Retry attempted for ${entryLabel(entry)}.`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not retry this entry.') }
    finally { setBusyId(null) }
  }

  const exportDiagnostics = () => {
    if (!entries) return
    const dump = JSON.stringify({ exported_at: new Date().toISOString(), store_id: scope.storeId, outbox: entries }, null, 2)
    const blob = new Blob([dump], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `sync-diagnostics-${scope.storeId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    document.body.appendChild(link); link.click(); link.remove()
    URL.revokeObjectURL(url)
  }

  const counts: Record<SyncState, number> = { pending: 0, in_flight: 0, blocked: 0, rejected: 0, synced: 0 }
  for (const entry of entries ?? []) counts[classifySyncState(entry)]++
  const visible = (entries ?? []).filter(entry => filter === 'all' || classifySyncState(entry) === filter)
  const byOperationId = new Map((entries ?? []).map(entry => [entry.operation_id, entry]))

  return <section className="order-history receipt-history"><p className="kicker">SYNC DIAGNOSTICS</p><h1>Sync center.</h1>
    <p className="screen-note">Every queued operation for this restaurant in this browser, exactly as the sync engine sees it. Nothing here can be dismissed or deleted while unsynced.</p>
    <div className="receipt-actions"><Link to={terminal ? '/pos/dashboard' : '/dashboard'}>← Back to dashboard</Link>
      <button type="button" onClick={exportDiagnostics} disabled={!entries?.length}>Export diagnostics (JSON)</button></div>

    <div className="history-tools" role="group" aria-label="Filter by sync state">
      {(['all', 'pending', 'in_flight', 'blocked', 'rejected', 'synced'] as const).map(state => <button key={state} type="button"
        aria-pressed={filter === state} className={filter === state ? 'selected' : ''} onClick={() => setFilter(state)}>
        {state === 'all' ? `All (${entries?.length ?? 0})` : `${SYNC_STATE_LABELS[state]} (${counts[state]})`}
      </button>)}
    </div>

    {(scope.error || loadError) && <div className="form-notice error" role="alert"><p>{scope.error || loadError}</p><button type="button" onClick={scope.retry}>Reload</button></div>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {!scope.error && !loadError && entries === undefined && <p role="status">Loading the sync queue…</p>}
    {entries?.length === 0 && <p>The sync queue is empty for this restaurant in this browser.</p>}
    {Boolean(entries?.length) && !visible.length && <p>No queue entries match this filter.</p>}

    <div className="history-list">{visible.map(entry => {
      const state = classifySyncState(entry)
      // Mirrors retryOrderForStore's own gate: every failure kind except a genuine server-side
      // 'validation' rejection is retryable, including 'authentication' once signed back in.
      const canRetry = canRetrySync(entry)
      const waitingOnBackoff = state !== 'synced' && state !== 'in_flight' && entry.next_attempt_at > new Date().toISOString()
      const dependencyLabels = (entry.depends_on ?? []).map(id => byOperationId.get(id) ? entryLabel(byOperationId.get(id)!) : 'another queued operation')
      return <article key={entry.id}>
        <div><strong>{entryLabel(entry)}</strong><small>{new Date(entry.created_at).toLocaleString()} · attempt {entry.attempt_count} · {entry.entity_type ?? 'order'}</small></div>
        <span className={`order-state ${state}`}>{SYNC_STATE_LABELS[state]}</span>
        {entry.entity_type !== 'customer' && <Link className="receipt-detail-link" to={`${terminal ? '/pos/orders' : '/orders'}/${encodeURIComponent(entry.order_id)}`}>View check</Link>}
        {canRetry && <button type="button" disabled={busyId !== null} onClick={() => void retry(entry)}>{busyId === (entry.id ?? -1) ? 'Retrying…' : 'Retry now'}</button>}
        {entry.failure_reason && <p className="history-reason">{entry.failure_reason}{entry.reason_code ? ` (${entry.reason_code})` : ''}</p>}
        {entry.failure_kind === 'authentication' && <p className="history-reason">Sign in again on this terminal, then retry — this entry is not permanently rejected.</p>}
        {dependencyLabels.length > 0 && <p className="history-reason">Depends on: {dependencyLabels.join(', ')}</p>}
        {waitingOnBackoff && <p className="history-reason">Next automatic retry around {new Date(entry.next_attempt_at).toLocaleTimeString()}.</p>}
      </article>
    })}</div>
  </section>
}
