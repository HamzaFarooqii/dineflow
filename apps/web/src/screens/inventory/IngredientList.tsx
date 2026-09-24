import type { Ingredient } from '../../lib/inventory'

// Low-stock indicator reuses the shared 'warning' tone (--mise-warning/--mise-warning-fill),
// same convention as table-status.ts's tone map — no new colors invented for this screen.
export function isLowStock(ingredient: Ingredient): boolean {
  if (ingredient.reorder_threshold === null) return false
  return Number(ingredient.current_stock) <= Number(ingredient.reorder_threshold)
}

export function IngredientList({ ingredients, selectedId, onSelect }: { ingredients: Ingredient[]; selectedId: string | null; onSelect: (ingredient: Ingredient) => void }) {
  return <div className="inventory-list">
    {ingredients.map(ingredient => <button
      type="button"
      key={ingredient.id}
      className={ingredient.id === selectedId ? 'inventory-list-item active' : 'inventory-list-item'}
      onClick={() => onSelect(ingredient)}
    >
      <span className="inventory-list-item-top">
        <span className="inventory-list-item-name">{ingredient.name}</span>
        {isLowStock(ingredient) && <span className="floor-status floor-status-warning">Low stock</span>}
      </span>
      <span className="inventory-list-item-meta">
        {ingredient.current_stock} on hand
        {ingredient.reorder_threshold !== null && <> · reorder at {ingredient.reorder_threshold}</>}
      </span>
    </button>)}
    {ingredients.length === 0 && <p className="floor-empty">No ingredients yet.</p>}
  </div>
}
