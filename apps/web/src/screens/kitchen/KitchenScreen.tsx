import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ORDER_TYPE_LABELS, type OrderType } from '../../../../../packages/domain/src/order-type'
import type { Course } from '../../../../../packages/domain/src/course'
import { advanceKitchenTicketItem, fetchKitchenTickets, fetchStationSummary, fireCourse, holdCourse, type KitchenTicket, type StationSummary } from '../../lib/kitchen'
import { requireSupabase } from '../../lib/supabase'
import { currentAccess } from '../../terminal-auth/cache'
import { KitchenTicketCard } from './KitchenTicketCard'
import { PageHeader } from '../../components/PageHeader'
import './kitchen.css'

// Same fetch cadence as RegisterScreen's outbox-push polling (15s) — the KDS needs new tickets
// to show up promptly, and nothing here is heavy enough to justify a realtime subscription that
// doesn't exist anywhere else in this codebase yet.
const POLL_MS = 15_000

export function KitchenScreen({ terminal = false }: { terminal?: boolean }) {
  const [storeId, setStoreId] = useState('')
  const [tickets, setTickets] = useState<KitchenTicket[]>([])
  const [stations, setStations] = useState<StationSummary[]>([])
  const [selectedStation, setSelectedStation] = useState<string>('all')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyItemId, setBusyItemId] = useState<string | null>(null)
  const [busyCourse, setBusyCourse] = useState<Course | null>(null)

  const refresh = async (id: string) => {
    const [ticketList, stationList] = await Promise.all([fetchKitchenTickets(id, terminal), fetchStationSummary(id, terminal)])
    setTickets(ticketList)
    setStations(stationList)
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load the kitchen board.')
        let id: string | undefined
        if (terminal) {
          const access = await currentAccess()
          if (!access?.policy.valid) throw new Error('Unlock this terminal to view the kitchen.')
          id = access.cache.device.store_id
        } else {
          const client = requireSupabase()
          const { data: { user }, error: userError } = await client.auth.getUser()
          if (userError || !user) throw new Error('Sign in to view the kitchen.')
          const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
            .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
          if (membershipError) throw membershipError
          id = data?.[0]?.store_id
        }
        if (!id) throw new Error('Store access is unavailable.')
        if (active) setStoreId(id)
        await refresh(id)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load the kitchen board.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal])

  useEffect(() => {
    if (!storeId) return
    let active = true
    const interval = window.setInterval(() => {
      if (!navigator.onLine || !active) return
      void refresh(storeId).catch(() => undefined)
    }, POLL_MS)
    return () => { active = false; window.clearInterval(interval) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, terminal])

  const stationTabs = [...new Map(tickets.flatMap(ticket => ticket.items)
    .filter(item => item.station_id)
    .map(item => [item.station_id as string, item.station_name ?? 'Station'])).entries()]
  const visibleTickets = selectedStation === 'all' ? tickets
    : tickets.map(ticket => ({ ...ticket, items: ticket.items.filter(item => item.station_id === selectedStation) }))
      .filter(ticket => ticket.items.length > 0)
  const stationDueLate = new Map(stations.map(station => [station.station_id ?? 'unassigned', station]))

  const advance = async (ticket: KitchenTicket, itemId: string, nextStatus: Parameters<typeof advanceKitchenTicketItem>[3]) => {
    setBusyItemId(itemId)
    setError('')
    try {
      await advanceKitchenTicketItem(storeId, ticket.id, itemId, nextStatus, terminal)
      await refresh(storeId)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update this ticket.')
    } finally { setBusyItemId(null) }
  }
  const doFireCourse = async (ticket: KitchenTicket, course: Course) => {
    setBusyCourse(course); setError('')
    try { await fireCourse(storeId, ticket.id, course, terminal); await refresh(storeId) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not fire this course.') }
    finally { setBusyCourse(null) }
  }
  const doHoldCourse = async (ticket: KitchenTicket, course: Course) => {
    setBusyCourse(course); setError('')
    try { await holdCourse(storeId, ticket.id, course, terminal); await refresh(storeId) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not hold this course.') }
    finally { setBusyCourse(null) }
  }

  return <section className="kitchen-page">
    <PageHeader kicker={terminal ? 'SERVICE TERMINAL' : 'KITCHEN DISPLAY'} title="Kitchen" subtitle="Every ticket firing for this restaurant, grouped by station."
      actions={!terminal ? <Link className="secondary-cta" to="/kitchen/history">Ticket history</Link> : undefined} />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading the kitchen board…</p>}
    {!loading && !error && tickets.length === 0 && <p className="kitchen-empty">No tickets are firing right now.</p>}
    {!loading && !error && tickets.length > 0 && <>
      <div className="kitchen-station-tabs" role="tablist" aria-label="Kitchen stations">
        <button type="button" className={selectedStation === 'all' ? 'active' : ''} onClick={() => setSelectedStation('all')}>All stations</button>
        {stationTabs.map(([id, name]) => {
          const summary = stationDueLate.get(id)
          return <button key={id} type="button" className={selectedStation === id ? 'active' : ''} onClick={() => setSelectedStation(id)}>
            {name}{Boolean(summary?.late) && <span className="kitchen-station-late-count"> · {summary!.late} late</span>}
          </button>
        })}
      </div>
      <div className="kitchen-grid">
        {visibleTickets.map(ticket => <KitchenTicketCard key={ticket.id} ticket={ticket}
          orderTypeLabel={ORDER_TYPE_LABELS[ticket.order_type as OrderType] ?? ticket.order_type}
          busyItemId={busyItemId} busyCourse={busyCourse}
          onAdvance={(itemId, next) => void advance(ticket, itemId, next)}
          onFireCourse={course => void doFireCourse(ticket, course)}
          onHoldCourse={course => void doHoldCourse(ticket, course)} />)}
        {visibleTickets.length === 0 && <p className="kitchen-empty">No tickets for this station right now.</p>}
      </div>
    </>}
  </section>
}
