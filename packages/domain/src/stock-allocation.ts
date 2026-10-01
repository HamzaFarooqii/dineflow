// Deterministic, decimal-safe allocation of a stock-out quantity across batches (Day 2).
//
// Two different questions, deliberately kept apart:
//
//  PHYSICAL PICKING ORDER -- which shelf stock gets used first. The database orders candidate
//    batches by expires_at ASC NULLS LAST, then received_at ASC, then id ASC (the id tie-break is
//    new: it makes the order total, so two concurrent or replayed calls can never disagree).
//    This is earliest-expiry-first, not FIFO.
//
//  ACCOUNTING VALUATION -- what a movement is said to cost. Each unit is valued at the purchase
//    cost of the batch it was allocated from ("batch pick-order valuation"), snapshotted onto the
//    allocation row at that moment. It is NOT FIFO, LIFO or weighted-average costing: a unit
//    picked from a later-received batch is costed at that batch's price even if older stock exists.
//
// Quantities are handled as integer micro-units (6 decimal places) so fractional kg/L never pick
// up binary floating-point noise, and costs as integer micro-cents (quantity_micro * cents), which
// is exact. Rounding to whole cents happens once, at the edge, never per step.

export const QUANTITY_SCALE = 1_000_000n
const QUANTITY_DECIMALS = 6

/** Parses a decimal string/number to integer micro-units, rounding half away from zero at 6 dp. */
export function toMicro(value: string | number): bigint {
  const text = typeof value === 'number' ? numberToPlainString(value) : value.trim()
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`"${String(value)}" is not a decimal quantity.`)
  const negative = text.startsWith('-')
  const [whole, fraction = ''] = text.replace('-', '').split('.')
  const padded = (fraction + '0'.repeat(QUANTITY_DECIMALS)).slice(0, QUANTITY_DECIMALS)
  let micro = BigInt(whole) * QUANTITY_SCALE + BigInt(padded)
  if (fraction.length > QUANTITY_DECIMALS && Number(fraction[QUANTITY_DECIMALS]) >= 5) micro += 1n
  return negative ? -micro : micro
}

function numberToPlainString(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Quantity must be a finite number.')
  // toFixed(8) then round at 6 dp via toMicro avoids exponent notation (1e-7) and keeps enough
  // digits that the rounding decision is made on the real value, not on a pre-truncated one.
  return value.toFixed(8)
}

/** Formats micro-units as a plain decimal string with trailing zeros trimmed ("0.25", "3"). */
export function microToString(micro: bigint): string {
  const negative = micro < 0n
  const abs = negative ? -micro : micro
  const whole = abs / QUANTITY_SCALE
  const fraction = (abs % QUANTITY_SCALE).toString().padStart(QUANTITY_DECIMALS, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Exact cost in micro-cents of `quantityMicro` units at an integer unit cost in cents. */
export function costMicroCents(quantityMicro: bigint, unitCostCents: number): bigint {
  if (!Number.isSafeInteger(unitCostCents) || unitCostCents < 0) throw new Error('Unit cost must be a non-negative integer number of cents.')
  return quantityMicro * BigInt(unitCostCents)
}

/** Whole cents, rounded half up, from an exact micro-cent amount. */
export function microCentsToCents(micro: bigint): number {
  const rounded = (micro + 500_000n) / QUANTITY_SCALE
  return Number(rounded)
}

/** Exact micro-cents as the numeric text stored in stock_movement_allocations.cost_cents. */
export function microCentsToString(micro: bigint): string {
  return microToString(micro)
}

export type AllocationBasis = 'batch' | 'estimated_ingredient_cost'

export interface AllocationSource {
  /** Row this quantity is taken from: a batch id, or (for reclassification) an earlier allocation id. */
  sourceId: string
  batchId: string | null
  remainingMicro: bigint
  unitCostCents: number
  basis: AllocationBasis
}

export interface PlannedAllocation {
  sourceId: string | null
  batchId: string | null
  quantityMicro: bigint
  unitCostCents: number
  basis: AllocationBasis
  costMicroCents: bigint
}

export interface AllocationPlan {
  allocations: PlannedAllocation[]
  /** Quantity no source could cover. Always priced as an estimate by the caller, never attributed to a batch. */
  uncoveredMicro: bigint
}

/**
 * Greedy allocation in the order given (the caller passes sources already in physical picking
 * order). Sources with nothing left are skipped. Whatever the sources cannot cover is returned as
 * `uncoveredMicro`; when `estimateUnitCostCents` is supplied it is appended as an allocation with
 * basis 'estimated_ingredient_cost' and no batch, so the plan always accounts for the full quantity.
 */
export function allocateAcrossSources(sources: readonly AllocationSource[], quantityMicro: bigint, estimateUnitCostCents: number | null): AllocationPlan {
  if (quantityMicro <= 0n) throw new Error('Allocation quantity must be greater than zero.')
  const allocations: PlannedAllocation[] = []
  let need = quantityMicro
  for (const source of sources) {
    if (need === 0n) break
    if (source.remainingMicro <= 0n) continue
    const take = source.remainingMicro < need ? source.remainingMicro : need
    allocations.push({
      sourceId: source.sourceId, batchId: source.batchId, quantityMicro: take, unitCostCents: source.unitCostCents,
      basis: source.basis, costMicroCents: costMicroCents(take, source.unitCostCents),
    })
    need -= take
  }
  const uncoveredMicro = need
  if (uncoveredMicro > 0n && estimateUnitCostCents !== null) {
    allocations.push({
      sourceId: null, batchId: null, quantityMicro: uncoveredMicro, unitCostCents: estimateUnitCostCents,
      basis: 'estimated_ingredient_cost', costMicroCents: costMicroCents(uncoveredMicro, estimateUnitCostCents),
    })
  }
  return { allocations, uncoveredMicro }
}

export function totalCostMicroCents(allocations: readonly PlannedAllocation[]): bigint {
  return allocations.reduce((sum, allocation) => sum + allocation.costMicroCents, 0n)
}

/**
 * The batch to record on the movement row itself (stock_movements.batch_id): only when ONE batch
 * covered the whole quantity, which keeps every pre-Day-2 reader of that column correct. Spanning
 * or partially-uncovered movements carry null there and their truth lives in the allocation rows.
 */
export function singleCoveringBatchId(plan: AllocationPlan, quantityMicro: bigint): string | null {
  if (plan.allocations.length !== 1) return null
  const only = plan.allocations[0]
  return only.basis === 'batch' && only.batchId !== null && only.quantityMicro === quantityMicro ? only.batchId : null
}
