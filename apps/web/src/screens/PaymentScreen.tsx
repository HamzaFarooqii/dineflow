import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { formatCents, parseCents } from '../../../../packages/domain/src/money'
import { completeLocalSale } from '../lib/checkout'
import { posDb } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { readTerminal } from '../terminal-auth/cache'

export function PaymentScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const inProgress = useRef(false)
  const items = usePosStore(state => state.items)
  const storeId = usePosStore(state => state.storeId)
  const clearCart = usePosStore(state => state.clearCart)
  const selectedCustomer = usePosStore(state => state.selectedCustomer)
  const managerApproval = usePosStore(state => state.managerApproval)
  const totals = usePosStore(state => state.totals)
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [received, setReceived] = useState('')
  const [reference, setReference] = useState('')
  const [cardConfirmed, setCardConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [employeeLoaded, setEmployeeLoaded] = useState(!terminal)
  useEffect(() => { if (storeId) void posDb.store_config.get(storeId).then(config => { if (config) setCurrency(config.currency) }) }, [storeId])
  useEffect(() => { if (terminal) void readTerminal().then(cache => { setEmployeeId(cache?.session?.employee_id ?? null); setEmployeeLoaded(true) }) }, [terminal])
  let total = 0
  let amountError = ''
  try { total = totals().totalCents } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Sale amount is invalid.' }
  let tender = 0
  if (method === 'card') tender = total
  else if (received.trim()) { try { tender = parseCents(received) } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Invalid cash amount.' } }
  const change = tender >= total ? tender - total : 0
  const canComplete = items.length > 0 && Boolean(storeId) && !amountError && !busy && employeeLoaded &&
    (method === 'cash' ? tender >= total : cardConfirmed)
  const submit = async () => {
    if (!canComplete || inProgress.current) return
    inProgress.current = true
    setBusy(true); setError('')
    try {
      const approval = managerApproval ? { managerId: managerApproval.managerId, approvedAt: managerApproval.approvedAt } : null
      const result = await completeLocalSale(items, storeId, method, tender, reference.trim() || null, selectedCustomer?.id ?? null, employeeId, approval)
      clearCart()
      void pushPendingOrders(storeId, terminal).catch(() => undefined)
      navigate(`${terminal ? '/pos/orders' : '/orders'}/${encodeURIComponent(result.operationId)}`, { replace: true, state: { committedOrderId: result.operationId } })
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : 'The check could not be saved.'
      setError(method === 'card' && cardConfirmed
        ? `${failure} The external card payment may have been approved. Record reference ${reference.trim() || '(none entered)'} and reconcile it before charging again.`
        : `${failure} No receipt was issued.`)
    }
    finally { inProgress.current = false; setBusy(false) }
  }
  return <section className="payment-page"><div className="pay-main"><Link to={terminal ? '/pos/register' : '/register'}>← Back to the check</Link><p className="kicker">PAYMENT</p>
    <h1>Payment</h1>{selectedCustomer && <p className="screen-note">Customer: {selectedCustomer.name} · {selectedCustomer.phone_normalized ? `+${selectedCustomer.phone_normalized}` : 'No phone'}</p>}{!items.length && <p className="form-notice error">This check is empty. Add menu items before taking payment.</p>}
    <fieldset className="methods"><legend>Select payment method</legend>
      <button type="button" className={method === 'cash' ? 'selected' : ''} onClick={() => setMethod('cash')}>Cash</button>
      <button type="button" className={method === 'card' ? 'selected' : ''} onClick={() => setMethod('card')}>Card (external)</button>
    </fieldset>
    {method === 'cash' ? <label>Amount received<input className="money-input" type="text" inputMode="decimal" value={received}
      onChange={event => setReceived(event.target.value)} placeholder="0.00" autoComplete="off" /><span className="quick-tender" aria-label="Quick cash amounts">
        <button type="button" onClick={() => setReceived((total / 100).toFixed(2))}>Exact amount</button>
        {[2000, 5000, 10000].map(amount => <button type="button" key={amount} onClick={() => setReceived((amount / 100).toFixed(2))}>{formatCents(amount, currency)}</button>)}
      </span></label> : <>
      <label>External payment reference (optional)<input type="text" maxLength={120} value={reference} onChange={event => setReference(event.target.value)} /></label>
      <label className="card-confirm"><input type="checkbox" checked={cardConfirmed} onChange={event => setCardConfirmed(event.target.checked)} /> I confirm the external card payment was approved.</label>
    </>}
    {amountError && <p className="form-notice error" role="alert">{amountError}</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
  </div><aside className="payment-summary"><div className={`change ${change > 0 ? 'positive' : ''}`}><small>Change due</small><b>{formatCents(change, currency)}</b></div>
    <div className="summary-lines"><span>Total <b>{formatCents(total, currency)}</b></span><strong>Amount to record <b>{formatCents(total, currency)}</b></strong></div>
    <button className="cta" type="button" disabled={!canComplete} onClick={() => void submit()}>{busy ? 'Closing check…' : 'Close check'}</button>
    <p className="screen-note">The receipt is saved locally before sync begins.</p></aside></section>
}
