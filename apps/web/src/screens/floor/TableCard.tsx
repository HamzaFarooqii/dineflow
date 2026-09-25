import { formatCents } from '../../../../../packages/domain/src/money'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE } from '../../../../../packages/domain/src/table-status'
import type { RestaurantTable } from '../../lib/floor'
import { StatusBadge } from '../../components/StatusBadge'

// The reusable restaurant table primitive (Blueprint Section 4). Duration stays "—" — no
// open-ticket layer exists yet to source elapsed-time-since-seated from. The trailing amount is
// the table's last *completed* order, not a live running tab (see lib/floor.ts's
// RestaurantTable comment) — honest about what this codebase can and can't show today rather
// than fabricating an in-progress total. Waiter name is real: sourced server-side from a join
// against terminal_employees (see getFloorPlan in apps/api/src/routes/floor.ts).
export function TableCard({ table, areaName, currency, onSelect }: { table: RestaurantTable; areaName: string; currency: string; onSelect: () => void }) {
  const lastOrder = table.current_order_total_cents && currency ? formatCents(Number(table.current_order_total_cents), currency) : '—'
  return <button type="button" className="table-card" onClick={onSelect}>
    <span className="table-card-top">
      <span className="table-card-label">{table.label}</span>
      <StatusBadge tone={TABLE_STATUS_TONE[table.status]}>{TABLE_STATUS_LABELS[table.status]}</StatusBadge>
    </span>
    <span className="table-card-seats">{table.seats} {table.seats === 1 ? 'guest' : 'guests'}</span>
    <span className="table-card-area">{areaName}</span>
    <span className="table-card-meta">Waiter {table.assigned_waiter_name ?? '—'} · {lastOrder}</span>
  </button>
}
