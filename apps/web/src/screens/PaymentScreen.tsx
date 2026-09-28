import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { calculateServiceCharge, formatCents, parseCents } from '../../../../packages/domain/src/money'
import { completeLocalSale, type SettlementTender } from '../lib/checkout'
import { posDb } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { closeOpenCheckAndRecordSale, saveOpenCheck, OpenCheckConflictError, type SaveCheckItem } from '../lib/open-checks'
import { SplitSettlement } from './SplitSettlement'
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
  const activeCheckId = usePosStore(state => state.activeCheckId)
  const activeCheckVersion = usePosStore(state => state.activeCheckVersion)
  const [method, setMethod] = useState<'cash' | 'card'>('cash')
  const [received, setReceived] = useState('')
  const [reference, setReference] = useState('')
  const [cardConfirmed, setCardConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [serviceChargeBps, setServiceChargeBps] = useState(0)
  const [catalogVersion, setCatalogVersion] = useState(1)
  const [split, setSplit] = useState(false)
  const [splitPayments, setSplitPayments] = useState<SettlementTender[] | null>(null)
  const [tip, setTip] = useState('')
  const paymentId = useRef(crypto.randomUUID())
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [employeeLoaded, setEmployeeLoaded] = useState(!terminal)
  useEffect(() => { if (storeId) void posDb.store_config.get(storeId).then(config => { if (config) { setCurrency(config.currency); setServiceChargeBps(config.service_charge_bps ?? 0); setCatalogVersion(config.catalog_version) } }) }, [storeId])
  useEffect(() => { if (terminal) void readTerminal().then(cache => { setEmployeeId(cache?.session?.employee_id ?? null); setEmployeeLoaded(true) }) }, [terminal])
  let lineTotal = 0
  let serviceChargeCents = 0
  let amountError = ''
  try {
    const cartTotals = totals()
    lineTotal = cartTotals.totalCents
    serviceChargeCents = calculateServiceCharge(cartTotals.subtotalCents - cartTotals.discountCents, serviceChargeBps)
  } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Sale amount is invalid.' }
  // Amount actually owed, service charge included -- checkout.ts computes this exact figure again
  // itself from the store's live service-charge rate and will reject a tender that falls short of
  // it, so this screen must never show or accept less than what completeLocalSale will require.
  const total = lineTotal + serviceChargeCents
  let tipCents = 0
  try { tipCents = tip.trim() ? parseCents(tip) : 0 } catch { amountError = 'Enter a valid tip in whole cents.' }
  const payable = total + tipCents
  let tender = 0
  if (method === 'card') tender = payable
  else if (received.trim()) { try { tender = parseCents(received) } catch (reason) { amountError = reason instanceof Error ? reason.message : 'Invalid cash amount.' } }
  const change = split ? (splitPayments ?? []).reduce((sum, payment) => sum + payment.change_cents, 0) : Math.max(0, tender - payable)
  const canComplete = items.length > 0 && Boolean(storeId) && !amountError && !busy && employeeLoaded &&
    (split ? Boolean(splitPayments) : method === 'cash' ? tender >= payable : cardConfirmed)
  const settlement: SettlementTender[] | undefined = split ? splitPayments ?? undefined : tipCents > 0 ? [{
    id: paymentId.current, method, amount_cents: total, tendered_cents: tender, change_cents: change, tip_cents: tipCents, reference: reference.trim() || null,
  }] : undefined
  const submit = async () => {
    if (!canComplete || inProgress.current) return
    inProgress.current = true
    setBusy(true); setError('')
    try {
      let result: { operationId: string }
      if (activeCheckId && activeCheckVersion) {
        // This cart is a resumed/held open check (lib/open-checks.ts) -- save the current cart to
        // it first (the cashier may have edited items since it was resumed) so the server-stored
        // check is what actually gets closed, then close it into a real order the exact same way
        // push() creates one, online (see open-checks.ts's header comment on why this path isn't
        // outboxed like completeLocalSale below).
        const saveItems: SaveCheckItem[] = items.map(item => ({
          id: item.lineId, productId: item.productId, snapshotName: item.name, snapshotSku: item.sku,
          snapshotPriceCents: item.unitPriceCents, snapshotTaxBps: item.taxRateBps, catalogVersion: item.catalogVersion,
          quantity: item.quantity, discount: item.discount,
          modifiers: item.modifiers.map(modifier => ({ optionId: modifier.optionId, groupName: modifier.groupName, optionName: modifier.optionName, priceDeltaCents: modifier.priceDeltaCents })),
        }))
        const saved = await saveOpenCheck(storeId, activeCheckId, activeCheckVersion, saveItems, serviceChargeBps, { customerId: selectedCustomer?.id ?? null, managerId: managerApproval?.managerId ?? null, managerApprovedAt: managerApproval?.approvedAt ?? null }, terminal)
        usePosStore.setState({ activeCheckVersion: saved.check.version })
        result = await closeOpenCheckAndRecordSale(storeId, activeCheckId, saved.check.version, method, tender, reference.trim() || null, serviceChargeBps, catalogVersion, terminal, settlement)
      } else {
        const approval = managerApproval ? { managerId: managerApproval.managerId, approvedAt: managerApproval.approvedAt } : null
        result = await completeLocalSale(items, storeId, method, tender, reference.trim() || null, selectedCustomer?.id ?? null, employeeId, approval, terminal, settlement)
        void pushPendingOrders(storeId, terminal).catch(() => undefined)
      }
      clearCart()
      navigate(`${terminal ? '/pos/orders' : '/orders'}/${encodeURIComponent(result.operationId)}`, { replace: true, state: { committedOrderId: result.operationId } })
    } catch (reason) {
      const failure = reason instanceof OpenCheckConflictError ? `${reason.message} Reload this check from Open Checks before trying again.`
        : reason instanceof Error ? reason.message : 'The check could not be saved.'
      setError((method === 'card' && cardConfirmed) || settlement?.some(payment => payment.method === 'card')
        ? `${failure} The external card payment may have been approved. Record reference ${reference.trim() || '(none entered)'} and reconcile it before charging again.`
        : `${failure} Check Orders before retrying if the connection was lost.`)
    }
    finally { inProgress.current = false; setBusy(false) }
  }
  return <section className="payment-page"><div className="pay-main"><Link to={terminal ? '/pos/register' : '/register'}>← Back to the check</Link><p className="kicker">PAYMENT</p>
    <h1>Payment</h1>{selectedCustomer && <p className="screen-note">Customer: {selectedCustomer.name} · {selectedCustomer.phone_normalized ? `+${selectedCustomer.phone_normalized}` : 'No phone'}</p>}{!items.length && <p className="form-notice error">This check is empty. Add menu items before taking payment.</p>}
    <label className="card-confirm"><input type="checkbox" checked={split} disabled={busy} onChange={event => setSplit(event.target.checked)} />Split payment</label>
    {split ? <SplitSettlement total={total} items={items} currency={currency} disabled={busy} onChange={setSplitPayments} /> : <>
    <fieldset className="methods"><legend>Select payment method</legend>
      <button type="button" className={method === 'cash' ? 'selected' : ''} onClick={() => setMethod('cash')}>Cash</button>
      <button type="button" className={method === 'card' ? 'selected' : ''} onClick={() => setMethod('card')}>Card (external)</button>
    </fieldset>
    <label>Tip (optional)<input inputMode="decimal" value={tip} onChange={event => { setTip(event.target.value); setCardConfirmed(false) }} placeholder="0.00" /></label>
    {method === 'cash' ? <label>Amount received<input className="money-input" type="text" inputMode="decimal" value={received}
      onChange={event => setReceived(event.target.value)} placeholder="0.00" autoComplete="off" /><span className="quick-tender" aria-label="Quick cash amounts">
        <button type="button" onClick={() => setReceived((payable / 100).toFixed(2))}>Exact amount</button>
        {[2000, 5000, 10000].map(amount => <button type="button" key={amount} onClick={() => setReceived((amount / 100).toFixed(2))}>{formatCents(amount, currency)}</button>)}
      </span></label> : <>
      <label>External payment reference (optional)<input type="text" maxLength={120} value={reference} onChange={event => setReference(event.target.value)} /></label>
      <label className="card-confirm"><input type="checkbox" checked={cardConfirmed} onChange={event => setCardConfirmed(event.target.checked)} /> I confirm the external card payment was approved.</label>
    </>}
    </>}
    {amountError && <p className="form-notice error" role="alert">{amountError}</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
  </div><aside className="payment-summary"><div className={`change ${change > 0 ? 'positive' : ''}`}><small>Change due</small><b>{formatCents(change, currency)}</b></div>
    <div className="summary-lines">
      {serviceChargeCents > 0 && <>
        <span>Total before service charge <b>{formatCents(lineTotal, currency)}</b></span>
        <span>Service charge <b>{formatCents(serviceChargeCents, currency)}</b></span>
      </>}
      <strong>Amount to record <b>{formatCents(total, currency)}</b></strong>
      <span>Tips <b>{formatCents(split ? (splitPayments ?? []).reduce((sum, payment) => sum + (payment.tip_cents ?? 0), 0) : tipCents, currency)}</b></span>
    </div>
    <button className="cta" type="button" disabled={!canComplete} onClick={() => void submit()}>{busy ? 'Closing check…' : 'Close check'}</button>
    <p className="screen-note">{activeCheckId ? 'This held check closes online.' : 'The receipt is saved locally before sync begins.'}</p></aside></section>
}
