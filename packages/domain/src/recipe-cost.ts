// Recipe costing (docs/day-plans/day3.md, "Recipe costing"). Pure functions so the product
// editor, the API, and Day 5's food-cost report all compute the same numbers.
//
// A recipe makes `yieldQuantity` of its yield unit per batch, and one sale of the menu item is
// assumed to consume one yield unit — so the per-sale ("portion") cost is batch cost ÷ yield.
// Unit conversion is deliberately not supported yet: a line is only costed when its unit is the
// ingredient's own stored unit; any other unit is reported as a mismatch rather than guessed at.

export interface RecipeCostLineInput {
  quantity: number
  unitId: string
  /** null when the line's ingredient is unknown (deleted, or not loaded yet). */
  ingredient: { unitId: string; costPerUnitCents: number } | null
}

export type RecipeLineCost =
  | { status: 'costed'; costCents: number }
  | { status: 'unit_mismatch' }
  | { status: 'missing_ingredient' }

export interface RecipeCost {
  lines: RecipeLineCost[]
  /** Sum of every costed line, rounded to whole cents. */
  batchCostCents: number
  /** batchCostCents ÷ yield, rounded to whole cents — the cost of one sale. */
  portionCostCents: number
  /** False when any line could not be costed; totals then understate the true cost. */
  complete: boolean
}

function positiveQuantity(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a number greater than 0.`)
  return value
}

export function costRecipe(lines: readonly RecipeCostLineInput[], yieldQuantity: number): RecipeCost {
  positiveQuantity(yieldQuantity, 'Recipe yield')
  let exactBatch = 0
  const costed = lines.map((line): RecipeLineCost => {
    positiveQuantity(line.quantity, 'Ingredient quantity')
    if (!line.ingredient) return { status: 'missing_ingredient' }
    const { costPerUnitCents } = line.ingredient
    if (!Number.isSafeInteger(costPerUnitCents) || costPerUnitCents < 0) {
      throw new Error('Ingredient cost must be a non-negative integer number of cents.')
    }
    if (line.unitId !== line.ingredient.unitId) return { status: 'unit_mismatch' }
    const exact = line.quantity * costPerUnitCents
    exactBatch += exact
    return { status: 'costed', costCents: Math.round(exact) }
  })
  return {
    lines: costed,
    batchCostCents: Math.round(exactBatch),
    portionCostCents: Math.round(exactBatch / yieldQuantity),
    complete: costed.every(line => line.status === 'costed'),
  }
}

/**
 * Food cost as integer basis points of the menu price (2840 = 28.40%), or null when the price
 * is zero and the ratio is undefined.
 */
export function foodCostBps(portionCostCents: number, menuPriceCents: number): number | null {
  if (!Number.isSafeInteger(portionCostCents) || portionCostCents < 0) throw new Error('Portion cost must be a non-negative integer number of cents.')
  if (!Number.isSafeInteger(menuPriceCents) || menuPriceCents < 0) throw new Error('Menu price must be a non-negative integer number of cents.')
  if (menuPriceCents === 0) return null
  return Math.round((portionCostCents * 10_000) / menuPriceCents)
}

export function formatFoodCostPercent(bps: number | null): string {
  return bps === null ? '—' : `${(bps / 100).toFixed(1)}%`
}
