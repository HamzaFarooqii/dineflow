import { formatCents } from '../../../../../packages/domain/src/money'
import type { RecipeLineCost } from '../../../../../packages/domain/src/recipe-cost'
import type { RecipeDraftLine, RecipeIngredientOption, RecipeUnit } from './recipe-draft'

interface Props {
  index: number
  line: RecipeDraftLine
  ingredients: readonly RecipeIngredientOption[]
  units: readonly RecipeUnit[]
  cost: RecipeLineCost | undefined
  error: string | undefined
  currency: string
  disabled: boolean
  onChange: (line: RecipeDraftLine) => void
  onRemove: () => void
}

/** One ingredient line of a recipe: ingredient, quantity, unit, and its live cost. */
export function RecipeIngredientLine({ index, line, ingredients, units, cost, error, currency, disabled, onChange, onRemove }: Props) {
  const selected = ingredients.find(ingredient => ingredient.id === line.ingredientId)
  // Inactive ingredients can't be newly picked, but one already on a saved recipe stays visible.
  const options = ingredients.filter(ingredient => ingredient.active || ingredient.id === line.ingredientId)
  const unitLabel = (id: string) => units.find(unit => unit.id === id)?.abbreviation ?? ''
  const label = `ingredient line ${index + 1}`

  return (
    <div className="recipe-line">
      <div className="recipe-line-top pc-field">
        <select
          aria-label={`Ingredient for ${label}`}
          className={error && !line.ingredientId ? 'err' : ''}
          value={line.ingredientId}
          disabled={disabled}
          onChange={event => {
            const ingredient = ingredients.find(option => option.id === event.target.value)
            // Default the line to the ingredient's own unit — the only unit costing accepts today.
            onChange({ ...line, ingredientId: event.target.value, unitId: ingredient?.unit_id ?? line.unitId })
          }}
        >
          <option value="">Choose ingredient…</option>
          {options.map(ingredient => (
            <option key={ingredient.id} value={ingredient.id}>
              {ingredient.name}{ingredient.active ? '' : ' (inactive)'}
            </option>
          ))}
        </select>
        <button type="button" className="recipe-line-remove" onClick={onRemove} disabled={disabled} aria-label={`Remove ${label}`}>×</button>
      </div>
      <div className="recipe-line-bottom pc-field">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Quantity for ${label}`}
          className={error && line.ingredientId ? 'err' : ''}
          placeholder="Qty"
          value={line.quantity}
          disabled={disabled}
          onChange={event => onChange({ ...line, quantity: event.target.value })}
        />
        <select aria-label={`Unit for ${label}`} value={line.unitId} disabled={disabled} onChange={event => onChange({ ...line, unitId: event.target.value })}>
          <option value="">Unit…</option>
          {units.map(unit => <option key={unit.id} value={unit.id}>{unit.name} ({unit.abbreviation})</option>)}
        </select>
        <span className="recipe-line-cost" aria-label={`Cost of ${label}`}>
          {cost?.status === 'costed' ? formatCents(cost.costCents, currency) : '—'}
        </span>
      </div>
      {selected && (
        <p className="pc-field-hint">
          {formatCents(selected.cost_per_unit_cents, currency)} per {unitLabel(selected.unit_id) || 'unit'}
        </p>
      )}
      {cost?.status === 'unit_mismatch' && !error && (
        <p className="cart-line-stock-warning" role="alert">
          Unit differs from this ingredient’s stock unit ({unitLabel(selected?.unit_id ?? '')}) — unit conversion isn’t supported yet, so this line isn’t costed.
        </p>
      )}
      {error && <p className="pc-field-err">{error}</p>}
    </div>
  )
}
