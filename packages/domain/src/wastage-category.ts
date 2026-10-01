// Structured wastage classification (Day 2). stock_movements.reason stays 'wastage' for every one
// of these -- the category lives in its own column (stock_movements.wastage_category) so reports
// can group by it without parsing the free-text note, which is preserved exactly as before.
// Values mirror the check constraint added by 202610020001_wastage_categories_batch_valuation.sql;
// do not add one here without a matching migration, and vice versa.
import type { StatusTone } from './table-status.js'

export type WastageCategory =
  | 'spoiled' | 'expired' | 'damaged' | 'prep_waste' | 'overproduction' | 'staff_meal'
  | 'complimentary' | 'incorrect_order' | 'returned_order' | 'discrepancy' | 'other'

export const WASTAGE_CATEGORIES: readonly WastageCategory[] = [
  'spoiled', 'expired', 'damaged', 'prep_waste', 'overproduction', 'staff_meal',
  'complimentary', 'incorrect_order', 'returned_order', 'discrepancy', 'other',
]

export const WASTAGE_CATEGORY_LABELS: Record<WastageCategory, string> = {
  spoiled: 'Spoiled',
  expired: 'Expired',
  damaged: 'Damaged',
  prep_waste: 'Prep waste',
  overproduction: 'Overproduction',
  staff_meal: 'Staff meal',
  complimentary: 'Complimentary',
  incorrect_order: 'Incorrect order',
  returned_order: 'Returned order',
  discrepancy: 'Discrepancy',
  other: 'Other',
}

export const WASTAGE_CATEGORY_TONE: Record<WastageCategory, StatusTone> = {
  spoiled: 'danger', expired: 'danger', damaged: 'warning', prep_waste: 'warning', overproduction: 'warning',
  staff_meal: 'info', complimentary: 'info', incorrect_order: 'saffron', returned_order: 'saffron',
  discrepancy: 'muted', other: 'muted',
}

// Whether a wastage entry takes stock out of inventory now, or only re-labels stock a served dish
// already consumed.
//   deduct            -- ordinary wastage: stock_movements.delta is negative, current_stock and the
//                        picked batches go down.
//   already_consumed  -- the food left the kitchen as a served dish, so KDS consumption already
//                        deducted its ingredients; throwing the returned dish away must NOT deduct
//                        them a second time. The movement is recorded with delta = 0 and is priced
//                        from the original item's consumption allocations.
export type WastageStockEffect = 'deduct' | 'already_consumed'
export const WASTAGE_STOCK_EFFECTS: readonly WastageStockEffect[] = ['deduct', 'already_consumed']

// returned_order is by definition food that was already served and consumed. incorrect_order can
// be either (a wrong dish thrown away before it was served was never consumed; one served and sent
// back was), so the caller must say which. Every other category physically removes stock.
const ALLOWED_STOCK_EFFECTS: Record<WastageCategory, readonly WastageStockEffect[]> = {
  spoiled: ['deduct'], expired: ['deduct'], damaged: ['deduct'], prep_waste: ['deduct'], overproduction: ['deduct'],
  staff_meal: ['deduct'], complimentary: ['deduct'], discrepancy: ['deduct'], other: ['deduct'],
  incorrect_order: ['deduct', 'already_consumed'],
  returned_order: ['already_consumed'],
}

export function allowedStockEffects(category: WastageCategory): readonly WastageStockEffect[] {
  return ALLOWED_STOCK_EFFECTS[category]
}

export function defaultStockEffect(category: WastageCategory): WastageStockEffect {
  return category === 'returned_order' ? 'already_consumed' : 'deduct'
}

export function isWastageCategory(value: unknown): value is WastageCategory {
  return typeof value === 'string' && (WASTAGE_CATEGORIES as readonly string[]).includes(value)
}

// --- Approval threshold ------------------------------------------------------------------------
//
// POLICY (decided here, enforced in apps/api/src/routes/inventory.ts):
//  * Everything that required manager approval before still does, for every quantity. Nothing in
//    this threshold weakens that.
//  * The threshold adds a STRONGER requirement on top: a terminal wastage entry whose attributed
//    cost is at or above the store's threshold must carry a server-verified, single-use approval
//    token (POST /pos/manager-approvals, Day 1) bound to this exact payload. The legacy
//    client-supplied manager_id + manager_approved_at evidence is still accepted below the
//    threshold only, because it is the only thing the currently shipped terminal UI can send.
//  * Signed-in owner/manager sessions are their own authority and are not threshold-gated.
//  * Boundary: cost == threshold requires the verified approval ("at or above").
export const DEFAULT_WASTAGE_APPROVAL_THRESHOLD_CENTS = 5000
export const MAX_WASTAGE_APPROVAL_THRESHOLD_CENTS = 100_000_000

/** costMicroCents is the exact attributed cost in millionths of a cent, so the comparison never rounds. */
export function wastageRequiresVerifiedApproval(costMicroCents: bigint, thresholdCents: number): boolean {
  if (!Number.isSafeInteger(thresholdCents) || thresholdCents < 0) throw new Error('Approval threshold must be a non-negative integer number of cents.')
  return costMicroCents >= BigInt(thresholdCents) * 1_000_000n
}

// --- Canonical operation payloads ---------------------------------------------------------------
//
// The API and the web client must serialise the SAME object in the SAME key order, because
// terminal-auth/manager-approval.ts binds an approval token to sha256(JSON.stringify(payload)).
// `quantity` is the normalised decimal string (stock-allocation.ts microToString(toMicro(q))).
export interface WastageOperationFields {
  ingredientId: string
  quantity: string
  category: WastageCategory
  stockEffect: WastageStockEffect
  note: string | null
  batchId: string | null
  kitchenTicketItemId: string | null
}

/** What makes two requests "the same operation" -- hashed for conflict detection, excludes the operation id itself. */
export function wastageIdentityPayload(fields: WastageOperationFields) {
  return {
    ingredient_id: fields.ingredientId, quantity: fields.quantity, wastage_category: fields.category,
    stock_effect: fields.stockEffect, note: fields.note, batch_id: fields.batchId,
    kitchen_ticket_item_id: fields.kitchenTicketItemId,
  }
}

/** The payload a manager approval token is bound to: the identity plus the operation id, so one approval authorises exactly one operation. */
export function wastageApprovalPayload(fields: WastageOperationFields, operationId: string) {
  return { operation_id: operationId, ...wastageIdentityPayload(fields) }
}
