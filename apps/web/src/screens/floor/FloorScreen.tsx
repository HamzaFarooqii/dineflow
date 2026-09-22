import { useEffect, useState } from 'react'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE } from '../../../../../packages/domain/src/table-status'
import { fetchFloorPlan, type FloorArea, type RestaurantTable } from '../../lib/floor'
import { requireSupabase } from '../../lib/supabase'
import { TableCard } from './TableCard'
import './floor.css'

export function FloorScreen() {
  const [areas, setAreas] = useState<FloorArea[]>([])
  const [tables, setTables] = useState<RestaurantTable[]>([])
  const [selectedArea, setSelectedArea] = useState<string>('all')
  const [selectedTable, setSelectedTable] = useState<RestaurantTable | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

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
        const storeId = data?.[0]?.store_id
        if (!storeId) throw new Error('Store access is unavailable.')
        const plan = await fetchFloorPlan(storeId)
        if (active) { setAreas(plan.areas); setTables(plan.tables) }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load the floor plan.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  const visibleTables = selectedArea === 'all' ? tables : tables.filter(table => table.floor_area_id === selectedArea)
  const areaName = (id: string) => areas.find(area => area.id === id)?.name ?? 'Unassigned'

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
        {visibleTables.map(table => <TableCard key={table.id} table={table} areaName={areaName(table.floor_area_id)} onSelect={() => setSelectedTable(table)} />)}
        {visibleTables.length === 0 && <p className="floor-empty">No tables in this area.</p>}
      </div>
    </>}
    {selectedTable && <aside className="floor-detail" role="dialog" aria-label={`Table ${selectedTable.label}`}>
      <header><h2>Table {selectedTable.label}</h2><button type="button" className="text-action" onClick={() => setSelectedTable(null)}>Close</button></header>
      <dl>
        <div><dt>Area</dt><dd>{areaName(selectedTable.floor_area_id)}</dd></div>
        <div><dt>Seats</dt><dd>{selectedTable.seats}</dd></div>
        <div><dt>Status</dt><dd><span className={`floor-status floor-status-${TABLE_STATUS_TONE[selectedTable.status]}`}>{TABLE_STATUS_LABELS[selectedTable.status]}</span></dd></div>
        <div><dt>Waiter</dt><dd>—</dd></div>
        <div><dt>Open order</dt><dd>—</dd></div>
      </dl>
      {/* Disabled: no open-ticket layer exists yet to seat/transfer/merge/bill a table (Day 2). */}
      <div className="floor-detail-actions">
        <button type="button" disabled title="Available once open tickets are built">Add order</button>
        <button type="button" disabled title="Available once open tickets are built">Transfer</button>
        <button type="button" disabled title="Available once open tickets are built">Merge</button>
        <button type="button" disabled title="Available once open tickets are built">Bill</button>
      </div>
    </aside>}
  </section>
}
