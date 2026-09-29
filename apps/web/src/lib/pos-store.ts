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

export interface SelectedModifier {
  groupId: string
  optionId: string
  groupName: string
  optionName: string
  priceDeltaCents: number
}

// Where a line's discount came from — a manual cashier discount has no source. A reward or
// promotion still produces a plain LineDiscount (Day 4 checkout wiring: both flow through the
// exact same discount/approval machinery as a manual one), but the cart needs to remember which
// one so the UI can label it honestly and, for a reward, so checkout.ts knows which reward_rule to
// tell the server to deduct points for. Deliberately not part of cartSignature/manager-approval
// evidence: the *amount* the source produced is what matters for money math, not its label.
export type DiscountSource =
  | { kind: 'reward'; ruleId: string; ruleName: string; pointsCost: number }
  | { kind: 'promotion'; promotionId: string; name: string }
  | null

export interface CartItem {
  lineId: string
  storeId: string
  productId: string
  name: string
  sku: string
  unitPriceCents: number     // integer cents
  basePriceCents: number
  modifiers: SelectedModifier[]
  taxRateBps: number
  catalogVersion: number
  quantity: number
  discount: LineDiscount
  discountSource?: DiscountSource
  // A free-text kitchen note ("no onions", "extra spicy"). Local/cart state only, same
  // convention as orderType below — no order_items column exists yet to persist it against,
  // and it deliberately isn't part of cartSignature since it doesn't affect money math or
  // require re-approval. Wiring it into checkout is Day 2, once kitchen tickets exist to carry it.
  notes?: string
  // Sellable combos (Ahmad's A4 work): present only when this line is a combo, one entry per
  // selected component. checkout.ts threads this straight through to the server as
  // `combo_selection` -- the server re-validates it against the real catalog and expands it into
  // the actual component order-item rows; the client never invents the expansion itself.
  comboSelection?: { groupId: string; componentProductId: string; priceDeltaCents: number }[]
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
  return JSON.stringify(items.map(item => [item.lineId, item.productId, item.quantity, item.unitPriceCents, item.taxRateBps, item.discount,
    item.modifiers.map(modifier => modifier.optionId)]))
}

// Product IDs whose current discount exceeds the cashier's 20% independent authority and
// therefore requires a current manager approval before checkout can proceed.
export function productsRequiringApproval(items: CartItem[]): string[] {
  return items.filter(item => {
    if (!item.discount) return false
    const line = calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount)
    return discountNeedsManagerApproval(line.subtotalCents, line.discountAppliedCents)
  }).map(item => item.lineId)
}

// True when a recorded manager approval still matches the exact cart and permission version
// it was granted for. Any cart edit (or a permission-version change) invalidates it.
export function approvalIsCurrent(approval: ManagerApproval | null, items: CartItem[], permissionVersion: number): boolean {
  return Boolean(approval) && approval!.permissionVersion === permissionVersion && approval!.cartSignature === cartSignature(items)
}

// At most one reward can be redeemed per check (reward_rules has no multi-redemption concept) —
// this is what checkout.ts reads to tell the server which reward_rule to deduct points for.
export function redeemedReward(items: CartItem[]): Extract<DiscountSource, { kind: 'reward' }> | null {
  for (const item of items) if (item.discountSource?.kind === 'reward') return item.discountSource
  return null
}

export type SyncStatus = 'idle' | 'syncing' | 'error'

export interface PosStore {
  // Store context (set on register boot)
  storeId: string
  storeName: string
  setStoreContext: (storeId: string, storeName: string) => void

  // The restaurant table the current register cart belongs to, set by the Floor screen's "Add
  // order" action (Day 2 table lifecycle — the one shared touch-point between the two Day 2
  // branches). Only meaningful while orderType is 'dine_in'; checkout.ts reads both together and
  // never sends a table_id for a non-dine-in order. Cleared on clearCart (a new check starts with
  // no table) and on an actual store-context change; a future payment/settlement integration can
  // clear it too once that flow exists.
  activeTableId: string | null
  setActiveTableId: (tableId: string | null) => void

  // The open check (lib/open-checks.ts) this cart is currently resuming, if any — null for an
  // ordinary walk-up sale. Set by loadCheckIntoCart when a held check is resumed from the Open
  // Checks screen, or right after a fresh check is created by "Hold." activeCheckVersion is the
  // optimistic-concurrency token the next save/close must send back; cleared together with the
  // cart (clearCart) since a cleared cart has nothing left to hold a check open for.
  activeCheckId: string | null
  activeCheckVersion: number | null
  setActiveCheck: (checkId: string | null, version: number | null) => void
  // Populates the cart from a resumed (or freshly created) open check — the one place a cart gets
  // built from something other than the cashier tapping menu items one at a time.
  loadCheckIntoCart: (params: { checkId: string; version: number; orderType: OrderType; tableId: string | null; customer: LocalCustomer | null; items: CartItem[] }) => void

  // Cart
  items: CartItem[]
  addItem: (product: Omit<CartItem, 'quantity' | 'discount'>) => void
  removeItem: (lineId: string) => void
  incrementItem: (lineId: string) => void
  decrementItem: (lineId: string) => void
  clearCart: () => void
  setItemNote: (lineId: string, notes: string) => void
  setItemModifiers: (lineId: string, nextLineId: string, modifiers: SelectedModifier[], unitPriceCents: number) => void
  selectedCustomer: LocalCustomer | null
  selectCustomer: (customer: LocalCustomer | null) => void

  // Dine-In / Takeaway / Delivery (Restaurant POS Transformation Blueprint, docs/09, Section 2).
  // Local/UI state only today — no orders column exists yet to persist it against (Day 2 work).
  orderType: OrderType
  setOrderType: (orderType: OrderType) => void

  // Line discounts (FEAT-CART-02) and the manager evidence that authorizes them (FEAT-AUTH-02).
  // Any cart mutation above clears managerApproval; setLineDiscount does too, since it changes the signature.
  // A manual discount (setLineDiscount) always clears any reward/promotion source that line had —
  // typing a new amount over a redeemed reward means the cashier is replacing it, not stacking it.
  setLineDiscount: (lineId: string, discount: LineDiscount) => void
  applyRewardDiscount: (lineId: string, source: Extract<DiscountSource, { kind: 'reward' }>, discount: LineDiscount) => void
  applyPromotionDiscount: (lineId: string, source: Extract<DiscountSource, { kind: 'promotion' }>, discount: LineDiscount) => void
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

  activeCheckId: null,
  activeCheckVersion: null,
  setActiveCheck: (checkId, version) => set({ activeCheckId: checkId, activeCheckVersion: version }),
  loadCheckIntoCart: ({ checkId, version, orderType, tableId, customer, items }) => set({
    activeCheckId: checkId, activeCheckVersion: version, orderType, activeTableId: tableId,
    selectedCustomer: customer, items, managerApproval: null,
  }),

  items: [],
  selectedCustomer: null,
  selectCustomer: customer => set({ selectedCustomer: customer }),

  orderType: 'dine_in',
  setOrderType: orderType => set({ orderType }),

  addItem: (product) =>
    set((state) => {
      const existing = state.items.find((i) => i.lineId === product.lineId)
      if (existing) {
        return {
          items: state.items.map((i) =>
            i.lineId === product.lineId
              ? { ...i, quantity: Math.min(10_000, i.quantity + 1) }
              : i,
          ),
          managerApproval: null,
        }
      }
      return { items: [...state.items, { ...product, quantity: 1, discount: null }], managerApproval: null }
    }),

  removeItem: (lineId) =>
    set((state) => ({ items: state.items.filter((i) => i.lineId !== lineId), managerApproval: null })),

  incrementItem: (lineId) =>
    set((state) => ({
      items: state.items.map((i) =>
        i.lineId === lineId ? { ...i, quantity: Math.min(10_000, i.quantity + 1) } : i,
      ),
      managerApproval: null,
    })),

  decrementItem: (lineId) =>
    set((state) => {
      const item = state.items.find((i) => i.lineId === lineId)
      if (!item) return state
      if (item.quantity <= 1) {
        return { items: state.items.filter((i) => i.lineId !== lineId), managerApproval: null }
      }
      return {
        items: state.items.map((i) =>
          i.lineId === lineId ? { ...i, quantity: i.quantity - 1 } : i,
        ),
        managerApproval: null,
      }
    }),

  clearCart: () => set({ items: [], selectedCustomer: null, managerApproval: null, orderType: 'dine_in', activeTableId: null, activeCheckId: null, activeCheckVersion: null }),

  // Notes don't affect totals or approval — no managerApproval invalidation needed here, unlike
  // every money-affecting mutation above.
  setItemNote: (lineId, notes) =>
    set((state) => ({ items: state.items.map((i) => i.lineId === lineId ? { ...i, notes } : i) })),

  setItemModifiers: (lineId, nextLineId, modifiers, unitPriceCents) =>
    set((state) => ({ items: state.items.map((i) => i.lineId === lineId ? { ...i, lineId: nextLineId, modifiers, unitPriceCents } : i), managerApproval: null })),

  setLineDiscount: (lineId, discount) =>
    set((state) => ({
      items: state.items.map((i) => i.lineId === lineId ? { ...i, discount, discountSource: null } : i),
      managerApproval: null,
    })),

  applyRewardDiscount: (lineId, source, discount) =>
    set((state) => ({
      // Only one line may redeem a reward at a time — applying a new one anywhere first clears
      // whichever line was carrying the previous one, matching reward_rules' single-redemption-
      // per-check design (redeemedReward() above assumes at most one).
      items: state.items.map((i) => {
        if (i.lineId === lineId) return { ...i, discount, discountSource: source }
        if (i.discountSource?.kind === 'reward') return { ...i, discount: null, discountSource: null }
        return i
      }),
      managerApproval: null,
    })),

  applyPromotionDiscount: (lineId, source, discount) =>
    set((state) => ({
      items: state.items.map((i) => i.lineId === lineId ? { ...i, discount, discountSource: source } : i),
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
