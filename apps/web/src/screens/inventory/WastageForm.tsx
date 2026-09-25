import { useState, type FormEvent } from 'react'
import { recordWastage, WastageValidationError, type Ingredient, type IngredientBatch } from '../../lib/inventory'
import { formatQuantity } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { ManagerApprovalEvidence } from '../../terminal-auth/ManagerApprovalModal'
import { SelectField } from '../../components/SelectField'

// A curated category list, not a new schema concept: the chosen reason (plus any extra detail)
// is folded into stock_movements.note, exactly the free-text field this schema already has for
// "a manual wastage entry's reason" (see 202609240002_ingredient_inventory.sql's own comment) --
// no new column, no new enum value.
const WASTAGE_REASONS = ['Spoilage', 'Expired', 'Preparation Waste', 'Damaged', 'Incorrect Order', 'Staff Meal', 'Other'] as const

export function WastageForm({ storeId, ingredient, unit, batches, terminal = false, requestApproval, onRecorded }: {
  storeId: string
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  batches: IngredientBatch[]
  terminal?: boolean
  requestApproval: (reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>) => Promise<void>
  onRecorded: (ingredient: Ingredient, quantity: number) => void
}) {
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState<typeof WASTAGE_REASONS[number]>('Spoilage')
  const [detail, setDetail] = useState('')
  const [batchId, setBatchId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState('')

  const availableBatches = batches.filter(batch => Number(batch.remaining_quantity) > 0)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const parsedQuantity = Number(quantity)
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setError('Enter a quantity greater than zero.')
      return
    }
    setError(''); setConfirmation('')
    const note = `${reason}${detail.trim() ? `: ${detail.trim()}` : ''}`
    await requestApproval('Authorize this wastage entry', async approval => {
      setBusy(true)
      try {
        const result = await recordWastage(storeId, ingredient.id, { quantity: parsedQuantity, note, batch_id: batchId || null }, terminal, approval)
        onRecorded(result.ingredient, parsedQuantity)
        setConfirmation(unit
          ? `${formatQuantity(parsedQuantity, unit)} of ${ingredient.name} recorded as wastage. Remaining stock: ${formatQuantity(result.ingredient.current_stock, unit)}.`
          : `Wastage recorded. Remaining stock: ${result.ingredient.current_stock}.`)
        setQuantity(''); setDetail(''); setBatchId('')
      } catch (reason) {
        setError(reason instanceof WastageValidationError || reason instanceof Error ? reason.message : 'Could not record this wastage entry.')
      } finally { setBusy(false) }
    })
  }

  return <form className="floor-inline-form inventory-wastage-form" onSubmit={event => void handleSubmit(event)}>
    <p className="receive-stock-form-title">Record Wastage — {ingredient.name}</p>
    <label>Quantity Wasted
      <div className="unit-suffixed-input">
        <input type="number" min={0} step="any" value={quantity} onChange={event => { setQuantity(event.target.value); setConfirmation('') }} disabled={busy} />
        <span aria-hidden="true">{unit?.abbreviation ?? 'unit'}</span>
      </div>
    </label>
    <SelectField label="Reason" value={reason} onChange={event => setReason(event.target.value as typeof WASTAGE_REASONS[number])} disabled={busy}>
      {WASTAGE_REASONS.map(option => <option key={option} value={option}>{option}</option>)}
    </SelectField>
    <label>Note (optional)<input type="text" maxLength={450} value={detail} onChange={event => setDetail(event.target.value)} disabled={busy} /></label>
    <SelectField label="Batch" value={batchId} onChange={event => setBatchId(event.target.value)} disabled={busy}>
      <option value="">Auto (soonest-expiring batch)</option>
      {availableBatches.map(batch => <option key={batch.id} value={batch.id}>
        Received {new Date(batch.received_at).toLocaleDateString()} — {unit ? formatQuantity(batch.remaining_quantity, unit) : batch.remaining_quantity} remaining
      </option>)}
    </SelectField>
    <div className="floor-inline-form-actions">
      <button type="submit" className="secondary-cta" disabled={busy || !quantity}>{busy ? 'Recording…' : 'Record Wastage'}</button>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {confirmation && !error && <p className="form-notice" role="status">{confirmation}</p>}
  </form>
}
