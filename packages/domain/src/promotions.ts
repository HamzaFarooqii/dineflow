// Promotion eligibility + discount mapping (docs/day-plans/day4.md, Bisma's half). Pure
// functions so Hamza's checkout-wiring task consumes the same numbers the Promotions management
// screen shows, the same pattern as Day 3's recipe-cost.ts feeding kitchen.ts's wiring.
//
// boundedInteger/MAX_CENTS are inlined below rather than imported as values from money.ts: this
// package's own test runner (node --experimental-strip-types) and apps/web's tsc (Bundler
// resolution) both tolerate a same-package '.ts'-suffixed value import, but apps/api's tsc
// (NodeNext) rejects it outright (TS5097) -- and that combination only actually surfaces once
// something in apps/api imports this file, which the Day 4 checkout-wiring task is the first to
// do. money.ts's formatCostPerUnit hit the identical conflict for the same reason (see its own
// comment) and was resolved the same way: don't import the value, duplicate the few lines. The
// type-only import below is unaffected -- it's erased before any runtime resolution happens.
import type { LineDiscount } from './money.js'

const MAX_CENTS = 1_000_000_000

function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  }
  return value
}

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
