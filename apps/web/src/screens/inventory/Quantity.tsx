import { formatQuantityNumber } from '../../../../../packages/domain/src/inventory-quantity'
import type { RecipeUnit } from '../menu/recipe-draft'

// A quantity's number and its unit read as one blurred string ("91 1", "93 1 -> 91 1") when
// they're just plain text at the same size and weight -- especially once the unit itself is a
// short, numeral-like abbreviation. This renders the number as the headline and the unit as a
// small, muted, uppercase tag next to it, so "what is that second number" stops being a question
// no matter what the unit's abbreviation happens to be. Every quantity in the Inventory module
// (ingredient list, stock/cost metric cards, batch cards, the activity ledger) renders through
// this instead of formatQuantity()'s plain string, so the number/unit split stays consistent.
export function Quantity({ value, unit }: { value: number | string; unit?: RecipeUnit }) {
  return <span className="qty">
    {formatQuantityNumber(value)}
    {unit && <span className="qty-unit">{unit.abbreviation}</span>}
  </span>
}
