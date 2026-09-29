import { formatCents } from '../../../../../packages/domain/src/money'
import { TABLE_STATUS_LABELS, TABLE_STATUS_TONE } from '../../../../../packages/domain/src/table-status'
import type { RestaurantTable } from '../../lib/floor'
import { StatusBadge } from '../../components/StatusBadge'

// The reusable restaurant table primitive (Blueprint Section 4). Duration stays "—" — no
// per-round firing history to source elapsed-time-since-seated from yet (Ahmad's kitchen
// operations work). A table with an open check (lib/open-checks.ts) shows its real, live
// running total; otherwise it falls back to the table's last *completed* order, same as before
// an open-ticket layer existed. Waiter name is real: sourced server-side from a join against
// terminal_employees (see getFloorPlan in apps/api/src/routes/floor.ts).
export function TableCard({ table, areaName, currency, onSelect }: { table: RestaurantTable; areaName: string; currency: string; onSelect: () => void }) {
  const openCheckTotal = table.open_check_total_cents && currency ? formatCents(Number(table.open_check_total_cents), currency) : null
  const lastOrder = table.current_order_total_cents && currency ? formatCents(Number(table.current_order_total_cents), currency) : '—'
  return <button type="button" className="table-card" onClick={onSelect}>
    <span className="table-card-top">
      <span className="table-card-label">{table.label}</span>
      <StatusBadge tone={TABLE_STATUS_TONE[table.status]}>{TABLE_STATUS_LABELS[table.status]}</StatusBadge>
    </span>
    <span className="table-card-seats">{table.seats} {table.seats === 1 ? 'guest' : 'guests'}</span>
    <span className="table-card-area">{areaName}</span>
    <span className="table-card-meta">Waiter {table.assigned_waiter_name ?? '—'} · {openCheckTotal ? `Open check ${openCheckTotal}` : lastOrder}</span>
  </button>
}
