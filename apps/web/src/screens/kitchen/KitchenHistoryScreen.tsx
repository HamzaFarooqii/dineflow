import { useEffect, useState } from 'react'
import { ORDER_TYPE_LABELS, type OrderType } from '../../../../../packages/domain/src/order-type'
import { KITCHEN_TICKET_STATUS_LABELS, KITCHEN_TICKET_STATUS_TONE } from '../../../../../packages/domain/src/kitchen-ticket-status'
import { fetchKitchenTicketHistory, type KitchenTicket } from '../../lib/kitchen'
import { requireSupabase } from '../../lib/supabase'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'
import './kitchen.css'

// Manager-only ticket history (A3) — served/cancelled tickets never appear on the active KDS
// board (kitchen.ts's TICKETS_QUERY filters them out entirely); this is the only place they're
// readable, filtered by date/station/status and paginated by the server.
export function KitchenHistoryScreen() {
  const [storeId, setStoreId] = useState('')
  const [stations, setStations] = useState<{ id: string; name: string }[]>([])
  const [status, setStatus] = useState<'served' | 'cancelled' | ''>('')
  const [date, setDate] = useState('')
  const [stationId, setStationId] = useState('')
  const [tickets, setTickets] = useState<KitchenTicket[]>()
  const [cursor, setCursor] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const client = requireSupabase()
        const { data: { user } } = await client.auth.getUser()
        if (!user) throw new Error('Sign in to view kitchen history.')
        const { data } = await client.from('store_memberships').select('store_id').eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        if (!active) return
        setStoreId(id)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load kitchen history.') }
    })()
    return () => { active = false }
  }, [])

  const load = async (cursorValue: string | null) => {
    if (!storeId) return
    setBusy(true); setError('')
    try {
      const page = await fetchKitchenTicketHistory(storeId, {
        status: status || undefined, date: date || undefined, stationId: stationId || undefined, cursor: cursorValue ?? undefined, limit: 25,
      })
      setTickets(current => cursorValue ? [...(current ?? []), ...page.tickets] : page.tickets)
      setNextCursor(page.next_cursor)
      const seenStations = new Map(stations.map(station => [station.id, station.name]))
      for (const ticket of page.tickets) for (const item of ticket.items) if (item.station_id && item.station_name) seenStations.set(item.station_id, item.station_name)
      setStations([...seenStations.entries()].map(([id, name]) => ({ id, name })))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load kitchen history.') }
    finally { setBusy(false) }
  }

  useEffect(() => { if (storeId) { setCursor(null); void load(null) } }, [storeId, status, date, stationId]) // eslint-disable-line react-hooks/exhaustive-deps

  return <section className="kitchen-page">
    <PageHeader kicker="KITCHEN HISTORY" title="Ticket history." subtitle="Every served or cancelled ticket, filterable by date, station and status." />
    <div className="history-tools">
      <label>Status<select value={status} onChange={event => setStatus(event.target.value as typeof status)}>
        <option value="">Served + cancelled</option><option value="served">Served</option><option value="cancelled">Cancelled</option>
      </select></label>
      <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label>Station<select value={stationId} onChange={event => setStationId(event.target.value)}>
        <option value="">All stations</option>{stations.map(station => <option key={station.id} value={station.id}>{station.name}</option>)}
      </select></label>
      {(status || date || stationId) && <button type="button" onClick={() => { setStatus(''); setDate(''); setStationId('') }}>Clear filters</button>}
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {tickets === undefined && !error && <p role="status">Loading ticket history…</p>}
    {tickets?.length === 0 && <EmptyState title="No tickets match these filters." description="Served and cancelled tickets appear here once a shift has run." />}
    <div className="kitchen-grid">{tickets?.map(ticket => (
      <article key={ticket.id} className="kitchen-ticket-card">
        <header className="kitchen-ticket-head">
          <span className="kitchen-ticket-ref">{ticket.table_label ? `Table ${ticket.table_label}` : ORDER_TYPE_LABELS[ticket.order_type as OrderType] ?? ticket.order_type}</span>
          <StatusBadge tone={KITCHEN_TICKET_STATUS_TONE[ticket.status]}>{KITCHEN_TICKET_STATUS_LABELS[ticket.status]}</StatusBadge>
        </header>
        <p className="kitchen-ticket-meta">{ticket.receipt_number} · {new Date(ticket.created_at).toLocaleString()}</p>
        <ul className="kitchen-ticket-items">{ticket.items.map(item => (
          <li key={item.id} className="kitchen-ticket-item">
            <span className="kitchen-item-name"><b>{item.quantity}×</b> {item.snapshot_name}{item.station_name && <small> · {item.station_name}</small>}</span>
            <StatusBadge tone={KITCHEN_TICKET_STATUS_TONE[item.status]}>{KITCHEN_TICKET_STATUS_LABELS[item.status]}</StatusBadge>
          </li>
        ))}</ul>
      </article>
    ))}</div>
    {nextCursor && <button type="button" className="secondary-cta" disabled={busy} onClick={() => { setCursor(nextCursor); void load(nextCursor) }}>{busy ? 'Loading…' : 'Load more'}</button>}
  </section>
}
