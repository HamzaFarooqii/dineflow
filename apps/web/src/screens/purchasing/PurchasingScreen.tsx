import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { formatCents } from '../../../../../packages/domain/src/money'
import { requireSupabase } from '../../lib/supabase'
import { posDb } from '../../lib/db'
import { loadRecipeData } from '../menu/recipe-api'
import type { RecipeUnit } from '../menu/recipe-draft'
import {
  cancelPurchaseOrder, createPurchaseOrder, createVendor, fetchPurchaseOrder, fetchPurchaseOrders,
  fetchPurchasingReport, fetchVendors, receivePurchaseOrder, sendPurchaseOrder, updateVendor,
  type PurchaseOrder, type PurchaseOrderDetail, type PurchasingReport, type Vendor,
} from '../../lib/purchasing'
import { PageHeader } from '../../components/PageHeader'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'
import { Plus, Mail, Phone, Truck } from '../../components/icons'
import './purchasing.css'

interface Ingredient { id: string; name: string; unit_id: string; cost_per_unit_cents: number }

type Tab = 'orders' | 'vendors' | 'report'

export function PurchasingScreen() {
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('orders')

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [orders, setOrders] = useState<PurchaseOrder[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [units, setUnits] = useState<RecipeUnit[]>([])
  const [report, setReport] = useState<PurchasingReport | null>(null)

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [vendorDialogOpen, setVendorDialogOpen] = useState(false)
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null)
  const [poDialogOpen, setPoDialogOpen] = useState(false)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [receiveNotice, setReceiveNotice] = useState('')

  const unitsById = useMemo(() => new Map(units.map(u => [u.id, u])), [units])
  const activeVendors = useMemo(() => vendors.filter(v => v.active), [vendors])
  const selectedOrder = useMemo(() => orders.find(o => o.id === selectedOrderId) ?? null, [orders, selectedOrderId])

  useEffect(() => {
    let active = true
    async function load() {
      try {
        if (!navigator.onLine) throw new Error('Connect to load purchasing.')
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to view purchasing.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id')
          .eq('user_id', user.id).eq('active', true).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        const config = await posDb.store_config.get(id)
        if (active) { setStoreId(id); if (config?.currency) setCurrency(config.currency) }
        const [vendorList, orderList, recipeData] = await Promise.all([
          fetchVendors(id, true),
          fetchPurchaseOrders(id),
          loadRecipeData(id),
        ])
        if (active) {
          setVendors(vendorList)
          setOrders(orderList)
          setUnits(recipeData.units)
          setIngredients(recipeData.ingredients ?? [])
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load purchasing.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (tab !== 'report' || !storeId || report) return
    void fetchPurchasingReport(storeId).then(setReport).catch(() => undefined)
  }, [tab, storeId, report])

  async function openOrder(orderId: string) {
    setSelectedOrderId(orderId)
    setReceiveOpen(false)
    setDetailError('')
    setDetailBusy(true)
    try {
      setDetail(await fetchPurchaseOrder(storeId, orderId))
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Could not load this purchase order.')
    } finally { setDetailBusy(false) }
  }

  function applyDetail(next: PurchaseOrderDetail) {
    setDetail(next)
    setOrders(current => current.map(o => o.id === next.purchase_order.id ? next.purchase_order : o))
  }

  async function handleSend() {
    if (!selectedOrderId) return
    setDetailBusy(true); setDetailError('')
    try { applyDetail(await sendPurchaseOrder(storeId, selectedOrderId)) }
    catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Could not send this purchase order.') }
    finally { setDetailBusy(false) }
  }

  async function handleCancel() {
    if (!selectedOrderId) return
    if (!window.confirm('Cancel this purchase order? Stock already received will not be reversed.')) return
    setDetailBusy(true); setDetailError('')
    try { applyDetail(await cancelPurchaseOrder(storeId, selectedOrderId)) }
    catch (reason) { setDetailError(reason instanceof Error ? reason.message : 'Could not cancel this purchase order.') }
    finally { setDetailBusy(false) }
  }

  return <section className="floor-page purchasing-page">
    <PageHeader kicker="VENDORS & ORDERS" title="Purchasing" subtitle="Manage vendors, purchase orders, and receiving." />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading purchasing…</p>}

    {!loading && !error && <>
      <div className="purchasing-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'orders'} className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Purchase orders</button>
        <button type="button" role="tab" aria-selected={tab === 'vendors'} className={tab === 'vendors' ? 'active' : ''} onClick={() => setTab('vendors')}>Vendors</button>
        <button type="button" role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>Report</button>
      </div>

      {tab === 'vendors' && <VendorsTab
        vendors={vendors}
        onAdd={() => { setEditingVendor(null); setVendorDialogOpen(true) }}
        onEdit={vendor => { setEditingVendor(vendor); setVendorDialogOpen(true) }}
      />}

      {tab === 'orders' && <div className="purchasing-layout">
        <div className="purchasing-order-list">
          <button type="button" className="cta" disabled={!activeVendors.length} onClick={() => setPoDialogOpen(true)}>
            <Plus aria-hidden="true" size={15} />New purchase order
          </button>
          {!activeVendors.length && <p className="purchasing-hint">Add an active vendor first.</p>}
          {!orders.length && <p className="purchasing-hint">No purchase orders yet.</p>}
          {orders.map(order => <button type="button" key={order.id}
            className={`purchasing-order-item${order.id === selectedOrderId ? ' active' : ''}`}
            onClick={() => void openOrder(order.id)}>
            <span className="purchasing-order-item-top">
              <b>{order.vendor_name ?? 'Unknown vendor'}</b>
              <StatusPill status={order.status} />
            </span>
            <span className="purchasing-order-item-meta">
              {order.line_count} line{order.line_count === 1 ? '' : 's'} · {formatCents(Number(order.ordered_total_cents), currency)}
              {order.reference ? ` · ${order.reference}` : ''}
            </span>
          </button>)}
        </div>

        <div className="purchasing-order-detail">
          {!selectedOrder && <div className="inventory-welcome">
            <h2>Select a purchase order</h2>
            <p>Choose an order from the list to review lines, receipts, and receive stock.</p>
          </div>}
          {selectedOrder && <>
            <div className="purchasing-detail-header">
              <div>
                <h2>{selectedOrder.vendor_name ?? 'Unknown vendor'}</h2>
                <p className="purchasing-detail-subtitle">Created {new Date(selectedOrder.created_at).toLocaleString()}</p>
              </div>
              <StatusPill status={selectedOrder.status} />
            </div>
            {detailError && <p className="form-notice error" role="alert">{detailError}</p>}
            {detailBusy && !detail && <p role="status">Loading order…</p>}
            <div className="purchasing-detail-actions">
              {selectedOrder.status === 'draft' && <button type="button" className="secondary-cta" disabled={detailBusy} onClick={() => void handleSend()}>Send to vendor</button>}
              {(selectedOrder.status === 'sent' || selectedOrder.status === 'partially_received') &&
                <button type="button" className="cta" disabled={detailBusy} onClick={() => { setReceiveOpen(value => !value); setReceiveNotice('') }}>{receiveOpen ? 'Close receiving' : 'Receive stock'}</button>}
              {selectedOrder.status !== 'cancelled' && selectedOrder.status !== 'received' &&
                <button type="button" className="text-action" disabled={detailBusy} onClick={() => void handleCancel()}>Cancel order</button>}
            </div>

            {receiveNotice && <p className="form-notice" role="status">{receiveNotice} <Link to="/inventory">View in Inventory →</Link></p>}
            {detail && receiveOpen && <ReceiveForm storeId={storeId} detail={detail} currency={currency}
              onReceived={next => { applyDetail(next); setReceiveOpen(false); setReceiveNotice('Stock received and recorded against each ingredient’s balance and stock ledger.') }} />}

            {detail && <>
              <h3>Lines</h3>
              <table className="purchasing-table">
                <thead><tr><th>Ingredient</th><th>Ordered</th><th>Received</th><th>Unit cost</th></tr></thead>
                <tbody>{detail.lines.map(line => <tr key={line.id}>
                  <td>{line.ingredient_name ?? line.ingredient_id}</td>
                  <td>{line.ordered_quantity}</td>
                  <td>{line.received_quantity}</td>
                  <td>{formatCents(line.unit_cost_cents, currency)}</td>
                </tr>)}</tbody>
              </table>

              <h3>Receipts</h3>
              {!detail.receipts.length && <p className="purchasing-hint">No receipts recorded yet.</p>}
              {detail.receipts.map(receipt => <div className="purchasing-receipt" key={receipt.id}>
                <span>{new Date(receipt.received_at).toLocaleString()}</span>
                <span>{receipt.invoice_reference ?? 'No invoice reference'}</span>
                {receipt.manager_approved && <span className="purchasing-approved-tag">Manager approved{receipt.manager_approval_reason ? `: ${receipt.manager_approval_reason}` : ''}</span>}
              </div>)}
            </>}
          </>}
        </div>
      </div>}

      {tab === 'report' && <ReportTab report={report} currency={currency} />}
    </>}

    {vendorDialogOpen && <VendorDialog storeId={storeId} vendor={editingVendor}
      onClose={() => setVendorDialogOpen(false)}
      onSaved={vendor => {
        setVendors(current => editingVendor ? current.map(v => v.id === vendor.id ? vendor : v) : [...current, vendor].sort((a, b) => a.name.localeCompare(b.name)))
        setVendorDialogOpen(false)
      }} />}

    {poDialogOpen && <CreatePurchaseOrderDialog storeId={storeId} vendors={activeVendors} ingredients={ingredients} unitsById={unitsById} currency={currency}
      onClose={() => setPoDialogOpen(false)}
      onCreated={created => {
        setOrders(current => [created.purchase_order, ...current])
        setPoDialogOpen(false)
        void openOrder(created.purchase_order.id)
      }} />}
  </section>
}

function StatusPill({ status }: { status: PurchaseOrder['status'] }) {
  const labels: Record<PurchaseOrder['status'], string> = {
    draft: 'Draft', sent: 'Sent', partially_received: 'Partially received', received: 'Received', cancelled: 'Cancelled',
  }
  return <span className={`purchasing-status purchasing-status-${status}`}>{labels[status]}</span>
}

function VendorsTab({ vendors, onAdd, onEdit }: { vendors: Vendor[]; onAdd: () => void; onEdit: (vendor: Vendor) => void }) {
  const activeCount = vendors.filter(vendor => vendor.active).length
  return <div className="purchasing-vendors">
    <div className="purchasing-vendors-head">
      <div><strong>{activeCount} active vendor{activeCount === 1 ? '' : 's'}</strong>
        {vendors.length > activeCount && <small>{vendors.length - activeCount} inactive</small>}</div>
      <button type="button" className="cta" onClick={onAdd}><Plus aria-hidden="true" size={15} />New vendor</button>
    </div>
    {!vendors.length
      ? <EmptyState title="No vendors yet." description="Add a vendor to start creating purchase orders and tracking what you buy from them."
          action={<button type="button" className="secondary-cta" onClick={onAdd}><Plus aria-hidden="true" size={15} />Add your first vendor</button>} />
      : <div className="purchasing-vendor-grid">
        {vendors.map(vendor => <button type="button" key={vendor.id} className={`purchasing-vendor-card${vendor.active ? '' : ' inactive'}`} onClick={() => onEdit(vendor)}>
          <div className="purchasing-vendor-card-head">
            <span className="purchasing-vendor-icon" aria-hidden="true"><Truck size={16} /></span>
            <b>{vendor.name}</b>
            {!vendor.active && <span className="purchasing-approved-tag">Inactive</span>}
          </div>
          {vendor.contact_name && <span className="purchasing-vendor-detail">{vendor.contact_name}</span>}
          {vendor.email && <span className="purchasing-vendor-detail"><Mail aria-hidden="true" size={12} />{vendor.email}</span>}
          {vendor.phone && <span className="purchasing-vendor-detail"><Phone aria-hidden="true" size={12} />{vendor.phone}</span>}
          {vendor.terms && <span className="purchasing-vendor-terms">{vendor.terms}</span>}
        </button>)}
      </div>}
  </div>
}

function VendorDialog({ storeId, vendor, onClose, onSaved }: { storeId: string; vendor: Vendor | null; onClose: () => void; onSaved: (vendor: Vendor) => void }) {
  const [name, setName] = useState(vendor?.name ?? '')
  const [contactName, setContactName] = useState(vendor?.contact_name ?? '')
  const [email, setEmail] = useState(vendor?.email ?? '')
  const [phone, setPhone] = useState(vendor?.phone ?? '')
  const [terms, setTerms] = useState(vendor?.terms ?? '')
  const [active, setActive] = useState(vendor?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) { setError('Vendor name is required.'); return }
    setBusy(true); setError('')
    try {
      const input = { name: name.trim(), contact_name: contactName.trim() || null, email: email.trim() || null, phone: phone.trim() || null, terms: terms.trim() || null }
      const saved = vendor ? await updateVendor(storeId, vendor.id, { ...input, active }) : await createVendor(storeId, input)
      onSaved(saved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save this vendor.')
    } finally { setBusy(false) }
  }

  return <Dialog kicker="VENDORS" title={vendor ? 'Edit vendor' : 'New vendor'} onClose={() => { if (!busy) onClose() }}>
    <form className="purchasing-form" onSubmit={event => void submit(event)}>
      <label>Name<input autoFocus type="text" maxLength={160} value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Contact name<input type="text" maxLength={120} value={contactName} onChange={e => setContactName(e.target.value)} /></label>
      <label>Email<input type="email" maxLength={160} value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Phone<input type="tel" maxLength={40} value={phone} onChange={e => setPhone(e.target.value)} /></label>
      <label>Terms<textarea maxLength={500} value={terms} onChange={e => setTerms(e.target.value)} /></label>
      {vendor && <label className="purchasing-checkbox-label"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Active</label>}
      {error && <p className="form-notice error" role="alert">{error}</p>}
      <div className="purchasing-form-actions">
        <button type="button" className="secondary-cta" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="cta" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save vendor'}</button>
      </div>
    </form>
  </Dialog>
}

function CreatePurchaseOrderDialog({ storeId, vendors, ingredients, unitsById, currency, onClose, onCreated }: {
  storeId: string; vendors: Vendor[]; ingredients: Ingredient[]; unitsById: Map<string, RecipeUnit>; currency: string
  onClose: () => void; onCreated: (detail: PurchaseOrderDetail) => void
}) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id ?? '')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<{ ingredientId: string; quantity: string; unitCost: string }[]>([
    { ingredientId: ingredients[0]?.id ?? '', quantity: '', unitCost: '' },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function updateLine(index: number, patch: Partial<{ ingredientId: string; quantity: string; unitCost: string }>) {
    setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line))
  }
  function addLine() { setLines(current => [...current, { ingredientId: ingredients[0]?.id ?? '', quantity: '', unitCost: '' }]) }
  function removeLine(index: number) { setLines(current => current.filter((_, i) => i !== index)) }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!vendorId) { setError('Choose a vendor.'); return }
    const payloadLines = []
    for (const line of lines) {
      const quantity = Number(line.quantity)
      const unitCostCents = Math.round(Number(line.unitCost) * 100)
      if (!line.ingredientId || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitCostCents) || unitCostCents < 0) {
        setError('Every line needs an ingredient, a positive quantity, and a valid unit cost.')
        return
      }
      payloadLines.push({ ingredient_id: line.ingredientId, ordered_quantity: quantity, unit_cost_cents: unitCostCents })
    }
    if (!payloadLines.length) { setError('Add at least one line.'); return }
    setError(''); setBusy(true)
    try {
      onCreated(await createPurchaseOrder(storeId, { vendor_id: vendorId, reference: reference.trim() || null, notes: notes.trim() || null, lines: payloadLines }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create this purchase order.')
    } finally { setBusy(false) }
  }

  return <Dialog kicker="PURCHASE ORDERS" title="New purchase order" className="purchasing-po-dialog" onClose={() => { if (!busy) onClose() }}>
    <form className="purchasing-form" onSubmit={event => void submit(event)}>
      <label>Vendor
        <select value={vendorId} onChange={e => setVendorId(e.target.value)}>
          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </label>
      <label>Reference <small>Optional</small><input type="text" maxLength={120} value={reference} onChange={e => setReference(e.target.value)} /></label>
      <label>Notes <small>Optional</small><textarea maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></label>

      <div className="purchasing-lines">
        {lines.map((line, index) => {
          const ingredient = ingredients.find(i => i.id === line.ingredientId)
          const unit = ingredient ? unitsById.get(ingredient.unit_id) : undefined
          return <div className="purchasing-line-row" key={index}>
            <select value={line.ingredientId} onChange={e => updateLine(index, { ingredientId: e.target.value })}>
              {ingredients.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            <input type="number" min={0} step="any" placeholder={unit ? `Qty (${unit.abbreviation})` : 'Qty'} value={line.quantity} onChange={e => updateLine(index, { quantity: e.target.value })} />
            <input type="number" min={0} step="0.01" placeholder={`Unit cost (${currency})`} value={line.unitCost} onChange={e => updateLine(index, { unitCost: e.target.value })} />
            <button type="button" className="text-action" disabled={lines.length === 1} onClick={() => removeLine(index)}>Remove</button>
          </div>
        })}
        <button type="button" className="secondary-cta" onClick={addLine}><Plus aria-hidden="true" size={14} />Add line</button>
      </div>

      {error && <p className="form-notice error" role="alert">{error}</p>}
      <div className="purchasing-form-actions">
        <button type="button" className="secondary-cta" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="cta" disabled={busy}>{busy ? 'Creating…' : 'Create purchase order'}</button>
      </div>
    </form>
  </Dialog>
}

function ReceiveForm({ storeId, detail, currency, onReceived }: { storeId: string; detail: PurchaseOrderDetail; currency: string; onReceived: (detail: PurchaseOrderDetail & { receipt_id: string; replayed: boolean }) => void }) {
  const [invoiceReference, setInvoiceReference] = useState('')
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [managerApproved, setManagerApproved] = useState(false)
  const [approvalReason, setApprovalReason] = useState('')
  const [updateCosts, setUpdateCosts] = useState(false)
  const [unitCosts, setUnitCosts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const operationId = useMemo(() => crypto.randomUUID(), [detail.purchase_order.id])

  const openLines = detail.lines.filter(line => Number(line.received_quantity) < Number(line.ordered_quantity) || managerApproved)

  async function submit(event: FormEvent) {
    event.preventDefault()
    const lines = []
    for (const [lineId, raw] of Object.entries(quantities)) {
      const quantity = Number(raw)
      if (!raw || !Number.isFinite(quantity) || quantity <= 0) continue
      const unitCostRaw = unitCosts[lineId]
      const unitCostCents = unitCostRaw ? Math.round(Number(unitCostRaw) * 100) : undefined
      lines.push({ purchase_order_line_id: lineId, received_quantity: quantity, ...(unitCostCents !== undefined ? { unit_cost_cents: unitCostCents } : {}) })
    }
    if (!lines.length) { setError('Enter a received quantity for at least one line.'); return }
    if ((managerApproved || updateCosts) && !approvalReason.trim()) { setError('Manager-approved receiving requires a reason.'); return }
    setError(''); setBusy(true)
    try {
      onReceived(await receivePurchaseOrder(storeId, detail.purchase_order.id, {
        operation_id: operationId,
        invoice_reference: invoiceReference.trim() || null,
        manager_approved: managerApproved,
        manager_approval_reason: approvalReason.trim() || null,
        update_ingredient_costs: updateCosts,
        lines,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not receive stock for this order.')
    } finally { setBusy(false) }
  }

  return <form className="purchasing-receive-form" onSubmit={event => void submit(event)}>
    <h3 className="purchasing-receive-title">Receive stock</h3>
    <label>Invoice reference <small>Optional</small><input type="text" maxLength={160} value={invoiceReference} onChange={e => setInvoiceReference(e.target.value)} /></label>

    {openLines.map(line => <div className="purchasing-receive-line" key={line.id}>
      <span>{line.ingredient_name ?? line.ingredient_id}</span>
      <span className="purchasing-hint">Ordered {line.ordered_quantity} · Received so far {line.received_quantity}</span>
      <input type="number" min={0} step="any" placeholder="Qty received now" value={quantities[line.id] ?? ''} onChange={e => setQuantities(current => ({ ...current, [line.id]: e.target.value }))} />
      {updateCosts && <input type="number" min={0} step="0.01" placeholder={`New unit cost (${currency})`} value={unitCosts[line.id] ?? ''} onChange={e => setUnitCosts(current => ({ ...current, [line.id]: e.target.value }))} />}
    </div>)}

    <label className="purchasing-checkbox-label"><input type="checkbox" checked={managerApproved} onChange={e => setManagerApproved(e.target.checked)} />Manager approved (required to receive more than ordered)</label>
    <label className="purchasing-checkbox-label"><input type="checkbox" checked={updateCosts} onChange={e => setUpdateCosts(e.target.checked)} />Update ingredient cost from this receipt</label>
    {(managerApproved || updateCosts) && <label>Approval reason<input type="text" maxLength={500} value={approvalReason} onChange={e => setApprovalReason(e.target.value)} /></label>}

    {error && <p className="form-notice error" role="alert">{error}</p>}
    <div className="purchasing-form-actions">
      <button type="submit" className="cta" disabled={busy}>{busy ? 'Receiving…' : 'Record receipt'}</button>
    </div>
  </form>
}

function ReportTab({ report, currency }: { report: PurchasingReport | null; currency: string }) {
  if (!report) return <p role="status">Loading report…</p>
  return <div className="purchasing-report">
    <div className="purchasing-report-summary">
      <span><b>{report.vendors.active}</b> active vendors</span>
      <span><b>{report.vendors.inactive}</b> inactive vendors</span>
    </div>

    <h3>Vendor spend</h3>
    {!report.vendor_spend.length && <p className="purchasing-hint">No receiving activity yet.</p>}
    <table className="purchasing-table">
      <thead><tr><th>Vendor</th><th>Spend</th></tr></thead>
      <tbody>{report.vendor_spend.map(row => <tr key={row.vendor_id}><td>{row.vendor_name}</td><td>{formatCents(Number(row.spend_cents), currency)}</td></tr>)}</tbody>
    </table>

    <h3>Cost variance</h3>
    {!report.cost_variance.length && <p className="purchasing-hint">No cost variance recorded yet.</p>}
    <table className="purchasing-table">
      <thead><tr><th>Ingredient</th><th>Variance</th></tr></thead>
      <tbody>{report.cost_variance.map(row => <tr key={row.ingredient_id}>
        <td>{row.ingredient_name}</td>
        <td className={Number(row.variance_cents) > 0 ? 'purchasing-variance-up' : Number(row.variance_cents) < 0 ? 'purchasing-variance-down' : ''}>{formatCents(Number(row.variance_cents), currency)}</td>
      </tr>)}</tbody>
    </table>
  </div>
}
