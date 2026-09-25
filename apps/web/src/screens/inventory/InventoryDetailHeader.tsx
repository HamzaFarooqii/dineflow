import { formatCents } from '../../../../../packages/domain/src/money'
import { formatCostPerUnit, formatQuantity } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit, UnitKind } from '../menu/recipe-draft'
import type { Ingredient } from '../../lib/inventory'
import { InventoryStatusBadge } from './InventoryStatusBadge'
import { MetricCard } from '../../components/MetricCard'

const KIND_SUBTITLE: Record<UnitKind, string> = { mass: 'Weight inventory', volume: 'Liquid inventory', count: 'Count inventory' }

// "Adjust Stock" and "Edit Ingredient" are deliberately not here: there's no manual-adjustment
// endpoint yet (only purchase/wastage/consumption move stock today), and ingredient edit was
// explicitly deferred to a later pass -- adding either now would be a button with nothing real
// behind it.
export function InventoryDetailHeader({ ingredient, unit, currency, receiveOpen, onToggleReceive, wastageOpen, onToggleWastage }: {
  ingredient: Ingredient
  unit: RecipeUnit | undefined
  currency: string
  receiveOpen: boolean
  onToggleReceive: () => void
  wastageOpen: boolean
  onToggleWastage: () => void
}) {
  const stock = Number(ingredient.current_stock)
  const estimatedValueCents = stock > 0 ? Math.round(stock * ingredient.cost_per_unit_cents) : 0

  return <div className="inventory-detail-header">
    <div className="inventory-detail-header-top">
      <div>
        <h2>{ingredient.name}</h2>
        {unit && <p className="inventory-detail-subtitle">{KIND_SUBTITLE[unit.kind]}</p>}
      </div>
      <InventoryStatusBadge ingredient={ingredient} />
    </div>
    <div className="inventory-detail-stats">
      <MetricCard label="Current Stock" value={unit ? formatQuantity(ingredient.current_stock, unit) : ingredient.current_stock} />
      <MetricCard label="Average Cost" value={unit ? formatCostPerUnit(formatCents(ingredient.cost_per_unit_cents, currency), unit) : '—'} />
      <MetricCard label="Estimated Stock Value" value={formatCents(estimatedValueCents, currency)} />
    </div>
    {ingredient.reorder_threshold !== null && unit && <p className="inventory-detail-reorder">Reorder at {formatQuantity(ingredient.reorder_threshold, unit)}</p>}
    <div className="inventory-detail-actions">
      <button type="button" className={receiveOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={onToggleReceive}>{receiveOpen ? 'Cancel' : 'Receive Stock'}</button>
      <button type="button" className={wastageOpen ? 'secondary-cta active' : 'secondary-cta'} onClick={onToggleWastage}>{wastageOpen ? 'Cancel' : 'Record Wastage'}</button>
    </div>
  </div>
}
