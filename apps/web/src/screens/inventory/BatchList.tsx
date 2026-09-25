import { BATCH_STATUS_LABELS, BATCH_STATUS_TONE, computeBatchStatus, daysUntilExpiry } from '../../../../../packages/domain/src/batch-status'
import { formatCents } from '../../../../../packages/domain/src/money'
import { formatQuantity } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { IngredientBatch } from '../../lib/inventory'

// Short, human-scannable identifier -- a batch has no natural "number" of its own, so this reads
// the first 8 characters of its id the same way order receipts already shorten identifiers
// elsewhere in this app, not a new numbering scheme that would need its own counter/migration.
export function batchLabel(batchId: string): string {
  return `BAT-${batchId.slice(0, 8).toUpperCase()}`
}

function expiryCopy(expiresAt: string | null): string {
  if (!expiresAt) return '—'
  const days = daysUntilExpiry(expiresAt)
  const date = new Date(expiresAt).toLocaleDateString()
  if (days === null) return date
  if (days < 0) return `${date} (expired ${Math.abs(days)}d ago)`
  if (days === 0) return `${date} (today)`
  return `${date} (${days}d remaining)`
}

export function BatchList({ batches, unit, currency }: { batches: IngredientBatch[]; unit: RecipeUnit | undefined; currency: string }) {
  return <table className="inventory-table batch-table">
    <thead><tr>
      <th>Batch</th><th>Received</th><th>Received Qty</th><th>Remaining</th><th>Cost/unit</th><th>Total Cost</th><th>Expires</th><th>Received by</th><th>Reference</th><th>Status</th>
    </tr></thead>
    <tbody>
      {batches.map(batch => {
        const status = computeBatchStatus({
          remainingQuantity: Number(batch.remaining_quantity),
          originalQuantity: Number(batch.quantity),
          expiresAt: batch.expires_at,
        })
        const totalCostCents = Math.round(Number(batch.quantity) * batch.cost_per_unit_cents)
        return <tr key={batch.id}>
          <td data-label="Batch">{batchLabel(batch.id)}</td>
          <td data-label="Received">{new Date(batch.received_at).toLocaleDateString()}</td>
          <td data-label="Received Qty">{unit ? formatQuantity(batch.quantity, unit) : batch.quantity}</td>
          <td data-label="Remaining">{unit ? formatQuantity(batch.remaining_quantity, unit) : batch.remaining_quantity}</td>
          <td data-label="Cost/unit">{unit ? `${formatCents(batch.cost_per_unit_cents, currency)} / ${unit.abbreviation}` : formatCents(batch.cost_per_unit_cents, currency)}</td>
          <td data-label="Total Cost">{formatCents(totalCostCents, currency)}</td>
          <td data-label="Expires">{expiryCopy(batch.expires_at)}</td>
          <td data-label="Received by">{batch.received_by_name ?? '—'}</td>
          <td data-label="Reference">{batch.reference ?? '—'}</td>
          <td data-label="Status"><span className={`floor-status floor-status-${BATCH_STATUS_TONE[status]}`}>{BATCH_STATUS_LABELS[status]}</span></td>
        </tr>
      })}
      {batches.length === 0 && <tr><td colSpan={10} className="floor-empty">No batches received yet. Receive your first stock delivery to start tracking inventory.</td></tr>}
    </tbody>
  </table>
}
