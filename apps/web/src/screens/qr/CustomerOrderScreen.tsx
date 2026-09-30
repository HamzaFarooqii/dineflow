import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { formatCents } from '../../../../../packages/domain/src/money'
import { Dialog } from '../../components/Dialog'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { QrApiError, fetchQrMenu, fetchQrOrders, openQrSession, submitQrOrder, type QrCustomerOrder, type QrMenu, type QrMenuProduct, type QrSessionIssued } from '../../lib/qr-ordering'
import './customer-order.css'

// Public page: the guest holds a short-lived table session, never a staff credential.
// Copy is deliberate: an order here is a *request* until staff add it to the check, so we never
// say food is being prepared -- the kitchen is only involved when the check is closed.
const CODE_PATTERN = /^[a-f0-9]{64}$/
const POLL_MS = 8_000
const STORAGE_PREFIX = 'dineflow.qr.session.'

type Phase = 'loading' | 'ready' | 'ended' | 'unavailable' | 'error'
interface CartLine { key: string; product: QrMenuProduct; quantity: number; optionIds: string[] }

const STATUS_COPY: Record<QrCustomerOrder['status'], { tone: 'warning' | 'success' | 'danger'; label: string; detail: string }> = {
  awaiting_confirmation: { tone: 'warning', label: 'Waiting for staff', detail: "Your order has been sent. A team member will confirm it before it is added to your table's check." },
  added_to_check: { tone: 'success', label: 'Added to your check', detail: "Staff confirmed this order and added it to your table's check." },
  declined: { tone: 'danger', label: 'Not accepted', detail: 'The restaurant could not accept this order. Please ask your server.' },
}

function readStored(code: string): QrSessionIssued | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + code)
    const parsed = raw ? JSON.parse(raw) as QrSessionIssued : null
    return parsed && Date.parse(parsed.expires_at) > Date.now() ? parsed : null
  } catch { return null }
}
function store(code: string, session: QrSessionIssued | null) {
  try { if (session) sessionStorage.setItem(STORAGE_PREFIX + code, JSON.stringify(session)); else sessionStorage.removeItem(STORAGE_PREFIX + code) } catch { /* storage unavailable: session lives in memory only */ }
}

export function CustomerOrderScreen() {
  const { code = '' } = useParams()
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState('')
  const [session, setSession] = useState<QrSessionIssued | null>(null)
  const [menu, setMenu] = useState<QrMenu | null>(null)
  const [orders, setOrders] = useState<QrCustomerOrder[]>([])
  const [category, setCategory] = useState('all')
  const [cart, setCart] = useState<CartLine[]>([])
  const [picking, setPicking] = useState<QrMenuProduct | null>(null)
  const [pickState, setPickState] = useState<Record<string, string[]>>({})
  const [pickQty, setPickQty] = useState(1)
  const [pickError, setPickError] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const operationId = useRef<string | null>(null)

  const currency = session?.currency ?? 'USD'

  const endSession = useCallback((reason: string) => {
    store(code, null); setSession(null); setPhase('ended'); setMessage(reason)
  }, [code])

  const handleFailure = useCallback((error: unknown) => {
    if (error instanceof QrApiError && error.sessionEnded) return endSession('Your table session has ended. Scan the code on your table again to keep ordering.')
    if (error instanceof QrApiError && error.code === 'menu_disabled') { setPhase('unavailable'); setMessage('This table is served by staff. Please ask your server to order.'); return }
    if (error instanceof QrApiError && (error.status === 404 || error.status === 409)) {
      setPhase('unavailable')
      setMessage(error.code === 'feature_disabled' ? 'Table ordering is not available right now. Please ask your server.' : 'This QR code is not active. Please ask your server for help.')
      return
    }
    setPhase('error'); setMessage(error instanceof Error ? error.message : 'Something went wrong.')
  }, [endSession])

  const start = useCallback(async () => {
    setPhase('loading'); setMessage('')
    if (!CODE_PATTERN.test(code)) { setPhase('unavailable'); setMessage('This link is not a valid table code. Please scan the code on your table again.'); return }
    try {
      const active = readStored(code) ?? await openQrSession(code)
      store(code, active); setSession(active)
      const [loadedMenu, loadedOrders] = await Promise.all([fetchQrMenu(active.session_token), fetchQrOrders(active.session_token)])
      setMenu(loadedMenu); setOrders(loadedOrders); setPhase('ready')
    } catch (error) {
      // A stored session the server no longer honours: drop it and try the code once before giving up.
      if (error instanceof QrApiError && error.sessionEnded && readStored(code)) { store(code, null); return start() }
      handleFailure(error)
    }
  }, [code, handleFailure])

  useEffect(() => { void start() }, [start])

  useEffect(() => {
    if (phase !== 'ready' || !session) return
    const timer = window.setInterval(() => { fetchQrOrders(session.session_token).then(setOrders).catch(handleFailure) }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [phase, session, handleFailure])

  const visibleProducts = useMemo(() => (menu?.products ?? []).filter(product => category === 'all' || product.category_id === category), [menu, category])
  const lineUnit = (line: CartLine) => line.product.price_cents + line.optionIds.reduce((add, id) => add + (line.product.modifier_groups.flatMap(group => group.options).find(option => option.id === id)?.price_delta_cents ?? 0), 0)
  const cartTotal = cart.reduce((sum, line) => sum + line.quantity * lineUnit(line), 0)
  const cartCount = cart.reduce((sum, line) => sum + line.quantity, 0)
  const canOrder = Boolean(menu?.ordering_available)

  function changeCart(next: CartLine[]) { setCart(next); operationId.current = null; setSubmitError('') }

  function beginPick(product: QrMenuProduct) {
    setPicking(product); setPickQty(1); setPickError('')
    setPickState(Object.fromEntries(product.modifier_groups.map(group => [group.id, []])))
  }
  function togglePick(groupId: string, optionId: string, single: boolean) {
    setPickState(state => {
      const current = state[groupId] ?? []
      return { ...state, [groupId]: single ? [optionId] : current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId] }
    })
  }
  function confirmPick() {
    if (!picking) return
    const missing = picking.modifier_groups.find(group => group.required && !(pickState[group.id]?.length))
    if (missing) { setPickError(`Choose an option for ${missing.name}.`); return }
    const optionIds = picking.modifier_groups.flatMap(group => pickState[group.id] ?? []).sort()
    const key = `${picking.id}:${optionIds.join(',')}`
    const existing = cart.find(line => line.key === key)
    changeCart(existing
      ? cart.map(line => line.key === key ? { ...line, quantity: Math.min(20, line.quantity + pickQty) } : line)
      : [...cart, { key, product: picking, quantity: pickQty, optionIds }])
    setPicking(null)
  }

  async function submit() {
    if (!session || !cart.length || submitting) return
    setSubmitting(true); setSubmitError('')
    // Same id for every retry of the same cart, so a dropped connection cannot double-submit.
    operationId.current ??= crypto.randomUUID()
    try {
      const result = await submitQrOrder(session.session_token, operationId.current, cart.map(line => ({ product_id: line.product.id, quantity: line.quantity, modifier_option_ids: line.optionIds })), note.trim() || null)
      setOrders(previous => [result.submission, ...previous.filter(order => order.id !== result.submission.id)])
      setCart([]); setNote(''); operationId.current = null
    } catch (error) {
      if (error instanceof QrApiError && error.sessionEnded) { endSession('Your table session has ended before this order was sent. Scan the code on your table again.'); return }
      if (error instanceof QrApiError && ['item_unavailable', 'unknown_item', 'combo_unavailable_via_qr'].includes(error.code)) {
        setSubmitError(`${error.message} Please review your order.`)
        try {
          const fresh = await fetchQrMenu(session.session_token)
          setMenu(fresh)
          const ids = new Set(fresh.products.map(product => product.id))
          setCart(previous => previous.filter(line => ids.has(line.product.id)))
        } catch { /* keep the current menu */ }
        operationId.current = null
      } else setSubmitError(error instanceof Error ? error.message : 'Could not send your order. Try again.')
    } finally { setSubmitting(false) }
  }

  if (phase === 'loading') return <main className="qr-page"><p role="status" className="qr-status">Opening your table…</p></main>
  if (phase === 'ended' || phase === 'unavailable' || phase === 'error') {
    return <main className="qr-page"><EmptyState title={phase === 'ended' ? 'Session ended' : phase === 'error' ? 'We could not load the menu' : 'Ordering unavailable'} description={message}
      action={phase === 'error' || phase === 'ended' ? <button type="button" className="cta" onClick={() => void start()}>Try again</button> : undefined} /></main>
  }
  if (!menu || !session) return null

  return <main className="qr-page">
    <header className="qr-header">
      <p className="qr-kicker">{session.store_name}</p>
      <h1>Table {menu.table_label}</h1>
      <p className="qr-sub">{canOrder ? (menu.requires_confirmation ? 'Send your order and staff will confirm it.' : "Your order is added to the table's check.") : 'Menu only. Please ask your server to order.'}</p>
    </header>

    {orders.length > 0 && <section aria-label="Your orders" className="qr-orders">
      <h2>Your orders</h2>
      {orders.map(order => { const copy = STATUS_COPY[order.status]; return <article key={order.id} className="qr-order">
        <StatusBadge tone={copy.tone}>{copy.label}</StatusBadge>
        <p>{copy.detail}</p>
        <ul>{order.items.map((item, index) => <li key={index}>{item.quantity} × {item.name}{item.modifiers.length ? ` (${item.modifiers.join(', ')})` : ''}</li>)}</ul>
      </article> })}
    </section>}

    {menu.categories.length > 0 && <div className="qr-categories" role="group" aria-label="Categories">
      <button type="button" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>All</button>
      {menu.categories.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)}
    </div>}

    {menu.products.length === 0
      ? <EmptyState title="The menu is empty right now" description="Nothing is available to order at the moment. Please ask your server." />
      : <ul className="qr-menu">{visibleProducts.map(product => <li key={product.id} className="qr-product">
        <div><strong>{product.name}</strong><span>{formatCents(product.price_cents, currency)}</span></div>
        {canOrder && <button type="button" className="secondary-cta" aria-label={`Add ${product.name}`} onClick={() => beginPick(product)}>Add</button>}
      </li>)}</ul>}

    {canOrder && cart.length > 0 && <section className="qr-cart" aria-label="Your order">
      <h2>Your order</h2>
      <ul>{cart.map(line => <li key={line.key}>
        <span>{line.quantity} × {line.product.name}</span>
        <button type="button" className="text-action" aria-label={`Remove ${line.product.name}`} onClick={() => changeCart(cart.filter(other => other.key !== line.key))}>Remove</button>
      </li>)}</ul>
      <label className="qr-note">Note for the kitchen (optional)<textarea maxLength={300} value={note} onChange={event => { setNote(event.target.value); operationId.current = null }} /></label>
      {submitError && <p className="form-notice error" role="alert">{submitError}</p>}
      <button type="button" className="cta qr-submit" disabled={submitting} onClick={() => void submit()}>
        {submitting ? 'Sending…' : `Send order · ${cartCount} item${cartCount === 1 ? '' : 's'} · from ${formatCents(cartTotal, currency)}`}
      </button>
      <p className="qr-fineprint">Final prices and tax are set by the restaurant.</p>
    </section>}

    {picking && <Dialog title={picking.name} kicker={formatCents(picking.price_cents, currency)} onClose={() => setPicking(null)}>
      <div className="qr-pick">
        {picking.modifier_groups.map(group => <fieldset key={group.id}>
          <legend>{group.name}{group.required ? ' (required)' : ''}</legend>
          {group.options.map(option => <label key={option.id}>
            <input type={group.selection === 'single' ? 'radio' : 'checkbox'} name={group.id} checked={(pickState[group.id] ?? []).includes(option.id)} onChange={() => togglePick(group.id, option.id, group.selection === 'single')} />
            {option.name}{option.price_delta_cents ? ` (+${formatCents(option.price_delta_cents, currency)})` : ''}
          </label>)}
        </fieldset>)}
        <div className="qr-qty" role="group" aria-label="Quantity">
          <button type="button" aria-label="Fewer" disabled={pickQty <= 1} onClick={() => setPickQty(pickQty - 1)}>−</button>
          <output aria-live="polite">{pickQty}</output>
          <button type="button" aria-label="More" disabled={pickQty >= 20} onClick={() => setPickQty(pickQty + 1)}>+</button>
        </div>
        {pickError && <p className="form-notice error" role="alert">{pickError}</p>}
        <button type="button" className="cta" onClick={confirmPick}>Add to order</button>
      </div>
    </Dialog>}
  </main>
}
