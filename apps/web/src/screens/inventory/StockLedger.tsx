import { useMemo, useState } from 'react'
import { STOCK_MOVEMENT_REASON_LABELS, STOCK_MOVEMENT_REASON_TONE, type StockMovementReason } from '../../../../../packages/domain/src/stock-movement-reason'
import { formatQuantity } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { StockMovement } from '../../lib/inventory'
import { batchLabel } from './BatchList'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'

type MovementFilter = 'all' | StockMovementReason
const FILTERS: { value: MovementFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'purchase', label: 'Received' },
  { value: 'consumption', label: 'Consumed' },
  { value: 'wastage', label: 'Wastage' },
  { value: 'adjustment', label: 'Adjustments' },
]

// The ledger's own rows carry no stored "previous/new stock" snapshot -- that's derived here
// instead of adding one to the schema, by walking backward from the ingredient's current known
// stock through this page's movements (already fetched newest-first). This is only exact because
// the page is a contiguous, gap-free run ending at "now"; a page reached via "load more" would
// need to carry the running balance forward from where the previous page left off, which this
// component doesn't yet do (movements only render one page at a time today).
// Rounded to a fixed precision at each step (not just for display) so floating-point noise from
// repeated subtraction across many rows -- e.g. 0.1 - 0.2 style drift -- never compounds into a
// visibly wrong running balance a few rows up the ledger.
function roundQuantity(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function withRunningBalance(movements: StockMovement[], currentStock: number) {
  let runningNewStock = roundQuantity(currentStock)
  return movements.map(movement => {
    const delta = Number(movement.delta)
    const newStock = runningNewStock
    const previousStock = roundQuantity(newStock - delta)
    runningNewStock = previousStock
    return { movement, previousStock, newStock }
  })
}

// One card per movement instead of a 7-column table -- the activity chip and the +/- change (the
// two things a manager actually scans for) read as the headline, with the running balance next to
// it and who/what/note folded into a quieter meta line, same recipe as BatchList's cards.
export function StockLedger({ movements, currentStock, unit }: { movements: StockMovement[]; currentStock: number; unit: RecipeUnit | undefined }) {
  const [filter, setFilter] = useState<MovementFilter>('all')
  const rows = useMemo(() => withRunningBalance(movements, currentStock), [movements, currentStock])
  const visibleRows = filter === 'all' ? rows : rows.filter(row => row.movement.reason === filter)

  return <div className="stock-activity">
    <div className="floor-area-tabs stock-activity-filters">
      {FILTERS.map(item => <button key={item.value} type="button" className={filter === item.value ? 'active' : undefined} onClick={() => setFilter(item.value)}>{item.label}</button>)}
    </div>
    {movements.length === 0 && <EmptyState title="No stock activity yet" />}
    {movements.length > 0 && visibleRows.length === 0 && <EmptyState title="No activity matches this filter" />}
    {visibleRows.length > 0 && <div className="activity-list">
      {visibleRows.map(({ movement, previousStock, newStock }) => {
        const delta = Number(movement.delta)
        const sign = delta > 0 ? '+' : ''
        return <article key={movement.id} className="activity-row">
          <div className="activity-row-main">
            <StatusBadge tone={STOCK_MOVEMENT_REASON_TONE[movement.reason]}>{STOCK_MOVEMENT_REASON_LABELS[movement.reason]}</StatusBadge>
            <span className="activity-row-note">{movement.note ?? (movement.batch_id ? batchLabel(movement.batch_id) : 'No note')}</span>
          </div>
          <div className="activity-row-end">
            <b className={delta > 0 ? 'activity-up' : delta < 0 ? 'activity-down' : undefined}>{sign}{unit ? formatQuantity(movement.delta, unit) : movement.delta}</b>
            <small>{unit ? formatQuantity(previousStock, unit) : previousStock} → {unit ? formatQuantity(newStock, unit) : newStock}</small>
          </div>
          <div className="activity-row-meta">
            <span>{new Date(movement.created_at).toLocaleString()}</span>
            {movement.created_by_name && <span>{movement.created_by_name}</span>}
          </div>
        </article>
      })}
    </div>}
  </div>
}
