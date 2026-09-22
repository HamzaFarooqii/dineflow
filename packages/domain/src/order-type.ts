// Restaurant POS Transformation Blueprint (docs/09) — shared order-type contract. Every
// screen that shows or sets an order's channel (POS, Floor, Kitchen, Reports) must import
// this instead of declaring its own string union, so "dine_in" vs "dine-in" vs "DineIn"
// never becomes a real bug between two developers' branches.
export type OrderType = 'dine_in' | 'takeaway' | 'delivery'

export const ORDER_TYPES: readonly OrderType[] = ['dine_in', 'takeaway', 'delivery']

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  dine_in: 'Dine-In',
  takeaway: 'Takeaway',
  delivery: 'Delivery',
}
