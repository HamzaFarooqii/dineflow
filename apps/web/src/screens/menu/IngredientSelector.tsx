import { useMemo, useState } from 'react'
import { parseCents } from '../../../../../packages/domain/src/money'
import { UnitSelector } from '../inventory/UnitSelector'
import { Dialog } from '../../components/Dialog'
import '../inventory/inventory.css'
import type { RecipeIngredientOption, RecipeUnit, UnitKind } from './recipe-draft'

/**
 * Ingredient picker for a recipe line: search-as-you-type over existing ingredients, or create a
 * new one (name, unit, cost per unit) inline without leaving the recipe editor. Mirrors
 * UnitSelector's search+quick-add shape so both pickers feel the same.
 */
export function IngredientSelector({ ingredients, value, onChange, units, onCreateUnit, onCreateIngredient, currency, disabled = false, hasError = false }: {
  ingredients: readonly RecipeIngredientOption[]
  value: string
  onChange: (ingredientId: string, unitId?: string) => void
  units: readonly RecipeUnit[]
  onCreateUnit: (unit: { name: string; abbreviation: string; kind: UnitKind; factor_to_base?: number | null }) => Promise<RecipeUnit>
  onCreateIngredient: (input: { name: string; unit_id: string; cost_per_unit_cents: number }) => Promise<RecipeIngredientOption>
  currency: string
  disabled?: boolean
  hasError?: boolean
}) {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: '', unitId: '', cost: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const options = useMemo(() => {
    const term = search.trim().toLowerCase()
    const visible = ingredients.filter(ingredient => ingredient.active || ingredient.id === value)
    return term ? visible.filter(ingredient => ingredient.name.toLowerCase().includes(term)) : visible
  }, [ingredients, search, value])

  const exactMatch = useMemo(() => {
    const term = search.trim().toLowerCase()
    return term !== '' && ingredients.some(ingredient => ingredient.name.trim().toLowerCase() === term)
  }, [ingredients, search])

  function startCreating() {
    setForm({ name: search.trim(), unitId: '', cost: '' })
    setCreating(true)
    setError('')
  }

  async function submitCreate() {
    const name = form.name.trim()
    if (!name) { setError('Enter an ingredient name.'); return }
    if (!form.unitId) { setError('Choose a unit.'); return }
    // Left blank rather than parsed as 0 -- a silent $0/unit cost would understate every recipe's
    // food cost with no warning, since a $0 line still reports as "costed", not "missing".
    if (!form.cost.trim()) { setError('Enter a cost per unit (enter 0 if it truly has no cost).'); return }
    let costPerUnitCents: number
    try {
      costPerUnitCents = parseCents(form.cost.trim())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enter a valid cost per unit.')
      return
    }
    setBusy(true); setError('')
    try {
      const created = await onCreateIngredient({ name, unit_id: form.unitId, cost_per_unit_cents: costPerUnitCents })
      onChange(created.id, created.unit_id)
      setCreating(false)
      setSearch('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add this ingredient.')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <div className="unit-selector">
      <input type="search" className="unit-selector-search" placeholder="Search ingredients…" value={search}
        onChange={event => setSearch(event.target.value)} aria-label="Search ingredients" disabled={disabled} />
      <select aria-label="Ingredient" className={hasError ? 'err' : ''} value={value} disabled={disabled}
        onChange={event => onChange(event.target.value)} size={Math.min(8, Math.max(4, options.length + 1))}>
        {value === '' && <option value="" disabled>Choose ingredient…</option>}
        {options.map(ingredient => (
          <option key={ingredient.id} value={ingredient.id}>{ingredient.name}{ingredient.active ? '' : ' (inactive)'}</option>
        ))}
      </select>
      <div className="unit-selector-suggestions">
        {search.trim() && !exactMatch
          ? <button type="button" className="unit-suggestion-chip" disabled={disabled} onClick={startCreating}>+ Create “{search.trim()}”…</button>
          : <button type="button" className="unit-suggestion-chip" disabled={disabled} onClick={startCreating}>+ Create new ingredient…</button>}
      </div>
    </div>
    {creating && <Dialog
      kicker="RECIPE INGREDIENT"
      title="Add a new ingredient"
      className="ingredient-create-dialog"
      onClose={() => { if (!busy) { setCreating(false); setError('') } }}
    >
      <p className="ingredient-dialog-copy">Add its purchasing unit and cost now. The new ingredient will be selected on this recipe automatically.</p>
      <form className="ingredient-dialog-form" onSubmit={event => { event.preventDefault(); void submitCreate() }}>
        <label>Ingredient name
          <input autoFocus placeholder="e.g. Bread slice" maxLength={120}
            value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} disabled={busy} />
        </label>
        <label>Cost per unit ({currency})
          <input type="text" inputMode="decimal" placeholder="0.00"
            value={form.cost} onChange={event => setForm(current => ({ ...current, cost: event.target.value }))} disabled={busy} />
        </label>
        <label>Purchasing unit
          <UnitSelector units={units as RecipeUnit[]} value={form.unitId} onChange={unitId => setForm(current => ({ ...current, unitId }))} onCreateUnit={onCreateUnit} />
        </label>
        {error && <p className="form-notice error" role="alert">{error}</p>}
        <div className="ingredient-dialog-actions">
          <button type="button" className="secondary-cta" onClick={() => { setCreating(false); setError('') }} disabled={busy}>Cancel</button>
          <button type="submit" className="cta" disabled={busy}>{busy ? 'Adding…' : 'Add ingredient'}</button>
        </div>
      </form>
    </Dialog>}
  </>
}
