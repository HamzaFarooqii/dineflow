import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  createIngredient, fetchExpiringBatchCount, fetchIngredientBatches, fetchIngredients, fetchStockMovements,
  type Ingredient, type IngredientBatch, type StockMovement,
} from '../../lib/inventory'
import { loadRecipeData, createUnit } from '../menu/recipe-api'
import type { RecipeUnit } from '../menu/recipe-draft'
import { posDb } from '../../lib/db'
import { requireSupabase } from '../../lib/supabase'
import { currentAccess, refreshTerminal, type TerminalCache } from '../../terminal-auth/cache'
import { ManagerApprovalModal, type ManagerApprovalEvidence } from '../../terminal-auth/ManagerApprovalModal'
import { InventorySummary } from './InventorySummary'
import { InventoryToolbar, type InventoryFilter, type InventorySort } from './InventoryToolbar'
import { IngredientList } from './IngredientList'
import { InventoryDetailHeader } from './InventoryDetailHeader'
import { ReceiveStockForm } from './ReceiveStockForm'
import { BatchList } from './BatchList'
import { WastageForm } from './WastageForm'
import { StockLedger } from './StockLedger'
import { UnitSelector } from './UnitSelector'
import { PageHeader } from '../../components/PageHeader'
import './inventory.css'

export function InventoryScreen({ terminal = false }: { terminal?: boolean }) {
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [terminalCache, setTerminalCache] = useState<TerminalCache | undefined>()
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [units, setUnits] = useState<RecipeUnit[]>([])
  const [expiringBatchCount, setExpiringBatchCount] = useState<number | null>(null)
  const [selected, setSelected] = useState<Ingredient | null>(null)
  const [batches, setBatches] = useState<IngredientBatch[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [wastageOpen, setWastageOpen] = useState(false)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<InventoryFilter>('all')
  const [sort, setSort] = useState<InventorySort>('name')

  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUnitId, setNewUnitId] = useState('')
  const [newCost, setNewCost] = useState('')
  const [newReorderThreshold, setNewReorderThreshold] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [addError, setAddError] = useState('')

  // A cashier terminal never writes inventory on its own authority — every mutation (add
  // ingredient, receive batch, wastage) is deferred behind a manager's PIN, reusing the exact
  // ManagerApprovalModal/evidence flow RegisterScreen uses for over-authority discounts. The
  // pending write is stashed in a ref (not state) so the modal's onApprove can invoke it without
  // a stale closure.
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalReason, setApprovalReason] = useState('')
  const pendingWrite = useRef<((approval: ManagerApprovalEvidence) => Promise<void>) | null>(null)
  const [accessRefreshBusy, setAccessRefreshBusy] = useState(false)
  const [accessRefreshError, setAccessRefreshError] = useState('')

  const unitsById = useMemo(() => new Map(units.map(unit => [unit.id, unit])), [units])
  const selectedUnit = selected ? unitsById.get(selected.unit_id) : undefined

  async function withApproval(reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>) {
    if (!terminal) { await action(null); return }
    pendingWrite.current = action
    setApprovalReason(reason)
    setApprovalOpen(true)
  }

  // Manual escape hatch for "no manager is provisioned on this terminal" — pulls the current
  // employee list (including any manager added since this terminal last logged in) without
  // sending the cashier back to /pos/login.
  async function handleRefreshAccess() {
    if (!navigator.onLine) { setAccessRefreshError('Connect to refresh terminal access.'); return }
    setAccessRefreshBusy(true); setAccessRefreshError('')
    try {
      const refreshed = await refreshTerminal()
      setTerminalCache(refreshed)
    } catch (reason) {
      setAccessRefreshError(reason instanceof Error ? reason.message : 'Could not refresh terminal access.')
    } finally { setAccessRefreshBusy(false) }
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load inventory.')
        let id: string
        if (terminal) {
          // Best-effort: pull the latest employee/manager list (e.g. a manager added after this
          // terminal last logged in) before reading the cache, mirroring CashierLogin's boot
          // refresh. Never fatal — an offline or failed refresh just falls back to whatever is
          // already cached, same as before this existed.
          await refreshTerminal().catch(() => undefined)
          const terminalAccess = await currentAccess()
          if (!terminalAccess?.policy.valid) throw new Error('Unlock this terminal before opening inventory.')
          id = terminalAccess.cache.device.store_id
          if (active) setTerminalCache(terminalAccess.cache)
        } else {
          const client = requireSupabase()
          const { data: { user }, error: userError } = await client.auth.getUser()
          if (userError || !user) throw new Error('Sign in to view inventory.')
          const { data, error: membershipError } = await client.from('store_memberships').select('store_id')
            .eq('user_id', user.id).eq('active', true).limit(1)
          if (membershipError) throw membershipError
          const membershipStoreId = data?.[0]?.store_id
          if (!membershipStoreId) throw new Error('Store access is unavailable.')
          id = membershipStoreId
        }
        const config = await posDb.store_config.get(id)
        if (active) { setStoreId(id); if (config?.currency) setCurrency(config.currency) }
        const [list, recipeData, expiringCount] = await Promise.all([
          // includeInactive: a deactivated ingredient needs to stay findable (under the
          // "Inactive" filter) to ever be reactivated -- excluding it entirely would strand it.
          fetchIngredients(id, terminal, true),
          loadRecipeData(id),
          fetchExpiringBatchCount(id, terminal).catch(() => null),
        ])
        if (active) {
          setIngredients(list)
          setUnits(recipeData.units)
          if (!newUnitId) setNewUnitId(recipeData.units[0]?.id ?? '')
          if (expiringCount !== null) setExpiringBatchCount(expiringCount)
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load inventory.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal])

  async function selectIngredient(ingredient: Ingredient) {
    setSelected(ingredient)
    setDetailError('')
    setBatches([])
    setMovements([])
    setReceiveOpen(false)
    setWastageOpen(false)
    setDetailBusy(true)
    try {
      const [batchList, page] = await Promise.all([
        fetchIngredientBatches(storeId, ingredient.id, terminal),
        fetchStockMovements(storeId, ingredient.id, terminal),
      ])
      setBatches(batchList)
      setMovements(page.movements)
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Could not load this ingredient.')
    } finally { setDetailBusy(false) }
  }

  function applyUpdatedIngredient(updated: Ingredient) {
    setIngredients(current => current.map(ingredient => ingredient.id === updated.id ? updated : ingredient))
    setSelected(current => current && current.id === updated.id ? updated : current)
  }

  async function refreshMovements(ingredientId: string) {
    const page = await fetchStockMovements(storeId, ingredientId, terminal)
    setMovements(page.movements)
  }

  async function refreshExpiringCount() {
    try { setExpiringBatchCount(await fetchExpiringBatchCount(storeId, terminal)) } catch { /* leave the last known count showing */ }
  }

  async function handleAddIngredient(event: FormEvent) {
    event.preventDefault()
    const costPerUnitCents = Math.round(Number(newCost) * 100)
    if (!newName.trim() || !newUnitId || !Number.isFinite(costPerUnitCents) || costPerUnitCents < 0) {
      setAddError('Enter a name, pick a unit, and enter a valid cost per unit.')
      return
    }
    const reorderThreshold = newReorderThreshold ? Number(newReorderThreshold) : null
    if (reorderThreshold !== null && (!Number.isFinite(reorderThreshold) || reorderThreshold <= 0)) {
      setAddError('Reorder threshold must be a positive number, or left blank.')
      return
    }
    setAddError('')
    await withApproval('Authorize adding this ingredient', async approval => {
      setAddBusy(true)
      try {
        const created = await createIngredient(storeId, { name: newName.trim(), unit_id: newUnitId, cost_per_unit_cents: costPerUnitCents, reorder_threshold: reorderThreshold }, terminal, approval)
        setIngredients(current => [...current, created].sort((a, b) => a.name.localeCompare(b.name)))
        setNewName(''); setNewCost(''); setNewReorderThreshold(''); setAddOpen(false)
      } catch (reason) {
        setAddError(reason instanceof Error ? reason.message : 'Could not add this ingredient.')
      } finally { setAddBusy(false) }
    })
  }

  async function handleStockReceived(result: { batch: IngredientBatch; ingredient: Ingredient }) {
    setBatches(current => [result.batch, ...current])
    applyUpdatedIngredient(result.ingredient)
    await Promise.all([refreshMovements(result.ingredient.id), refreshExpiringCount()])
  }

  async function handleWastageRecorded(updated: Ingredient) {
    applyUpdatedIngredient(updated)
    if (selected) {
      await Promise.all([refreshMovements(selected.id), refreshExpiringCount()])
      const batchList = await fetchIngredientBatches(storeId, selected.id, terminal)
      setBatches(batchList)
    }
  }

  return <section className="floor-page inventory-page">
    <PageHeader
      kicker="STOCK & INGREDIENTS"
      title="Inventory"
      subtitle="Track ingredients, batches, and stock movements."
      actions={terminal && <button type="button" className="text-action" disabled={accessRefreshBusy} onClick={() => void handleRefreshAccess()}
        title="Pull the latest employee/manager list, e.g. after a manager was just added">{accessRefreshBusy ? 'Refreshing…' : 'Refresh access'}</button>}
    />
    {accessRefreshError && <p className="form-notice error" role="alert">{accessRefreshError}</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading inventory…</p>}

    {!loading && !error && <>
      <InventorySummary ingredients={ingredients} expiringBatchCount={expiringBatchCount} currency={currency} />
      <InventoryToolbar search={search} onSearchChange={setSearch} filter={filter} onFilterChange={setFilter}
        sort={sort} onSortChange={setSort} addOpen={addOpen} onAddIngredient={() => setAddOpen(value => !value)} />

      {addOpen && <form className="floor-inline-form" onSubmit={event => void handleAddIngredient(event)}>
        <label>Name<input type="text" maxLength={120} value={newName} onChange={event => setNewName(event.target.value)} /></label>
        <label>Unit<UnitSelector units={units} value={newUnitId} onChange={setNewUnitId} onCreateUnit={unit => createUnit(storeId, unit).then(created => { setUnits(current => [...current, created]); return created })} /></label>
        <label>Cost/unit<input type="number" min={0} step="0.01" value={newCost} onChange={event => setNewCost(event.target.value)} /></label>
        <label>Reorder threshold (optional)<input type="number" min={0} step="any" value={newReorderThreshold} onChange={event => setNewReorderThreshold(event.target.value)} /></label>
        <div className="floor-inline-form-actions">
          <button type="submit" className="secondary-cta" disabled={addBusy || !newName.trim() || !newUnitId}>{addBusy ? 'Adding…' : 'Add ingredient'}</button>
        </div>
        {addError && <p className="form-notice error" role="alert">{addError}</p>}
      </form>}

      <div className="inventory-layout">
        <IngredientList ingredients={ingredients} units={units} currency={currency} search={search} filter={filter} sort={sort}
          selectedId={selected?.id ?? null} onSelect={ingredient => void selectIngredient(ingredient)} />

        {selected && <div className="inventory-detail">
          <InventoryDetailHeader storeId={storeId} ingredient={selected} unit={selectedUnit} units={units} currency={currency} terminal={terminal}
            receiveOpen={receiveOpen} onToggleReceive={() => setReceiveOpen(value => !value)}
            wastageOpen={wastageOpen} onToggleWastage={() => setWastageOpen(value => !value)}
            requestApproval={withApproval}
            onCreateUnit={unit => createUnit(storeId, unit).then(created => { setUnits(current => [...current, created]); return created })}
            onUpdated={applyUpdatedIngredient} />
          {detailError && <p className="form-notice error" role="alert">{detailError}</p>}
          {detailBusy && <p role="status">Loading ingredient details…</p>}

          {receiveOpen && <ReceiveStockForm storeId={storeId} ingredient={selected} unit={selectedUnit} currency={currency} terminal={terminal}
            requestApproval={withApproval} onReceived={handleStockReceived} />}

          {!detailBusy && <>
            <h3>Batches</h3>
            <BatchList batches={batches} unit={selectedUnit} currency={currency} />

            {wastageOpen && <WastageForm key={selected.id} storeId={storeId} ingredient={selected} unit={selectedUnit} batches={batches}
              terminal={terminal} requestApproval={withApproval} onRecorded={updated => void handleWastageRecorded(updated)} />}

            <h3>Stock Activity</h3>
            <StockLedger movements={movements} currentStock={Number(selected.current_stock)} unit={selectedUnit} />
          </>}
        </div>}
      </div>
    </>}

    {approvalOpen && terminal && terminalCache && <ManagerApprovalModal
      cache={terminalCache}
      title="Manager approval required"
      reason={approvalReason}
      actionLabel="Approve"
      onClose={() => { setApprovalOpen(false); pendingWrite.current = null }}
      onApprove={evidence => {
        setApprovalOpen(false)
        const action = pendingWrite.current
        pendingWrite.current = null
        if (action) void action(evidence)
      }}
    />}
  </section>
}
