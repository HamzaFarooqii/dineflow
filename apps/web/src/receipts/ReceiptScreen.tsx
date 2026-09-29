import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { fetchRemoteReceipt, readReceipt, syncLabel, type SavedReceipt } from './data'
import { ReceiptOutput } from './ReceiptOutput'
import { useReceiptStore } from './useReceiptStore'
import { accessToken, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { requireSupabase } from '../lib/supabase'
import { PageHeader } from '../components/PageHeader'

export function ReceiptScreen({ terminal = false }: { terminal?: boolean }) {
  const { orderId = '' } = useParams()
  const location = useLocation()
  // Navigation state only controls the initial-print label. Data always comes from Dexie.
  const navigationType = useNavigationType()
  const fresh = navigationType !== 'POP' && (location.state as { committedOrderId?: string } | null)?.committedOrderId === orderId
  const scope = useReceiptStore(terminal)
  const [receipt, setReceipt] = useState<SavedReceipt | null>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [remoteReceipt, setRemoteReceipt] = useState<SavedReceipt | null>()
  const [remoteError, setRemoteError] = useState('')
  useEffect(() => {
    setReceipt(undefined); setError(''); setRemoteReceipt(undefined); setRemoteError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => readReceipt(scope.storeId, orderId)).subscribe({ next: setReceipt,
      error: reason => setError(reason instanceof Error ? reason.message : 'Unable to read this check.') })
    return () => subscription.unsubscribe()
  }, [scope.storeId, orderId, attempt])
  // Cross-device fallback: only once the local read has definitively come back empty, and only
  // when online -- never races the local liveQuery, and a later local write (this same check
  // syncing in) still wins since the liveQuery above keeps re-running independently.
  useEffect(() => {
    if (receipt !== null || !scope.storeId || !navigator.onLine) return
    let active = true
    fetchRemoteReceipt(scope.storeId, orderId, terminal)
      .then(result => { if (active) setRemoteReceipt(result) })
      .catch(reason => { if (active) setRemoteError(reason instanceof Error ? reason.message : 'Unable to load this check from the server.') })
    return () => { active = false }
  }, [receipt, scope.storeId, orderId, terminal, attempt])
  const stillLoading = receipt === undefined || (receipt === null && remoteReceipt === undefined && navigator.onLine && !remoteError)
  const notFound = receipt === null && !stillLoading && (remoteReceipt === null || remoteReceipt === undefined)
  const effectiveReceipt = receipt ?? remoteReceipt ?? null
  const failure = scope.error || error

  // Refund is an owner/manager-only, web-session action (never on a cashier terminal) — resolve
  // that role the same way RegisterScreen resolves customer-access authorization.
  const [canRefund, setCanRefund] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundError, setRefundError] = useState('')
  const [partialRefund, setPartialRefund] = useState(false)
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({})
  const refundOperation = useRef(crypto.randomUUID())
  useEffect(() => {
    if (terminal || !scope.storeId) return
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user } } = await client.auth.getUser()
        if (!user) return
        const { data } = await client.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', scope.storeId).eq('active', true).limit(1)
        if (active) setCanRefund(data?.[0]?.role === 'owner' || data?.[0]?.role === 'manager')
      } catch { /* silent — the refund action just stays hidden if role resolution fails */ }
    })()
    return () => { active = false }
  }, [terminal, scope.storeId])

  // "Refunded" is derived straight from the local order record (receipt.order.refunded_at), not
  // from transient component state — posDb.orders.update() below feeds the same liveQuery this
  // screen already subscribes to, so the banner survives a reload instead of resetting to the
  // "Refund this receipt" button every time, and every screen reading local sales (reports, order
  // history) sees the same fact immediately.
  const submitRefund = async () => {
    const receipt = effectiveReceipt
    if (!receipt || refunding) return
    if (!window.confirm(`Refund check ${receipt.order.receipt_number} for the selected remaining items? This cannot be undone.`)) return
    setRefunding(true)
    setRefundError('')
    try {
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/orders/${receipt.order.id}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ store_id: receipt.order.store_id, operation_id: refundOperation.current,
          ...(partialRefund ? { items: Object.entries(refundQuantities).filter(([, quantity]) => quantity > 0).map(([order_item_id, quantity]) => ({ order_item_id, quantity })) } : {}) }),
      })
      const data = (await response.json()) as { code?: string; message?: string; refund?: { amount_cents: string } }
      if (!response.ok) {
        throw new Error(data.message ?? `Server error (${response.status})`)
      }
      const refreshed = await fetchRemoteReceipt(scope.storeId, receipt.order.id, terminal)
      if (!refreshed) throw new Error('Refund recorded. Reload the receipt to see its balance.')
      if (await posDb.orders.get(receipt.order.id)) await posDb.transaction('rw', posDb.orders, posDb.payments, async () => {
        await posDb.orders.put(refreshed.order)
        await posDb.payments.bulkPut(refreshed.payments ?? [refreshed.payment])
      })
      else setRemoteReceipt(refreshed)
      refundOperation.current = crypto.randomUUID()
      setRefundQuantities({})
    } catch (reason) {
      setRefundError(reason instanceof Error ? reason.message : 'Could not refund this check.')
    } finally {
      setRefunding(false)
    }
  }

  return <section className="receipt-page">
    <PageHeader
      kicker="SAVED CHECK"
      title="Guest check."
      actions={<>
        <Link className="secondary-cta" to={terminal ? '/pos/orders' : '/orders'}>← Back to checks</Link>
        <Link className="cta" to={terminal ? '/pos/register' : '/register'}>Open a check →</Link>
      </>}
    />
    {failure ? <div role="alert"><p>{failure}</p><button type="button" onClick={() => { scope.retry(); setAttempt(value => value + 1) }}>Try again</button></div>
      : stillLoading ? <p role="status">Loading saved check…</p>
      : notFound || !effectiveReceipt
        ? <div role="status"><h2>Check not found</h2><p>{remoteError || (!navigator.onLine ? 'This check is not saved for this restaurant in this browser. Reconnect to check the server, or look under Orders on the terminal that closed it.' : 'This check is not saved for this restaurant in this browser, and could not be found on the server. Look under Orders on the terminal that closed it.')}</p></div>
      : <><p role="status">{fresh ? 'Check closed and saved in this browser. ' : !receipt ? 'Loaded from the server — this check was closed on a different device. ' : ''}{syncLabel(effectiveReceipt.order)}{effectiveReceipt.order.failure_reason ? ` — ${effectiveReceipt.order.failure_reason}` : ''}</p>
        <ReceiptOutput key={effectiveReceipt.order.id} receipt={effectiveReceipt} fresh={fresh} />
        {canRefund && effectiveReceipt.order.sync_status === 'synced' && <div className="refund-action">
          {Boolean(effectiveReceipt.order.refunded_amount_cents) && <p role="status">Refunded {formatCents(effectiveReceipt.order.refunded_amount_cents!, effectiveReceipt.order.currency)}.</p>}
          {(effectiveReceipt.order.refunded_amount_cents ?? 0) < effectiveReceipt.order.total_cents && <>
            <label><input type="checkbox" checked={partialRefund} disabled={refunding} onChange={event => { setPartialRefund(event.target.checked); refundOperation.current = crypto.randomUUID() }} />Partial refund</label>
            {partialRefund && effectiveReceipt.items.map(item => <label key={item.id}>{item.snapshot_name} ? quantity to refund
              <input type="number" min={0} max={item.quantity} step={1} disabled={refunding} value={refundQuantities[item.id] ?? 0}
                onChange={event => { setRefundQuantities(current => ({ ...current, [item.id]: Number(event.target.value) })); refundOperation.current = crypto.randomUUID() }} />
            </label>)}
            <p className="screen-note">Refunds return to the original tenders, up to their remaining balance, with a proportional refund of each tender’s tip.</p>
            <button type="button" className="cta" onClick={() => void submitRefund()} disabled={refunding}>{refunding ? 'Refunding?' : partialRefund ? 'Refund selected items' : 'Refund remaining check'}</button>
          </>}
          {refundError && <p role="alert" className="form-notice error">{refundError}</p>}
        </div>}</>}
  </section>
}
