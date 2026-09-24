import { STOCK_MOVEMENT_REASON_LABELS, STOCK_MOVEMENT_REASON_TONE } from '../../../../../packages/domain/src/stock-movement-reason'
import type { StockMovement } from '../../lib/inventory'

export function StockLedger({ movements }: { movements: StockMovement[] }) {
  return <table className="inventory-table">
    <thead><tr><th>When</th><th>Reason</th><th>Delta</th><th>Note</th></tr></thead>
    <tbody>
      {movements.map(movement => <tr key={movement.id}>
        <td>{new Date(movement.created_at).toLocaleString()}</td>
        <td><span className={`floor-status floor-status-${STOCK_MOVEMENT_REASON_TONE[movement.reason]}`}>{STOCK_MOVEMENT_REASON_LABELS[movement.reason]}</span></td>
        <td>{Number(movement.delta) > 0 ? `+${movement.delta}` : movement.delta}</td>
        <td>{movement.note ?? '—'}</td>
      </tr>)}
      {movements.length === 0 && <tr><td colSpan={4} className="floor-empty">No stock movements yet.</td></tr>}
    </tbody>
  </table>
}
