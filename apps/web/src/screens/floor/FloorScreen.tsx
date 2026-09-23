import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatCents } from '../../../../../packages/domain/src/money'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE, type TableStatus } from '../../../../../packages/domain/src/table-status'
import { createFloorArea, createRestaurantTable, deleteFloorArea, deleteRestaurantTable, fetchFloorPlan, mergeTableParty, TableStatusConflictError,
  transferTableParty, updateRestaurantTable, updateTableStatus, type FloorArea, type FloorEmployee, type RestaurantTable } from '../../lib/floor'
import { posDb } from '../../lib/db'
import { requireSupabase } from '../../lib/supabase'
import { usePosStore } from '../../lib/pos-store'
import { TableCard } from './TableCard'
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

export function FloorScreen() {
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
    const plan = await fetchFloorPlan(id)
    setAreas(plan.areas); setTables(plan.tables); setEmployees(plan.employees)
    return plan
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load the floor plan.')
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to view the floor.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
          .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        const config = await posDb.store_config.get(id)
        if (active) setStoreId(id)
        if (active) setCurrency(config?.currency ?? '')
        const plan = await reload(id)
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
      const updated = await updateTableStatus(storeId, table.id, expectedStatus, status, assignedWaiterId)
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
    if (updated) { setActiveTableId(table.id); navigate('/register') }
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
    if (!window.confirm(`Delete "${area.name}"? This only works if it has no tables left in it.`)) return
    setAreaActionBusy(true); setAreaActionError('')
    try {
      await deleteFloorArea(storeId, area.id)
      if (selectedArea === area.id) setSelectedArea('all')
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
    } catch (reason) { setTableActionError(reason instanceof Error ? reason.message : 'Could not save this table.') }
    finally { setTableActionBusy(false) }
  }

  async function handleDeleteTable(table: RestaurantTable) {
    if (!window.confirm(`Delete table ${table.label}? Only possible while it's available.`)) return
    setTableActionBusy(true); setTableActionError('')
    try {
      await deleteRestaurantTable(storeId, table.id)
      setSelectedTable(null)
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
      if (moveMode === 'transfer') await transferTableParty(storeId, table.id, moveTargetId)
      else await mergeTableParty(storeId, moveTargetId, table.id)
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
    <div className="floor-page-head">
      <div><p className="kicker">RESTAURANT FLOOR</p><h1>Floor & Tables</h1><p>Every table across your dining areas, at a glance.</p></div>
      <button type="button" className={editMode ? 'secondary-cta active' : 'secondary-cta'} onClick={() => setEditMode(value => !value)}>{editMode ? 'Done editing' : 'Edit floor'}</button>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading the floor…</p>}
    {!loading && !error && areas.length === 0 && tables.length === 0 && !editMode &&
      <p className="floor-empty">No floor areas or tables are set up for this restaurant yet. Click "Edit floor" to add one.</p>}
    {!loading && !error && <>
      <div className="floor-area-tabs" role="tablist" aria-label="Floor areas">
        <button type="button" className={selectedArea === 'all' ? 'active' : ''} onClick={() => setSelectedArea('all')}>All areas</button>
        {areas.map(area => <span className="floor-area-tab-wrap" key={area.id}>
          <button type="button" className={selectedArea === area.id ? 'active' : ''} onClick={() => setSelectedArea(area.id)}>{area.name}</button>
          {editMode && <button type="button" className="floor-area-delete" aria-label={`Delete ${area.name}`} title="Delete area" disabled={areaActionBusy} onClick={() => void handleDeleteArea(area)}>×</button>}
        </span>)}
      </div>
      {editMode && <form className="floor-inline-form" onSubmit={event => void handleAddArea(event)}>
        <input type="text" maxLength={80} placeholder="New area name (e.g. Rooftop)" value={newAreaName} onChange={event => setNewAreaName(event.target.value)} />
        <button type="submit" className="secondary-cta" disabled={areaActionBusy || !newAreaName.trim()}>{areaActionBusy ? 'Adding…' : 'Add area'}</button>
      </form>}
      {areaActionError && <p className="form-notice error" role="alert">{areaActionError}</p>}

      <div className="floor-grid">
        {visibleTables.map(table => <TableCard key={table.id} table={table} areaName={areaName(table.floor_area_id)} currency={currency} onSelect={() => openTable(table)} />)}
        {visibleTables.length === 0 && !editMode && <p className="floor-empty">No tables in this area.</p>}
        {editMode && !newTableOpen && <button type="button" className="floor-add-table-card" onClick={() => { setNewTableOpen(true); setTableActionError(''); if (!newTableAreaId) setNewTableAreaId(areas[0]?.id ?? '') }}>+ Add table</button>}
      </div>
      {editMode && newTableOpen && <form className="floor-inline-form floor-new-table-form" onSubmit={event => void handleAddTable(event)}>
        <label>Label<input type="text" maxLength={40} placeholder="T1" value={newTableLabel} onChange={event => setNewTableLabel(event.target.value)} /></label>
        <label>Seats<input type="number" min={1} value={newTableSeats} onChange={event => setNewTableSeats(event.target.value)} /></label>
        <label>Area<select value={newTableAreaId} onChange={event => setNewTableAreaId(event.target.value)}>
          {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select></label>
        <div className="floor-inline-form-actions">
          <button type="button" className="text-action" onClick={() => setNewTableOpen(false)}>Cancel</button>
          <button type="submit" className="secondary-cta" disabled={tableActionBusy}>{tableActionBusy ? 'Adding…' : 'Add table'}</button>
        </div>
        {tableActionError && <p className="form-notice error" role="alert">{tableActionError}</p>}
      </form>}
    </>}
    {selectedTable && <aside className="floor-detail" role="dialog" aria-label={`Table ${selectedTable.label}`}>
      <header><h2>Table {selectedTable.label}</h2><button type="button" className="text-action" onClick={() => setSelectedTable(null)}>Close</button></header>
      {!editTableOpen ? <dl>
        <div><dt>Area</dt><dd>{areaName(selectedTable.floor_area_id)}</dd></div>
        <div><dt>Seats</dt><dd>{selectedTable.seats}</dd></div>
        <div><dt>Status</dt><dd><span className={`floor-status floor-status-${TABLE_STATUS_TONE[selectedTable.status]}`}>{TABLE_STATUS_LABELS[selectedTable.status]}</span></dd></div>
        <div><dt>Waiter</dt><dd>{selectedTable.assigned_waiter_name ?? '—'}</dd></div>
        <div><dt>Last order</dt><dd>{selectedTable.current_order_total_cents && currency
          ? formatCents(Number(selectedTable.current_order_total_cents), currency) : '—'}</dd></div>
      </dl> : <div className="floor-inline-form floor-edit-table-form">
        <label>Label<input type="text" maxLength={40} value={editTableLabel} onChange={event => setEditTableLabel(event.target.value)} /></label>
        <label>Seats<input type="number" min={1} value={editTableSeats} onChange={event => setEditTableSeats(event.target.value)} /></label>
        <label>Area<select value={editTableAreaId} onChange={event => setEditTableAreaId(event.target.value)}>
          {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select></label>
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
      {selectedTable.status === SEAT_FROM && <label className="floor-waiter-select">
        Assign a waiter (optional)
        <select value={selectedWaiterId} onChange={event => setSelectedWaiterId(event.target.value)}>
          <option value="">No waiter selected</option>
          {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>}
      {actionError && <p className="form-notice error" role="alert">{actionError}</p>}
      {cartBlockNotice && <p className="form-notice error" role="alert">Clear the current cart before starting a table order.
        <button type="button" className="text-action" onClick={() => { clearCart(); setCartBlockNotice(false) }}>Clear cart</button>
      </p>}
      {moveMode && <div className="floor-move-form" role="group" aria-label={moveMode === 'transfer' ? 'Transfer to' : 'Merge with'}>
        <label>{moveMode === 'transfer' ? 'Transfer to which table?' : 'Merge with which table?'}
          <select value={moveTargetId} onChange={event => setMoveTargetId(event.target.value)}>
            <option value="">Choose a table…</option>
            {moveCandidates.map(table => <option key={table.id} value={table.id}>{table.label} · {areaName(table.floor_area_id)}</option>)}
          </select>
        </label>
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
        <button type="button" disabled={actionBusy || selectedTable.status !== MARK_SERVED_FROM} onClick={() => void handleMarkServed(selectedTable)}
          title="The kitchen normally does this automatically once every item on the ticket is served">Mark served</button>
        <button type="button" disabled={actionBusy || !OCCUPIED_STATUSES.includes(selectedTable.status)} onClick={() => openMove('transfer')}>Transfer</button>
        <button type="button" disabled={actionBusy || !OCCUPIED_STATUSES.includes(selectedTable.status)} onClick={() => openMove('merge')}>Merge</button>
        <button type="button" disabled={actionBusy || !BILLABLE_FROM.includes(selectedTable.status)} onClick={() => void handleBill(selectedTable)}>Bill</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== BILL_SETTLED_FROM} onClick={() => void handleBillSettled(selectedTable)}>Bill settled</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== CLEANED_FROM} onClick={() => void handleCleaned(selectedTable)}>Cleaned</button>
      </div>
    </aside>}
  </section>
}
