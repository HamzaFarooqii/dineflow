import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { readReceipt, syncLabel, type SavedReceipt } from './data'
import { ReceiptOutput } from './ReceiptOutput'
import { useReceiptStore } from './useReceiptStore'
import { accessToken, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { requireSupabase } from '../lib/supabase'

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
  useEffect(() => {
    setReceipt(undefined); setError('')
    if (!scope.storeId) return
    const subscription = liveQuery(() => readReceipt(scope.storeId, orderId)).subscribe({ next: setReceipt,
      error: reason => setError(reason instanceof Error ? reason.message : 'Unable to read this check.') })
    return () => subscription.unsubscribe()
  }, [scope.storeId, orderId, attempt])
  const failure = scope.error || error

  // Refund is an owner/manager-only, web-session action (never on a cashier terminal) — resolve
  // that role the same way RegisterScreen resolves customer-access authorization.
  const [canRefund, setCanRefund] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [refundError, setRefundError] = useState('')
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
    if (!receipt || refunding) return
    if (!window.confirm(`Refund check ${receipt.order.receipt_number} for its full amount? This cannot be undone.`)) return
    setRefunding(true)
    setRefundError('')
    try {
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/orders/${receipt.order.id}/refund`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ store_id: receipt.order.store_id }),
      })
      const data = (await response.json()) as { code?: string; message?: string; refund?: { amount_cents: string } }
      if (!response.ok) {
        if (data.code === 'refund_conflict') {
          // The server already had this order refunded (e.g. a prior attempt succeeded but this
          // browser never heard back) — bring the local record in line rather than leaving it
          // permanently out of sync with reality.
          await posDb.orders.update(receipt.order.id, { refunded_at: new Date().toISOString(), refunded_amount_cents: receipt.order.total_cents })
          return
        }
        throw new Error(data.message ?? `Server error (${response.status})`)
      }
      const amountCents = data.refund ? Number(data.refund.amount_cents) : receipt.order.total_cents
      await posDb.orders.update(receipt.order.id, { refunded_at: new Date().toISOString(), refunded_amount_cents: amountCents })
    } catch (reason) {
      setRefundError(reason instanceof Error ? reason.message : 'Could not refund this check.')
    } finally {
      setRefunding(false)
    }
  }

  return <section className="receipt-page"><p className="kicker">SAVED CHECK</p><h1>Guest check.</h1>
    <div className="receipt-actions"><Link to={terminal ? '/pos/orders' : '/orders'}>← Back to checks</Link><Link to={terminal ? '/pos/register' : '/register'}>Open a check →</Link></div>
    {failure ? <div role="alert"><p>{failure}</p><button type="button" onClick={() => { scope.retry(); setAttempt(value => value + 1) }}>Try again</button></div>
      : receipt === undefined ? <p role="status">Loading saved check…</p>
      : receipt === null ? <div role="status"><h2>Check not found</h2><p>This check is not saved for this restaurant in this browser. Look under Orders on the terminal that closed it.</p></div>
      : <><p role="status">{fresh ? 'Check closed and saved in this browser. ' : ''}{syncLabel(receipt.order)}{receipt.order.failure_reason ? ` — ${receipt.order.failure_reason}` : ''}</p>
        <ReceiptOutput key={receipt.order.id} receipt={receipt} fresh={fresh} />
        {canRefund && receipt.order.sync_status === 'synced' && <div className="refund-action">
          {receipt.order.refunded_at
            ? <p role="status">Refunded {formatCents(receipt.order.refunded_amount_cents ?? receipt.order.total_cents, receipt.order.currency)} on {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(receipt.order.refunded_at))}.</p>
            : <><button type="button" className="cta" onClick={() => void submitRefund()} disabled={refunding}>{refunding ? 'Refunding…' : 'Refund this check'}</button>
              {refundError && <p role="alert" className="form-notice error">{refundError}</p>}</>}
        </div>}</>}
  </section>
}
