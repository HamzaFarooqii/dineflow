import { useState, type FormEvent } from 'react'
import { formatCents } from '../../../../../packages/domain/src/money'
import { recordIngredientBatch, type Ingredient, type IngredientBatch, type StockMovement } from '../../lib/inventory'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { ManagerApprovalEvidence } from '../../terminal-auth/ManagerApprovalModal'

// Mirrors WastageForm's shape deliberately: the approval-wrapped write has to happen *inside*
// the requestApproval callback, not after an outer await, or a terminal's PIN modal flow (which
// resolves the outer call immediately and only runs the real write once approved) would clear
// this form's fields and stop showing a busy state before the manager has even approved anything.
export function ReceiveStockForm({ storeId, ingredient, unit, currency, terminal = false, requestApproval, onReceived }: {
  storeId: string
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  currency: string
  terminal?: boolean
  requestApproval: (reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>) => Promise<void>
  onReceived: (result: { batch: IngredientBatch; movement: StockMovement; ingredient: Ingredient }) => void | Promise<void>
}) {
  const [quantity, setQuantity] = useState('')
  const [cost, setCost] = useState('')
  const [expiry, setExpiry] = useState('')
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const parsedQuantity = Number(quantity)
  const costPerUnitCents = Math.round(Number(cost) * 100)
  const totalCents = Number.isFinite(parsedQuantity) && parsedQuantity > 0 && Number.isFinite(costPerUnitCents) && costPerUnitCents >= 0
    ? Math.round(parsedQuantity * costPerUnitCents)
    : null

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) { setError('Enter a quantity greater than zero.'); return }
    if (!Number.isFinite(costPerUnitCents) || costPerUnitCents < 0) { setError('Enter a valid, non-negative cost.'); return }
    if (expiry && Number.isNaN(new Date(`${expiry}T00:00:00`).getTime())) { setError('Enter a valid expiry date.'); return }
    setError('')
    await requestApproval('Authorize receiving this batch', async approval => {
      setBusy(true)
      try {
        const result = await recordIngredientBatch(storeId, ingredient.id, {
          quantity: parsedQuantity, cost_per_unit_cents: costPerUnitCents, expires_at: expiry || null, reference: reference.trim() || null,
        }, terminal, approval)
        await onReceived(result)
        setQuantity(''); setCost(''); setExpiry(''); setReference('')
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Could not record this batch.')
      } finally { setBusy(false) }
    })
  }

  const abbreviation = unit?.abbreviation ?? 'unit'

  return <form className="floor-inline-form receive-stock-form" onSubmit={event => void handleSubmit(event)}>
    <p className="receive-stock-form-title">Receive Stock — {ingredient.name}</p>
    <label>Quantity Received
      <div className="unit-suffixed-input">
        <input type="number" min={0} step="any" value={quantity} onChange={event => setQuantity(event.target.value)} disabled={busy} />
        <span aria-hidden="true">{abbreviation}</span>
      </div>
    </label>
    <label>{`Cost / ${abbreviation}`}
      <input type="number" min={0} step="0.01" value={cost} onChange={event => setCost(event.target.value)} disabled={busy} />
    </label>
    <div className="receive-stock-total">
      <small>Total Batch Cost</small>
      <strong>{totalCents !== null ? formatCents(totalCents, currency) : '—'}</strong>
    </div>
    <label>Expiry Date (optional)<input type="date" value={expiry} onChange={event => setExpiry(event.target.value)} disabled={busy} /></label>
    <label>Reference / Supplier (optional)<input type="text" maxLength={200} placeholder="Invoice #, supplier name…" value={reference} onChange={event => setReference(event.target.value)} disabled={busy} /></label>
    <div className="floor-inline-form-actions">
      <button type="submit" className="secondary-cta" disabled={busy || !quantity || !cost}>{busy ? 'Saving…' : 'Receive Stock'}</button>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
  </form>
}
