// Loyalty math (docs/day-plans/day4.md, "Loyalty domain math"). Pure functions so the API, the
// guest picker, and the checkout-wiring hook in orders.ts all compute the same numbers.
//
// Earn rate: 1 point per whole dollar (100 cents) spent, scaled by the customer's tier multiplier
// in basis points (10000 = 1x, 15000 = 1.5x — the same bps convention as loyalty_tiers and
// tax_rate_bps). Rounding happens once, DOWN, on the exact scaled total: a guest is never credited
// a fraction of a point they didn't fully earn, and flooring the dollars before applying the
// multiplier would under-credit higher tiers ($9.99 at 1.5x is 14.985 → 14, not 9 × 1.5 → 13).
import type { LineDiscount } from './money.js'

export const CENTS_PER_POINT = 100
export const BASE_MULTIPLIER_BPS = 10_000

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

/** Points a completed order earns. Order total is whatever the caller decides is point-eligible. */
export function pointsEarned(orderTotalCents: number, tierMultiplierBps: number): number {
  nonNegativeInteger(orderTotalCents, 'Order total')
  positiveInteger(tierMultiplierBps, 'Tier multiplier')
  return Math.floor((orderTotalCents * tierMultiplierBps) / (CENTS_PER_POINT * BASE_MULTIPLIER_BPS))
}

/**
 * The tier a customer's lifetime points qualify for: the one with the highest threshold at or
 * below their lifetime points, or null when none qualify (no tiers configured, or every tier's
 * threshold is above them). On equal thresholds the tier listed first wins, so pass tiers in a
 * stable order (the API returns them by threshold, then name).
 *
 * Lifetime points, not the spendable balance: redeeming points never demotes a tier.
 */
export function tierForLifetimePoints<T extends { minLifetimePoints: number }>(lifetimePoints: number, tiers: readonly T[]): T | null {
  nonNegativeInteger(lifetimePoints, 'Lifetime points')
  let best: T | null = null
  for (const tier of tiers) {
    nonNegativeInteger(tier.minLifetimePoints, 'Tier threshold')
    if (tier.minLifetimePoints <= lifetimePoints && (best === null || tier.minLifetimePoints > best.minLifetimePoints)) best = tier
  }
  return best
}

/**
 * The discount a reward rule gives if the account can afford it, as the existing LineDiscount
 * shape so it flows through the same discountNeedsManagerApproval gate as a manual discount.
 * Null when the balance is short of the rule's point cost.
 */
export function redemptionValue(pointsCost: number, discountCents: number, accountBalance: number): Extract<LineDiscount, { kind: 'fixed' }> | null {
  positiveInteger(pointsCost, 'Reward point cost')
  positiveInteger(discountCents, 'Reward discount')
  nonNegativeInteger(accountBalance, 'Points balance')
  return accountBalance >= pointsCost ? { kind: 'fixed', cents: discountCents } : null
}
