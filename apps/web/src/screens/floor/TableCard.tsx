import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE } from '../../../../../packages/domain/src/table-status'
import type { RestaurantTable } from '../../lib/floor'

// The reusable restaurant table primitive (Blueprint Section 4). Waiter/duration/running-total
// are deliberately left as "—" — no open-ticket layer exists yet to source real values, and
// this screen never fabricates data to fill the gap.
export function TableCard({ table, areaName, onSelect }: { table: RestaurantTable; areaName: string; onSelect: () => void }) {
  return <button type="button" className="table-card" onClick={onSelect}>
    <span className="table-card-top">
      <span className="table-card-label">{table.label}</span>
      <span className={`floor-status floor-status-${TABLE_STATUS_TONE[table.status]}`}>{TABLE_STATUS_LABELS[table.status]}</span>
    </span>
    <span className="table-card-seats">{table.seats} {table.seats === 1 ? 'guest' : 'guests'}</span>
    <span className="table-card-area">{areaName}</span>
    <span className="table-card-meta">Waiter — · —</span>
  </button>
}
