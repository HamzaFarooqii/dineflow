/**
 * apps/web/src/lib/pos-store.ts
 *
 * Zustand cart store for the POS register.
 * Holds the current cart, store context, and sync state.
 * All monetary values are integer cents — never float.
 */
import { create } from 'zustand'
import { calculateDiscountedLine, discountNeedsManagerApproval, sumDiscountedLines, type LineDiscount } from '../../../../packages/domain/src/money'
import type { OrderType } from '../../../../packages/domain/src/order-type'
import type { LocalCustomer } from './db'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { LineDiscount }

export interface CartItem {
  storeId: string
  productId: string
  name: string
  sku: string
  unitPriceCents: number     // integer cents
  taxRateBps: number
  catalogVersion: number
  quantity: number
  discount: LineDiscount
}

export interface CartTotals {
  subtotalCents: number
  discountCents: number
  taxCents: number
  totalCents: number
}

// Evidence that a manager authorized the cart's current discounts. Bound to an exact cart
// signature and permission version (docs/05_product_requirements.md, Manager modal — FEAT-AUTH-02):
// any cart edit changes the signature and silently invalidates the approval.
export interface ManagerApproval {
  managerId: string
  managerName: string
  approvedAt: string
  permissionVersion: number
  cartSignature: string
}

// A stable fingerprint of every line that affects money math. Two carts with the same
// signature produce the same totals and the same manager-approval requirement.
export function cartSignature(items: CartItem[]): string {
  return JSON.stringify(items.map(item => [item.productId, item.quantity, item.unitPriceCents, item.taxRateBps, item.discount]))
}

// Product IDs whose current discount exceeds the cashier's 20% independent authority and
// therefore requires a current manager approval before checkout can proceed.
export function productsRequiringApproval(items: CartItem[]): string[] {
  return items.filter(item => {
    if (!item.discount) return false
    const line = calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount)
    return discountNeedsManagerApproval(line.subtotalCents, line.discountAppliedCents)
  }).map(item => item.productId)
}

// True when a recorded manager approval still matches the exact cart and permission version
// it was granted for. Any cart edit (or a permission-version change) invalidates it.
export function approvalIsCurrent(approval: ManagerApproval | null, items: CartItem[], permissionVersion: number): boolean {
  return Boolean(approval) && approval!.permissionVersion === permissionVersion && approval!.cartSignature === cartSignature(items)
}

export type SyncStatus = 'idle' | 'syncing' | 'error'

export interface PosStore {
  // Store context (set on register boot)
  storeId: string
  storeName: string
  setStoreContext: (storeId: string, storeName: string) => void

  // The restaurant table the current register cart belongs to, set by the Floor screen's "Add
  // order" action (Day 2 table lifecycle). Cleared when its table finishes the dirty -> available
  // cleaning cycle, or when the store context actually changes. The correct long-term clearing
  // point is a successful bill_requested -> dirty settlement, once payment integration owns that
  // transition (apps/web/src/screens/floor/FloorScreen.tsx does not trigger it today) — that's a
  // follow-up for whoever builds checkout's table linkage, not implemented here.
  activeTableId: string | null
  setActiveTableId: (tableId: string | null) => void

  // Cart
  items: CartItem[]
  addItem: (product: Omit<CartItem, 'quantity' | 'discount'>) => void
  removeItem: (productId: string) => void
  incrementItem: (productId: string) => void
  decrementItem: (productId: string) => void
  clearCart: () => void
  selectedCustomer: LocalCustomer | null
  selectCustomer: (customer: LocalCustomer | null) => void

  // Dine-In / Takeaway / Delivery (Restaurant POS Transformation Blueprint, docs/09, Section 2).
  // Local/UI state only today — no orders column exists yet to persist it against (Day 2 work).
  orderType: OrderType
  setOrderType: (orderType: OrderType) => void

  // Line discounts (FEAT-CART-02) and the manager evidence that authorizes them (FEAT-AUTH-02).
  // Any cart mutation above clears managerApproval; setLineDiscount does too, since it changes the signature.
  setLineDiscount: (productId: string, discount: LineDiscount) => void
  managerApproval: ManagerApproval | null
  setManagerApproval: (approval: ManagerApproval) => void
  clearManagerApproval: () => void

  // Totals (derived)
  totals: () => CartTotals

  // Sync status
  syncStatus: SyncStatus
  setSyncStatus: (status: SyncStatus) => void
  catalogStatus: 'unknown' | 'ready' | 'unavailable'
  setCatalogStatus: (status: 'unknown' | 'ready' | 'unavailable') => void
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const usePosStore = create<PosStore>((set, get) => ({
  storeId: '',
  storeName: '',
  setStoreContext: (storeId, storeName) => set(state => ({
    storeId, storeName,
    items: state.storeId && state.storeId !== storeId ? [] : state.items,
    selectedCustomer: state.storeId && state.storeId !== storeId ? null : state.selectedCustomer,
    activeTableId: state.storeId && state.storeId !== storeId ? null : state.activeTableId,
  })),

  activeTableId: null,
  setActiveTableId: tableId => set({ activeTableId: tableId }),

  items: [],
  selectedCustomer: null,
  selectCustomer: customer => set({ selectedCustomer: customer }),

  orderType: 'dine_in',
  setOrderType: orderType => set({ orderType }),

  addItem: (product) =>
    set((state) => {
      const existing = state.items.find((i) => i.productId === product.productId)
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.productId === product.productId
              ? { ...i, quantity: Math.min(10_000, i.quantity + 1) }
              : i,
          ),
          managerApproval: null,
        }
      }
      return { items: [...state.items, { ...product, quantity: 1, discount: null }], managerApproval: null }
    }),

  removeItem: (productId) =>
    set((state) => ({ items: state.items.filter((i) => i.productId !== productId), managerApproval: null })),

  incrementItem: (productId) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.productId === productId ? { ...i, quantity: Math.min(10_000, i.quantity + 1) } : i,
      ),
      managerApproval: null,
    })),

  decrementItem: (productId) =>
    set((state) => {
      const item = state.items.find((i) => i.productId === productId)
      if (!item) return state
      if (item.quantity <= 1) {
        return { items: state.items.filter((i) => i.productId !== productId), managerApproval: null }
      }
      return {
        items: state.items.map((i) =>
          i.productId === productId ? { ...i, quantity: i.quantity - 1 } : i,
        ),
        managerApproval: null,
      }
    }),

  clearCart: () => set({ items: [], selectedCustomer: null, managerApproval: null, orderType: 'dine_in' }),

  setLineDiscount: (productId, discount) =>
    set((state) => ({
      items: state.items.map((i) => i.productId === productId ? { ...i, discount } : i),
      managerApproval: null,
    })),

  managerApproval: null,
  setManagerApproval: (approval) => set({ managerApproval: approval }),
  clearManagerApproval: () => set({ managerApproval: null }),

  totals: () => {
    const { items } = get()
    if (items.length === 0) {
      return { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 }
    }
    const lines = items.map((item) =>
      calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount),
    )
    return sumDiscountedLines(lines)
  },

  syncStatus: 'idle',
  setSyncStatus: (status) => set({ syncStatus: status }),
  catalogStatus: 'unknown',
  setCatalogStatus: (status) => set({ catalogStatus: status }),
}))
