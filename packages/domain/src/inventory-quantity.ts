// Shared quantity/unit formatting for the Inventory module. The one rule this file exists to
// enforce: a quantity is never displayed without its unit, and a cost is never displayed without
// both its currency and its unit ("Rs 150 / L", never "150"). Every inventory screen renders
// through these functions rather than formatting numbers inline, so the rule can't drift screen
// by screen the way it already had (IngredientList.tsx was rendering a bare
// `{ingredient.current_stock} on hand` before this existed).
//
// formatCostPerUnit takes an already-formatted cost string rather than raw cents, deliberately:
// this package's own test runner (node --experimental-strip-types) and apps/web's tsc build
// disagree on which extension a same-package cross-file import needs ('.ts' vs no extension vs
// '.js'), so money.ts's formatCents is left to each caller to invoke directly instead.
export interface QuantityUnit { abbreviation: string }

// Trims trailing zeros from a decimal quantity without ever going scientific-notation or
// swallowing a meaningful fraction -- "50" stays "50", "2.50" becomes "2.5", "2.505" stays as-is
// (Postgres numeric already arrives as a decimal string, not a float, so precision loss isn't a
// concern here).
export function formatQuantityNumber(quantity: number | string): string {
  const value = typeof quantity === 'string' ? quantity : String(quantity)
  if (!value.includes('.')) return value
  return value.replace(/0+$/, '').replace(/\.$/, '')
}

export function formatQuantity(quantity: number | string, unit: QuantityUnit): string {
  return `${formatQuantityNumber(quantity)} ${unit.abbreviation}`
}

export function formatCostPerUnit(formattedCost: string, unit: QuantityUnit): string {
  return `${formattedCost} / ${unit.abbreviation}`
}
