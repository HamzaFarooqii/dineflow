import type { Ingredient } from '../../lib/inventory'

// Low-stock indicator reuses the shared 'warning' tone (--mise-warning/--mise-warning-fill),
// same convention as table-status.ts's tone map — no new colors invented for this screen.
export function isLowStock(ingredient: Ingredient): boolean {
  if (ingredient.reorder_threshold === null) return false
  return Number(ingredient.current_stock) <= Number(ingredient.reorder_threshold)
}

// Kitchen consumption (kitchen.ts's consumeRecipeIngredients) deliberately lets current_stock go
// negative rather than blocking a dish that's already been served — the same oversell reasoning
// pos_stock already documents. That only works as a real reconciliation strategy if it's visible:
// unlike isLowStock, this doesn't depend on a reorder_threshold being configured, so an ingredient
// with no threshold set still flags once it's actually out.
export function isOutOfStock(ingredient: Ingredient): boolean {
  return Number(ingredient.current_stock) <= 0
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
        {isOutOfStock(ingredient)
          ? <span className="floor-status floor-status-danger">Out of stock</span>
          : isLowStock(ingredient) && <span className="floor-status floor-status-warning">Low stock</span>}
      </span>
      <span className="inventory-list-item-meta">
        {ingredient.current_stock} on hand
        {ingredient.reorder_threshold !== null && <> · reorder at {ingredient.reorder_threshold}</>}
        {ingredient.created_by_name && <> · added by {ingredient.created_by_name}</>}
      </span>
    </button>)}
    {ingredients.length === 0 && <p className="floor-empty">No ingredients yet.</p>}
  </div>
}
