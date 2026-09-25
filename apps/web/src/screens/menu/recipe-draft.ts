// Recipe editor form state and its conversion to the PUT /catalog/products/:id/recipe body.
// Pure (no Dexie/Supabase imports) so it can be unit-tested directly.
import { convertQuantity, costRecipe, type RecipeCost, type RecipeCostUnit } from '../../../../../packages/domain/src/recipe-cost'

export type UnitKind = 'mass' | 'volume' | 'count'
export interface RecipeUnit { id: string; name: string; abbreviation: string; kind: UnitKind; factor_to_base: number | null }
export interface RecipeIngredientOption { id: string; name: string; unit_id: string; cost_per_unit_cents: number; active: boolean }
export interface SavedRecipe {
  id: string; product_id: string; yield_quantity: number; yield_unit_id: string
  lines: { id: string; ingredient_id: string; quantity: number; unit_id: string }[]
}
export interface RecipePayload {
  yield_quantity: number; yield_unit_id: string
  lines: { ingredient_id: string; quantity: number; unit_id: string }[]
}

export interface RecipeDraftLine { key: string; ingredientId: string; quantity: string; unitId: string }
export interface RecipeDraft { yieldQuantity: string; yieldUnitId: string; lines: RecipeDraftLine[] }
export interface RecipeDraftErrors { yieldQuantity?: string; yieldUnitId?: string; lines?: Record<string, string> }

export const EMPTY_RECIPE_DRAFT: RecipeDraft = { yieldQuantity: '1', yieldUnitId: '', lines: [] }

let lineSeq = 0
export function newDraftLine(): RecipeDraftLine {
  lineSeq += 1
  return { key: `line-${lineSeq}`, ingredientId: '', quantity: '', unitId: '' }
}

export function draftFromRecipe(recipe: SavedRecipe | undefined): RecipeDraft {
  if (!recipe) return EMPTY_RECIPE_DRAFT
  return {
    yieldQuantity: String(recipe.yield_quantity),
    yieldUnitId: recipe.yield_unit_id,
    lines: recipe.lines.map(line => ({ ...newDraftLine(), ingredientId: line.ingredient_id, quantity: String(line.quantity), unitId: line.unit_id })),
  }
}

/** True when the add-dish form's recipe section was never touched and should not be saved. */
export function isDraftBlank(draft: RecipeDraft): boolean {
  return draft.yieldUnitId === '' && draft.lines.length === 0
}

// Up to 6 integer digits and 4 decimals: enough for "0.0125 kg" without float-noise inputs.
const QUANTITY_RE = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/
function parseQuantity(input: string): number | null {
  const trimmed = input.trim()
  if (!QUANTITY_RE.test(trimmed)) return null
  const value = Number(trimmed)
  return value > 0 ? value : null
}

function toCostUnit(unit: RecipeUnit | undefined): RecipeCostUnit | null {
  return unit ? { id: unit.id, kind: unit.kind, factorToBase: unit.factor_to_base } : null
}

/** True when a quantity in `fromId` could cost against an ingredient stocked in `toId`. */
function unitsConvertible(fromId: string, toId: string, unitsById: Map<string, RecipeUnit>): boolean {
  const from = toCostUnit(unitsById.get(fromId))
  const to = toCostUnit(unitsById.get(toId))
  if (!from || !to) return false
  return convertQuantity(1, from, to) !== null
}

export function validateDraft(draft: RecipeDraft, ingredients: readonly RecipeIngredientOption[], units: readonly RecipeUnit[]):
  { ok: true; payload: RecipePayload } | { ok: false; errors: RecipeDraftErrors } {
  const errors: RecipeDraftErrors = {}
  const yieldQuantity = parseQuantity(draft.yieldQuantity)
  if (yieldQuantity === null) errors.yieldQuantity = 'Enter a yield greater than 0 (up to 4 decimals).'
  if (!draft.yieldUnitId) errors.yieldUnitId = 'Choose a yield unit.'
  const lineErrors: Record<string, string> = {}
  const unitOf = new Map(ingredients.map(ingredient => [ingredient.id, ingredient.unit_id]))
  const unitsById = new Map(units.map(unit => [unit.id, unit]))
  const seen = new Set<string>()
  const lines: RecipePayload['lines'] = []
  for (const line of draft.lines) {
    const quantity = parseQuantity(line.quantity)
    const ingredientUnitId = unitOf.get(line.ingredientId)
    if (!line.ingredientId) lineErrors[line.key] = 'Choose an ingredient.'
    else if (seen.has(line.ingredientId)) lineErrors[line.key] = 'This ingredient is already on the recipe.'
    else if (quantity === null) lineErrors[line.key] = 'Enter a quantity greater than 0.'
    else if (!line.unitId) lineErrors[line.key] = 'Choose a unit.'
    else if (!ingredientUnitId || !unitsConvertible(line.unitId, ingredientUnitId, unitsById)) {
      lineErrors[line.key] = 'This unit has no known conversion to the ingredient’s stock unit — use its own unit, or set a conversion factor on one of them.'
    }
    else lines.push({ ingredient_id: line.ingredientId, quantity, unit_id: line.unitId })
    if (line.ingredientId) seen.add(line.ingredientId)
  }
  if (Object.keys(lineErrors).length) errors.lines = lineErrors
  if (errors.yieldQuantity || errors.yieldUnitId || errors.lines) return { ok: false, errors }
  return { ok: true, payload: { yield_quantity: yieldQuantity!, yield_unit_id: draft.yieldUnitId, lines } }
}

/**
 * Live cost of whatever is currently typed. Lines that aren't complete enough to cost yet
 * (no ingredient, no valid quantity) are skipped rather than failing the whole calculation;
 * an invalid yield falls back to 1 so the batch cost still shows while the user types.
 */
export function costDraft(draft: RecipeDraft, ingredients: readonly RecipeIngredientOption[], units: readonly RecipeUnit[]): RecipeCost & { lineCosts: Record<string, RecipeCost['lines'][number]> } {
  const byId = new Map(ingredients.map(ingredient => [ingredient.id, ingredient]))
  const unitsById = new Map(units.map(unit => [unit.id, unit]))
  const costable = draft.lines.flatMap(line => {
    const quantity = parseQuantity(line.quantity)
    const lineUnit = toCostUnit(unitsById.get(line.unitId))
    if (!line.ingredientId || quantity === null || !lineUnit) return []
    const ingredient = byId.get(line.ingredientId)
    const ingredientUnit = ingredient ? toCostUnit(unitsById.get(ingredient.unit_id)) : null
    return [{ key: line.key, input: { quantity, unit: lineUnit, ingredient: ingredient && ingredientUnit ? { unit: ingredientUnit, costPerUnitCents: ingredient.cost_per_unit_cents } : null } }]
  })
  const cost = costRecipe(costable.map(entry => entry.input), parseQuantity(draft.yieldQuantity) ?? 1)
  const lineCosts: Record<string, RecipeCost['lines'][number]> = {}
  costable.forEach((entry, index) => { lineCosts[entry.key] = cost.lines[index] })
  return { ...cost, lineCosts }
}

/** Per-sale cost of an already-saved recipe, for the menu list. */
export function costSavedRecipe(recipe: SavedRecipe, ingredients: readonly RecipeIngredientOption[], units: readonly RecipeUnit[]): RecipeCost {
  const byId = new Map(ingredients.map(ingredient => [ingredient.id, ingredient]))
  const unitsById = new Map(units.map(unit => [unit.id, unit]))
  return costRecipe(recipe.lines.map(line => {
    const ingredient = byId.get(line.ingredient_id)
    const lineUnit = toCostUnit(unitsById.get(line.unit_id))
    const ingredientUnit = ingredient ? toCostUnit(unitsById.get(ingredient.unit_id)) : null
    return { quantity: line.quantity, unit: lineUnit ?? { id: line.unit_id, kind: 'count' as UnitKind, factorToBase: null }, ingredient: ingredient && ingredientUnit ? { unit: ingredientUnit, costPerUnitCents: ingredient.cost_per_unit_cents } : null }
  }), recipe.yield_quantity)
}
