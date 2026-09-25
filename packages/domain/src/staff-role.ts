// Shared staff-role contract, same reasoning as order-type.ts: every screen or route that checks
// a terminal employee's role imports this instead of declaring its own string union or its own
// capability list, so a new role or a permission change is a one-file edit, not a hunt across
// every screen. `manager` is a superset of every capability by convention (checked separately,
// not listed per-capability below) -- it is the only role a manager-PIN-approval evidence check
// (discountNeedsManagerApproval, inventory writes, etc.) ever accepts, unaffected by this file.
export type StaffRole = 'cashier' | 'manager' | 'waiter' | 'chef' | 'inventory_manager' | 'rider'

export const STAFF_ROLES: readonly StaffRole[] = ['cashier', 'manager', 'waiter', 'chef', 'inventory_manager', 'rider']

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  cashier: 'Cashier',
  manager: 'Manager',
  waiter: 'Waiter',
  chef: 'Chef',
  inventory_manager: 'Inventory Manager',
  rider: 'Rider',
}

/**
 * A capability a terminal screen or route requires. `manager` always has every capability;
 * every other role has exactly the ones listed for it below. This is a starting, deliberately
 * small matrix -- rider has no dedicated screen yet (see docs/day-plans/day5.md), so it's listed
 * with no capabilities beyond logging in; extend this file, not a per-screen role check, when
 * that changes.
 */
export type StaffCapability = 'register' | 'floor' | 'kitchen' | 'inventory' | 'staff'

const ROLE_CAPABILITIES: Record<Exclude<StaffRole, 'manager'>, readonly StaffCapability[]> = {
  cashier: ['register'],
  waiter: ['register', 'floor'],
  chef: ['kitchen'],
  inventory_manager: ['inventory'],
  rider: [],
}

export function roleHasCapability(role: StaffRole, capability: StaffCapability): boolean {
  return role === 'manager' || ROLE_CAPABILITIES[role].includes(capability)
}
