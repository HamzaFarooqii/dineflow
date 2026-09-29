// Sellable combos (Ahmad's A4 work): a combo is a real pos_products row (so it appears in the
// existing menu grid/cart/checkout/KDS pipeline like any other dish) plus one or more selectable
// groups, each offering a choice of other real, already-sellable products as components. This is
// deliberately a *separate* structure from modifier_groups (packages/domain has no combo-specific
// money math of its own beyond what's here) -- a modifier option is a flat name + price delta with
// no product identity, so it can never drive stock consumption or its own kitchen routing the way
// a combo component (a real product with its own recipe and station) needs to.
// Deliberately no cross-file import here (see open-check.ts's header comment in this same
// package for why a real value-level import between domain files breaks the plain-node test
// runner while a `.ts`-extension workaround breaks apps/api's NodeNext build) -- the one bounds
// check this file needs is inlined rather than reusing money.ts's boundedInteger.
const MAX_CENTS = 1_000_000_000
function boundedCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CENTS) throw new Error(`${label} must be an integer between 0 and ${MAX_CENTS}.`)
  return value
}

export type ComboPricingMode = 'fixed' | 'derived'

export interface ComboGroupSpec {
  id: string
  minSelect: number
  maxSelect: number
}

// Every group's selection count must sit within its own [minSelect, maxSelect] bounds. Returns
// one human-readable error per violated group, empty when the whole selection is valid -- the API
// and the register's combo picker both call this exact function so client and server never
// disagree about what counts as a complete, valid selection.
export function validateComboSelection(groups: readonly ComboGroupSpec[], selectedCountByGroup: ReadonlyMap<string, number>): string[] {
  const errors: string[] = []
  for (const group of groups) {
    const count = selectedCountByGroup.get(group.id) ?? 0
    if (count < group.minSelect) errors.push(`Choose at least ${group.minSelect} option${group.minSelect === 1 ? '' : 's'}.`)
    else if (count > group.maxSelect) errors.push(`Choose at most ${group.maxSelect} option${group.maxSelect === 1 ? '' : 's'}.`)
  }
  return errors
}

export interface SelectedComboOption {
  priceDeltaCents: number
  // The component's own current unit price -- only actually used in 'derived' pricing mode; a
  // 'fixed'-mode combo ignores it entirely (the combo's own base price already covers the dish,
  // and a price_delta_cents on an option is purely an upsell on top of that fixed price).
  componentUnitPriceCents: number
}

// The combo's total unit price before tax/discount -- 'fixed' mode is the combo's own base price
// plus each selected option's upsell delta; 'derived' mode sums each selected component's own
// price plus its delta instead of using a base price at all (the combo IS the sum of its parts).
export function calculateComboPriceCents(pricingMode: ComboPricingMode, basePriceCents: number, selectedOptions: readonly SelectedComboOption[]): number {
  boundedCents(basePriceCents, 'Combo base price')
  const deltaTotal = selectedOptions.reduce((sum, option) => sum + option.priceDeltaCents, 0)
  if (pricingMode === 'fixed') return boundedCents(basePriceCents + deltaTotal, 'Combo price')
  const derivedTotal = selectedOptions.reduce((sum, option) => sum + option.componentUnitPriceCents + option.priceDeltaCents, 0)
  return boundedCents(derivedTotal, 'Combo price')
}
