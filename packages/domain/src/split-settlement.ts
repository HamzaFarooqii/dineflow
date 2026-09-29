// Split settlement (Ahmad's A2 work): how a check's total is fairly divided across N guests
// (equal split) or across weighted shares (itemized/per-seat split), before any tender is
// actually collected. Deliberately has no cross-file import (see open-check.ts's header comment
// for why a real value-level import between domain files breaks the plain-node test runner) --
// this is genuinely new math, not a wrapper around money.ts's existing functions.

// Largest-remainder method: the only integer-cents-safe way to divide totalCents into `count`
// shares that (a) sum back to exactly totalCents and (b) never differ from each other by more
// than one cent. A naive Math.round(total/count) on every share can under- or over-shoot the
// total by a few cents; this never does.
export function allocateEqualSplit(totalCents: number, count: number): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Total must be a non-negative integer number of cents.')
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error('Guest count must be an integer between 1 and 50.')
  const base = Math.floor(totalCents / count)
  const remainder = totalCents - base * count
  // The first `remainder` guests pay one cent more than the rest -- an arbitrary but stable and
  // auditable tie-break (not randomized), so the same inputs always produce the same allocation.
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

// Weighted allocation for itemized/per-seat splits: each weight is that share's subtotal (or
// seat total) before splitting; the result divides totalCents proportionally to those weights,
// still summing to exactly totalCents via the same largest-remainder correction. A zero-weight
// share gets zero. All weights must be non-negative and sum to more than zero.
export function allocateWeightedSplit(totalCents: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new Error('Total must be a non-negative integer number of cents.')
  if (!weights.length || weights.length > 100) throw new Error('Provide 1 to 100 weights.')
  if (weights.some(weight => !Number.isSafeInteger(weight) || weight < 0)) throw new Error('Every weight must be a non-negative integer.')
  const weightTotal = weights.reduce((sum, weight) => sum + BigInt(weight), 0n)
  if (weightTotal <= 0n) throw new Error('At least one weight must be positive.')
  // Inputs can be safe integers while their products and sum exceed Number's precision.
  const products = weights.map(weight => BigInt(totalCents) * BigInt(weight))
  const floors = products.map(product => Number(product / weightTotal))
  let remainder = totalCents - floors.reduce((sum, value) => sum + value, 0)
  // Largest fractional remainder gets the leftover cents first, breaking ties by earliest index
  // (same stability rationale as allocateEqualSplit).
  const order = products.map((value, index) => ({ index, fraction: value % weightTotal }))
    .sort((a, b) => a.fraction === b.fraction ? a.index - b.index : a.fraction > b.fraction ? -1 : 1)
  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }
  return result
}
