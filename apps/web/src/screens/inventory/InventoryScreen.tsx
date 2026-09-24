import { useEffect, useState, type FormEvent } from 'react'
import { fetchIngredients, fetchStockMovements, recordIngredientBatch, type Ingredient, type IngredientBatch, type StockMovement } from '../../lib/inventory'
import { posDb } from '../../lib/db'
import { requireSupabase } from '../../lib/supabase'
import { IngredientList } from './IngredientList'
import { BatchList } from './BatchList'
import { StockLedger } from './StockLedger'
import { WastageForm } from './WastageForm'
import './inventory.css'

export function InventoryScreen() {
  const [storeId, setStoreId] = useState('')
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [selected, setSelected] = useState<Ingredient | null>(null)
  const [batches, setBatches] = useState<IngredientBatch[]>([])
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState('')

  const [batchQuantity, setBatchQuantity] = useState('')
  const [batchCost, setBatchCost] = useState('')
  const [batchExpiry, setBatchExpiry] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        if (!navigator.onLine) throw new Error('Connect to load inventory.')
        const client = requireSupabase()
        const { data: { user }, error: userError } = await client.auth.getUser()
        if (userError || !user) throw new Error('Sign in to view inventory.')
        const { data, error: membershipError } = await client.from('store_memberships').select('store_id')
          .eq('user_id', user.id).eq('active', true).limit(1)
        if (membershipError) throw membershipError
        const id = data?.[0]?.store_id
        if (!id) throw new Error('Store access is unavailable.')
        await posDb.store_config.get(id)
        if (active) setStoreId(id)
        const list = await fetchIngredients(id)
        if (active) setIngredients(list)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load inventory.')
      } finally { if (active) setLoading(false) }
    }
    void load()
    return () => { active = false }
  }, [])

  async function selectIngredient(ingredient: Ingredient) {
    setSelected(ingredient)
    setDetailError('')
    setBatches([])
    setMovements([])
    setDetailBusy(true)
    try {
      const page = await fetchStockMovements(storeId, ingredient.id)
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
    const page = await fetchStockMovements(storeId, ingredientId)
    setMovements(page.movements)
  }

  async function handleAddBatch(event: FormEvent) {
    event.preventDefault()
    if (!selected) return
    const quantity = Number(batchQuantity)
    const costPerUnitCents = Math.round(Number(batchCost) * 100)
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(costPerUnitCents) || costPerUnitCents < 0) {
      setDetailError('Enter a positive quantity and a valid cost per unit.')
      return
    }
    setDetailBusy(true); setDetailError('')
    try {
      const result = await recordIngredientBatch(storeId, selected.id, {
        quantity,
        cost_per_unit_cents: costPerUnitCents,
        expires_at: batchExpiry || null,
      })
      setBatches(current => [result.batch, ...current])
      applyUpdatedIngredient(result.ingredient)
      await refreshMovements(selected.id)
      setBatchQuantity(''); setBatchCost(''); setBatchExpiry('')
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : 'Could not record this batch.')
    } finally { setDetailBusy(false) }
  }

  async function handleWastageRecorded(updated: Ingredient) {
    applyUpdatedIngredient(updated)
    if (selected) await refreshMovements(selected.id)
  }

  return <section className="floor-page inventory-page">
    <div className="floor-page-head">
      <div><p className="kicker">STOCK & INGREDIENTS</p><h1>Inventory</h1><p>Track ingredients, batches, and stock movements.</p></div>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {loading && !error && <p role="status">Loading inventory…</p>}
    {!loading && !error && <div className="inventory-layout">
      <IngredientList ingredients={ingredients} selectedId={selected?.id ?? null} onSelect={ingredient => void selectIngredient(ingredient)} />
      {selected && <div className="inventory-detail">
        <h2>{selected.name}</h2>
        {detailError && <p className="form-notice error" role="alert">{detailError}</p>}

        <h3>Receive a batch</h3>
        <form className="floor-inline-form" onSubmit={event => void handleAddBatch(event)}>
          <label>Quantity<input type="number" min={0} step="any" value={batchQuantity} onChange={event => setBatchQuantity(event.target.value)} /></label>
          <label>Cost/unit<input type="number" min={0} step="0.01" value={batchCost} onChange={event => setBatchCost(event.target.value)} /></label>
          <label>Expires (optional)<input type="date" value={batchExpiry} onChange={event => setBatchExpiry(event.target.value)} /></label>
          <div className="floor-inline-form-actions">
            <button type="submit" className="secondary-cta" disabled={detailBusy || !batchQuantity || !batchCost}>{detailBusy ? 'Saving…' : 'Receive batch'}</button>
          </div>
        </form>

        <h3>Batches</h3>
        <BatchList batches={batches} />

        <h3>Record wastage</h3>
        <WastageForm storeId={storeId} ingredient={selected} onRecorded={updated => void handleWastageRecorded(updated)} />

        <h3>Stock movements</h3>
        <StockLedger movements={movements} />
      </div>}
    </div>}
  </section>
}
