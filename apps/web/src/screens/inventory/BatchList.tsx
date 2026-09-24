import type { IngredientBatch } from '../../lib/inventory'

// Expiry tone: 'danger' once past expires_at, 'warning' within 3 days before it. The 3-day
// window is a judgment call, not a spec'd value — flagged in the PR description as adjustable.
const WARNING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export function expiryTone(expiresAt: string | null, now = Date.now()): 'danger' | 'warning' | null {
  if (!expiresAt) return null
  const expiryMs = Date.parse(expiresAt)
  if (Number.isNaN(expiryMs)) return null
  if (expiryMs <= now) return 'danger'
  if (expiryMs - now <= WARNING_WINDOW_MS) return 'warning'
  return null
}

export function BatchList({ batches }: { batches: IngredientBatch[] }) {
  return <table className="inventory-table">
    <thead><tr><th>Received</th><th>Quantity</th><th>Cost/unit</th><th>Expires</th></tr></thead>
    <tbody>
      {batches.map(batch => {
        const tone = expiryTone(batch.expires_at)
        return <tr key={batch.id}>
          <td>{new Date(batch.received_at).toLocaleDateString()}</td>
          <td>{batch.quantity}</td>
          <td>{(batch.cost_per_unit_cents / 100).toFixed(2)}</td>
          <td>{batch.expires_at
            ? <span className={tone ? `floor-status floor-status-${tone}` : undefined}>{new Date(batch.expires_at).toLocaleDateString()}</span>
            : '—'}</td>
        </tr>
      })}
      {batches.length === 0 && <tr><td colSpan={4} className="floor-empty">No batches received yet.</td></tr>}
    </tbody>
  </table>
}
