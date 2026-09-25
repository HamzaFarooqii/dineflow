import { formatCostPerUnit } from '../../../../../packages/domain/src/inventory-quantity'
import { formatCents } from '../../../../../packages/domain/src/money'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { Ingredient } from '../../lib/inventory'
import { InventoryStatusBadge } from './InventoryStatusBadge'
import { Quantity } from './Quantity'

export function IngredientRow({ ingredient, unit, currency, selected, onSelect }: {
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  currency: string
  selected: boolean
  onSelect: () => void
}) {
  return <button type="button" className={selected ? 'inventory-list-item active' : 'inventory-list-item'} onClick={onSelect}>
    <span className="inventory-list-item-top">
      <span className="inventory-list-item-name">{ingredient.name}</span>
      <InventoryStatusBadge ingredient={ingredient} />
    </span>
    <span className="inventory-list-item-stock"><Quantity value={ingredient.current_stock} unit={unit} /> available</span>
    <span className="inventory-list-item-meta">
      {unit && <>Avg cost {formatCostPerUnit(formatCents(ingredient.cost_per_unit_cents, currency), unit)} · </>}
      {ingredient.active_batch_count} {ingredient.active_batch_count === 1 ? 'batch' : 'batches'}
      {ingredient.nearest_expiry && <> · Nearest expiry {new Date(ingredient.nearest_expiry).toLocaleDateString()}</>}
    </span>
    {ingredient.reorder_threshold !== null && unit && (
      <span className="inventory-list-item-meta">Reorder at <Quantity value={ingredient.reorder_threshold} unit={unit} /></span>
    )}
  </button>
}
