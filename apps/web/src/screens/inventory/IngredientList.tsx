import { useMemo } from 'react'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { Ingredient } from '../../lib/inventory'
import { IngredientRow } from './IngredientRow'
import { ingredientStatus } from './inventory-status'
import { EXPIRING_SOON_WINDOW_MS } from '../../../../../packages/domain/src/batch-status'
import type { InventoryFilter, InventorySort } from './InventoryToolbar'

export { isLowStock, isOutOfStock } from './inventory-status'

function isExpiringSoon(ingredient: Ingredient, now: number): boolean {
  if (!ingredient.nearest_expiry) return false
  const expiryMs = Date.parse(ingredient.nearest_expiry)
  return !Number.isNaN(expiryMs) && expiryMs - now <= EXPIRING_SOON_WINDOW_MS
}

export function applyInventoryView(ingredients: Ingredient[], search: string, filter: InventoryFilter, sort: InventorySort, now = Date.now()): Ingredient[] {
  const term = search.trim().toLowerCase()
  const filtered = ingredients.filter(ingredient => {
    if (term && !ingredient.name.toLowerCase().includes(term)) return false
    if (filter === 'all') return true
    if (filter === 'expiring_soon') return isExpiringSoon(ingredient, now)
    return ingredientStatus(ingredient) === filter
  })
  const sorted = [...filtered]
  if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
  else if (sort === 'stock_level') sorted.sort((a, b) => Number(a.current_stock) - Number(b.current_stock))
  else if (sort === 'recently_updated') sorted.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  else if (sort === 'expiry') sorted.sort((a, b) => {
    if (!a.nearest_expiry && !b.nearest_expiry) return a.name.localeCompare(b.name)
    if (!a.nearest_expiry) return 1
    if (!b.nearest_expiry) return -1
    return Date.parse(a.nearest_expiry) - Date.parse(b.nearest_expiry)
  })
  return sorted
}

export function IngredientList({ ingredients, units, currency, search, filter, sort, selectedId, onSelect }: {
  ingredients: Ingredient[]
  units: RecipeUnit[]
  currency: string
  search: string
  filter: InventoryFilter
  sort: InventorySort
  selectedId: string | null
  onSelect: (ingredient: Ingredient) => void
}) {
  const unitsById = useMemo(() => new Map(units.map(unit => [unit.id, unit])), [units])
  const view = useMemo(() => applyInventoryView(ingredients, search, filter, sort), [ingredients, search, filter, sort])

  return <div className="inventory-list">
    {view.map(ingredient => (
      <IngredientRow key={ingredient.id} ingredient={ingredient} unit={unitsById.get(ingredient.unit_id)} currency={currency}
        selected={ingredient.id === selectedId} onSelect={() => onSelect(ingredient)} />
    ))}
    {view.length === 0 && ingredients.length > 0 && <p className="floor-empty">No ingredients match this search or filter.</p>}
    {ingredients.length === 0 && (
      <div className="floor-empty inventory-empty-state">
        <p>No inventory items yet.</p>
        <p>Start by adding ingredients such as Milk, Chicken, Flour or Cooking Oil.</p>
      </div>
    )}
  </div>
}
