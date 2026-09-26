export const MAX_CENTS = 1_000_000_000

export function boundedInteger(value: number, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function calculateLine(unitPriceCents: number, quantity: number, taxRateBps: number) {
  boundedInteger(unitPriceCents, 'Unit price', 0, MAX_CENTS)
  boundedInteger(quantity, 'Quantity', 1, 10_000)
  boundedInteger(taxRateBps, 'Tax rate', 0, 10_000)
  const subtotalCents = boundedInteger(unitPriceCents * quantity, 'Line subtotal', 0, MAX_CENTS)
  const taxCents = Math.floor((subtotalCents * taxRateBps + 5_000) / 10_000)
  const totalCents = boundedInteger(subtotalCents + taxCents, 'Line total', 0, MAX_CENTS)
  return { subtotalCents, taxCents, totalCents }
}

export function sumLines(lines: ReturnType<typeof calculateLine>[]) {
  return lines.reduce((sum, line) => ({
    subtotalCents: boundedInteger(sum.subtotalCents + line.subtotalCents, 'Subtotal', 0, MAX_CENTS),
    taxCents: boundedInteger(sum.taxCents + line.taxCents, 'Tax', 0, MAX_CENTS),
    totalCents: boundedInteger(sum.totalCents + line.totalCents, 'Total', 0, MAX_CENTS),
  }), { subtotalCents: 0, taxCents: 0, totalCents: 0 })
}

// A line may carry at most one discount in Phase 1 (docs/05_product_requirements.md section 3):
// a percentage in basis points (rounded half up) or a fixed integer-cent amount bounded by the line subtotal.
export type LineDiscount = { kind: 'percent'; bps: number } | { kind: 'fixed'; cents: number } | null

// Cashiers may apply a discount up to this share of the line subtotal without manager approval (FEAT-AUTH-02).
export const MANAGER_APPROVAL_DISCOUNT_BPS = 2_000

export function calculateDiscountAmount(lineSubtotalCents: number, discount: LineDiscount): number {
  boundedInteger(lineSubtotalCents, 'Line subtotal', 0, MAX_CENTS)
  if (!discount) return 0
  if (discount.kind === 'percent') {
    boundedInteger(discount.bps, 'Discount percent', 0, 10_000)
    return Math.floor((lineSubtotalCents * discount.bps + 5_000) / 10_000)
  }
  return boundedInteger(discount.cents, 'Discount amount', 0, lineSubtotalCents)
}

// True when a discount on a line of this subtotal exceeds the cashier's independent authority
// and must be authorized through the Manager Approval Modal before checkout.
export function discountNeedsManagerApproval(lineSubtotalCents: number, discountAppliedCents: number): boolean {
  if (lineSubtotalCents <= 0 || discountAppliedCents <= 0) return false
  return discountAppliedCents * 10_000 > lineSubtotalCents * MANAGER_APPROVAL_DISCOUNT_BPS
}

export function calculateDiscountedLine(unitPriceCents: number, quantity: number, taxRateBps: number, discount: LineDiscount = null) {
  boundedInteger(unitPriceCents, 'Unit price', 0, MAX_CENTS)
  boundedInteger(quantity, 'Quantity', 1, 10_000)
  boundedInteger(taxRateBps, 'Tax rate', 0, 10_000)
  const subtotalCents = boundedInteger(unitPriceCents * quantity, 'Line subtotal', 0, MAX_CENTS)
  const discountAppliedCents = calculateDiscountAmount(subtotalCents, discount)
  const taxableCents = boundedInteger(subtotalCents - discountAppliedCents, 'Taxable amount', 0, MAX_CENTS)
  const taxCents = Math.floor((taxableCents * taxRateBps + 5_000) / 10_000)
  const totalCents = boundedInteger(taxableCents + taxCents, 'Line total', 0, MAX_CENTS)
  return { subtotalCents, discountAppliedCents, taxableCents, taxCents, totalCents }
}

export function sumDiscountedLines(lines: ReturnType<typeof calculateDiscountedLine>[]) {
  return lines.reduce((sum, line) => ({
    subtotalCents: boundedInteger(sum.subtotalCents + line.subtotalCents, 'Subtotal', 0, MAX_CENTS),
    discountCents: boundedInteger(sum.discountCents + line.discountAppliedCents, 'Discount', 0, MAX_CENTS),
    taxCents: boundedInteger(sum.taxCents + line.taxCents, 'Tax', 0, MAX_CENTS),
    totalCents: boundedInteger(sum.totalCents + line.totalCents, 'Total', 0, MAX_CENTS),
  }), { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 })
}

/**
 * A whole-bill service charge (basis points, same convention as tax), applied on the post-discount
 * subtotal -- same base as tax itself, but a separate figure so it's never confused with tax on a
 * receipt. Half-up rounding, matching every other bps calculation in this file.
 */
export function calculateServiceCharge(subtotalAfterDiscountCents: number, serviceChargeBps: number): number {
  boundedInteger(subtotalAfterDiscountCents, 'Subtotal', 0, MAX_CENTS)
  boundedInteger(serviceChargeBps, 'Service charge rate', 0, 10_000)
  return Math.floor((subtotalAfterDiscountCents * serviceChargeBps + 5_000) / 10_000)
}

export function parseCents(input: string): number {
  const normalized = input.trim()
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(normalized)) throw new Error('Enter a valid amount with up to two decimal places.')
  const [units, fraction = ''] = normalized.split('.')
  return boundedInteger(Number(units) * 100 + Number(fraction.padEnd(2, '0')), 'Tender', 0, MAX_CENTS)
}

export function formatCents(cents: number, currency = 'USD'): string {
  boundedInteger(cents, 'Amount', 0, MAX_CENTS)
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)
}
