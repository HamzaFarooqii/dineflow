// Promotion eligibility + discount mapping (docs/day-plans/day4.md, Bisma's half). Pure
// functions so Hamza's checkout-wiring task consumes the same numbers the Promotions management
// screen shows, the same pattern as Day 3's recipe-cost.ts feeding kitchen.ts's wiring.

import { boundedInteger, MAX_CENTS, type LineDiscount } from './money.ts'

export interface Promotion {
  id: string
  storeId: string
  name: string
  discountKind: 'percent' | 'fixed'
  discountValue: number
  startsAt: Date | null
  endsAt: Date | null
  active: boolean
}

// Currently usable: marked active, and now falls within [startsAt, endsAt] (either bound may be
// open-ended). A promotion outside its window is excluded even if `active` is still true — the
// toggle governs whether it's enabled at all, the window governs whether it's live right now.
export function activePromotions(promotions: readonly Promotion[], now: Date): Promotion[] {
  return promotions.filter(promotion => {
    if (!promotion.active) return false
    if (promotion.startsAt && now < promotion.startsAt) return false
    if (promotion.endsAt && now > promotion.endsAt) return false
    return true
  })
}

// Direct mapping onto money.ts's own LineDiscount union -- discount_kind/discount_value are
// already shaped as {percent,bps}|{fixed,cents}, so this is a rename, not a translation layer.
export function promotionToLineDiscount(promotion: Promotion): LineDiscount {
  if (promotion.discountKind === 'percent') {
    return { kind: 'percent', bps: boundedInteger(promotion.discountValue, 'Promotion discount', 0, 10_000) }
  }
  return { kind: 'fixed', cents: boundedInteger(promotion.discountValue, 'Promotion discount', 0, MAX_CENTS) }
}
