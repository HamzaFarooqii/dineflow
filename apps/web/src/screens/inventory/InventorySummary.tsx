import { formatCents } from '../../../../../packages/domain/src/money'
import { isLowStock, isOutOfStock } from './inventory-status'
import type { Ingredient } from '../../lib/inventory'

// Reuses reporting.css's .report-card visual recipe under inventory's own class names
// (inventory.css) rather than importing that file directly -- keeps each screen's CSS
// self-contained, matching the existing one-file-per-screen convention, while still drawing from
// the same --mise-* tokens (docs/DESIGN_SYSTEM.md).
export function InventorySummary({ ingredients, expiringBatchCount, currency }: {
  ingredients: Ingredient[]
  expiringBatchCount: number | null
  currency: string
}) {
  const lowStockCount = ingredients.filter(isLowStock).length
  const outOfStockCount = ingredients.filter(isOutOfStock).length
  // current_stock is allowed to go negative (kitchen consumption oversell) -- a negative line
  // would only ever drag the total value down in a misleading way, so it's excluded here rather
  // than netted in; the "Out of stock" tag is what actually surfaces that ingredient's problem.
  const totalValueCents = ingredients.reduce((sum, ingredient) => {
    const stock = Number(ingredient.current_stock)
    return stock > 0 ? sum + Math.round(stock * ingredient.cost_per_unit_cents) : sum
  }, 0)

  return <div className="inventory-summary-grid">
    <article className="inventory-summary-card">
      <small>Total Ingredients</small>
      <strong>{ingredients.length}</strong>
      <div className="inventory-summary-card-footer"><span>Tracked in this store</span></div>
    </article>
    <article className="inventory-summary-card">
      <small>Low Stock Items</small>
      <strong>{lowStockCount}</strong>
      <div className="inventory-summary-card-footer"><span>{outOfStockCount} out of stock</span></div>
    </article>
    <article className="inventory-summary-card">
      <small>Expiring Batches</small>
      <strong>{expiringBatchCount ?? '—'}</strong>
      <div className="inventory-summary-card-footer"><span>Within 3 days, or already expired</span></div>
    </article>
    <article className="inventory-summary-card featured">
      <small>Inventory Value</small>
      <strong>{formatCents(totalValueCents, currency)}</strong>
      <div className="inventory-summary-card-footer"><span>Current stock × cost per unit</span></div>
    </article>
  </div>
}
