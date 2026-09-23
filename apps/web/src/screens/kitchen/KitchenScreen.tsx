import { useEffect, useState } from 'react'
import { ORDER_TYPE_LABELS, type OrderType } from '../../../../../packages/domain/src/order-type'
import { advanceKitchenTicketItem, fetchKitchenTickets, type KitchenTicket } from '../../lib/kitchen'
import { requireSupabase } from '../../lib/supabase'
import { KitchenTicketCard } from './KitchenTicketCard'
import './kitchen.css'

// Same fetch cadence as RegisterScreen's outbox-push polling (15s) — the KDS needs new tickets
// to show up promptly, and nothing here is heavy enough to justify a realtime subscription that
// doesn't exist anywhere else in this codebase yet.
const POLL_MS = 15_000

export function KitchenScreen() {
  const [storeId, setStoreId] = useState('')
  const [tickets, setTickets] = useState<KitchenTicket[]>([])
  const [selectedStation, setSelectedStation] = useState<string>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyItemId, setBusyItemId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load the kitchen board.')
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to view the kitchen.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
          .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        if (active) setStoreId(id)
        const list = await fetchKitchenTickets(id)
        if (active) setTickets(list)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load the kitchen board.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId) return
    let active = true
    const interval = window.setInterval(() => {
      if (!navigator.onLine) return
      void fetchKitchenTickets(storeId).then(list => { if (active) setTickets(list) }).catch(() => undefined)
    }, POLL_MS)
    return () => { active = false; window.clearInterval(interval) }
  }, [storeId])

  const stations = [...new Map(tickets.flatMap(ticket => ticket.items)
    .filter(item => item.station_id)
    .map(item => [item.station_id as string, item.station_name ?? 'Station'])).entries()]
  const visibleTickets = selectedStation === 'all' ? tickets
    : tickets.map(ticket => ({ ...ticket, items: ticket.items.filter(item => item.station_id === selectedStation) }))
      .filter(ticket => ticket.items.length > 0)

  const advance = async (ticket: KitchenTicket, itemId: string, nextStatus: Parameters<typeof advanceKitchenTicketItem>[3]) => {
    setBusyItemId(itemId)
    setError('')
    try {
      await advanceKitchenTicketItem(storeId, ticket.id, itemId, nextStatus)
      const refreshed = await fetchKitchenTickets(storeId)
      setTickets(refreshed)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update this ticket.')
    } finally { setBusyItemId(null) }
  }

  return <section className="kitchen-page">
    <p className="kicker">KITCHEN DISPLAY</p>
    <h1>Kitchen</h1>
    <p>Every ticket firing for this restaurant, grouped by station.</p>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading the kitchen board…</p>}
    {!loading && !error && tickets.length === 0 && <p className="kitchen-empty">No tickets are firing right now.</p>}
    {!loading && !error && tickets.length > 0 && <>
      <div className="kitchen-station-tabs" role="tablist" aria-label="Kitchen stations">
        <button type="button" className={selectedStation === 'all' ? 'active' : ''} onClick={() => setSelectedStation('all')}>All stations</button>
        {stations.map(([id, name]) => <button key={id} type="button" className={selectedStation === id ? 'active' : ''} onClick={() => setSelectedStation(id)}>{name}</button>)}
      </div>
      <div className="kitchen-grid">
        {visibleTickets.map(ticket => <KitchenTicketCard key={ticket.id} ticket={ticket}
          orderTypeLabel={ORDER_TYPE_LABELS[ticket.order_type as OrderType] ?? ticket.order_type}
          busyItemId={busyItemId} onAdvance={(itemId, next) => void advance(ticket, itemId, next)} />)}
        {visibleTickets.length === 0 && <p className="kitchen-empty">No tickets for this station right now.</p>}
      </div>
    </>}
  </section>
}
