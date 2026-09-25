import type { Ingredient } from '../../lib/inventory'

export type IngredientStatus = 'out_of_stock' | 'low_stock' | 'in_stock'

// Low-stock only fires once a reorder_threshold is actually configured -- an ingredient with no
// threshold set is never "low", just eventually "out".
export function isLowStock(ingredient: Ingredient): boolean {
  if (ingredient.reorder_threshold === null) return false
  return Number(ingredient.current_stock) <= Number(ingredient.reorder_threshold)
}

// Kitchen consumption (kitchen.ts's consumeRecipeIngredients) deliberately lets current_stock go
// negative rather than blocking a dish that's already been served -- the same oversell reasoning
// pos_stock already documents. That only works as a real reconciliation strategy if it's visible:
// unlike isLowStock, this doesn't depend on a reorder_threshold being configured, so an ingredient
// with no threshold set still flags once it's actually out.
export function isOutOfStock(ingredient: Ingredient): boolean {
  return Number(ingredient.current_stock) <= 0
}

// One status per ingredient, out-of-stock taking priority over merely-low -- the single source
// every list row, filter, and summary card counts from, so they can never disagree with each
// other about how many ingredients are "low" vs "out".
export function ingredientStatus(ingredient: Ingredient): IngredientStatus {
  if (isOutOfStock(ingredient)) return 'out_of_stock'
  if (isLowStock(ingredient)) return 'low_stock'
  return 'in_stock'
}

export const INGREDIENT_STATUS_LABELS: Record<IngredientStatus, string> = {
  out_of_stock: 'Out of stock',
  low_stock: 'Low stock',
  in_stock: 'In stock',
}

export const INGREDIENT_STATUS_TONE: Record<IngredientStatus, 'danger' | 'warning' | 'success'> = {
  out_of_stock: 'danger',
  low_stock: 'warning',
  in_stock: 'success',
}
