import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatCents } from '../../../../../packages/domain/src/money'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE, type TableStatus } from '../../../../../packages/domain/src/table-status'
import { createFloorArea, createRestaurantTable, deleteFloorArea, deleteRestaurantTable, fetchFloorPlan, mergeTableParty, TableStatusConflictError,
  transferTableParty, updateRestaurantTable, updateTableStatus, type FloorArea, type FloorEmployee, type RestaurantTable } from '../../lib/floor'
import { createBooking, fetchBookings, runBookingAction, seatBooking, updateBooking, type BookingEntry, type BookingFilter, type BookingKind } from '../../lib/reservations'
import { posDb } from '../../lib/db'
import { requireSupabase } from '../../lib/supabase'
import { usePosStore } from '../../lib/pos-store'
import { TableCard } from './TableCard'
import { PageHeader } from '../../components/PageHeader'
import { StatusBadge } from '../../components/StatusBadge'
import { SelectField } from '../../components/SelectField'
import { Dialog } from '../../components/Dialog'
import { LayoutGrid, Pencil, Plus, Trash2 } from '../../components/icons'
import { currentAccess } from '../../terminal-auth/cache'
import './floor.css'

const SEAT_FROM: TableStatus = 'available'
const ADD_ORDER_FROM: TableStatus = 'seated'
const MARK_SERVED_FROM: TableStatus = 'ordering'
const BILLABLE_FROM: readonly TableStatus[] = ['ordering', 'served']
const BILL_SETTLED_FROM: TableStatus = 'bill_requested'
const CLEANED_FROM: TableStatus = 'dirty'
// Mirrors apps/api/src/routes/floor.ts's OCCUPIED_STATUSES — a table must have an active party
// to be a Transfer source or a Merge target/source.
const OCCUPIED_STATUSES: readonly TableStatus[] = ['seated', 'ordering', 'served']

export function FloorScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('')
  const [areas, setAreas] = useState<FloorArea[]>([])
  const [tables, setTables] = useState<RestaurantTable[]>([])
  const [employees, setEmployees] = useState<FloorEmployee[]>([])
  const [selectedArea, setSelectedArea] = useState<string>('all')
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null)
  const [selectedWaiterId, setSelectedWaiterId] = useState<string>('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [cartBlockNotice, setCartBlockNotice] = useState(false)
  const [bookingFilter, setBookingFilter] = useState<BookingFilter>('today')
  const [reservations, setReservations] = useState<BookingEntry[]>([])
  const [waitlist, setWaitlist] = useState<BookingEntry[]>([])
  const [bookingBusy, setBookingBusy] = useState(false)
  const [bookingError, setBookingError] = useState('')
  const [bookingWarnings, setBookingWarnings] = useState<string[]>([])
  const [bookingFormOpen, setBookingFormOpen] = useState<BookingKind | null>(null)
  const [editingBooking, setEditingBooking] = useState<{ kind: BookingKind; entry: BookingEntry } | null>(null)
  const [bookingName, setBookingName] = useState('')
  const [bookingPhone, setBookingPhone] = useState('')
  const [bookingSize, setBookingSize] = useState('2')
  const [bookingExpectedAt, setBookingExpectedAt] = useState('')
  const [bookingNotes, setBookingNotes] = useState('')
  const [bookingTableId, setBookingTableId] = useState('')

  // Floor management (Day 3): create/edit/delete areas and tables. Kept behind an explicit
  // toggle so day-to-day service on this screen stays exactly as fast and uncluttered as before —
  // this is a back-of-house setup task, not something touched mid-shift.
  const [editMode, setEditMode] = useState(false)
  const [newAreaName, setNewAreaName] = useState('')
  const [areaActionBusy, setAreaActionBusy] = useState(false)
  const [areaActionError, setAreaActionError] = useState('')
  const [newTableOpen, setNewTableOpen] = useState(false)
  const [newTableLabel, setNewTableLabel] = useState('')
  const [newTableSeats, setNewTableSeats] = useState('4')
  const [newTableAreaId, setNewTableAreaId] = useState('')
  const [tableActionBusy, setTableActionBusy] = useState(false)
  const [tableActionError, setTableActionError] = useState('')
  const [editTableOpen, setEditTableOpen] = useState(false)
  const [managedTable, setManagedTable] = useState<RestaurantTable | null>(null)
  const [deleteAreaId, setDeleteAreaId] = useState<string | null>(null)
  const [deleteTableId, setDeleteTableId] = useState<string | null>(null)
  const [editTableLabel, setEditTableLabel] = useState('')
  const [editTableSeats, setEditTableSeats] = useState('')
  const [editTableAreaId, setEditTableAreaId] = useState('')

  // Transfer / Merge (Day 3 — these were disabled placeholders; now real).
  const [moveMode, setMoveMode] = useState<'transfer' | 'merge' | null>(null)
  const [moveTargetId, setMoveTargetId] = useState('')
  const [moveBusy, setMoveBusy] = useState(false)
  const [moveError, setMoveError] = useState('')

  const cartItems = usePosStore(state => state.items)
  const setActiveTableId = usePosStore(state => state.setActiveTableId)
  const activeTableId = usePosStore(state => state.activeTableId)
  const clearCart = usePosStore(state => state.clearCart)

  const reload = async (id: string) => {
    const plan = await fetchFloorPlan(id, terminal)
    setAreas(plan.areas); setTables(plan.tables); setEmployees(plan.employees)
    return plan
  }

  const reloadBookings = async (id: string, filter = bookingFilter) => {
    const bookings = await fetchBookings(id, filter, terminal)
    setReservations(bookings.reservations)
    setWaitlist(bookings.waitlist)
    return bookings
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load the floor plan.')
        let id: string | undefined
        if (terminal) {
          const access = await currentAccess()
          if (!access?.policy.valid) throw new Error('Unlock this terminal to view the floor.')
          id = access.cache.device.store_id
        } else {
          const client = requireSupabase()
          const { data: { user }, error: userError } = await client.auth.getUser()
          if (userError || !user) throw new Error('Sign in to view the floor.')
          const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
            .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
          if (membershipError) throw membershipError
          id = data?.[0]?.store_id
        }
        if (!id) throw new Error('Store access is unavailable.')
        const config = await posDb.store_config.get(id)
        if (active) setStoreId(id)
        if (active) setCurrency(config?.currency ?? '')
        const plan = await reload(id)
        await reloadBookings(id)
        if (active && !newTableAreaId) setNewTableAreaId(plan.areas[0]?.id ?? '')
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load the floor plan.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const visibleTables = selectedArea === 'all' ? tables : tables.filter(table => table.floor_area_id === selectedArea)
  const areaName = (id: string) => areas.find(area => area.id === id)?.name ?? 'Unassigned'
  const tableName = (id: string | null) => id ? tables.find(table => table.id === id)?.label ?? 'Table' : 'Unassigned'

  function openTable(table: RestaurantTable) {
    setSelectedTable(table)
    setSelectedWaiterId('')
    setActionError('')
    setCartBlockNotice(false)
    setEditTableOpen(false)
    setMoveMode(null); setMoveError(''); setMoveTargetId('')
  }

  function applyUpdatedTable(updated: RestaurantTable) {
    setTables(current => current.map(table => table.id === updated.id ? { ...table, ...updated } : table))
    setSelectedTable(current => current && current.id === updated.id ? { ...current, ...updated } : current)
  }

  async function runTransition(table: RestaurantTable, expectedStatus: TableStatus, status: TableStatus, assignedWaiterId?: string | null) {
    setActionBusy(true)
    setActionError('')
    try {
      const updated = await updateTableStatus(storeId, table.id, expectedStatus, status, assignedWaiterId, terminal)
      applyUpdatedTable(updated)
      return updated
    } catch (reason) {
      if (reason instanceof TableStatusConflictError) {
        // Someone else moved this table first — reconcile with the server instead of guessing.
        try {
          const plan = await reload(storeId)
          const fresh = plan.tables.find(t => t.id === table.id) ?? null
          setSelectedTable(fresh)
        } catch { /* keep the conflict message even if the reconcile fetch fails */ }
      }
      setActionError(reason instanceof Error ? reason.message : 'Could not update this table.')
      return null
    } finally {
      setActionBusy(false)
    }
  }

  async function handleSeat(table: RestaurantTable) {
    await runTransition(table, SEAT_FROM, 'seated', selectedWaiterId || null)
  }

  async function handleMarkServed(table: RestaurantTable) {
    await runTransition(table, MARK_SERVED_FROM, 'served')
  }

  async function handleAddOrder(table: RestaurantTable) {
    if (cartItems.length > 0 && activeTableId !== table.id) {
      setCartBlockNotice(true)
      return
    }
    const updated = await runTransition(table, ADD_ORDER_FROM, 'ordering')
    if (updated) { setActiveTableId(table.id); navigate(terminal ? '/pos/register' : '/register') }
  }

  async function handleBill(table: RestaurantTable) {
    if (!BILLABLE_FROM.includes(table.status)) return
    await runTransition(table, table.status, 'bill_requested')
  }

  async function handleBillSettled(table: RestaurantTable) {
    const updated = await runTransition(table, BILL_SETTLED_FROM, 'dirty')
    if (updated && activeTableId === table.id) setActiveTableId(null)
  }

  async function handleCleaned(table: RestaurantTable) {
    const updated = await runTransition(table, CLEANED_FROM, 'available')
    if (updated && activeTableId === table.id) setActiveTableId(null)
  }

  function resetBookingForm(kind: BookingKind, entry?: BookingEntry) {
    setBookingFormOpen(kind)
    setEditingBooking(entry ? { kind, entry } : null)
    setBookingName(entry?.guest_name ?? '')
    setBookingPhone(entry?.guest_phone ?? '')
    setBookingSize(String(entry?.guest_size ?? 2))
    setBookingExpectedAt(entry?.expected_at ? entry.expected_at.slice(0, 16) : new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16))
    setBookingNotes(entry?.notes ?? '')
    setBookingTableId(entry?.restaurant_table_id ?? selectedTable?.id ?? '')
    setBookingWarnings([])
    setBookingError('')
  }

  async function saveBooking(event: FormEvent) {
    event.preventDefault()
    if (!bookingFormOpen) return
    const size = Number(bookingSize)
    if (!bookingName.trim() || !Number.isInteger(size) || size <= 0) {
      setBookingError('Enter a guest name and party size.')
      return
    }
    setBookingBusy(true); setBookingError(''); setBookingWarnings([])
    try {
      const draft = {
        guest_name: bookingName.trim(),
        guest_phone: bookingPhone.trim() || null,
        guest_size: size,
        notes: bookingNotes.trim(),
        expected_at: new Date(bookingExpectedAt).toISOString(),
        restaurant_table_id: bookingTableId || null,
        floor_area_id: bookingTableId ? tables.find(table => table.id === bookingTableId)?.floor_area_id ?? null : null,
      }
      const result = editingBooking
        ? await updateBooking(storeId, editingBooking.kind, editingBooking.entry.id, draft, terminal)
        : await createBooking(storeId, bookingFormOpen, draft, terminal)
      setBookingWarnings(result.warnings ?? [])
      setBookingFormOpen(null); setEditingBooking(null)
      await reloadBookings(storeId)
    } catch (reason) { setBookingError(reason instanceof Error ? reason.message : 'Could not save this booking.') }
    finally { setBookingBusy(false) }
  }

  async function handleBookingAction(kind: BookingKind, entry: BookingEntry, next: 'arrive' | 'cancel' | 'no-show') {
    setBookingBusy(true); setBookingError('')
    try {
      await runBookingAction(storeId, kind, entry.id, next, terminal)
      await reloadBookings(storeId)
    } catch (reason) { setBookingError(reason instanceof Error ? reason.message : 'Could not update this booking.') }
    finally { setBookingBusy(false) }
  }

  async function handleSeatBooking(kind: BookingKind, entry: BookingEntry, tableId: string) {
    setBookingBusy(true); setBookingError('')
    try {
      await seatBooking(storeId, kind, entry.id, tableId, selectedWaiterId || null, terminal)
      const plan = await reload(storeId)
      await reloadBookings(storeId)
      setSelectedTable(plan.tables.find(table => table.id === tableId) ?? selectedTable)
    } catch (reason) { setBookingError(reason instanceof Error ? reason.message : 'Could not seat this booking.') }
    finally { setBookingBusy(false) }
  }

  // --- Area management -----------------------------------------------------------------------

  async function handleAddArea(event: FormEvent) {
    event.preventDefault()
    if (!newAreaName.trim()) return
    setAreaActionBusy(true); setAreaActionError('')
    try {
      await createFloorArea(storeId, newAreaName.trim())
      setNewAreaName('')
      await reload(storeId)
    } catch (reason) { setAreaActionError(reason instanceof Error ? reason.message : 'Could not add this area.') }
    finally { setAreaActionBusy(false) }
  }

  async function handleDeleteArea(area: FloorArea) {
    setAreaActionBusy(true); setAreaActionError('')
    try {
      await deleteFloorArea(storeId, area.id)
      if (selectedArea === area.id) setSelectedArea('all')
      setDeleteAreaId(null)
      await reload(storeId)
    } catch (reason) { setAreaActionError(reason instanceof Error ? reason.message : 'Could not delete this area.') }
    finally { setAreaActionBusy(false) }
  }

  // --- Table management -----------------------------------------------------------------------

  async function handleAddTable(event: FormEvent) {
    event.preventDefault()
    const seats = Number(newTableSeats)
    if (!newTableLabel.trim() || !newTableAreaId || !Number.isInteger(seats) || seats <= 0) {
      setTableActionError('Enter a table label, a positive number of seats, and pick an area.')
      return
    }
    setTableActionBusy(true); setTableActionError('')
    try {
      await createRestaurantTable(storeId, newTableAreaId, newTableLabel.trim(), seats)
      setNewTableLabel(''); setNewTableSeats('4'); setNewTableOpen(false)
      await reload(storeId)
    } catch (reason) { setTableActionError(reason instanceof Error ? reason.message : 'Could not add this table.') }
    finally { setTableActionBusy(false) }
  }

  function openEditTable(table: RestaurantTable) {
    setManagedTable(table)
    setEditTableOpen(true)
    setEditTableLabel(table.label)
    setEditTableSeats(String(table.seats))
    setEditTableAreaId(table.floor_area_id)
    setTableActionError('')
  }

  async function handleSaveTable(table: RestaurantTable) {
    const seats = Number(editTableSeats)
    if (!editTableLabel.trim() || !editTableAreaId || !Number.isInteger(seats) || seats <= 0) {
      setTableActionError('Enter a table label, a positive number of seats, and pick an area.')
      return
    }
    setTableActionBusy(true); setTableActionError('')
    try {
      const updated = await updateRestaurantTable(storeId, table.id, { label: editTableLabel.trim(), seats, floor_area_id: editTableAreaId })
      applyUpdatedTable(updated)
      setEditTableOpen(false)
      setManagedTable(null)
    } catch (reason) { setTableActionError(reason instanceof Error ? reason.message : 'Could not save this table.') }
    finally { setTableActionBusy(false) }
  }

  async function handleDeleteTable(table: RestaurantTable) {
    setTableActionBusy(true); setTableActionError('')
    try {
      await deleteRestaurantTable(storeId, table.id)
      setSelectedTable(null)
      setManagedTable(null)
      setEditTableOpen(false)
      setDeleteTableId(null)
      await reload(storeId)
    } catch (reason) { setTableActionError(reason instanceof Error ? reason.message : 'Could not delete this table.') }
    finally { setTableActionBusy(false) }
  }

  // --- Transfer / Merge -----------------------------------------------------------------------

  function openMove(mode: 'transfer' | 'merge') {
    setMoveMode(mode); setMoveError(''); setMoveTargetId('')
  }

  async function confirmMove(table: RestaurantTable) {
    if (!moveTargetId) { setMoveError('Choose a table.'); return }
    setMoveBusy(true); setMoveError('')
    try {
      if (moveMode === 'transfer') await transferTableParty(storeId, table.id, moveTargetId, terminal)
      else await mergeTableParty(storeId, moveTargetId, table.id, terminal)
      setMoveMode(null); setMoveTargetId('')
      const plan = await reload(storeId)
      // The acted-on table is freed either way (transferred away, or merged into the other) —
      // follow it in the drawer so staff see the result instead of a table that just vanished.
      setSelectedTable(plan.tables.find(t => t.id === table.id) ?? null)
    } catch (reason) { setMoveError(reason instanceof Error ? reason.message : 'Could not complete this action.') }
    finally { setMoveBusy(false) }
  }

  const moveCandidates = selectedTable
    ? tables.filter(table => table.id !== selectedTable.id && (moveMode === 'transfer' ? table.status === 'available' : OCCUPIED_STATUSES.includes(table.status)))
    : []

  return <section className="floor-page">
    <PageHeader
      kicker="RESTAURANT FLOOR"
      title="Floor & Tables"
      subtitle="Every table across your dining areas, at a glance."
      actions={!terminal && <button type="button" className="secondary-cta" onClick={() => {
        setSelectedTable(null)
        setEditMode(true)
        setAreaActionError('')
        setTableActionError('')
      }}><Pencil aria-hidden="true" size={15} />Edit floor</button>}
    />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading the floor…</p>}
    {!loading && !error && areas.length === 0 && tables.length === 0 && !editMode &&
      <p className="floor-empty">No floor areas or tables are set up for this restaurant yet. Click "Edit floor" to add one.</p>}
    {!loading && !error && <>
      <div className="floor-area-tabs" role="tablist" aria-label="Floor areas">
        <button type="button" className={selectedArea === 'all' ? 'active' : ''} onClick={() => setSelectedArea('all')}>All areas</button>
        {areas.map(area => <button key={area.id} type="button" className={selectedArea === area.id ? 'active' : ''} onClick={() => setSelectedArea(area.id)}>{area.name}</button>)}
      </div>
      {false && editMode && <form className="floor-inline-form" onSubmit={event => void handleAddArea(event)}>
        <input type="text" maxLength={80} placeholder="New area name (e.g. Rooftop)" value={newAreaName} onChange={event => setNewAreaName(event.target.value)} />
        <button type="submit" className="secondary-cta" disabled={areaActionBusy || !newAreaName.trim()}>{areaActionBusy ? 'Adding…' : 'Add area'}</button>
      </form>}
      {areaActionError && <p className="form-notice error" role="alert">{areaActionError}</p>}

      <section className="floor-bookings" aria-label="Reservations and waitlist">
        <div className="floor-bookings-head">
          <div>
            <p className="kicker">GUEST FLOW</p>
            <h2>Reservations & Waitlist</h2>
          </div>
          <div className="floor-booking-actions">
            <SelectField label="Filter" value={bookingFilter} onChange={event => {
              const next = event.target.value as BookingFilter
              setBookingFilter(next)
              if (storeId) void reloadBookings(storeId, next)
            }}>
              <option value="today">Today</option>
              <option value="upcoming">Upcoming</option>
              <option value="waiting">Waiting</option>
              <option value="all">All</option>
            </SelectField>
            <button type="button" className="secondary-cta" onClick={() => resetBookingForm('reservation')}>New reservation</button>
            <button type="button" className="secondary-cta" onClick={() => resetBookingForm('waitlist')}>Add waitlist</button>
          </div>
        </div>
        {bookingError && <p className="form-notice error" role="alert">{bookingError}</p>}
        {bookingWarnings.length > 0 && <ul className="floor-booking-warnings">{bookingWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        <div className="floor-booking-columns">
          <BookingList title="Reservations" kind="reservation" entries={reservations} tableName={tableName} busy={bookingBusy}
            onEdit={entry => resetBookingForm('reservation', entry)}
            onArrive={entry => void handleBookingAction('reservation', entry, 'arrive')}
            onCancel={entry => void handleBookingAction('reservation', entry, 'cancel')}
            onNoShow={entry => void handleBookingAction('reservation', entry, 'no-show')}
            onSeat={(entry, tableId) => void handleSeatBooking('reservation', entry, tableId)}
            selectedTableId={selectedTable?.id ?? ''} />
          <BookingList title="Waitlist" kind="waitlist" entries={waitlist} tableName={tableName} busy={bookingBusy}
            onEdit={entry => resetBookingForm('waitlist', entry)}
            onCancel={entry => void handleBookingAction('waitlist', entry, 'cancel')}
            onNoShow={entry => void handleBookingAction('waitlist', entry, 'no-show')}
            onSeat={(entry, tableId) => void handleSeatBooking('waitlist', entry, tableId)}
            selectedTableId={selectedTable?.id ?? ''} />
        </div>
      </section>

      <div className="floor-grid">
        {visibleTables.map(table => <TableCard key={table.id} table={table} areaName={areaName(table.floor_area_id)} currency={currency} onSelect={() => openTable(table)} />)}
        {visibleTables.length === 0 && !editMode && <p className="floor-empty">No tables in this area.</p>}
        {false && editMode && !newTableOpen && <button type="button" className="floor-add-table-card" onClick={() => { setNewTableOpen(true); setTableActionError(''); if (!newTableAreaId) setNewTableAreaId(areas[0]?.id ?? '') }}>+ Add table</button>}
      </div>
      {false && editMode && newTableOpen && <form className="floor-inline-form floor-new-table-form" onSubmit={event => void handleAddTable(event)}>
        <label>Label<input type="text" maxLength={40} placeholder="T1" value={newTableLabel} onChange={event => setNewTableLabel(event.target.value)} /></label>
        <label>Seats<input type="number" min={1} value={newTableSeats} onChange={event => setNewTableSeats(event.target.value)} /></label>
        <SelectField label="Area" value={newTableAreaId} onChange={event => setNewTableAreaId(event.target.value)}>
          {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
        </SelectField>
        <div className="floor-inline-form-actions">
          <button type="button" className="text-action" onClick={() => setNewTableOpen(false)}>Cancel</button>
          <button type="submit" className="secondary-cta" disabled={tableActionBusy}>{tableActionBusy ? 'Adding…' : 'Add table'}</button>
        </div>
        {tableActionError && <p className="form-notice error" role="alert">{tableActionError}</p>}
      </form>}
    </>}
    {editMode && <Dialog
      title="Edit floor plan"
      kicker="LAYOUT MANAGEMENT"
      className="floor-manager-dialog"
      onClose={() => {
        if (areaActionBusy || tableActionBusy) return
        setEditMode(false)
        setNewTableOpen(false)
        setEditTableOpen(false)
        setManagedTable(null)
        setDeleteAreaId(null)
        setDeleteTableId(null)
      }}
    >
      <div className="floor-manager-intro">
        <div className="floor-manager-mark"><LayoutGrid aria-hidden="true" size={20} /></div>
        <div>
          <strong>Shape the room without interrupting service.</strong>
          <p>Create dining areas, add tables, or update seating from one focused workspace.</p>
        </div>
      </div>

      <div className="floor-manager-summary" aria-label="Floor plan summary">
        <div><span>Areas</span><strong>{areas.length}</strong></div>
        <div><span>Tables</span><strong>{tables.length}</strong></div>
        <div><span>Total seats</span><strong>{tables.reduce((sum, table) => sum + table.seats, 0)}</strong></div>
      </div>

      <div className="floor-manager-grid">
        <section className="floor-manager-section">
          <div className="floor-manager-section-head">
            <div><p className="kicker">DINING AREAS</p><h3>Organize the room</h3></div>
          </div>
          <form className="floor-manager-form" onSubmit={event => void handleAddArea(event)}>
            <label>Area name
              <input type="text" maxLength={80} placeholder="e.g. Rooftop" value={newAreaName} onChange={event => setNewAreaName(event.target.value)} />
            </label>
            <button type="submit" className="secondary-cta" disabled={areaActionBusy || !newAreaName.trim()}>
              <Plus aria-hidden="true" size={15} />{areaActionBusy ? 'Adding...' : 'Add area'}
            </button>
          </form>
          {areaActionError && <p className="form-notice error" role="alert">{areaActionError}</p>}
          <ul className="floor-manager-list">
            {areas.map(area => {
              const areaTables = tables.filter(table => table.floor_area_id === area.id)
              const confirming = deleteAreaId === area.id
              return <li key={area.id}>
                <div className="floor-manager-row-copy">
                  <strong>{area.name}</strong>
                  <span>{areaTables.length} {areaTables.length === 1 ? 'table' : 'tables'} · {areaTables.reduce((sum, table) => sum + table.seats, 0)} seats</span>
                </div>
                {!confirming ? <button type="button" className="icon-action danger" aria-label={`Delete ${area.name}`}
                  disabled={areaActionBusy || areaTables.length > 0} title={areaTables.length ? 'Move or delete its tables first' : 'Delete area'}
                  onClick={() => setDeleteAreaId(area.id)}><Trash2 aria-hidden="true" size={15} /></button>
                  : <div className="floor-manager-confirm">
                    <span>Delete?</span>
                    <button type="button" className="text-action" onClick={() => setDeleteAreaId(null)}>Keep</button>
                    <button type="button" className="danger-action" disabled={areaActionBusy} onClick={() => void handleDeleteArea(area)}>Delete</button>
                  </div>}
              </li>
            })}
            {!areas.length && <li className="floor-manager-list-empty">Add an area before creating tables.</li>}
          </ul>
        </section>

        <section className="floor-manager-section">
          <div className="floor-manager-section-head">
            <div><p className="kicker">TABLES</p><h3>Manage seating</h3></div>
            <button type="button" className="text-action" disabled={!areas.length} onClick={() => {
              setNewTableOpen(true)
              setManagedTable(null)
              setEditTableOpen(false)
              setTableActionError('')
              if (!newTableAreaId) setNewTableAreaId(areas[0]?.id ?? '')
            }}><Plus aria-hidden="true" size={14} />New table</button>
          </div>

          {newTableOpen && <form className="floor-manager-card-form" onSubmit={event => void handleAddTable(event)}>
            <div className="floor-manager-form-title"><strong>Add a table</strong><span>Set the label, capacity, and dining area.</span></div>
            <div className="floor-manager-fields">
              <label>Table label<input type="text" maxLength={40} placeholder="T1" value={newTableLabel} onChange={event => setNewTableLabel(event.target.value)} /></label>
              <label>Seats<input type="number" min={1} value={newTableSeats} onChange={event => setNewTableSeats(event.target.value)} /></label>
              <SelectField label="Area" value={newTableAreaId} onChange={event => setNewTableAreaId(event.target.value)}>
                {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
              </SelectField>
            </div>
            <div className="floor-manager-form-actions">
              <button type="button" className="text-action" onClick={() => setNewTableOpen(false)}>Cancel</button>
              <button type="submit" className="cta" disabled={tableActionBusy}>{tableActionBusy ? 'Creating...' : 'Create table'}</button>
            </div>
          </form>}

          {editTableOpen && managedTable && <form className="floor-manager-card-form editing" onSubmit={event => { event.preventDefault(); void handleSaveTable(managedTable) }}>
            <div className="floor-manager-form-title"><strong>Edit table {managedTable.label}</strong><span>Changes appear on the floor immediately.</span></div>
            <div className="floor-manager-fields">
              <label>Table label<input type="text" maxLength={40} value={editTableLabel} onChange={event => setEditTableLabel(event.target.value)} /></label>
              <label>Seats<input type="number" min={1} value={editTableSeats} onChange={event => setEditTableSeats(event.target.value)} /></label>
              <SelectField label="Area" value={editTableAreaId} onChange={event => setEditTableAreaId(event.target.value)}>
                {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
              </SelectField>
            </div>
            <div className="floor-manager-form-actions">
              <button type="button" className="text-action" onClick={() => { setEditTableOpen(false); setManagedTable(null) }}>Cancel</button>
              <button type="submit" className="cta" disabled={tableActionBusy}>{tableActionBusy ? 'Saving...' : 'Save table'}</button>
            </div>
          </form>}

          {tableActionError && <p className="form-notice error" role="alert">{tableActionError}</p>}
          <ul className="floor-manager-list floor-manager-table-list">
            {tables.map(table => {
              const confirming = deleteTableId === table.id
              return <li key={table.id} className={managedTable?.id === table.id ? 'selected' : undefined}>
                <button type="button" className="floor-manager-table-main" onClick={() => { setNewTableOpen(false); openEditTable(table) }}>
                  <span className="floor-manager-table-code">{table.label}</span>
                  <span><strong>{areaName(table.floor_area_id)}</strong><small>{table.seats} seats · {TABLE_STATUS_LABELS[table.status]}</small></span>
                  <Pencil aria-hidden="true" size={14} />
                </button>
                {!confirming ? <button type="button" className="icon-action danger" aria-label={`Delete table ${table.label}`}
                  disabled={tableActionBusy || table.status !== 'available'} title={table.status !== 'available' ? 'Free the table before deleting it' : 'Delete table'}
                  onClick={() => setDeleteTableId(table.id)}><Trash2 aria-hidden="true" size={15} /></button>
                  : <div className="floor-manager-confirm">
                    <button type="button" className="text-action" onClick={() => setDeleteTableId(null)}>Keep</button>
                    <button type="button" className="danger-action" disabled={tableActionBusy} onClick={() => void handleDeleteTable(table)}>Delete</button>
                  </div>}
              </li>
            })}
            {!tables.length && <li className="floor-manager-list-empty">No tables yet. Add the first one above.</li>}
          </ul>
        </section>
      </div>
    </Dialog>}
    {bookingFormOpen && <Dialog title={editingBooking ? 'Edit booking' : bookingFormOpen === 'reservation' ? 'New reservation' : 'Add to waitlist'} kicker="GUEST FLOW" onClose={() => { if (!bookingBusy) { setBookingFormOpen(null); setEditingBooking(null) } }}>
      <form className="floor-booking-form" onSubmit={event => void saveBooking(event)}>
        <label>Guest name<input maxLength={120} value={bookingName} onChange={event => setBookingName(event.target.value)} required /></label>
        <label>Phone<input inputMode="tel" value={bookingPhone} onChange={event => setBookingPhone(event.target.value)} /></label>
        <label>Party size<input type="number" min={1} max={99} value={bookingSize} onChange={event => setBookingSize(event.target.value)} required /></label>
        <label>{bookingFormOpen === 'waitlist' ? 'Arrival time' : 'Expected time'}<input type="datetime-local" value={bookingExpectedAt} onChange={event => setBookingExpectedAt(event.target.value)} required /></label>
        <SelectField label="Assigned table" value={bookingTableId} onChange={event => setBookingTableId(event.target.value)}>
          <option value="">No table yet</option>
          {tables.map(table => <option key={table.id} value={table.id}>{table.label} · {areaName(table.floor_area_id)} · {TABLE_STATUS_LABELS[table.status]}</option>)}
        </SelectField>
        <label>Notes<textarea maxLength={500} value={bookingNotes} onChange={event => setBookingNotes(event.target.value)} /></label>
        {bookingError && <p className="form-notice error" role="alert">{bookingError}</p>}
        <div className="floor-inline-form-actions">
          <button type="button" className="text-action" onClick={() => { setBookingFormOpen(null); setEditingBooking(null) }}>Cancel</button>
          <button type="submit" className="cta" disabled={bookingBusy}>{bookingBusy ? 'Saving...' : 'Save'}</button>
        </div>
      </form>
    </Dialog>}
    {selectedTable && <aside className="floor-detail" role="dialog" aria-label={`Table ${selectedTable.label}`}>
      <header><h2>Table {selectedTable.label}</h2><button type="button" className="text-action" onClick={() => setSelectedTable(null)}>Close</button></header>
      {!editTableOpen ? <dl>
        <div><dt>Area</dt><dd>{areaName(selectedTable.floor_area_id)}</dd></div>
        <div><dt>Seats</dt><dd>{selectedTable.seats}</dd></div>
        <div><dt>Status</dt><dd><StatusBadge tone={TABLE_STATUS_TONE[selectedTable.status]}>{TABLE_STATUS_LABELS[selectedTable.status]}</StatusBadge></dd></div>
        <div><dt>Waiter</dt><dd>{selectedTable.assigned_waiter_name ?? '—'}</dd></div>
        <div><dt>Last order</dt><dd>{selectedTable.current_order_total_cents && currency
          ? formatCents(Number(selectedTable.current_order_total_cents), currency) : '—'}</dd></div>
      </dl> : <div className="floor-inline-form floor-edit-table-form">
        <label>Label<input type="text" maxLength={40} value={editTableLabel} onChange={event => setEditTableLabel(event.target.value)} /></label>
        <label>Seats<input type="number" min={1} value={editTableSeats} onChange={event => setEditTableSeats(event.target.value)} /></label>
        <SelectField label="Area" value={editTableAreaId} onChange={event => setEditTableAreaId(event.target.value)}>
          {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
        </SelectField>
        <div className="floor-inline-form-actions">
          <button type="button" className="text-action" onClick={() => setEditTableOpen(false)}>Cancel</button>
          <button type="button" className="secondary-cta" disabled={tableActionBusy} onClick={() => void handleSaveTable(selectedTable)}>{tableActionBusy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </div>}
      {tableActionError && <p className="form-notice error" role="alert">{tableActionError}</p>}
      {editMode && !editTableOpen && <div className="floor-detail-edit-actions">
        <button type="button" className="secondary-cta" onClick={() => openEditTable(selectedTable)}>Edit table</button>
        <button type="button" className="text-action" disabled={tableActionBusy || selectedTable.status !== 'available'}
          title={selectedTable.status !== 'available' ? 'Free the table before deleting it' : undefined}
          onClick={() => void handleDeleteTable(selectedTable)}>Delete table</button>
      </div>}
      {selectedTable.status === SEAT_FROM && <div className="floor-waiter-select">
        <SelectField label="Assign a waiter (optional)" value={selectedWaiterId} onChange={event => setSelectedWaiterId(event.target.value)}>
          <option value="">No waiter selected</option>
          {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </SelectField>
      </div>}
      {actionError && <p className="form-notice error" role="alert">{actionError}</p>}
      {cartBlockNotice && <p className="form-notice error" role="alert">Clear the current cart before starting a table order.
        <button type="button" className="text-action" onClick={() => { clearCart(); setCartBlockNotice(false) }}>Clear cart</button>
      </p>}
      {moveMode && <div className="floor-move-form" role="group" aria-label={moveMode === 'transfer' ? 'Transfer to' : 'Merge with'}>
        <SelectField label={moveMode === 'transfer' ? 'Transfer to which table?' : 'Merge with which table?'} value={moveTargetId} onChange={event => setMoveTargetId(event.target.value)}>
          <option value="">Choose a table…</option>
          {moveCandidates.map(table => <option key={table.id} value={table.id}>{table.label} · {areaName(table.floor_area_id)}</option>)}
        </SelectField>
        {moveCandidates.length === 0 && <p className="floor-empty">{moveMode === 'transfer' ? 'No available tables to transfer to.' : 'No other occupied tables to merge with.'}</p>}
        {moveError && <p className="form-notice error" role="alert">{moveError}</p>}
        <div className="floor-inline-form-actions">
          <button type="button" className="text-action" onClick={() => setMoveMode(null)}>Cancel</button>
          <button type="button" className="secondary-cta" disabled={moveBusy || !moveTargetId} onClick={() => void confirmMove(selectedTable)}>{moveBusy ? 'Working…' : moveMode === 'transfer' ? 'Confirm transfer' : 'Confirm merge'}</button>
        </div>
      </div>}
      <div className="floor-detail-actions">
        <button type="button" disabled={actionBusy || selectedTable.status !== SEAT_FROM} onClick={() => void handleSeat(selectedTable)}>Seat</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== ADD_ORDER_FROM} onClick={() => void handleAddOrder(selectedTable)}>Add order</button>
        {!terminal && <button type="button" disabled={actionBusy || selectedTable.status !== MARK_SERVED_FROM} onClick={() => void handleMarkServed(selectedTable)}
          title="The kitchen normally does this automatically once every item on the ticket is served">Mark served</button>
        }
        <button type="button" disabled={actionBusy || !OCCUPIED_STATUSES.includes(selectedTable.status)} onClick={() => openMove('transfer')}>Transfer</button>
        <button type="button" disabled={actionBusy || !OCCUPIED_STATUSES.includes(selectedTable.status)} onClick={() => openMove('merge')}>Merge</button>
        <button type="button" disabled={actionBusy || !BILLABLE_FROM.includes(selectedTable.status)} onClick={() => void handleBill(selectedTable)}>Bill</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== BILL_SETTLED_FROM} onClick={() => void handleBillSettled(selectedTable)}>Bill settled</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== CLEANED_FROM} onClick={() => void handleCleaned(selectedTable)}>Cleaned</button>
      </div>
    </aside>}
  </section>
}

function formatBookingTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
}

function BookingList({
  title, kind, entries, tableName, busy, selectedTableId, onEdit, onArrive, onCancel, onNoShow, onSeat,
}: {
  title: string
  kind: BookingKind
  entries: BookingEntry[]
  tableName: (id: string | null) => string
  busy: boolean
  selectedTableId: string
  onEdit: (entry: BookingEntry) => void
  onArrive?: (entry: BookingEntry) => void
  onCancel: (entry: BookingEntry) => void
  onNoShow: (entry: BookingEntry) => void
  onSeat: (entry: BookingEntry, tableId: string) => void
}) {
  return <section className="floor-booking-list">
    <header><h3>{title}</h3><span>{entries.length}</span></header>
    {entries.length === 0 && <p className="floor-empty">Nothing here for this filter.</p>}
    {entries.map(entry => {
      const actionable = kind === 'reservation' ? ['booked', 'arrived'].includes(entry.status) : entry.status === 'waiting'
      const seatTableId = selectedTableId || entry.restaurant_table_id || ''
      return <article key={entry.id} className="floor-booking-card">
        <div className="floor-booking-main">
          <strong>{entry.guest_name}</strong>
          <span>{entry.guest_size} guests · {formatBookingTime(entry.expected_at)}</span>
          <small>{tableName(entry.restaurant_table_id)} · {entry.status.replace('_', ' ')}</small>
          {entry.wait_minutes !== undefined && entry.wait_minutes > 0 && <small>{entry.wait_minutes} min waiting</small>}
          {entry.notes && <p>{entry.notes}</p>}
        </div>
        <div className="floor-booking-card-actions">
          <button type="button" className="text-action" disabled={busy || !actionable} onClick={() => onEdit(entry)}>Edit</button>
          {onArrive && <button type="button" className="text-action" disabled={busy || entry.status !== 'booked'} onClick={() => onArrive(entry)}>Arrive</button>}
          <button type="button" className="text-action" disabled={busy || !actionable} onClick={() => onNoShow(entry)}>No-show</button>
          <button type="button" className="text-action" disabled={busy || !actionable} onClick={() => onCancel(entry)}>Cancel</button>
          <button type="button" className="secondary-cta" disabled={busy || !actionable || !seatTableId} title={!seatTableId ? 'Select a table or assign one first' : undefined} onClick={() => onSeat(entry, seatTableId)}>Seat</button>
        </div>
      </article>
    })}
  </section>
}
