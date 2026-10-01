import { useEffect, useState } from 'react'
import { advanceMyDelivery, fetchMyDeliveries, newOperationId, DeliveryConflictError, DELIVERY_STATUS_TONE, type DeliveryOrder, type DeliveryStatus } from '../../lib/delivery'
import { currentAccess } from '../../terminal-auth/cache'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import './delivery.css'

const POLL_MS = 15_000

const NEXT_STEP: Partial<Record<DeliveryStatus, { to: DeliveryStatus; label: string }>> = {
  pending: { to: 'accepted', label: 'Accept delivery' },
  accepted: { to: 'picked_up', label: 'Mark picked up' },
  picked_up: { to: 'out_for_delivery', label: 'Start delivering' },
  out_for_delivery: { to: 'delivered', label: 'Mark delivered' },
}
const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: 'New', accepted: 'Accepted', picked_up: 'Picked up', out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed: 'Failed',
}
const PROOF_CODE_RE = /^\d{6}$/

// Rider terminal: exactly the three capabilities the Rider role has — view assigned deliveries,
// accept, and advance one's own delivery through the lifecycle. No listing of other riders' or
// other stores' orders (fetchMyDeliveries is already scoped server-side), no financial data.
export function RiderDeliveryScreen() {
  const [storeId, setStoreId] = useState('')
  const [deliveries, setDeliveries] = useState<DeliveryOrder[]>([])
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = async (id: string) => {
    try {
      const list = await fetchMyDeliveries(id)
      setDeliveries(list)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load your deliveries.') }
  }

  useEffect(() => {
    let active = true
    void currentAccess().then(async state => {
      if (!active) return
      const id = state?.cache.device.store_id
      if (!id) { setError('Unlock this terminal to view deliveries.'); setLoading(false); return }
      setStoreId(id)
      await load(id)
      if (active) setLoading(false)
    }).catch(() => { if (active) { setError('Unlock this terminal to view deliveries.'); setLoading(false) } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId) return
    let active = true
    const interval = window.setInterval(() => { if (navigator.onLine && active) void load(storeId) }, POLL_MS)
    return () => { active = false; window.clearInterval(interval) }
  }, [storeId])

  const advance = async (delivery: DeliveryOrder, toStatus: DeliveryStatus, failureReason?: string, proofCode?: string) => {
    setBusyId(delivery.id)
    setError('')
    setConflict('')
    try {
      await advanceMyDelivery(storeId, delivery.id, delivery.status, toStatus, newOperationId(), failureReason, proofCode)
      await load(storeId)
    } catch (reason) {
      if (reason instanceof DeliveryConflictError) {
        // Offline-conflict contract: never silently overwrite. Show the conflict and force a
        // refresh of this device's local copy before it can try again.
        setConflict(reason.message)
        await load(storeId)
      } else {
        setError(reason instanceof Error ? reason.message : 'Could not update this delivery.')
      }
    } finally { setBusyId(null) }
  }

  const markFailed = async (delivery: DeliveryOrder) => {
    const reason = window.prompt('Why did this delivery fail? (shown to the manager)')
    if (!reason || !reason.trim()) return
    await advance(delivery, 'failed', reason.trim())
  }

  // The customer gives this code back at the door (it was read to them when the order was taken
  // -- no SMS/push provider exists here to send it any other way). Server-verified, attempt-
  // limited and single-use; a manager can reissue one from Dispatch if it's lost or locked out.
  const markDelivered = async (delivery: DeliveryOrder) => {
    const code = window.prompt('Enter the customer\'s 6-digit proof-of-delivery code:')
    if (!code) return
    if (!PROOF_CODE_RE.test(code.trim())) { setError('That code must be exactly 6 digits.'); return }
    await advance(delivery, 'delivered', undefined, code.trim())
  }

  return <section className="rider-page">
    <PageHeader kicker="RIDER TERMINAL" title="My deliveries" subtitle="Deliveries assigned to you right now." />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {conflict && <p className="form-notice error" role="alert">{conflict} — showing the latest state below.</p>}
    {loading && !error && <p role="status">Loading your deliveries…</p>}
    {!loading && !error && deliveries.length === 0 && <p className="delivery-empty">No deliveries assigned to you right now.</p>}
    <div className="rider-list">
      {deliveries.map(delivery => {
        const next = NEXT_STEP[delivery.status]
        const terminal = delivery.status === 'delivered' || delivery.status === 'failed'
        // Pickup is blocked ahead of a rejected request whenever the server already told us the
        // kitchen isn't ready (kitchen_ready is undefined only on a stale cached row, in which
        // case we let the tap through and let the server's own gate answer authoritatively).
        const pickupBlocked = delivery.status === 'accepted' && delivery.kitchen_ready === false
        const nextDisabled = busyId === delivery.id || pickupBlocked
        const onNext = () => next && void (next.to === 'delivered' ? markDelivered(delivery) : advance(delivery, next.to))
        return <article className="rider-card" key={delivery.id}>
          <div className="rider-card-head">
            <span className="rider-card-receipt">{delivery.receipt_number ?? delivery.order_id.slice(0, 8)}</span>
            <StatusBadge tone={DELIVERY_STATUS_TONE[delivery.status]}>{STATUS_LABEL[delivery.status]}</StatusBadge>
          </div>
          <p className="rider-card-field"><b>{delivery.recipient_name_snapshot}</b> · {delivery.contact_phone_snapshot}</p>
          <p className="rider-card-field">{delivery.address_snapshot}</p>
          {delivery.delivery_instructions_snapshot && <p className="rider-card-field">Note: {delivery.delivery_instructions_snapshot}</p>}
          {pickupBlocked && <p className="rider-card-field">Waiting on the kitchen ({delivery.kitchen_status ?? 'not started'}) before this can be picked up.</p>}
          {!terminal && <div className="rider-card-actions">
            {next && <button type="button" disabled={nextDisabled} title={pickupBlocked ? 'The kitchen has not finished preparing this order yet.' : undefined} onClick={onNext}>{next.label}</button>}
            <button type="button" className="danger" disabled={busyId === delivery.id} onClick={() => void markFailed(delivery)}>Mark failed</button>
          </div>}
        </article>
      })}
    </div>
  </section>
}
