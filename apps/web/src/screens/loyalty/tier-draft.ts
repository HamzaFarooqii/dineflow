import type { LoyaltyTier, LoyaltyTierInput } from '../../lib/loyalty'

export interface TierDraft { name: string; threshold: string; multiplier: string }

export const EMPTY_TIER_DRAFT: TierDraft = { name: '', threshold: '', multiplier: '1.00' }

export function draftFromTier(tier: LoyaltyTier): TierDraft {
  return { name: tier.name, threshold: String(tier.min_lifetime_points), multiplier: (tier.point_multiplier_bps / 10_000).toFixed(2) }
}

export function parseTierDraft(draft: TierDraft): LoyaltyTierInput {
  const name = draft.name.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 40) throw new Error('Tier name must be 1–40 characters.')
  const threshold = draft.threshold.trim()
  if (!/^\d{1,9}$/.test(threshold)) throw new Error('Lifetime points must be a non-negative whole number.')
  const multiplierText = draft.multiplier.trim()
  if (!/^(?:\d+)(?:\.\d{1,4})?$/.test(multiplierText)) throw new Error('Multiplier must be a number from 0.0001 to 10.0000.')
  const point_multiplier_bps = Math.round(Number(multiplierText) * 10_000)
  if (!Number.isSafeInteger(point_multiplier_bps) || point_multiplier_bps <= 0 || point_multiplier_bps > 100_000) {
    throw new Error('Multiplier must be a number from 0.0001 to 10.0000.')
  }
  return { name, min_lifetime_points: Number(threshold), point_multiplier_bps }
}
