import { formatCents } from '../../../../../packages/domain/src/money'
import type { RecipeLineCost } from '../../../../../packages/domain/src/recipe-cost'
import { IngredientSelector } from './IngredientSelector'
import type { RecipeDraftLine, RecipeIngredientOption, RecipeUnit, UnitKind } from './recipe-draft'

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
  onCreateUnit: (unit: { name: string; abbreviation: string; kind: UnitKind; factor_to_base?: number | null }) => Promise<RecipeUnit>
  onCreateIngredient: (input: { name: string; unit_id: string; cost_per_unit_cents: number }) => Promise<RecipeIngredientOption>
}

/** One ingredient line of a recipe: ingredient, quantity, unit, and its live cost. */
export function RecipeIngredientLine({ index, line, ingredients, units, cost, error, currency, disabled, onChange, onRemove, onCreateUnit, onCreateIngredient }: Props) {
  const selected = ingredients.find(ingredient => ingredient.id === line.ingredientId)
  const unitLabel = (id: string) => units.find(unit => unit.id === id)?.abbreviation ?? ''
  const label = `ingredient line ${index + 1}`

  return (
    <div className="recipe-line">
      <div className="recipe-line-top pc-field">
        <IngredientSelector
          ingredients={ingredients}
          value={line.ingredientId}
          units={units}
          currency={currency}
          disabled={disabled}
          hasError={Boolean(error) && !line.ingredientId}
          onCreateUnit={onCreateUnit}
          onCreateIngredient={onCreateIngredient}
          onChange={(ingredientId, unitId) => {
            const ingredient = ingredients.find(option => option.id === ingredientId)
            // Default the line to the ingredient's own unit — the only unit costing accepts today.
            onChange({ ...line, ingredientId, unitId: unitId ?? ingredient?.unit_id ?? line.unitId })
          }}
        />
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
          No known conversion between this unit and the ingredient’s stock unit ({unitLabel(selected?.unit_id ?? '')}) — this line isn’t costed. Use the ingredient’s own unit, or give both units a conversion factor.
        </p>
      )}
      {error && <p className="pc-field-err">{error}</p>}
    </div>
  )
}
