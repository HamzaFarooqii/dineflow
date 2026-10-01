import { useMemo, useRef, useState, type FormEvent } from 'react'
import { InventoryRequestError, recordWastage, type Ingredient, type IngredientBatch, type StockMovement, type WastagePolicy } from '../../lib/inventory'
import { formatQuantity } from '../../../../../packages/domain/src/inventory-quantity'
import { formatCents } from '../../../../../packages/domain/src/money'
import { microToString, toMicro } from '../../../../../packages/domain/src/stock-allocation'
import {
  allowedStockEffects, defaultStockEffect, WASTAGE_CATEGORIES, WASTAGE_CATEGORY_LABELS, wastageApprovalPayload,
  type WastageCategory, type WastageStockEffect,
} from '../../../../../packages/domain/src/wastage-category'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { ManagerApprovalEvidence, OnlineApprovalBinding } from '../../terminal-auth/ManagerApprovalModal'
import { SelectField } from '../../components/SelectField'
import { StatusBadge } from '../../components/StatusBadge'
import { batchLabel } from './BatchList'
import { consumptionChoices, previewWastage } from './wastage-estimate'

const OTHER_NEEDS_NOTE: readonly WastageCategory[] = ['other', 'discrepancy']
const WASTAGE_APPROVAL_ACTION = 'inventory.wastage.record'

export function WastageForm({ storeId, ingredient, unit, batches, movements, currency, policy, policyError, terminal = false, requestApproval, onRecorded }: {
  storeId: string
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  batches: IngredientBatch[]
  movements: StockMovement[]
  currency: string
  /** null while loading (or if it failed to load -- see policyError). */
  policy: WastagePolicy | null
  policyError: string
  terminal?: boolean
  requestApproval: (reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>, online?: OnlineApprovalBinding) => Promise<void>
  onRecorded: (ingredient: Ingredient, quantity: number) => void
}) {
  const [quantity, setQuantity] = useState('')
  const [category, setCategory] = useState<WastageCategory>('spoiled')
  const [stockEffect, setStockEffect] = useState<WastageStockEffect>('deduct')
  const [servedItemId, setServedItemId] = useState('')
  const [note, setNote] = useState('')
  const [batchId, setBatchId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState('')
  // One operation id per logical entry. A retry of the SAME unchanged entry (e.g. after a dropped
  // response) reuses it, so the server replays the original result instead of recording it twice;
  // any edit makes it a different entry and gets a fresh id.
  const attempt = useRef<{ signature: string; id: string } | null>(null)

  const effect: WastageStockEffect = (allowedStockEffects(category) as readonly WastageStockEffect[]).includes(stockEffect) ? stockEffect : defaultStockEffect(category)
  const reclassify = effect === 'already_consumed'
  const availableBatches = batches.filter(batch => Number(batch.remaining_quantity) > 0)
  const choices = useMemo(() => consumptionChoices(movements), [movements])
  const noteRequired = OTHER_NEEDS_NOTE.includes(category)

  const preview = useMemo(() => reclassify || !quantity ? null : previewWastage({
    quantity, batches, explicitBatchId: batchId || null, ingredientCostCents: ingredient.cost_per_unit_cents,
    currentStock: ingredient.current_stock, thresholdCents: policy?.wastage_approval_threshold_cents ?? null,
  }), [reclassify, quantity, batches, batchId, ingredient.cost_per_unit_cents, ingredient.current_stock, policy])

  function onCategoryChange(next: WastageCategory) {
    setCategory(next)
    setStockEffect(defaultStockEffect(next))
    setServedItemId('')
    setError(''); setConfirmation('')
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    let quantityMicro: bigint
    try { quantityMicro = toMicro(quantity) } catch { setError('Enter a quantity greater than zero.'); return }
    if (quantityMicro <= 0n) { setError('Enter a quantity greater than zero.'); return }
    if (noteRequired && !note.trim()) { setError(`Add a note explaining this “${WASTAGE_CATEGORY_LABELS[category]}” entry.`); return }
    if (reclassify && !servedItemId) { setError('Choose the served dish this return belongs to.'); return }
    if (preview && !preview.ok) { setError(preview.reason); return }
    setError(''); setConfirmation('')

    const fields = {
      ingredientId: ingredient.id, quantity: microToString(quantityMicro), category, stockEffect: effect,
      note: note.trim() || null, batchId: reclassify ? null : batchId || null, kitchenTicketItemId: reclassify ? servedItemId : null,
    }
    const signature = JSON.stringify(fields)
    if (attempt.current?.signature !== signature) attempt.current = { signature, id: crypto.randomUUID() }
    const operationId = attempt.current.id

    await requestApproval('Authorize this wastage entry', async approval => {
      setBusy(true)
      try {
        const result = await recordWastage(storeId, ingredient.id, {
          operation_id: operationId, quantity: Number(fields.quantity), wastage_category: category, stock_effect: effect,
          note: fields.note, batch_id: fields.batchId, kitchen_ticket_item_id: fields.kitchenTicketItemId,
        }, terminal, approval)
        onRecorded(result.ingredient, Number(fields.quantity))
        const recorded = unit ? formatQuantity(fields.quantity, unit) : fields.quantity
        setConfirmation(
          `${result.replayed ? 'Already recorded — this retry was recognised and nothing was duplicated. ' : ''}${recorded} of ${ingredient.name} recorded as ${WASTAGE_CATEGORY_LABELS[category].toLowerCase()} wastage. ` +
          (reclassify ? 'Stock was not deducted again: that dish already consumed these ingredients when it was served.'
            : `Remaining stock: ${unit ? formatQuantity(result.ingredient.current_stock, unit) : result.ingredient.current_stock}.`))
        setQuantity(''); setNote(''); setBatchId(''); setServedItemId('')
        attempt.current = null
      } catch (reason) {
        // A conflict means this id already belongs to a different entry: never reuse it.
        if (reason instanceof InventoryRequestError && reason.code === 'operation_conflict') attempt.current = null
        setError(reason instanceof Error ? reason.message : 'Could not record this wastage entry.')
      } finally { setBusy(false) }
    }, terminal ? { action: WASTAGE_APPROVAL_ACTION, payload: wastageApprovalPayload(fields, operationId) } : undefined)
  }

  const threshold = policy?.wastage_approval_threshold_cents ?? null
  return <form className="floor-inline-form inventory-wastage-form" onSubmit={event => void handleSubmit(event)}>
    <p className="receive-stock-form-title">Record Wastage — {ingredient.name}</p>
    <SelectField label="Category" value={category} onChange={event => onCategoryChange(event.target.value as WastageCategory)} disabled={busy}>
      {WASTAGE_CATEGORIES.map(option => <option key={option} value={option}>{WASTAGE_CATEGORY_LABELS[option]}</option>)}
    </SelectField>
    {category === 'incorrect_order' && <SelectField label="Stock effect" value={effect} onChange={event => setStockEffect(event.target.value as WastageStockEffect)} disabled={busy}>
      <option value="deduct">Never served — deduct from stock</option>
      <option value="already_consumed">Already served — do not deduct again</option>
    </SelectField>}
    {reclassify && <>
      <p className="wastage-note">This dish was already served, so its ingredients were deducted when it was marked served. This entry records the loss for costing and does <strong>not</strong> take stock out a second time.</p>
      <SelectField label="Served dish" value={servedItemId} onChange={event => setServedItemId(event.target.value)} disabled={busy || !choices.length}>
        <option value="">{choices.length ? 'Choose the served dish' : 'No served dish has consumed this ingredient'}</option>
        {choices.map(choice => <option key={choice.kitchenTicketItemId} value={choice.kitchenTicketItemId}>
          Served {new Date(choice.createdAt).toLocaleString()} — used {unit ? formatQuantity(choice.consumed, unit) : choice.consumed}
        </option>)}
      </SelectField>
    </>}
    <label>Quantity Wasted
      <div className="unit-suffixed-input">
        <input type="number" min={0} step="any" value={quantity} onChange={event => { setQuantity(event.target.value); setConfirmation('') }} disabled={busy} />
        <span aria-hidden="true">{unit?.abbreviation ?? 'unit'}</span>
      </div>
    </label>
    <label>{noteRequired ? 'Note (required)' : 'Note (optional)'}<input type="text" maxLength={450} value={note} onChange={event => setNote(event.target.value)} disabled={busy} /></label>
    {!reclassify && <SelectField label="Batch" value={batchId} onChange={event => setBatchId(event.target.value)} disabled={busy}>
      <option value="">Auto (earliest expiry first, across batches)</option>
      {availableBatches.map(batch => <option key={batch.id} value={batch.id}>
        {batchLabel(batch.id)} · received {new Date(batch.received_at).toLocaleDateString()} — {unit ? formatQuantity(batch.remaining_quantity, unit) : batch.remaining_quantity} remaining
      </option>)}
    </SelectField>}

    {preview?.ok && <div className="wastage-preview" role="status" aria-live="polite">
      <div className="wastage-preview-head"><strong>Estimated cost {formatCents(preview.totalCents, currency)}</strong>
        {preview.estimatedCents > 0 && <StatusBadge tone="warning">Partly estimated</StatusBadge>}</div>
      <ul>
        {preview.allocations.map((item, index) => <li key={index}>
          <span>{item.batchId ? batchLabel(item.batchId) : 'No batch covers this'}</span>
          <span>{unit ? formatQuantity(item.quantity, unit) : item.quantity} × {formatCents(item.unitCostCents, currency)} = {formatCents(item.costCents, currency)}{item.basis === 'estimated_ingredient_cost' ? ' (estimate at ingredient cost)' : ''}</span>
        </li>)}
      </ul>
      <small>Preview only; the server re-checks stock and prices against live batches when you save.</small>
    </div>}
    {preview && !preview.ok && <p className="form-notice error" role="alert">{preview.reason}</p>}

    {terminal && <p className="wastage-note">
      {policyError ? <>Approval policy unavailable: {policyError}. A manager PIN is still required.</>
        : threshold === null ? 'Loading approval policy…'
          : preview?.ok && preview.requiresVerifiedApproval ? <>Worth <strong>{formatCents(preview.totalCents, currency)}</strong>, at or above this store’s {formatCents(threshold, currency)} threshold: a manager’s PIN will be verified by the server.</>
            : <>A manager PIN is required. Entries worth {formatCents(threshold, currency)} or more are verified by the server{preview?.ok ? '; this one is below that' : ''}.</>}
    </p>}
    {!terminal && <p className="wastage-note">You’re signed in as a manager, so no separate PIN is needed.{threshold !== null && <> Terminals need a verified PIN at {formatCents(threshold, currency)} or more.</>}</p>}

    <div className="floor-inline-form-actions">
      <button type="submit" className="secondary-cta" disabled={busy || !quantity || (reclassify && !choices.length)}>{busy ? 'Recording…' : 'Record Wastage'}</button>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {confirmation && !error && <p className="form-notice" role="status">{confirmation}</p>}
  </form>
}
