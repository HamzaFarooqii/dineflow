// Client-side PREVIEW of what a wastage entry will cost and whether it needs a verified approval.
// It runs the exact same pure allocator the API uses (packages/domain/src/stock-allocation.ts) over
// the batches the screen already loaded, so the number shown before saving is the number the server
// computes -- but it is only a preview: the server re-plans against live rows under lock and is the
// source of truth (a batch drawn down in the meantime can change the split).
import {
  allocateAcrossSources, microCentsToCents, microToString, toMicro, totalCostMicroCents, type AllocationSource,
} from '../../../../../packages/domain/src/stock-allocation'
import { wastageRequiresVerifiedApproval } from '../../../../../packages/domain/src/wastage-category'
import type { IngredientBatch, StockMovement } from '../../lib/inventory'

/** Physical picking order, mirroring the database: earliest expiry first (none last), then oldest received, then id. */
export function inPickingOrder(batches: readonly IngredientBatch[]): IngredientBatch[] {
  const expiry = (batch: IngredientBatch) => batch.expires_at === null ? Number.POSITIVE_INFINITY : Date.parse(batch.expires_at)
  return [...batches].sort((a, b) => {
    const byExpiry = expiry(a) === expiry(b) ? 0 : expiry(a) < expiry(b) ? -1 : 1
    if (byExpiry !== 0) return byExpiry
    const byReceived = Date.parse(a.received_at) - Date.parse(b.received_at)
    if (byReceived !== 0) return byReceived
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

export interface WastagePreview {
  ok: true
  allocations: { batchId: string | null; quantity: string; unitCostCents: number; costCents: number; basis: 'batch' | 'estimated_ingredient_cost' }[]
  knownCents: number
  estimatedCents: number
  totalCents: number
  requiresVerifiedApproval: boolean
}
export type WastagePreviewResult = WastagePreview | { ok: false; reason: string }

export function previewWastage(input: {
  quantity: string
  batches: readonly IngredientBatch[]
  explicitBatchId: string | null
  ingredientCostCents: number
  currentStock: string
  thresholdCents: number | null
}): WastagePreviewResult {
  let quantityMicro: bigint
  try { quantityMicro = toMicro(input.quantity) } catch { return { ok: false, reason: 'Enter a quantity greater than zero.' } }
  if (quantityMicro <= 0n) return { ok: false, reason: 'Enter a quantity greater than zero.' }
  if (quantityMicro > toMicro(input.currentStock)) return { ok: false, reason: `Only ${microToString(toMicro(input.currentStock))} in stock — wastage cannot exceed it.` }

  const usable = inPickingOrder(input.batches).filter(batch => toMicro(batch.remaining_quantity) > 0n && (input.explicitBatchId === null || batch.id === input.explicitBatchId))
  if (input.explicitBatchId !== null) {
    if (!usable.length) return { ok: false, reason: 'That batch has nothing remaining.' }
    if (quantityMicro > toMicro(usable[0].remaining_quantity)) return { ok: false, reason: `Only ${microToString(toMicro(usable[0].remaining_quantity))} remaining in that batch.` }
  }
  const sources: AllocationSource[] = usable.map(batch => ({
    sourceId: batch.id, batchId: batch.id, remainingMicro: toMicro(batch.remaining_quantity), unitCostCents: batch.cost_per_unit_cents, basis: 'batch',
  }))
  const plan = allocateAcrossSources(sources, quantityMicro, input.ingredientCostCents)
  const known = plan.allocations.filter(item => item.basis === 'batch').reduce((sum, item) => sum + item.costMicroCents, 0n)
  const estimated = plan.allocations.filter(item => item.basis !== 'batch').reduce((sum, item) => sum + item.costMicroCents, 0n)
  return {
    ok: true,
    allocations: plan.allocations.map(item => ({
      batchId: item.batchId, quantity: microToString(item.quantityMicro), unitCostCents: item.unitCostCents,
      costCents: microCentsToCents(item.costMicroCents), basis: item.basis,
    })),
    knownCents: microCentsToCents(known),
    estimatedCents: microCentsToCents(estimated),
    totalCents: microCentsToCents(known) + microCentsToCents(estimated),
    requiresVerifiedApproval: input.thresholdCents !== null && wastageRequiresVerifiedApproval(totalCostMicroCents(plan.allocations), input.thresholdCents),
  }
}

/** Served kitchen items that consumed this ingredient, newest first -- the choices for a returned-dish entry. */
export function consumptionChoices(movements: readonly StockMovement[]): { kitchenTicketItemId: string; consumed: string; createdAt: string }[] {
  const seen = new Set<string>()
  const choices: { kitchenTicketItemId: string; consumed: string; createdAt: string }[] = []
  for (const movement of movements) {
    if (movement.reason !== 'consumption' || !movement.kitchen_ticket_item_id || seen.has(movement.kitchen_ticket_item_id)) continue
    seen.add(movement.kitchen_ticket_item_id)
    choices.push({ kitchenTicketItemId: movement.kitchen_ticket_item_id, consumed: microToString(-toMicro(movement.delta)), createdAt: movement.created_at })
  }
  return choices
}

/** Whole cents of a movement's attributed cost, split by certainty; null when it has no cost evidence. */
export function movementCost(movement: Pick<StockMovement, 'cost_source' | 'known_cost_cents' | 'estimated_cost_cents' | 'allocations'>): { knownCents: number; estimatedCents: number } | null {
  if (movement.cost_source === null || movement.cost_source === 'unknown') return null
  return {
    knownCents: movement.known_cost_cents === null ? 0 : microCentsToCents(toMicro(movement.known_cost_cents)),
    estimatedCents: movement.estimated_cost_cents === null ? 0 : microCentsToCents(toMicro(movement.estimated_cost_cents)),
  }
}
