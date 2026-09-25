import { INGREDIENT_STATUS_LABELS, INGREDIENT_STATUS_TONE, ingredientStatus } from './inventory-status'
import type { Ingredient } from '../../lib/inventory'

// Shared between the ingredient list row and the detail header (docs/DESIGN_SYSTEM.md: reuse a
// status chip pattern rather than reinventing it per screen, and don't build a component for a
// single call site -- this one has two).
export function InventoryStatusBadge({ ingredient }: { ingredient: Ingredient }) {
  const status = ingredientStatus(ingredient)
  return <span className={`floor-status floor-status-${INGREDIENT_STATUS_TONE[status]}`}>{INGREDIENT_STATUS_LABELS[status]}</span>
}
