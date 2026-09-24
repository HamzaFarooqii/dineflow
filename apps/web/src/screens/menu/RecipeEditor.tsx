/**
 * RecipeEditor — the "Recipe" section of the product editor (ProductCatalogScreen). Controlled:
 * the parent owns the draft and decides when to save it (a full replace-on-save through
 * PUT /catalog/products/:id/recipe). Costs come from packages/domain/src/recipe-cost.ts so they
 * match the API and later reports exactly.
 */
import { useState } from 'react'
import { formatCents } from '../../../../../packages/domain/src/money'
import { foodCostBps, formatFoodCostPercent } from '../../../../../packages/domain/src/recipe-cost'
import type { RecipeData } from './recipe-api'
import { costDraft, newDraftLine, type RecipeDraft, type RecipeDraftErrors, type RecipeUnit, type UnitKind } from './recipe-draft'
import { RecipeIngredientLine } from './RecipeIngredientLine'
import './recipe-editor.css'

const NEW_UNIT = '__new__'

interface Props {
  draft: RecipeDraft
  onChange: (draft: RecipeDraft) => void
  errors: RecipeDraftErrors
  data: RecipeData | null
  dataError: string
  /** The dish's menu price, or null while it isn't a valid amount yet. */
  menuPriceCents: number | null
  currency: string
  disabled: boolean
  onCreateUnit: (unit: { name: string; abbreviation: string; kind: UnitKind }) => Promise<RecipeUnit>
}

export function RecipeEditor({ draft, onChange, errors, data, dataError, menuPriceCents, currency, disabled, onCreateUnit }: Props) {
  const [creatingUnit, setCreatingUnit] = useState(false)
  const [unitForm, setUnitForm] = useState({ name: '', abbreviation: '', kind: 'count' as UnitKind })
  const [unitBusy, setUnitBusy] = useState(false)
  const [unitError, setUnitError] = useState('')

  if (dataError) return <p className="pc-field-err" role="alert">{dataError}</p>
  if (!data) return <p className="pc-field-hint" role="status">Loading recipe data…</p>

  const { units, ingredients, ingredientsReady } = data
  const cost = costDraft(draft, ingredients)
  const bps = menuPriceCents === null ? null : foodCostBps(cost.portionCostCents, menuPriceCents)
  const yieldUnit = units.find(unit => unit.id === draft.yieldUnitId)
  const activeIngredients = ingredients.filter(ingredient => ingredient.active)

  const submitUnit = async () => {
    const name = unitForm.name.trim(), abbreviation = unitForm.abbreviation.trim()
    if (!name || !abbreviation) {
      setUnitError('Enter a unit name and abbreviation.')
      return
    }
    setUnitBusy(true)
    setUnitError('')
    try {
      const unit = await onCreateUnit({ name, abbreviation, kind: unitForm.kind })
      onChange({ ...draft, yieldUnitId: unit.id })
      setCreatingUnit(false)
      setUnitForm({ name: '', abbreviation: '', kind: 'count' })
    } catch (reason) {
      setUnitError(reason instanceof Error ? reason.message : 'Could not add the unit.')
    } finally {
      setUnitBusy(false)
    }
  }

  return (
    <>
      <div className="pc-pair">
        <div className="pc-field">
          <label htmlFor="rf-yield">Recipe makes</label>
          <input
            id="rf-yield"
            type="text"
            inputMode="decimal"
            className={errors.yieldQuantity ? 'err' : ''}
            value={draft.yieldQuantity}
            disabled={disabled}
            onChange={event => onChange({ ...draft, yieldQuantity: event.target.value })}
          />
          {errors.yieldQuantity && <p className="pc-field-err">{errors.yieldQuantity}</p>}
        </div>
        <div className="pc-field">
          <label htmlFor="rf-yield-unit">Yield unit</label>
          <select
            id="rf-yield-unit"
            className={errors.yieldUnitId ? 'err' : ''}
            value={creatingUnit ? NEW_UNIT : draft.yieldUnitId}
            disabled={disabled}
            onChange={event => {
              if (event.target.value === NEW_UNIT) {
                setCreatingUnit(true)
                return
              }
              setCreatingUnit(false)
              onChange({ ...draft, yieldUnitId: event.target.value })
            }}
          >
            <option value="">Choose unit…</option>
            {units.map(unit => <option key={unit.id} value={unit.id}>{unit.name} ({unit.abbreviation})</option>)}
            <option value={NEW_UNIT}>+ Create new unit…</option>
          </select>
          {errors.yieldUnitId && !creatingUnit && <p className="pc-field-err">{errors.yieldUnitId}</p>}
        </div>
      </div>

      {creatingUnit && (
        <div className="recipe-new-unit pc-field">
          <div className="recipe-new-unit-row">
            <input aria-label="New unit name" placeholder="Name (e.g. Portion)" maxLength={40} value={unitForm.name}
              onChange={event => setUnitForm(form => ({ ...form, name: event.target.value }))} disabled={unitBusy} />
            <input aria-label="New unit abbreviation" placeholder="Abbr. (ptn)" maxLength={10} value={unitForm.abbreviation}
              onChange={event => setUnitForm(form => ({ ...form, abbreviation: event.target.value }))} disabled={unitBusy} />
            <select aria-label="New unit kind" value={unitForm.kind} disabled={unitBusy}
              onChange={event => setUnitForm(form => ({ ...form, kind: event.target.value as UnitKind }))}>
              <option value="count">Count</option>
              <option value="mass">Mass</option>
              <option value="volume">Volume</option>
            </select>
          </div>
          <div className="recipe-new-unit-actions">
            <button type="button" className="pc-btn-ghost" onClick={() => { setCreatingUnit(false); setUnitError('') }} disabled={unitBusy}>Cancel</button>
            <button type="button" className="pc-btn-primary" onClick={() => void submitUnit()} disabled={unitBusy}>{unitBusy ? 'Adding…' : 'Add unit'}</button>
          </div>
          {unitError && <p className="pc-field-err" role="alert">{unitError}</p>}
        </div>
      )}
      <p className="pc-field-hint">Food cost assumes one sale of this dish uses one yield unit — e.g. “makes 4 portions” costs each sale at a quarter of the batch.</p>

      <div className="recipe-lines">
        <p className="recipe-lines-label">Ingredients</p>
        {!ingredientsReady ? (
          <p className="pc-field-hint">Ingredient inventory isn’t set up yet. Save the yield now — ingredient lines and costs become available once ingredients exist.</p>
        ) : activeIngredients.length === 0 && draft.lines.length === 0 ? (
          <p className="pc-field-hint">No ingredients exist yet. Add them on the Inventory screen, then build this recipe.</p>
        ) : draft.lines.length === 0 ? (
          <p className="pc-field-hint">No ingredients on this recipe yet.</p>
        ) : (
          draft.lines.map((line, index) => (
            <RecipeIngredientLine
              key={line.key}
              index={index}
              line={line}
              ingredients={ingredients}
              units={units}
              cost={cost.lineCosts[line.key]}
              error={errors.lines?.[line.key]}
              currency={currency}
              disabled={disabled}
              onChange={next => onChange({ ...draft, lines: draft.lines.map(existing => existing.key === line.key ? next : existing) })}
              onRemove={() => onChange({ ...draft, lines: draft.lines.filter(existing => existing.key !== line.key) })}
            />
          ))
        )}
        <button
          type="button"
          className="pc-btn-ghost recipe-add-line"
          onClick={() => onChange({ ...draft, lines: [...draft.lines, newDraftLine()] })}
          disabled={disabled || !ingredientsReady || activeIngredients.length === 0}
        >
          + Add ingredient
        </button>
      </div>

      <dl className="recipe-cost-summary" aria-live="polite">
        <div><dt>Batch cost</dt><dd>{formatCents(cost.batchCostCents, currency)}</dd></div>
        <div><dt>Cost per {yieldUnit?.abbreviation ?? 'sale'}</dt><dd>{formatCents(cost.portionCostCents, currency)}</dd></div>
        <div><dt>Food cost</dt><dd>{menuPriceCents === null ? '—' : formatFoodCostPercent(bps)}</dd></div>
      </dl>
      {menuPriceCents === null && <p className="pc-field-hint">Enter a menu price to see the food-cost percentage.</p>}
      {menuPriceCents === 0 && <p className="pc-field-hint">Food cost % is undefined for a dish priced at zero.</p>}
      {!cost.complete && <p className="cart-line-stock-warning">Some lines can’t be costed yet, so these totals understate the real cost.</p>}
    </>
  )
}
