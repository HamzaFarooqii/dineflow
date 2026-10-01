// Read-side inventory cost contract (Day 2) -- the shape the profitability/reporting layer reads.
// Full prose contract, SQL and worked examples: docs/inventory-cost-contract.md.
//
// This module is pure: the API groups public.stock_movement_cost_lines rows in SQL
// (apps/api/src/lib/inventory-cost-contract.ts) and hands the groups to summarizeInventoryCost,
// so the reporting developer can unit-test against plain fixtures with no database.
//
// WHAT IS AND IS NOT COUNTED
//  * Consumption cost  = stock deducted when a kitchen item is served (recipe-driven, so it is
//    THEORETICAL usage, not measured usage).
//  * Wastage cost      = explicit wastage entries. Entries with stockEffect 'already_consumed'
//    (returned dishes) re-label food that consumption already counted, so they are reported
//    separately as `includedInConsumption` and EXCLUDED from `incrementalCostCents`. Adding
//    consumption + wastage.totals would double count them; add consumption + incrementalCostCents.
//  * Never reported as a number: movements with no cost evidence (pre-Day-2 rows with no batch).
//    They are counted in unknownMovementCount instead of being priced at today's ingredient price.
import type { WastageCategory, WastageStockEffect } from './wastage-category.js'

// Local copies of stock-allocation.ts's toMicro/microCentsToCents (decimal text -> integer micro-cents,
// half-up to whole cents): domain modules cannot import each other at runtime because this
// package's own test runner (node --experimental-strip-types) and the API's NodeNext tsc disagree
// on the specifier extension, the same constraint inventory-quantity.ts documents.
function toMicro(value: string): bigint {
  if (!/^-?\d+(\.\d+)?$/.test(value)) throw new Error(`"${value}" is not a decimal amount.`)
  const negative = value.startsWith('-')
  const [whole, fraction = ''] = value.replace('-', '').split('.')
  let micro = BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))
  if (fraction.length > 6 && Number(fraction[6]) >= 5) micro += 1n
  return negative ? -micro : micro
}
function microCentsToCents(micro: bigint): number { return Number((micro + 500_000n) / 1_000_000n) }

export type CostedReason = 'consumption' | 'wastage' | 'adjustment'

/** One SQL group of stock_movement_cost_lines. Cost fields are exact decimal cents as text. */
export interface CostLineGroup {
  reason: CostedReason
  wastageCategory: WastageCategory | null
  stockEffect: WastageStockEffect | null
  movementCount: number
  /** Cost attributed to a real batch: an allocation snapshot, or a pre-Day-2 movement's own batch_id x that batch's immutable cost. */
  knownCostCents: string
  /** Cost of quantity no batch covered, priced at the ingredient's cost AT THE TIME and snapshotted. */
  estimatedCostCents: string
  /** Movements that contain any estimated quantity. */
  estimatedMovementCount: number
  /** Movements with no cost evidence at all. */
  unknownMovementCount: number
}

export const VALUATION_METHOD = 'batch_pick_order' as const
export const VALUATION_POLICY_VERSION = 1

export interface CostAmounts {
  /** knownCents + estimatedCents -- always exactly their sum. */
  totalCents: number
  knownCents: number
  estimatedCents: number
  movementCount: number
  estimatedMovementCount: number
  unknownMovementCount: number
}

export type CostCompleteness = 'no_data' | 'complete' | 'estimated' | 'incomplete'

export interface CostCompletenessReport {
  status: CostCompleteness
  /** known / (known + estimated) in basis points; null when there is no priced cost at all. */
  knownShareBps: number | null
  estimatedMovementCount: number
  unknownMovementCount: number
  note: string
}

export interface InventoryCostSummary {
  period: { startUtc: string; endUtc: string; endExclusive: true }
  timeBasis: { field: 'stock_movements.created_at'; description: string }
  refundTreatment: { consumption: 'not_reversed'; wastage: 'not_applicable'; description: string }
  valuation: {
    method: typeof VALUATION_METHOD
    policyVersion: number
    /** First moment this store recorded a cost allocation snapshot; null until it records one. */
    effectiveFrom: string | null
    description: string
    legacyHandling: string
  }
  consumption: CostAmounts
  wastage: CostAmounts & {
    byCategory: { category: WastageCategory | null; label: WastageCategory | 'uncategorised'; amounts: CostAmounts }[]
    /** Already-consumed (returned-dish) wastage: part of consumption cost already, shown for visibility only. */
    includedInConsumption: CostAmounts
    /** Wastage that removed additional stock; the amount to ADD to consumption cost. */
    incrementalCostCents: number
  }
  completeness: CostCompletenessReport
  variance: {
    actualVariance: { available: false; reason: 'no_independent_stock_counts'; message: string }
    theoreticalUsageCostCents: number
    recordedWastageCostCents: number
    knownAdjustments: { movementCount: number; valued: false; message: string }
  }
}

const EMPTY: CostAmounts = { totalCents: 0, knownCents: 0, estimatedCents: 0, movementCount: 0, estimatedMovementCount: 0, unknownMovementCount: 0 }

interface Accumulator { known: bigint; estimated: bigint; movements: number; estimatedMovements: number; unknownMovements: number }
const newAccumulator = (): Accumulator => ({ known: 0n, estimated: 0n, movements: 0, estimatedMovements: 0, unknownMovements: 0 })
function add(acc: Accumulator, group: CostLineGroup) {
  acc.known += toMicro(group.knownCostCents)
  acc.estimated += toMicro(group.estimatedCostCents)
  acc.movements += group.movementCount
  acc.estimatedMovements += group.estimatedMovementCount
  acc.unknownMovements += group.unknownMovementCount
}
function finish(acc: Accumulator): CostAmounts {
  // Each part is rounded once from its exact total; the grand total is the sum of the two rounded
  // parts so a UI that shows "known" and "estimated" beside "total" always adds up.
  const knownCents = microCentsToCents(acc.known)
  const estimatedCents = microCentsToCents(acc.estimated)
  return {
    totalCents: knownCents + estimatedCents, knownCents, estimatedCents, movementCount: acc.movements,
    estimatedMovementCount: acc.estimatedMovements, unknownMovementCount: acc.unknownMovements,
  }
}

function completeness(groups: readonly CostLineGroup[], amounts: CostAmounts[]): CostCompletenessReport {
  const movementCount = amounts.reduce((sum, item) => sum + item.movementCount, 0)
  const estimatedMovementCount = amounts.reduce((sum, item) => sum + item.estimatedMovementCount, 0)
  const unknownMovementCount = amounts.reduce((sum, item) => sum + item.unknownMovementCount, 0)
  const known = amounts.reduce((sum, item) => sum + item.knownCents, 0)
  const estimated = amounts.reduce((sum, item) => sum + item.estimatedCents, 0)
  const knownShareBps = known + estimated > 0 ? Math.round((known * 10_000) / (known + estimated)) : null
  if (movementCount === 0 && groups.length === 0) {
    return { status: 'no_data', knownShareBps, estimatedMovementCount, unknownMovementCount, note: 'No consumption or wastage was recorded in this period.' }
  }
  if (unknownMovementCount > 0) {
    return { status: 'incomplete', knownShareBps, estimatedMovementCount, unknownMovementCount,
      note: `${unknownMovementCount} movement(s) have no cost evidence (recorded before batch cost snapshots existed, with no batch). Totals exclude them; they are not priced at today's ingredient cost.` }
  }
  if (estimatedMovementCount > 0) {
    return { status: 'estimated', knownShareBps, estimatedMovementCount, unknownMovementCount,
      note: `${estimatedMovementCount} movement(s) include quantity no batch covered; that part is priced at the ingredient cost recorded at the time.` }
  }
  return { status: 'complete', knownShareBps, estimatedMovementCount, unknownMovementCount, note: 'Every movement is fully attributed to batch costs.' }
}

export function summarizeInventoryCost(input: { startUtc: string; endUtc: string; effectiveFrom: string | null; groups: readonly CostLineGroup[] }): InventoryCostSummary {
  const consumption = newAccumulator()
  const wastageAll = newAccumulator()
  const wastageIncluded = newAccumulator()
  const byCategory = new Map<string, { category: WastageCategory | null; acc: Accumulator }>()
  let adjustmentMovements = 0

  for (const group of input.groups) {
    if (group.reason === 'consumption') add(consumption, group)
    else if (group.reason === 'adjustment') adjustmentMovements += group.movementCount
    else {
      add(wastageAll, group)
      if (group.stockEffect === 'already_consumed') add(wastageIncluded, group)
      const key = group.wastageCategory ?? 'uncategorised'
      const entry = byCategory.get(key) ?? { category: group.wastageCategory, acc: newAccumulator() }
      add(entry.acc, group)
      byCategory.set(key, entry)
    }
  }

  const consumptionAmounts = finish(consumption)
  const wastageAmounts = finish(wastageAll)
  const includedAmounts = finish(wastageIncluded)
  const categoryRows = [...byCategory.entries()]
    .map(([key, entry]) => ({ category: entry.category, label: (entry.category ?? 'uncategorised') as WastageCategory | 'uncategorised', amounts: finish(entry.acc), key }))
    .sort((a, b) => b.amounts.totalCents - a.amounts.totalCents || a.key.localeCompare(b.key))
    .map(({ key: _key, ...row }) => row)

  return {
    period: { startUtc: input.startUtc, endUtc: input.endUtc, endExclusive: true },
    timeBasis: {
      field: 'stock_movements.created_at',
      description: 'A movement belongs to the period in which it was RECORDED: consumption when the kitchen item was marked served, wastage when the entry was saved. It is not the order paid time and not the business day of the sale.',
    },
    refundTreatment: {
      consumption: 'not_reversed', wastage: 'not_applicable',
      description: 'Refunding an order does not return ingredient stock, so its consumption cost stays in the period it was served. Present revenue net of refunds and cost gross of refunds; do not net them against each other.',
    },
    valuation: {
      method: VALUATION_METHOD, policyVersion: VALUATION_POLICY_VERSION, effectiveFrom: input.effectiveFrom,
      description: 'Each unit is costed at the purchase cost of the batch it was physically allocated from (earliest expiry first, then oldest received), snapshotted at movement time. This is not FIFO, LIFO or weighted-average costing, and later ingredient price edits never change it.',
      legacyHandling: 'Movements recorded before effectiveFrom have no allocation rows. Those that already carried a batch_id are valued at that batch\'s immutable cost; the rest are counted as unknown, never priced retroactively.',
    },
    consumption: consumptionAmounts,
    wastage: { ...wastageAmounts, byCategory: categoryRows, includedInConsumption: includedAmounts, incrementalCostCents: wastageAmounts.totalCents - includedAmounts.totalCents },
    completeness: completeness(input.groups, [consumptionAmounts, wastageAmounts]),
    variance: {
      actualVariance: {
        available: false, reason: 'no_independent_stock_counts',
        message: 'Actual-versus-theoretical variance is unavailable: there are no independent stock counts. Consumption is generated from recipes, so comparing it with the same recipe calculation would not measure anything.',
      },
      theoreticalUsageCostCents: consumptionAmounts.totalCents,
      recordedWastageCostCents: wastageAmounts.totalCents - includedAmounts.totalCents,
      knownAdjustments: { movementCount: adjustmentMovements, valued: false, message: 'Manual adjustments are counted but not valued: they carry no batch cost evidence.' },
    },
  }
}

export { EMPTY as EMPTY_COST_AMOUNTS }
