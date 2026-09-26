import { useState } from 'react'
import { formatCents, parseCents } from '../../../../../packages/domain/src/money'
import { formatCostPerUnit } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit, UnitKind } from '../menu/recipe-draft'
import { deactivateIngredient, reactivateIngredient, updateIngredient, type Ingredient } from '../../lib/inventory'
import type { ManagerApprovalEvidence } from '../../terminal-auth/ManagerApprovalModal'
import { InventoryStatusBadge } from './InventoryStatusBadge'
import { MetricCard } from '../../components/MetricCard'
import { Quantity } from './Quantity'
import { UnitSelector } from './UnitSelector'

const KIND_SUBTITLE: Record<UnitKind, string> = { mass: 'Weight inventory', volume: 'Liquid inventory', count: 'Count inventory' }

// Mirrors ReceiveStockForm/WastageForm's shape deliberately: the approval-wrapped write has to
// happen *inside* the requestApproval callback, not after an outer await, or a terminal's PIN
// modal flow (which resolves the outer call immediately and only runs the real write once
// approved) would close the edit form or clear the busy state before a manager has approved
// anything.
export function InventoryDetailHeader({
  storeId, ingredient, unit, units, currency, terminal = false, receiveOpen, onToggleReceive, wastageOpen, onToggleWastage,
  requestApproval, onCreateUnit, onUpdated,
}: {
  storeId: string
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  units: RecipeUnit[]
  currency: string
  terminal?: boolean
  receiveOpen: boolean
  onToggleReceive: () => void
  wastageOpen: boolean
  onToggleWastage: () => void
  requestApproval: (reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>) => Promise<void>
  onCreateUnit: (unit: { name: string; abbreviation: string; kind: UnitKind; factor_to_base?: number | null }) => Promise<RecipeUnit>
  onUpdated: (updated: Ingredient) => void
}) {
  const [editOpen, setEditOpen] = useState(false)
  const [name, setName] = useState(ingredient.name)
  const [unitId, setUnitId] = useState(ingredient.unit_id)
  const [cost, setCost] = useState((ingredient.cost_per_unit_cents / 100).toFixed(2))
  const [reorderThreshold, setReorderThreshold] = useState(ingredient.reorder_threshold ?? '')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [toggleBusy, setToggleBusy] = useState(false)
  const [toggleError, setToggleError] = useState('')

  const stock = Number(ingredient.current_stock)
  const estimatedValueCents = stock > 0 ? Math.round(stock * ingredient.cost_per_unit_cents) : 0

  function openEdit() {
    setName(ingredient.name); setUnitId(ingredient.unit_id); setCost((ingredient.cost_per_unit_cents / 100).toFixed(2))
    setReorderThreshold(ingredient.reorder_threshold ?? ''); setEditError('')
    setEditOpen(true)
  }

  async function submitEdit() {
    const trimmedName = name.trim()
    if (!trimmedName) { setEditError('Enter a name.'); return }
    if (!unitId) { setEditError('Choose a unit.'); return }
    let costPerUnitCents: number
    try { costPerUnitCents = parseCents(cost.trim() || '0') } catch (reason) {
      setEditError(reason instanceof Error ? reason.message : 'Enter a valid cost per unit.')
      return
    }
    const thresholdValue = String(reorderThreshold).trim()
    const threshold = thresholdValue === '' ? null : Number(thresholdValue)
    if (threshold !== null && (!Number.isFinite(threshold) || threshold <= 0)) {
      setEditError('Reorder threshold must be a positive number, or left blank.')
      return
    }
    setEditError('')
    await requestApproval('Authorize editing this ingredient', async approval => {
      setEditBusy(true)
      try {
        const updated = await updateIngredient(storeId, ingredient.id,
          { name: trimmedName, unit_id: unitId, cost_per_unit_cents: costPerUnitCents, reorder_threshold: threshold }, terminal, approval)
        onUpdated(updated)
        setEditOpen(false)
      } catch (reason) {
        setEditError(reason instanceof Error ? reason.message : 'Could not save this ingredient.')
      } finally {
        setEditBusy(false)
      }
    })
  }

  async function toggleActive() {
    setToggleError('')
    await requestApproval(ingredient.active ? 'Authorize deactivating this ingredient' : 'Authorize reactivating this ingredient', async approval => {
      setToggleBusy(true)
      try {
        const updated = ingredient.active
          ? await deactivateIngredient(storeId, ingredient.id, terminal, approval)
          : await reactivateIngredient(storeId, ingredient.id, terminal, approval)
        onUpdated(updated)
      } catch (reason) {
        setToggleError(reason instanceof Error ? reason.message : 'Could not update this ingredient.')
      } finally {
        setToggleBusy(false)
      }
    })
  }

  return <div className="inventory-detail-header">
    <div className="inventory-detail-header-top">
      <div>
        <h2>{ingredient.name}</h2>
        {unit && <p className="inventory-detail-subtitle">{KIND_SUBTITLE[unit.kind]}</p>}
      </div>
      <InventoryStatusBadge ingredient={ingredient} />
    </div>
    <div className="inventory-detail-stats">
      <MetricCard label="Current Stock" value={<Quantity value={ingredient.current_stock} unit={unit} />} />
      <MetricCard label="Average Cost" value={unit ? formatCostPerUnit(formatCents(ingredient.cost_per_unit_cents, currency), unit) : '—'} />
      <MetricCard label="Estimated Stock Value" value={formatCents(estimatedValueCents, currency)} />
    </div>
    {ingredient.reorder_threshold !== null && unit && <p className="inventory-detail-reorder">Reorder at <Quantity value={ingredient.reorder_threshold} unit={unit} /></p>}
    <div className="inventory-detail-actions">
      <button type="button" className={receiveOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={onToggleReceive}>{receiveOpen ? 'Cancel' : 'Receive Stock'}</button>
      <button type="button" className={wastageOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={onToggleWastage}>{wastageOpen ? 'Cancel' : 'Record Wastage'}</button>
      <button type="button" className={editOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={() => editOpen ? setEditOpen(false) : openEdit()}>{editOpen ? 'Cancel' : 'Edit'}</button>
      <button type="button" className="secondary-cta" disabled={toggleBusy} onClick={() => void toggleActive()}>
        {toggleBusy ? 'Working…' : ingredient.active ? 'Deactivate' : 'Reactivate'}
      </button>
    </div>
    {toggleError && <p className="form-notice error" role="alert">{toggleError}</p>}

    {editOpen && <form className="floor-inline-form" onSubmit={event => { event.preventDefault(); void submitEdit() }}>
      <label>Name<input type="text" maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={editBusy} /></label>
      <label>Unit<UnitSelector units={units} value={unitId} onChange={setUnitId} onCreateUnit={onCreateUnit} /></label>
      <label>Cost/unit<input type="number" min={0} step="0.01" value={cost} onChange={event => setCost(event.target.value)} disabled={editBusy} /></label>
      <label>Reorder threshold (optional)<input type="number" min={0} step="any" value={reorderThreshold} onChange={event => setReorderThreshold(event.target.value)} disabled={editBusy} /></label>
      <div className="floor-inline-form-actions">
        <button type="submit" className="secondary-cta" disabled={editBusy || !name.trim() || !unitId}>{editBusy ? 'Saving…' : 'Save changes'}</button>
      </div>
      {editError && <p className="form-notice error" role="alert">{editError}</p>}
    </form>}
  </div>
}
