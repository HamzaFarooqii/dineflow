import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE, type TableStatus } from '../../../../../packages/domain/src/table-status'
import { fetchFloorPlan, TableStatusConflictError, updateTableStatus, type FloorArea, type FloorEmployee, type RestaurantTable } from '../../lib/floor'
import { requireSupabase } from '../../lib/supabase'
import { usePosStore } from '../../lib/pos-store'
import { TableCard } from './TableCard'
import './floor.css'

// Explicit edge -> action mapping mirrors apps/api/src/routes/floor.ts's TRANSITIONS map. Kept
// here only for driving which drawer button is enabled; the server is the source of truth and
// re-validates every transition itself.
const SEAT_FROM: TableStatus = 'available'
const ADD_ORDER_FROM: TableStatus = 'seated'
const BILLABLE_FROM: readonly TableStatus[] = ['ordering', 'served']
const CLEANED_FROM: TableStatus = 'dirty'

export function FloorScreen() {
  const navigate = useNavigate()
  const [storeId, setStoreId] = useState('')
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

  const cartItems = usePosStore(state => state.items)
  const setActiveTableId = usePosStore(state => state.setActiveTableId)
  const activeTableId = usePosStore(state => state.activeTableId)
  const clearCart = usePosStore(state => state.clearCart)

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
        const plan = await fetchFloorPlan(id)
        if (active) { setStoreId(id); setAreas(plan.areas); setTables(plan.tables); setEmployees(plan.employees) }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load the floor plan.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  const visibleTables = selectedArea === 'all' ? tables : tables.filter(table => table.floor_area_id === selectedArea)
  const areaName = (id: string) => areas.find(area => area.id === id)?.name ?? 'Unassigned'

  function openTable(table: RestaurantTable) {
    setSelectedTable(table)
    setSelectedWaiterId('')
    setActionError('')
    setCartBlockNotice(false)
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
          const plan = await fetchFloorPlan(storeId)
          setAreas(plan.areas); setTables(plan.tables); setEmployees(plan.employees)
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

  async function handleCleaned(table: RestaurantTable) {
    const updated = await runTransition(table, CLEANED_FROM, 'available')
    if (updated && activeTableId === table.id) setActiveTableId(null)
  }

  return <section className="floor-page">
    <p className="kicker">RESTAURANT FLOOR</p>
    <h1>Floor & Tables</h1>
    <p>Every table across your dining areas, at a glance.</p>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading the floor…</p>}
    {!loading && !error && areas.length === 0 && tables.length === 0 &&
      <p className="floor-empty">No floor areas or tables are set up for this restaurant yet.</p>}
    {!loading && !error && (areas.length > 0 || tables.length > 0) && <>
      <div className="floor-area-tabs" role="tablist" aria-label="Floor areas">
        <button type="button" className={selectedArea === 'all' ? 'active' : ''} onClick={() => setSelectedArea('all')}>All areas</button>
        {areas.map(area => <button key={area.id} type="button" className={selectedArea === area.id ? 'active' : ''} onClick={() => setSelectedArea(area.id)}>{area.name}</button>)}
      </div>
      <div className="floor-grid">
        {visibleTables.map(table => <TableCard key={table.id} table={table} areaName={areaName(table.floor_area_id)} onSelect={() => openTable(table)} />)}
        {visibleTables.length === 0 && <p className="floor-empty">No tables in this area.</p>}
      </div>
    </>}
    {selectedTable && <aside className="floor-detail" role="dialog" aria-label={`Table ${selectedTable.label}`}>
      <header><h2>Table {selectedTable.label}</h2><button type="button" className="text-action" onClick={() => setSelectedTable(null)}>Close</button></header>
      <dl>
        <div><dt>Area</dt><dd>{areaName(selectedTable.floor_area_id)}</dd></div>
        <div><dt>Seats</dt><dd>{selectedTable.seats}</dd></div>
        <div><dt>Status</dt><dd><span className={`floor-status floor-status-${TABLE_STATUS_TONE[selectedTable.status]}`}>{TABLE_STATUS_LABELS[selectedTable.status]}</span></dd></div>
        <div><dt>Waiter</dt><dd>{selectedTable.assigned_waiter_name ?? '—'}</dd></div>
        {/* No open-ticket layer exists yet — order total/elapsed time stay "—" until Ahmed's order/table link is merged. */}
        <div><dt>Open order</dt><dd>—</dd></div>
      </dl>
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
      <div className="floor-detail-actions">
        <button type="button" disabled={actionBusy || selectedTable.status !== SEAT_FROM} onClick={() => void handleSeat(selectedTable)}>Seat</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== ADD_ORDER_FROM} onClick={() => void handleAddOrder(selectedTable)}>Add order</button>
        <button type="button" disabled title="Available once table–order linking lands">Transfer</button>
        <button type="button" disabled title="Available once table–order linking lands">Merge</button>
        <button type="button" disabled={actionBusy || !BILLABLE_FROM.includes(selectedTable.status)} onClick={() => void handleBill(selectedTable)}>Bill</button>
        <button type="button" disabled={actionBusy || selectedTable.status !== CLEANED_FROM} onClick={() => void handleCleaned(selectedTable)}>Cleaned</button>
      </div>
    </aside>}
  </section>
}
