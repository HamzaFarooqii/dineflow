// Shared batch-lifecycle status for the Inventory module (docs/day-plans's Inventory UX
// redesign). One priority order decides a single status per batch -- a batch is never shown with
// two conflicting badges at once.
import type { StatusTone } from './table-status.js'

export type BatchStatus = 'active' | 'low_remaining' | 'expiring_soon' | 'expired' | 'depleted'

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  active: 'Active',
  low_remaining: 'Low Remaining',
  expiring_soon: 'Expiring Soon',
  expired: 'Expired',
  depleted: 'Depleted',
}

// Reuses the existing six-tone palette (docs/DESIGN_SYSTEM.md) -- no new colors. Expiring-soon
// and low-remaining deliberately share 'warning': both mean "needs attention soon", not "broken",
// the same way ordering/preparing share 'saffron' in table-status.ts.
export const BATCH_STATUS_TONE: Record<BatchStatus, StatusTone> = {
  active: 'muted',
  low_remaining: 'warning',
  expiring_soon: 'warning',
  expired: 'danger',
  depleted: 'muted',
}

// A judgment call, not a spec'd value (documented the same way BatchList.tsx's original 3-day
// expiry window was): a batch is "running low" once at or below a fifth of what it started with.
export const LOW_REMAINING_FRACTION = 0.2
// Also referenced by apps/api/src/routes/inventory.ts's summary endpoint (as a literal '3 days'
// SQL interval, since a JS constant can't cross into a query) -- change both together.
export const EXPIRING_SOON_WINDOW_MS = 3 * 24 * 60 * 60 * 1000

export function computeBatchStatus(
  batch: { remainingQuantity: number; originalQuantity: number; expiresAt: string | null },
  now = Date.now(),
): BatchStatus {
  if (batch.remainingQuantity <= 0) return 'depleted'
  const expiryMs = batch.expiresAt ? Date.parse(batch.expiresAt) : NaN
  if (!Number.isNaN(expiryMs)) {
    if (expiryMs <= now) return 'expired'
    if (expiryMs - now <= EXPIRING_SOON_WINDOW_MS) return 'expiring_soon'
  }
  if (batch.originalQuantity > 0 && batch.remainingQuantity <= batch.originalQuantity * LOW_REMAINING_FRACTION) return 'low_remaining'
  return 'active'
}

// "5 days remaining" / "Expired 2 days ago" -- null when there's no expiry date to speak of.
export function daysUntilExpiry(expiresAt: string | null, now = Date.now()): number | null {
  if (!expiresAt) return null
  const expiryMs = Date.parse(expiresAt)
  if (Number.isNaN(expiryMs)) return null
  return Math.ceil((expiryMs - now) / (24 * 60 * 60 * 1000))
}
