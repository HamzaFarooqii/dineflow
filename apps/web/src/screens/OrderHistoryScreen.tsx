import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Dexie, { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type OutboxEntry } from '../lib/db'
import { pushPendingOrders, retryOrder } from '../lib/order-sync'
import { classifySyncState, canRetrySync, SYNC_STATE_LABELS, type SyncState } from '../lib/order-sync-core'
import { saleDate, saleDay } from '../receipts/data'
import { receiptStore, useReceiptStore } from '../receipts/useReceiptStore'
import { fetchOrdersPage, type ServerOrderSummary } from '../lib/server-reports'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge, type BadgeTone } from '../components/StatusBadge'
import '../receipts/receipts.css'

// Mirrors the color choices .order-state already used (receipts.css) onto the shared chip.
const SYNC_STATE_TONE: Record<SyncState, BadgeTone> = {
  synced: 'success',
  pending: 'warning',
  in_flight: 'info',
  blocked: 'violet',
  rejected: 'danger',
}

export function OrderHistoryScreen({ terminal = false }: { terminal?: boolean }) {
  const scope = useReceiptStore(terminal)
  const [orders, setOrders] = useState<LocalOrder[]>()
  const [outboxByOrder, setOutboxByOrder] = useState<Map<string, OutboxEntry>>(new Map())
  const [query, setQuery] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [remoteOrders, setRemoteOrders] = useState<ServerOrderSummary[]>()
  const [remoteTruncated, setRemoteTruncated] = useState(false)
  const [remoteError, setRemoteError] = useState('')
  const [currency, setCurrency] = useState<string>()
  useEffect(() => {
    setOrders(undefined); setError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => posDb.orders.where('[store_id+client_generated_at]')
      .between([scope.storeId, Dexie.minKey], [scope.storeId, Dexie.maxKey]).reverse().toArray())
      .subscribe({ next: setOrders, error: reason => setError(reason instanceof Error ? reason.message : 'Unable to load checks saved on this terminal.') })
    // FEAT-STAT-02: the order's own sync_status collapses several outbox states into "pending";
    // join the outbox entries so the badge can show pending/in-flight/blocked/rejected/synced distinctly.
    const outboxSubscription = liveQuery(() => posDb.outbox.where('store_id').equals(scope.storeId).and(entry => entry.entity_type === 'order').toArray())
      .subscribe({ next: entries => setOutboxByOrder(new Map(entries.map(entry => [entry.order_id, entry]))) })
    return () => { subscription.unsubscribe(); outboxSubscription.unsubscribe() }
  }, [scope.storeId])
  useEffect(() => {
    // CashierPosLayout runs its own reconnect-sync trigger for every /pos/* screen, this one
    // included — skip this copy in terminal mode so the two don't fire concurrently.
    if (!scope.storeId || terminal) return
    const sync = async () => {
      try { if (await receiptStore(terminal) === scope.storeId) await pushPendingOrders(scope.storeId, terminal) }
      catch { /* Explicit sync reports errors; background retries preserve the local view. */ }
    }
    const handler = () => { if (navigator.onLine) void sync() }
    window.addEventListener('online', handler)
    const timer = window.setInterval(handler, 15_000)
    return () => { window.removeEventListener('online', handler); window.clearInterval(timer) }
  }, [scope.storeId, terminal])
  // A local order's day is judged by its own timezone_snapshot (the timezone recorded at sale
  // time), same as the search filter below — this can occasionally disagree with the server's
  // day boundary (computed from the store's *current* timezone setting) right at midnight or
  // after a store timezone change, which could show/hide a boundary order from either list.
  const hasLocalOrderForDate = useMemo(() => Boolean(date && orders?.some(order => saleDay(order) === date)), [date, orders])
  const showRemoteHistory = !terminal && Boolean(date) && orders !== undefined && !hasLocalOrderForDate
  // Backfill from the cross-device GET /reports/orders endpoint when this browser's local Dexie
  // history has nothing for the chosen date (new browser, lost local storage) — owner/manager view
  // only, since /reports/orders requires that Supabase-authenticated role and the cashier terminal
  // view is intentionally register-local. Only a summary is fetched (no line items/payment), so this
  // section is a read-only supplement, not a replacement for the local list.
  useEffect(() => {
    setRemoteOrders(undefined); setRemoteTruncated(false); setRemoteError('')
    if (!showRemoteHistory) return
    if (!navigator.onLine) { setRemoteError('You are offline. Reconnect to check other terminals for this date.'); return }
    let active = true
    void fetchOrdersPage(scope.storeId, date, null, 200)
      .then(page => {
        if (!active) return
        setRemoteOrders(page.orders)
        setRemoteTruncated(page.next_cursor !== null)
      })
      .catch(reason => { if (active) setRemoteError(reason instanceof Error ? reason.message : 'Unable to load checks from other terminals.') })
    return () => { active = false }
  }, [showRemoteHistory, scope.storeId, date])
  useEffect(() => {
    setCurrency(undefined)
    if (!scope.storeId) return
    let active = true
    void posDb.store_config.get(scope.storeId).then(config => { if (active && config) setCurrency(config.currency) })
    return () => { active = false }
  }, [scope.storeId])
  const sync = async (orderId?: string) => {
    if (!scope.storeId || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (!navigator.onLine) { setNotice('You are offline. Closed checks stay saved on this terminal; reconnect to sync.'); return }
      if (await receiptStore(terminal) !== scope.storeId) throw new Error('Restaurant access changed. Reload checks before syncing.')
      if (orderId) await retryOrder(orderId, scope.storeId, terminal)
      else await pushPendingOrders(scope.storeId, terminal)
      setNotice('Sync attempt finished. Review each status below; pending or rejected checks stay saved.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not sync checks.') }
    finally { setBusy(false) }
  }
  const visible = orders?.filter(order => (!date || saleDay(order) === date) &&
    `${order.receipt_number} ${saleDate(order)} ${saleDay(order)}`.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  return <section className="order-history receipt-history">
    <PageHeader
      kicker="SERVICE HISTORY"
      title="Closed checks."
      subtitle="Every check settled on this terminal, saved in this browser. Dates use the timezone recorded when the check was closed."
      actions={<Link className="cta" to={terminal ? '/pos/register' : '/register'}>Open a check</Link>}
    />
    <div className="history-tools"><label>Find check or date<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Check number or date" /></label>
      <label>Service date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      {(query || date) && <button type="button" onClick={() => { setQuery(''); setDate('') }}>Clear search</button>}
      <button type="button" onClick={() => void sync()} disabled={busy || !scope.storeId}>{busy ? 'Syncing...' : 'Sync pending checks'}</button></div>
    {(scope.error || error) && <div className="form-notice error" role="alert"><p>{scope.error || error}</p><button type="button" onClick={scope.retry}>Reload checks</button></div>}
    <p role="status">{notice}</p>
    {!scope.error && !error && orders === undefined && <p role="status">Loading closed checks...</p>}
    {orders?.length === 0 && <p>No checks have been closed on this terminal yet.</p>}
    {Boolean(orders?.length) && !visible.length && <p>No checks match your search.</p>}
    <div className="history-list">{visible.map(order => {
      const outboxEntry = outboxByOrder.get(order.id)
      const state: SyncState = outboxEntry ? classifySyncState(outboxEntry) : order.sync_status === 'synced' ? 'synced' : order.sync_status === 'failed' ? 'rejected' : 'pending'
      // Mirror retryOrderForStore's own gate (order-sync-core.ts): every failure kind except a
      // genuine server-side 'validation' rejection can be retried, including 'authentication'
      // once the cashier signs back in. Using the 5-way display state here would have wrongly
      // disabled retry for authentication failures too, since both share the 'rejected' badge.
      const canRetry = Boolean(order.failure_reason) && (outboxEntry ? canRetrySync(outboxEntry) : order.sync_status !== 'synced')
      const failureMsg = order.failure_reason
      return (
        <article key={order.id}>
          <div><strong>{order.receipt_number}</strong><small>{saleDate(order)} | {order.timezone_snapshot}</small></div>
          <b>{formatCents(order.total_cents, order.currency)}</b>
          <StatusBadge tone={SYNC_STATE_TONE[state]}>{SYNC_STATE_LABELS[state]}</StatusBadge>
          <Link className="receipt-detail-link" to={`${terminal ? '/pos/orders' : '/orders'}/${encodeURIComponent(order.id)}`}>View check / print</Link>
          {canRetry && <button type="button" disabled={busy} onClick={() => void sync(order.id)}>Retry now</button>}
          {failureMsg && <p className="history-reason">{failureMsg}</p>}
        </article>
      )
    })}</div>
    {showRemoteHistory && (
      <div className="remote-history">
        <h2>Closed on other terminals</h2>
        {remoteOrders === undefined && !remoteError && <p role="status">Checking other terminals for this date…</p>}
        {remoteError && <p className="history-reason">{remoteError}</p>}
        {Boolean(remoteOrders?.length) && !currency && (
          <p className="history-reason">This browser hasn't confirmed the restaurant's currency yet. Connect once with this browser signed in, then reopen this date to see amounts.</p>
        )}
        {remoteOrders?.length === 0 && <p>No checks were closed on other terminals for this date either.</p>}
        {Boolean(remoteOrders?.length) && currency && (
          <>
            <p className="screen-note">This browser has no saved copy of these checks, so only a summary is shown — the full check isn't available here.
              {remoteTruncated && ' Showing the first 200 checks for this date; more exist.'}</p>
            <div className="history-list">{remoteOrders!.map(order => (
              <article key={order.id}>
                <div><strong>{order.receiptNumber}</strong><small>{new Date(order.time).toLocaleString()}{order.cashierName ? ` | ${order.cashierName}` : ''}</small></div>
                <b>{formatCents(order.totalCents, currency)}</b>
                <StatusBadge tone="success">Synced</StatusBadge>
                <small>{order.itemCount} item{order.itemCount === 1 ? '' : 's'} | {order.paymentMethod}</small>
              </article>
            ))}</div>
          </>
        )}
      </div>
    )}
  </section>
}
