import { BATCH_STATUS_LABELS, BATCH_STATUS_TONE, computeBatchStatus, daysUntilExpiry } from '../../../../../packages/domain/src/batch-status'
import { formatCents } from '../../../../../packages/domain/src/money'
import { formatQuantityNumber } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit } from '../menu/recipe-draft'
import type { IngredientBatch } from '../../lib/inventory'
import { StatusBadge } from '../../components/StatusBadge'
import { EmptyState } from '../../components/EmptyState'
import { Quantity } from './Quantity'

// Short, human-scannable identifier -- a batch has no natural "number" of its own, so this reads
// the first 8 characters of its id the same way order receipts already shorten identifiers
// elsewhere in this app, not a new numbering scheme that would need its own counter/migration.
export function batchLabel(batchId: string): string {
  return `BAT-${batchId.slice(0, 8).toUpperCase()}`
}

function expiryCopy(expiresAt: string | null): string {
  if (!expiresAt) return 'No expiry set'
  const days = daysUntilExpiry(expiresAt)
  const date = new Date(expiresAt).toLocaleDateString()
  if (days === null) return `Expires ${date}`
  if (days < 0) return `Expired ${date} (${Math.abs(days)}d ago)`
  if (days === 0) return `Expires today (${date})`
  return `Expires ${date} (${days}d left)`
}

// One card per batch instead of a 10-column table -- the same facts, but with the two numbers a
// manager actually scans for (how much is left, out of how much came in) pulled out as the
// headline, a remaining-vs-received bar for an at-a-glance read, and everything else (received
// date/by, reference, cost) folded into a quieter meta line underneath.
export function BatchList({ batches, unit, currency }: { batches: IngredientBatch[]; unit: RecipeUnit | undefined; currency: string }) {
  if (batches.length === 0) {
    return <EmptyState title="No batches received yet" description="Receive your first stock delivery to start tracking inventory." />
  }
  return <div className="batch-list">
    {batches.map(batch => {
      const status = computeBatchStatus({
        remainingQuantity: Number(batch.remaining_quantity),
        originalQuantity: Number(batch.quantity),
        expiresAt: batch.expires_at,
      })
      const original = Number(batch.quantity)
      const remaining = Number(batch.remaining_quantity)
      const usedPct = original > 0 ? Math.min(100, Math.max(0, Math.round(((original - remaining) / original) * 100))) : 0
      const totalCostCents = Math.round(original * batch.cost_per_unit_cents)
      const remainingValueCents = Math.round(remaining * batch.cost_per_unit_cents)
      const itemised = Number(batch.consumed_quantity) + Number(batch.wasted_quantity)
      // Draw-downs before Day 2's allocation snapshots were never itemised; say so instead of implying the numbers are complete.
      const unitemised = Math.round((original - remaining - itemised) * 1_000_000) / 1_000_000
      return <article key={batch.id} className="batch-card">
        <div className="batch-card-top">
          <span className="batch-card-id">{batchLabel(batch.id)}</span>
          <StatusBadge tone={BATCH_STATUS_TONE[status]}>{BATCH_STATUS_LABELS[status]}</StatusBadge>
        </div>
        <div className="batch-card-qty">
          <strong><Quantity value={batch.remaining_quantity} unit={unit} /></strong>
          <span>remaining of {formatQuantityNumber(batch.quantity)}</span>
        </div>
        <div className="batch-card-bar" role="progressbar" aria-label="Remaining stock in this batch" aria-valuenow={100 - usedPct} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${100 - usedPct}%` }} />
        </div>
        <div className="batch-card-costs">
          <span>{unit ? `${formatCents(batch.cost_per_unit_cents, currency)} / ${unit.abbreviation}` : formatCents(batch.cost_per_unit_cents, currency)}</span>
          <span>{formatCents(totalCostCents, currency)} total</span>
        </div>
        <div className="batch-card-draw">
          <span>Left on shelf worth <strong>{formatCents(remainingValueCents, currency)}</strong></span>
          {batch.allocation_count > 0
            ? <span>Drawn down: <Quantity value={batch.consumed_quantity} unit={unit} /> served · <Quantity value={batch.wasted_quantity} unit={unit} /> wasted, costed at {formatCents(Math.round(Number(batch.allocated_cost_cents)), currency)} ({batch.allocation_count} movement{batch.allocation_count === 1 ? '' : 's'})</span>
            : <span>No itemised draw-downs yet</span>}
          {unitemised > 0.0005 && <span className="batch-card-draw-note">{formatQuantityNumber(String(unitemised))} {unit?.abbreviation ?? ''} was drawn down before cost snapshots began and isn’t itemised.</span>}
        </div>
        <div className="batch-card-meta">
          <span>Received {new Date(batch.received_at).toLocaleDateString()}{batch.received_by_name ? ` by ${batch.received_by_name}` : ''}</span>
          <span>{expiryCopy(batch.expires_at)}</span>
          {batch.reference && <span>Ref: {batch.reference}</span>}
        </div>
      </article>
    })}
  </div>
}
