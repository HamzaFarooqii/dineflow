import { formatCents } from '../../../../../packages/domain/src/money'
import { isLowStock, isOutOfStock } from './inventory-status'
import { MetricCard } from '../../components/MetricCard'
import type { Ingredient } from '../../lib/inventory'

export function InventorySummary({ ingredients, expiringBatchCount, currency }: {
  ingredients: Ingredient[]
  expiringBatchCount: number | null
  currency: string
}) {
  // A deactivated ingredient is kept around (findable under the "Inactive" filter) rather than
  // deleted, but it's no longer part of anyone's real stock picture -- every card here is about
  // active ingredients only.
  const active = ingredients.filter(ingredient => ingredient.active)
  const lowStockCount = active.filter(isLowStock).length
  const outOfStockCount = active.filter(isOutOfStock).length
  // current_stock is allowed to go negative (kitchen consumption oversell) -- a negative line
  // would only ever drag the total value down in a misleading way, so it's excluded here rather
  // than netted in; the "Out of stock" tag is what actually surfaces that ingredient's problem.
  const totalValueCents = active.reduce((sum, ingredient) => {
    const stock = Number(ingredient.current_stock)
    return stock > 0 ? sum + Math.round(stock * ingredient.cost_per_unit_cents) : sum
  }, 0)

  return <div className="metric-grid">
    <MetricCard label="Total Ingredients" value={active.length} detail="Tracked in this store" />
    <MetricCard label="Low Stock Items" value={lowStockCount} detail={`${outOfStockCount} out of stock`} />
    <MetricCard label="Expiring Batches" value={expiringBatchCount ?? '—'} detail="Within 3 days, or already expired" />
    <MetricCard label="Inventory Value" value={formatCents(totalValueCents, currency)} detail="Current stock × cost per unit" featured />
  </div>
}
