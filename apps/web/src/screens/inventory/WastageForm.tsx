import { useState, type FormEvent } from 'react'
import { recordWastage, WastageValidationError, type Ingredient } from '../../lib/inventory'

export function WastageForm({ storeId, ingredient, onRecorded }: { storeId: string; ingredient: Ingredient; onRecorded: (ingredient: Ingredient) => void }) {
  const [quantity, setQuantity] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const parsedQuantity = Number(quantity)
    if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
      setError('Enter a quantity greater than zero.')
      return
    }
    setBusy(true); setError('')
    try {
      const result = await recordWastage(storeId, ingredient.id, { quantity: parsedQuantity, note: note.trim() || null })
      onRecorded(result.ingredient)
      setQuantity(''); setNote('')
    } catch (reason) {
      setError(reason instanceof WastageValidationError || reason instanceof Error ? reason.message : 'Could not record this wastage entry.')
    } finally { setBusy(false) }
  }

  return <form className="floor-inline-form inventory-wastage-form" onSubmit={event => void handleSubmit(event)}>
    <label>Quantity<input type="number" min={0} step="any" value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
    <label>Note (optional)<input type="text" maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></label>
    <div className="floor-inline-form-actions">
      <button type="submit" className="secondary-cta" disabled={busy || !quantity}>{busy ? 'Recording…' : 'Record wastage'}</button>
    </div>
    {error && <p className="form-notice error" role="alert">{error}</p>}
  </form>
}
