import { useState, type FormEvent } from 'react'
import { recordWastage, WastageValidationError, type Ingredient } from '../../lib/inventory'
import type { ManagerApprovalEvidence } from '../../terminal-auth/ManagerApprovalModal'

export function WastageForm({ storeId, ingredient, terminal = false, requestApproval, onRecorded }: {
  storeId: string
  ingredient: Ingredient
  terminal?: boolean
  requestApproval: (reason: string, action: (approval: ManagerApprovalEvidence | null) => Promise<void>) => Promise<void>
  onRecorded: (ingredient: Ingredient) => void
}) {
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
    setError('')
    await requestApproval('Authorize this wastage entry', async approval => {
      setBusy(true)
      try {
        const result = await recordWastage(storeId, ingredient.id, { quantity: parsedQuantity, note: note.trim() || null }, terminal, approval)
        onRecorded(result.ingredient)
        setQuantity(''); setNote('')
      } catch (reason) {
        setError(reason instanceof WastageValidationError || reason instanceof Error ? reason.message : 'Could not record this wastage entry.')
      } finally { setBusy(false) }
    })
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
