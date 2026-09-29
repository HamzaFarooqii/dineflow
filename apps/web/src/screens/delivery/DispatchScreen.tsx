import { Fragment, useEffect, useState } from 'react'
import { requireSupabase } from '../../lib/supabase'
import {
  assignRider, fetchDispatchKpis, fetchDispatchList, fetchDeliveryTimeline, newOperationId, ownerTransitionDelivery,
  DeliveryConflictError, DELIVERY_STATUS_TONE, type DeliveryKpis, type DeliveryOrder, type DeliveryStatus, type DeliveryStatusEvent,
} from '../../lib/delivery'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import './delivery.css'

const POLL_MS = 20_000
const STATUS_LABEL: Record<DeliveryStatus, string> = {
  pending: 'Pending', accepted: 'Accepted', picked_up: 'Picked up', out_for_delivery: 'Out for delivery', delivered: 'Delivered', failed: 'Failed',
}
interface RiderOption { id: string; name: string }

// Owner/manager dispatch: list every delivery-type order for this store, assign/reassign a
// rider, review the status timeline, and see KPIs -- deliberately no financial/admin data beyond
// what already appears on the order (receipt number, total), so this screen stays safe to show
// to a wider set of staff later without becoming a second Reports screen.
export function DispatchScreen() {
  const [storeId, setStoreId] = useState('')
  const [deliveries, setDeliveries] = useState<DeliveryOrder[]>([])
  const [kpis, setKpis] = useState<DeliveryKpis | null>(null)
  const [riders, setRiders] = useState<RiderOption[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [timelineFor, setTimelineFor] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<DeliveryStatusEvent[]>([])

  const load = async (id: string) => {
    const [list, kpi] = await Promise.all([fetchDispatchList(id), fetchDispatchKpis(id)])
    setDeliveries(list)
    setKpis(kpi)
  }

  useEffect(() => {
    let active = true
    const init = async () => {
      try {
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to view dispatch.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
          .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        if (!active) return
        setStoreId(id)
        // Riders for the assignment dropdown -- reuses the same manage/list endpoint the
        // Terminals settings screen already calls, filtered client-side to the rider role.
        const { data: { session } } = await client.auth.getSession()
        const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? ''
        const response = await fetch(`${apiUrl}/terminal-auth/manage/${id}`, { headers: { Authorization: `Bearer ${session?.access_token ?? ''}` } })
        if (response.ok) {
          const body = await response.json() as { employees?: { id: string; name: string; role: string; active: boolean }[] }
          setRiders((body.employees ?? []).filter(e => e.role === 'rider' && e.active).map(e => ({ id: e.id, name: e.name })))
        }
        await load(id)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load dispatch.')
      } finally { if (active) setLoading(false) }
    }
    void init()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId) return
    let active = true
    const interval = window.setInterval(() => { if (navigator.onLine && active) void load(storeId).catch(() => undefined) }, POLL_MS)
    return () => { active = false; window.clearInterval(interval) }
  }, [storeId])

  const onAssign = async (delivery: DeliveryOrder, riderId: string) => {
    setBusyId(delivery.id)
    setError('')
    try {
      await assignRider(storeId, delivery.id, riderId || null)
      await load(storeId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not assign a rider.') }
    finally { setBusyId(null) }
  }

  const onForceStatus = async (delivery: DeliveryOrder, status: DeliveryStatus) => {
    setBusyId(delivery.id)
    setError('')
    try {
      const failureReason = status === 'failed' ? window.prompt('Failure reason?') ?? undefined : undefined
      if (status === 'failed' && !failureReason) { setBusyId(null); return }
      await ownerTransitionDelivery(storeId, delivery.id, delivery.status, status, newOperationId(), failureReason)
      await load(storeId)
    } catch (reason) {
      setError(reason instanceof DeliveryConflictError ? reason.message : reason instanceof Error ? reason.message : 'Could not update status.')
      await load(storeId)
    } finally { setBusyId(null) }
  }

  const toggleTimeline = async (delivery: DeliveryOrder) => {
    if (timelineFor === delivery.id) { setTimelineFor(null); return }
    setTimelineFor(delivery.id)
    try { setTimeline(await fetchDeliveryTimeline(storeId, delivery.id)) } catch { setTimeline([]) }
  }

  return <section className="delivery-page">
    <PageHeader kicker="DELIVERY" title="Dispatch" subtitle="Every delivery-type order for this store, and who's carrying it." />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading dispatch…</p>}
    {!loading && kpis && <div className="dispatch-kpis">
      {(Object.keys(STATUS_LABEL) as DeliveryStatus[]).map(status => <div className="dispatch-kpi" key={status}>
        <div className="dispatch-kpi-value">{kpis.by_status[status] ?? 0}</div>
        <div className="dispatch-kpi-label">{STATUS_LABEL[status]}</div>
      </div>)}
      <div className="dispatch-kpi">
        <div className="dispatch-kpi-value">{kpis.average_time_to_delivered_seconds != null ? `${Math.round(kpis.average_time_to_delivered_seconds / 60)}m` : '—'}</div>
        <div className="dispatch-kpi-label">Avg time to delivered</div>
      </div>
    </div>}
    {!loading && !error && deliveries.length === 0 && <p className="delivery-empty">No delivery orders yet.</p>}
    {!loading && deliveries.length > 0 && <div className="dispatch-table-wrap">
      <table className="dispatch-table">
        <thead><tr><th>Order</th><th>Recipient</th><th>Address</th><th>Status</th><th>Rider</th><th>Actions</th></tr></thead>
        <tbody>
          {deliveries.map(delivery => <Fragment key={delivery.id}>
            <tr>
              <td>{delivery.receipt_number ?? delivery.order_id.slice(0, 8)}</td>
              <td>{delivery.recipient_name_snapshot}<br /><small>{delivery.contact_phone_snapshot}</small></td>
              <td>{delivery.address_snapshot}</td>
              <td><StatusBadge tone={DELIVERY_STATUS_TONE[delivery.status]}>{STATUS_LABEL[delivery.status]}</StatusBadge></td>
              <td>
                <select value={delivery.rider_id ?? ''} disabled={busyId === delivery.id || !['pending', 'accepted'].includes(delivery.status)}
                  onChange={event => void onAssign(delivery, event.target.value)}>
                  <option value="">Unassigned</option>
                  {riders.map(rider => <option key={rider.id} value={rider.id}>{rider.name}</option>)}
                </select>
              </td>
              <td>
                <button type="button" onClick={() => void toggleTimeline(delivery)}>{timelineFor === delivery.id ? 'Hide' : 'Timeline'}</button>
                {' '}
                {delivery.status !== 'delivered' && delivery.status !== 'failed' &&
                  <button type="button" disabled={busyId === delivery.id} onClick={() => void onForceStatus(delivery, 'failed')}>Mark failed</button>}
              </td>
            </tr>
            {timelineFor === delivery.id && <tr><td colSpan={6}>
              <ul className="dispatch-timeline">
                {timeline.map(event => <li key={event.id}>{event.created_at} — {event.from_status ?? '∅'} → {event.to_status} ({event.actor_type}){event.note ? ` — ${event.note}` : ''}</li>)}
                {timeline.length === 0 && <li>No transitions recorded yet.</li>}
              </ul>
            </td></tr>}
          </Fragment>)}
        </tbody>
      </table>
    </div>}
  </section>
}
