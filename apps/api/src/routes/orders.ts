import { createHash, randomUUID } from 'node:crypto'
import { Router } from 'express'
import { db } from '../db.js'
import { ApiError, requireStoreMember, requireStoreManager, sendApiError } from './auth.js'
import { boundedInteger, calculateDiscountedLine, calculateServiceCharge, discountNeedsManagerApproval, MAX_CENTS, sumDiscountedLines, type LineDiscount } from '../../../../packages/domain/src/money.js'
import { ORDER_TYPES, type OrderType } from '../../../../packages/domain/src/order-type.js'
import { BASE_MULTIPLIER_BPS, pointsEarned, tierForLifetimePoints } from '../../../../packages/domain/src/loyalty.js'
import { requireCashierTerminal, requireDeviceTerminal } from '../terminal-auth/routes.js'
import { createDeliveryOrderSnapshot, deliveryDetailsBody } from './delivery.js'
import { firesImmediately, type Course } from '../../../../packages/domain/src/course.js'
import { DEFAULT_PREP_TARGET_SECONDS } from '../../../../packages/domain/src/kitchen-sla.js'
import { deriveTicketStatus } from '../../../../packages/domain/src/kitchen-ticket-status.js'

export const ordersRouter = Router()
export const terminalOrdersRouter = Router()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
type JsonRecord = Record<string, unknown>
function record(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(422, 'validation_failed', `${name} is required.`)
  return value as JsonRecord
}
function text(value: unknown, name: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(422, 'validation_failed', `${name} is invalid.`)
  return value
}
function id(value: unknown, name: string): string {
  const result = text(value, name, 36)
  if (!uuid.test(result)) throw new ApiError(422, 'validation_failed', `${name} must be a UUID.`)
  return result
}
function cents(value: unknown, name: string, max = MAX_CENTS): number {
  try { return boundedInteger(value as number, name, 0, max) }
  catch { throw new ApiError(422, 'validation_failed', `${name} must be valid integer cents.`) }
}
function timestamp(value: unknown, name: string): string {
  const result = text(value, name, 40)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new ApiError(422, 'validation_failed', `${name} must be a valid UTC timestamp.`)
  }
  return result
}
// Absent means 'dine_in' — the DB column defaults the same way, so an offline sale queued in a
// cashier's outbox before this field existed still validates and syncs unchanged (Restaurant POS
// Transformation Blueprint, docs/09, Day 2).
function orderTypeValue(value: unknown): OrderType {
  if (value === null || value === undefined) return 'dine_in'
  if (typeof value !== 'string' || !ORDER_TYPES.includes(value as OrderType)) throw new ApiError(422, 'validation_failed', 'Order type is invalid.')
  return value as OrderType
}
// Day 4 checkout wiring: a cart may redeem one reward rule against the guest's loyalty account,
// converting it to a LineDiscount on a line client-side (Ahmed's redemptionValue) exactly like a
// manual discount. This is the API's own record of *which* rule to deduct points for -- the line
// discount amount itself is trusted the same way any other line discount already is (the server
// checks the arithmetic totals, not the "why" behind a given cent amount).
function parseLoyaltyRedemption(body: JsonRecord, customerId: string | null): { rewardRuleId: string } | null {
  const raw = body.loyalty_redemption
  if (raw === null || raw === undefined) return null
  const redemption = record(raw, 'Loyalty redemption')
  if (!customerId) throw new ApiError(422, 'validation_failed', 'Loyalty redemption requires a guest on this sale.')
  return { rewardRuleId: id(redemption.reward_rule_id, 'Reward rule ID') }
}

// A line may send discount_kind/discount_value together, or omit both for no discount.
function parseDiscount(item: JsonRecord, label: string): LineDiscount {
  const kind = item.discount_kind
  if (kind === null || kind === undefined) {
    if (item.discount_value !== null && item.discount_value !== undefined) throw new ApiError(422, 'validation_failed', `${label} discount value must be empty when no discount is applied.`)
    return null
  }
  if (kind !== 'percent' && kind !== 'fixed') throw new ApiError(422, 'validation_failed', `${label} discount kind is invalid.`)
  if (!Number.isSafeInteger(item.discount_value) || (item.discount_value as number) < 0) throw new ApiError(422, 'validation_failed', `${label} discount value is invalid.`)
  return kind === 'percent' ? { kind: 'percent', bps: item.discount_value as number } : { kind: 'fixed', cents: item.discount_value as number }
}

function parseItemModifiers(item: JsonRecord, label: string) {
  const raw = item.modifiers
  if (raw === undefined || raw === null) return { supplied: false, rows: [] as { option_id: string; group_name: string; option_name: string; price_delta_cents: number }[] }
  if (!Array.isArray(raw) || raw.length > 50) throw new ApiError(422, 'validation_failed', `${label} modifiers are invalid.`)
  const rows = raw.map((value, index) => {
    const modifier = record(value, `${label} modifier ${index + 1}`)
    const delta = modifier.price_delta_cents
    if (!Number.isSafeInteger(delta) || (delta as number) < -MAX_CENTS || (delta as number) > MAX_CENTS) throw new ApiError(422, 'validation_failed', `${label} modifier price is invalid.`)
    return { option_id: id(modifier.option_id, 'Modifier option ID'), group_name: text(modifier.group_name, 'Modifier group', 60),
      option_name: text(modifier.option_name, 'Modifier option', 60), price_delta_cents: delta as number }
  })
  if (new Set(rows.map(row => row.option_id)).size !== rows.length) throw new ApiError(422, 'validation_failed', `${label} contains a duplicate modifier option.`)
  return { supplied: true, rows }
}

// A2 (split settlement): a sale may carry either the original singular `payment` field (kept
// working byte-for-byte for anyone not splitting — see parsePayments below) or a new `payments`
// array for a cash+card split, an itemized split, or a per-seat split. Tips travel per-tender,
// separate from the taxable sale amount, exactly like an external card reference already did.
export interface ParsedPayment { id: string; method: 'cash' | 'card'; amount_cents: number; tendered_cents: number; change_cents: number; tip_cents: number; reference: string | null }

function parseSinglePayment(payment: JsonRecord, label: string): ParsedPayment {
  const method = payment.method
  if (method !== 'cash' && method !== 'card') throw new ApiError(422, 'validation_failed', `${label} method is invalid.`)
  const amount = cents(payment.amount_cents, `${label} amount`)
  const tendered = cents(payment.tendered_cents, `${label} tendered amount`)
  const change = cents(payment.change_cents, `${label} change amount`)
  const tip = payment.tip_cents === undefined || payment.tip_cents === null ? 0 : cents(payment.tip_cents, `${label} tip`)
  if (amount === 0 && tip > 0) throw new ApiError(422, 'validation_failed', 'A tip must belong to a positive sale allocation.')
  if ((method === 'cash' && tendered !== amount + tip + change) || (method === 'card' && (tendered !== amount + tip || change !== 0))) {
    throw new ApiError(422, 'total_mismatch', `${label} does not balance.`)
  }
  return { id: id(payment.id, `${label} ID`), method, amount_cents: amount, tendered_cents: tendered, change_cents: change, tip_cents: tip,
    reference: payment.reference === null || payment.reference === undefined ? null : text(payment.reference, `${label} reference`, 120) }
}

// Every tender's amount_cents must sum to exactly grandTotalCents -- tips are excluded from this
// equality on purpose (FEAT-A2: tips are explicit, separate from taxable sales/service charge),
// so a cash+card split with tips on top still has to add up to the bill itself, cent for cent.
export function parsePayments(body: JsonRecord, grandTotalCents: number): ParsedPayment[] {
  const rawList = body.payments
  const rawSingle = body.payment
  if (rawList !== undefined && rawSingle !== undefined) throw new ApiError(422, 'validation_failed', 'Send either payment or payments, not both.')
  if (rawList !== undefined && !Array.isArray(rawList)) throw new ApiError(422, 'validation_failed', 'Payments must be a list.')
  let payments: ParsedPayment[]
  if (Array.isArray(rawList)) {
    if (rawList.length < 1 || rawList.length > 20) throw new ApiError(422, 'validation_failed', 'A sale needs 1 to 20 tenders.')
    payments = rawList.map((raw, index) => parseSinglePayment(record(raw, `Tender ${index + 1}`), `Tender ${index + 1}`))
  } else {
    payments = [parseSinglePayment(record(rawSingle, 'Payment'), 'Payment')]
  }
  if (new Set(payments.map(entry => entry.id)).size !== payments.length) throw new ApiError(422, 'validation_failed', 'Tender IDs must be unique.')
  const amountSum = payments.reduce((sum, entry) => sum + entry.amount_cents, 0)
  if (amountSum !== grandTotalCents) throw new ApiError(422, 'total_mismatch', 'Payments do not balance with the order.')
  return payments
}

export function validateOperation(raw: unknown) {
  const body = record(raw, 'Operation')
  const order = record(body.order, 'Order')
  const items = body.items
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) throw new ApiError(422, 'validation_failed', 'An order needs 1 to 100 items.')
  const storeId = id(order.store_id, 'Store ID')
  const customerId = order.customer_id === null || order.customer_id === undefined ? null : id(order.customer_id, 'Customer ID')
  const operationId = id(body.operation_id, 'Operation ID')
  if (operationId !== id(order.id, 'Order ID')) throw new ApiError(422, 'validation_failed', 'Order ID must match operation ID.')
  const parsedItems = items.map((rawItem, index) => {
    const item = record(rawItem, `Item ${index + 1}`)
    if (!Number.isSafeInteger(item.catalog_version) || (item.catalog_version as number) < 1 || (item.catalog_version as number) > MAX_CENTS) {
      throw new ApiError(422, 'validation_failed', `Item ${index + 1} catalog version is invalid.`)
    }
    const price = cents(item.snapshot_price_cents, 'Unit price')
    const modifiers = parseItemModifiers(item, `Item ${index + 1}`)
    const basePrice = item.base_price_cents === undefined || item.base_price_cents === null ? price : cents(item.base_price_cents, 'Base price')
    const modifierPrice = modifiers.rows.reduce((sum, modifier) => sum + modifier.price_delta_cents, 0)
    if (!Number.isSafeInteger(basePrice + modifierPrice) || basePrice + modifierPrice !== price) {
      throw new ApiError(422, 'total_mismatch', `Item ${index + 1} modifier prices do not match its unit price.`)
    }
    const discount = parseDiscount(item, `Item ${index + 1}`)
    let line: ReturnType<typeof calculateDiscountedLine>
    try { line = calculateDiscountedLine(price, item.quantity as number, item.snapshot_tax_bps as number, discount) }
    catch { throw new ApiError(422, 'validation_failed', `Item ${index + 1} has invalid quantity, tax, discount or amount.`) }
    if (line.subtotalCents !== item.subtotal_cents || line.discountAppliedCents !== item.discount_applied_cents ||
        line.taxableCents !== item.taxable_cents || line.taxCents !== item.tax_cents || line.totalCents !== item.total_cents) {
      throw new ApiError(422, 'total_mismatch', `Item ${index + 1} totals do not match.`)
    }
    return { id: id(item.id, 'Item ID'), product_id: id(item.product_id, 'Product ID'),
      snapshot_name: text(item.snapshot_name, 'Item name'), snapshot_sku: text(item.snapshot_sku, 'Item SKU', 80),
      snapshot_price_cents: price, base_price_cents: basePrice, modifiers: modifiers.rows, modifiers_supplied: modifiers.supplied,
      snapshot_tax_bps: item.snapshot_tax_bps as number,
      catalog_version: item.catalog_version as number, quantity: item.quantity as number,
      discount_kind: discount?.kind ?? null, discount_value: discount ? (discount.kind === 'percent' ? discount.bps : discount.cents) : null,
      subtotal_cents: line.subtotalCents, discount_applied_cents: line.discountAppliedCents,
      taxable_cents: line.taxableCents, tax_cents: line.taxCents, total_cents: line.totalCents }
  })
  if (new Set(parsedItems.map(item => item.id)).size !== parsedItems.length) {
    throw new ApiError(422, 'validation_failed', 'Item IDs must be unique within a sale.')
  }
  let totals: ReturnType<typeof sumDiscountedLines>
  try {
    totals = sumDiscountedLines(parsedItems.map(item => ({ subtotalCents: item.subtotal_cents, discountAppliedCents: item.discount_applied_cents,
      taxableCents: item.taxable_cents, taxCents: item.tax_cents, totalCents: item.total_cents })))
  } catch { throw new ApiError(422, 'total_mismatch', 'Order exceeds the supported money range.') }
  if (totals.subtotalCents !== order.subtotal_cents || totals.discountCents !== order.discount_cents ||
      totals.taxCents !== order.tax_cents) {
    throw new ApiError(422, 'total_mismatch', 'Order totals do not match line totals.')
  }
  // service_charge_bps travels with the order the same way each item snapshots its own tax_bps --
  // it's the rate that was in effect on the store when this sale was rung up, not whatever the
  // store's live setting happens to be by the time an offline sale eventually syncs. The server
  // only re-derives the resulting cents from that snapshotted rate, exactly as it re-derives tax.
  if (!Number.isSafeInteger(order.service_charge_bps) || (order.service_charge_bps as number) < 0 || (order.service_charge_bps as number) > 10_000) {
    throw new ApiError(422, 'validation_failed', 'service_charge_bps is invalid.')
  }
  const serviceChargeCents = calculateServiceCharge(totals.subtotalCents - totals.discountCents, order.service_charge_bps as number)
  if (serviceChargeCents !== order.service_charge_cents || totals.totalCents + serviceChargeCents !== order.total_cents) {
    throw new ApiError(422, 'total_mismatch', 'Order totals do not match line totals.')
  }
  const grandTotalCents = totals.totalCents + serviceChargeCents
  const parsedOrderType = orderTypeValue(order.order_type)
  const tableId = order.table_id === null || order.table_id === undefined ? null : id(order.table_id, 'Table ID')
  if (tableId && parsedOrderType !== 'dine_in') throw new ApiError(422, 'validation_failed', 'A table can only be set for a dine-in order.')
  // Delivery orders snapshot their recipient/contact/address/instructions at checkout time (see
  // delivery.ts's createDeliveryOrderSnapshot) -- required exactly when order_type is 'delivery',
  // rejected otherwise, same "field only makes sense for its own order type" rule as table_id
  // above.
  const deliveryDetails = parsedOrderType === 'delivery' ? deliveryDetailsBody(record(order.delivery, 'Delivery details')) : null
  if (parsedOrderType !== 'delivery' && order.delivery !== undefined && order.delivery !== null) {
    throw new ApiError(422, 'validation_failed', 'Delivery details can only be set for a delivery order.')
  }
  const employeeId = order.employee_id === null || order.employee_id === undefined ? null : id(order.employee_id, 'Employee ID')
  const managerId = order.manager_id === null || order.manager_id === undefined ? null : id(order.manager_id, 'Manager ID')
  const managerApprovedAt = order.manager_approved_at === null || order.manager_approved_at === undefined ? null : timestamp(order.manager_approved_at, 'Manager approval time')
  if ((managerId === null) !== (managerApprovedAt === null)) throw new ApiError(422, 'validation_failed', 'Manager approval evidence is incomplete.')
  const needsApproval = parsedItems.some(item => discountNeedsManagerApproval(item.subtotal_cents, item.discount_applied_cents))
  if (needsApproval && managerId === null) throw new ApiError(422, 'validation_failed', 'A discount on this sale requires manager approval.')
  const payments = parsePayments(body, grandTotalCents)
  const generatedAt = timestamp(order.client_generated_at, 'Sale time')
  if (!Number.isSafeInteger(order.catalog_version) || (order.catalog_version as number) < 1 || (order.catalog_version as number) > MAX_CENTS) {
    throw new ApiError(422, 'validation_failed', 'Catalog version is invalid.')
  }
  return { operationId, storeId, items: parsedItems, totals: { ...totals, totalCents: grandTotalCents }, serviceChargeCents,
    loyaltyRedemption: parseLoyaltyRedemption(body, customerId),
    deliveryDetails,
    order: { customer_id: customerId, receipt_number: text(order.receipt_number, 'Receipt number', 100),
      catalog_version: order.catalog_version as number, order_type: parsedOrderType, table_id: tableId,
      client_generated_at: generatedAt, employee_id: employeeId, manager_id: managerId, manager_approved_at: managerApprovedAt },
    payments }
}

export type ValidatedOperation = ReturnType<typeof validateOperation>

// The core "turn a validated operation into a real paid sale" transaction body: order + items +
// modifiers, kitchen ticket (fired straight to preparing), payment, loyalty redeem/earn, stock
// decrement, change feed, and the operation-ledger row that makes replays idempotent. Shared by
// push() (a client-built cart, items supplied in the request) and open-checks.ts's close endpoint
// (an already-durable, server-stored check, items read from open_check_items) so both paths create
// a sale through exactly the same code -- an open check becomes a real order the same way a normal
// register sale always has, never a parallel, only-partially-equivalent implementation of it.
// Caller is responsible for the operation-ledger replay check (see push() below) and for holding
// this all inside a single `client` transaction that it begins/commits/rolls back itself.
export async function createPaidOrder(client: import('pg').PoolClient, operation: ValidatedOperation, payloadHash: string) {
      const store = await client.query('select name,timezone,currency from public.stores where id=$1', [operation.storeId])
      if (!store.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Store no longer exists.')
      const productIds = [...new Set(operation.items.map(item => item.product_id))]
      const products = await client.query<{ id: string; station_id: string | null; course: Course | null; prep_time_seconds: number | null }>(
        'select id, station_id, course, prep_time_seconds from public.pos_products where store_id=$1 and id = any($2::uuid[])', [operation.storeId, productIds])
      if (products.rowCount !== productIds.length) throw new ApiError(422, 'cross_store_reference', 'An item refers to a product outside this store.')
      const stationByProduct = new Map(products.rows.map(row => [row.id, row.station_id]))
      const courseByProduct = new Map(products.rows.map(row => [row.id, row.course]))
      const prepTimeByProduct = new Map(products.rows.map(row => [row.id, row.prep_time_seconds]))
      const modifierCatalog = await client.query<{ product_id: string; group_id: string; group_name: string; selection: 'single' | 'multi'; required: boolean; option_id: string | null }>(
        `select pmg.product_id, mg.id as group_id, mg.name as group_name, mg.selection, mg.required, mo.id as option_id
         from public.product_modifier_groups pmg
         join public.modifier_groups mg on mg.store_id=pmg.store_id and mg.id=pmg.group_id
         left join public.modifier_options mo on mo.store_id=mg.store_id and mo.group_id=mg.id
         where pmg.store_id=$1 and pmg.product_id=any($2::uuid[])`,
        [operation.storeId, productIds],
      )
      for (const item of operation.items) {
        if (!item.modifiers_supplied) continue // compatibility for sales queued before modifiers existed
        const catalogRows = modifierCatalog.rows.filter(row => row.product_id === item.product_id)
        const optionToGroup = new Map(catalogRows.filter(row => row.option_id).map(row => [row.option_id as string, row]))
        const selectedCounts = new Map<string, number>()
        for (const modifier of item.modifiers) {
          const catalog = optionToGroup.get(modifier.option_id)
          if (!catalog) throw new ApiError(422, 'validation_failed', `${item.snapshot_name} has a modifier that is not attached to this dish.`)
          if (catalog.group_name !== modifier.group_name) throw new ApiError(422, 'validation_failed', `${item.snapshot_name} modifier group snapshot is invalid.`)
          selectedCounts.set(catalog.group_id, (selectedCounts.get(catalog.group_id) ?? 0) + 1)
        }
        const groups = new Map(catalogRows.map(row => [row.group_id, row]))
        for (const group of groups.values()) {
          const count = selectedCounts.get(group.group_id) ?? 0
          if (group.required && count === 0) throw new ApiError(422, 'validation_failed', `${item.snapshot_name} requires a ${group.group_name} selection.`)
          if (group.selection === 'single' && count > 1) throw new ApiError(422, 'validation_failed', `${item.snapshot_name} allows only one ${group.group_name} selection.`)
        }
      }
      if (operation.order.customer_id) {
        const customer = await client.query('select 1 from public.pos_customers where store_id=$1 and id=$2', [operation.storeId, operation.order.customer_id])
        if (!customer.rowCount) {
          // Customer was rejected or not yet synced — accept the order without the customer link
          // rather than blocking this paid sale from syncing permanently.
          // The local Dexie record retains the customer reference for the cashier's view.
          operation.order.customer_id = null
        }
      }
      if (operation.order.employee_id) {
        const employee = await client.query('select 1 from public.terminal_employees where store_id=$1 and id=$2', [operation.storeId, operation.order.employee_id])
        if (!employee.rowCount) {
          // Employee record was removed or never synced — accept the order without cashier
          // attribution rather than blocking this paid sale from syncing permanently.
          operation.order.employee_id = null
        }
      }
      if (operation.order.table_id) {
        const table = await client.query('select 1 from public.restaurant_tables where store_id=$1 and id=$2', [operation.storeId, operation.order.table_id])
        if (!table.rowCount) {
          // Table was deleted or never synced — accept the order without the table link rather
          // than blocking this paid sale from syncing permanently, same as customer_id/employee_id
          // above. The kitchen ticket below still gets created; it just has no table reference.
          operation.order.table_id = null
        }
      }
      if (operation.order.manager_id) {
        const manager = await client.query(
          "select 1 from public.terminal_employees where store_id=$1 and id=$2 and role='manager' and active=true",
          [operation.storeId, operation.order.manager_id])
        if (!manager.rowCount) throw new ApiError(422, 'validation_failed', 'Manager approval references an employee who is not an active manager for this store.')
      }
      await client.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,service_charge_cents,total_cents,catalog_version,client_generated_at,customer_id,employee_id,manager_id,manager_approved_at,
        order_type,table_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [operation.operationId, operation.storeId, operation.order.receipt_number, store.rows[0].currency,
          store.rows[0].name, store.rows[0].timezone, operation.totals.subtotalCents, operation.totals.discountCents, operation.totals.taxCents,
          operation.serviceChargeCents, operation.totals.totalCents, operation.order.catalog_version, operation.order.client_generated_at, operation.order.customer_id,
          operation.order.employee_id, operation.order.manager_id, operation.order.manager_approved_at,
          operation.order.order_type, operation.order.table_id])
      if (operation.deliveryDetails) {
        await createDeliveryOrderSnapshot(client, {
          storeId: operation.storeId, orderId: operation.operationId,
          recipientName: operation.deliveryDetails.recipientName, contactPhone: operation.deliveryDetails.contactPhone,
          address: operation.deliveryDetails.address, instructions: operation.deliveryDetails.instructions,
        })
      }
      for (const item of operation.items) {
        await client.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
          snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,discount_kind,discount_value,
          subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [item.id, operation.storeId, operation.operationId, item.product_id, item.snapshot_name, item.snapshot_sku,
            item.snapshot_price_cents, item.snapshot_tax_bps, item.catalog_version, item.quantity, item.discount_kind, item.discount_value,
            item.subtotal_cents, item.discount_applied_cents, item.taxable_cents, item.tax_cents, item.total_cents])
        for (const modifier of item.modifiers) {
          await client.query(
            `insert into public.pos_order_item_modifiers(store_id,order_item_id,snapshot_group_name,snapshot_option_name,price_delta_cents)
             values ($1,$2,$3,$4,$5)`,
            [operation.storeId, item.id, modifier.group_name, modifier.option_name, modifier.price_delta_cents],
          )
        }
      }
      // Kitchen ticket — one per order, one item per order line, each tagged with its product's
      // kitchen station (Day 1's pos_products.station_id, nullable). Created for every order type,
      // not just dine-in — takeaway and delivery still need the kitchen to prep the food; only
      // table_id is dine-in-only. (docs/09, Day 2, Ahmed section 3.)
      //
      // Course-based firing (A3): an item whose product has no course set fires straight to
      // 'preparing' exactly as every item always has -- a completed, paid order is definitionally
      // ready for the kitchen to start on immediately, so this is unchanged for the entire existing
      // population of products with no course configured. Only appetizer/side/beverage keep firing
      // immediately when a course *is* set; main/dessert start 'queued', held for an explicit
      // "fire this course" action (kitchen.ts's fireCourse) once the rest of the table is ready for
      // them. Each item snapshots its course and preparation-time target at creation time (never a
      // live re-join to pos_products), so a later recipe/menu edit can't rewrite an in-flight
      // ticket's SLA clock or which course it belongs to.
      const ticketId = randomUUID()
      const itemInitialState = operation.items.map(item => {
        const course = courseByProduct.get(item.product_id) ?? null
        const immediate = firesImmediately(course)
        return { item, course, prepTarget: prepTimeByProduct.get(item.product_id) ?? DEFAULT_PREP_TARGET_SECONDS, immediate }
      })
      const ticketStatus = deriveTicketStatus(itemInitialState.map(entry => entry.immediate ? 'preparing' : 'queued'))
      await client.query(`insert into public.kitchen_tickets(id,store_id,order_id,table_id,status) values ($1,$2,$3,$4,$5)`,
        [ticketId, operation.storeId, operation.operationId, operation.order.table_id, ticketStatus])
      for (const entry of itemInitialState) {
        await client.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,station_id,status,fired_at,course,prep_time_target_seconds)
          values ($1,$2,$3,$4,$5,$6,${entry.immediate ? 'now()' : 'null'},$7,$8)`,
          [randomUUID(), operation.storeId, ticketId, entry.item.id, stationByProduct.get(entry.item.product_id) ?? null,
            entry.immediate ? 'preparing' : 'queued', entry.course, entry.prepTarget])
      }
      // A2: one row per tender (cash+card split, itemized, per-seat, or simply the one payment a
      // non-splitting sale has always had) -- every tender shares this order's client_generated_at
      // (the sale happened at one moment; only the money collecting it was possibly divided).
      for (const payment of operation.payments) {
        await client.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,tip_cents,reference,client_generated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [payment.id, operation.storeId, operation.operationId,
            payment.method, payment.amount_cents, payment.tendered_cents,
            payment.change_cents, payment.tip_cents, payment.reference, operation.order.client_generated_at])
      }
      // Loyalty (Day 4 checkout wiring): redeem first, then award. Both are silent no-ops for a
      // guest with no loyalty_accounts row (opt-in enrollment, Ahmed's Day 4 decision) -- this
      // sale completes exactly the same either way, it just doesn't touch the loyalty tables.
      // Idempotent for free: this whole block only ever runs once per operation_id, since a
      // retried/replayed sync already returned early against pos_operation_ledger above.
      if (operation.order.customer_id) {
        const account = await client.query<{ id: string; points_balance: number; lifetime_points: number }>(
          'select id, points_balance, lifetime_points from public.loyalty_accounts where store_id=$1 and customer_id=$2',
          [operation.storeId, operation.order.customer_id])
        if (account.rows[0]) {
          const { id: accountId, points_balance: balance, lifetime_points: lifetimePoints } = account.rows[0]
          let balanceDelta = 0
          if (operation.loyaltyRedemption) {
            const rule = await client.query<{ points_cost: number }>(
              'select points_cost from public.reward_rules where store_id=$1 and id=$2 and active=true',
              [operation.storeId, operation.loyaltyRedemption.rewardRuleId])
            if (rule.rows[0]) {
              // Clamped to whatever balance is actually available, never blocking the sale: this
              // device may have queued the sale while offline, so the balance it saw when the
              // reward was picked in the cart can be stale by the time this finally syncs. The
              // discount was already given and the guest already left with their order --
              // reversing a completed, paid sale over a stale points balance would be worse than
              // deducting fewer points than the reward technically cost (same reasoning as
              // oversold stock elsewhere in this file).
              const deduct = Math.min(rule.rows[0].points_cost, balance)
              if (deduct > 0) {
                await client.query(`insert into public.loyalty_point_ledger(store_id,account_id,delta,reason,order_id)
                  values ($1,$2,$3,'redeemed',$4)`, [operation.storeId, accountId, -deduct, operation.operationId])
                balanceDelta -= deduct
              }
            }
          }
          // Tier is computed from lifetime_points *before* this order's own points are added
          // (Ahmed's PR description), falling back to the base 1x rate when no tier qualifies —
          // e.g. no tiers configured yet for this store.
          const tiers = await client.query<{ min_lifetime_points: number; point_multiplier_bps: number }>(
            'select min_lifetime_points, point_multiplier_bps from public.loyalty_tiers where store_id=$1 order by min_lifetime_points asc, name asc',
            [operation.storeId])
          const tier = tierForLifetimePoints(lifetimePoints, tiers.rows.map(row => ({ minLifetimePoints: row.min_lifetime_points, multiplierBps: row.point_multiplier_bps })))
          const earned = pointsEarned(operation.totals.totalCents, tier ? tier.multiplierBps : BASE_MULTIPLIER_BPS)
          if (earned > 0) {
            await client.query(`insert into public.loyalty_point_ledger(store_id,account_id,delta,reason,order_id)
              values ($1,$2,$3,'earned',$4)`, [operation.storeId, accountId, earned, operation.operationId])
            balanceDelta += earned
          }
          if (balanceDelta !== 0 || earned > 0) {
            await client.query('update public.loyalty_accounts set points_balance=points_balance+$2, lifetime_points=lifetime_points+$3 where id=$1',
              [accountId, balanceDelta, earned])
          }
        }
      }
      let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [operation.storeId])).rows[0].last_position)
      for (const productId of productIds) {
        const quantity = operation.items.filter(item => item.product_id === productId).reduce((sum, item) => sum + item.quantity, 0)
        await client.query(`insert into public.pos_inventory_movements(store_id,product_id,order_id,operation_id,delta,reason)
          values ($1,$2,$3,$4,$5,'sale')`, [operation.storeId, productId, operation.operationId, operation.operationId, -quantity])
        const stock = await client.query(`update public.pos_stock set current_stock=current_stock-$3, updated_at=now()
          where store_id=$1 and product_id=$2 returning current_stock`, [operation.storeId, productId, quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
          values ($1,$2,'stock',$3,$4)`, [operation.storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
      }
      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'order',$3,$4)`, [operation.storeId, position.toString(), operation.operationId, { receipt_number: operation.order.receipt_number }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [operation.storeId, position.toString()])
      const result = { status: 'accepted', operation_id: operation.operationId, accepted_checkpoint: position.toString() }
      await client.query(`insert into public.pos_operation_ledger(store_id,operation_id,payload_hash,status,result_json,accepted_checkpoint)
        values ($1,$2,$3,'accepted',$4,$5)`, [operation.storeId, operation.operationId, payloadHash, result, position.toString()])
      return result
}

async function push(req: import('express').Request, res: import('express').Response, terminal = false) {
  try {
    const operation = validateOperation(req.body)
    if (terminal) {
      const session = await requireDeviceTerminal(req, db)
      if (session.storeId !== operation.storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
      // Prefer the currently authenticated cashier's identity over whatever the client sent, so a
      // sale can't be attributed to a different employee than the one actually unlocked on this
      // device. A device-only session (queued sale synced after logout) has no cashier to check
      // against, so it falls back to the client-sent value's best-effort existence check below.
      try { operation.order.employee_id = (await requireCashierTerminal(req, db)).employeeId }
      catch { /* no active cashier session on this device right now */ }
    } else await requireStoreMember(req, operation.storeId)
    const hash = createHash('sha256').update(JSON.stringify(req.body)).digest('hex')
    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [operation.storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id = $1 for update', [operation.storeId])
      const replay = await client.query('select payload_hash,result_json from public.pos_operation_ledger where store_id=$1 and operation_id=$2', [operation.storeId, operation.operationId])
      if (replay.rows[0]) {
        if (replay.rows[0].payload_hash !== hash) throw new ApiError(409, 'operation_id_conflict', 'This operation ID was used for another sale.')
        await client.query('commit')
        res.json(replay.rows[0].result_json)
        return
      }
      const result = await createPaidOrder(client, operation, hash)
      await client.query('commit')
      res.json(result)
    } catch (reason) { await client.query('rollback'); throw reason }
    finally { client.release() }
  } catch (reason) { sendApiError(res, reason) }
}
// ---------------------------------------------------------------------------
// POST /orders/:id/refund — owner/manager full or partial refund, allocated back to the
// original tenders (A2: refund allocation). Money-correctness code: held to the same review bar
// as checkout itself (validateOperation above). The original pos_orders/pos_order_items/
// pos_payments rows are never touched; every refund is its own append-only record, per
// docs/04_er_diagrams.md:98's suggested shape (reference the sale through order_id, the return
// through a separate refund_id — never the other way around) — now extended so more than one
// refund can exist per order (a partial return today, another line next week), each one an
// explicit record of exactly which quantities and which tenders it covers.
//
// `items` and `tenders` are both optional. Omitting `items` refunds everything still
// outstanding on every line (identical dollar result to the old whole-order-only endpoint on a
// fresh order, and "refund what's left" on a partially-refunded one). Omitting `tenders`
// auto-allocates the computed refund amount across the order's original payments, oldest first,
// up to each one's remaining refundable balance — the only possible allocation for an order that
// never split its payment, so a non-splitting caller's request body and result are unchanged.
// ---------------------------------------------------------------------------
interface RefundItemRequest { order_item_id: string; quantity: number }
interface RefundTenderRequest { payment_id: string; amount_cents: number; tip_cents?: number }

export function parseRefundItems(raw: unknown): RefundItemRequest[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new ApiError(422, 'validation_failed', 'items must be a non-empty list.')
  const rows = raw.map((entry, index) => {
    const row = record(entry, `items[${index}]`)
    const quantity = row.quantity
    if (!Number.isSafeInteger(quantity) || (quantity as number) <= 0) throw new ApiError(422, 'validation_failed', `items[${index}].quantity must be a positive integer.`)
    return { order_item_id: id(row.order_item_id, `items[${index}].order_item_id`), quantity: quantity as number }
  })
  if (new Set(rows.map(row => row.order_item_id)).size !== rows.length) throw new ApiError(422, 'validation_failed', 'Refund item IDs must be unique.')
  return rows
}
export function parseRefundTenders(raw: unknown): RefundTenderRequest[] | null {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new ApiError(422, 'validation_failed', 'tenders must be a non-empty list.')
  const rows = raw.map((entry, index) => {
    const row = record(entry, `tenders[${index}]`)
    return { payment_id: id(row.payment_id, `tenders[${index}].payment_id`), amount_cents: cents(row.amount_cents, `tenders[${index}].amount_cents`) }
  })
  if (new Set(rows.map(row => row.payment_id)).size !== rows.length) throw new ApiError(422, 'validation_failed', 'Refund tender IDs must be unique.')
  if (rows.some(row => row.amount_cents === 0)) throw new ApiError(422, 'validation_failed', 'Refund tender amounts must be positive.')
  return rows
}

async function refund(req: import('express').Request, res: import('express').Response) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const body = record(req.body, 'Refund')
    const storeId = id(body.store_id, 'Store ID')
    const userId = await requireStoreManager(req, storeId)
    res.status(201).json(await refundOrderCore(storeId, orderId, userId, body))
  } catch (reason) { sendApiError(res, reason) }
}

export async function refundOrderCore(storeId: string, orderId: string, userId: string, body: JsonRecord) {
    const reason = body.reason === null || body.reason === undefined || body.reason === ''
      ? null : text(body.reason, 'Refund reason', 240)
    const operationId = body.operation_id === undefined ? null : id(body.operation_id, 'Refund operation ID')
    const payloadHash = createHash('sha256').update(JSON.stringify({ orderId, storeId, reason, items: body.items ?? null, tenders: body.tenders ?? null })).digest('hex')
    const requestedItems = parseRefundItems(body.items)
    const requestedTenders = parseRefundTenders(body.tenders)

    const client = await db.connect()
    try {
      await client.query('begin')
      await client.query('insert into public.pos_sync_feed_state(store_id) values ($1) on conflict do nothing', [storeId])
      await client.query('select last_position from public.pos_sync_feed_state where store_id=$1 for update', [storeId])

      if (operationId) {
        const replay = await client.query('select * from public.pos_refunds where store_id=$1 and operation_id=$2', [storeId, operationId])
        if (replay.rows[0]) {
          if (replay.rows[0].payload_hash !== payloadHash) throw new ApiError(409, 'operation_id_conflict', 'Refund operation was used for another request.')
          const tenders = await client.query('select payment_id, amount_cents::text, tip_cents::text from public.pos_refund_tenders where store_id=$1 and refund_id=$2', [storeId, replay.rows[0].id])
          await client.query('commit')
          return { refund: replay.rows[0], tenders: tenders.rows }
        }
      }
      const orderRes = await client.query<{ id: string; total_cents: string; service_charge_cents: string }>(
        'select id, total_cents::text as total_cents, service_charge_cents::text from public.pos_orders where store_id=$1 and id=$2',
        [storeId, orderId],
      )
      if (!orderRes.rows[0]) throw new ApiError(404, 'not_found', 'Order not found.')

      const itemsRes = await client.query<{ id: string; product_id: string; quantity: number; total_cents: string; tax_cents: string }>(
        'select id, product_id, quantity, total_cents::text as total_cents, tax_cents::text from public.pos_order_items where store_id=$1 and order_id=$2',
        [storeId, orderId],
      )
      if (!itemsRes.rowCount) throw new ApiError(422, 'validation_failed', 'Order has no line items to refund.')

      // Prior refunds against this same order, per line item -- what's actually still refundable.
      const priorRes = await client.query<{ order_item_id: string; refunded_quantity: string; refunded_amount_cents: string }>(
        `select order_item_id, sum(quantity)::text as refunded_quantity, sum(amount_cents)::text as refunded_amount_cents
         from public.pos_refund_items where store_id=$1 and refund_id in (select id from public.pos_refunds where store_id=$1 and order_id=$2)
         group by order_item_id`,
        [storeId, orderId],
      )
      const priorByItem = new Map(priorRes.rows.map(row => [row.order_item_id, { quantity: Number(row.refunded_quantity), amount: Number(row.refunded_amount_cents) }]))

      const remaining = itemsRes.rows.map(item => {
        const prior = priorByItem.get(item.id) ?? { quantity: 0, amount: 0 }
        return { id: item.id, product_id: item.product_id, remainingQuantity: item.quantity - prior.quantity, remainingAmountCents: Number(item.total_cents) - prior.amount }
      })
      const remainingById = new Map(remaining.map(item => [item.id, item]))

      const targets = requestedItems ?? remaining.filter(item => item.remainingQuantity > 0).map(item => ({ order_item_id: item.id, quantity: item.remainingQuantity }))
      if (!targets.length) throw new ApiError(409, 'refund_conflict', 'This order has already been fully refunded.')

      const refundItems = targets.map(target => {
        const item = remainingById.get(target.order_item_id)
        if (!item) throw new ApiError(422, 'validation_failed', `${target.order_item_id} is not a line item on this order.`)
        if (target.quantity > item.remainingQuantity) throw new ApiError(409, 'refund_conflict', `Only ${item.remainingQuantity} of this line remains refundable.`)
        // Exact remaining amount when refunding everything left on the line (no rounding drift
        // across repeated partial refunds); otherwise proportional to the remaining amount/quantity.
        const original = itemsRes.rows.find(row => row.id === target.order_item_id)!
        const priorQuantity = original.quantity - item.remainingQuantity
        const roundShare = (value: number, quantity: number) => Number((BigInt(value) * BigInt(quantity) * 2n + BigInt(original.quantity)) / (2n * BigInt(original.quantity)))
        const amount = target.quantity === item.remainingQuantity ? item.remainingAmountCents
          : roundShare(Number(original.total_cents), priorQuantity + target.quantity) - roundShare(Number(original.total_cents), priorQuantity)
        const tax = roundShare(Number(original.tax_cents), priorQuantity + target.quantity) - roundShare(Number(original.tax_cents), priorQuantity)
        return { order_item_id: target.order_item_id, product_id: item.product_id, quantity: target.quantity, amount_cents: amount, tax_cents: tax }
      })
      const lineRefundCents = refundItems.reduce((sum, item) => sum + item.amount_cents, 0)
      const originalLines = itemsRes.rows.reduce((sum, item) => sum + Number(item.total_cents), 0)
      const priorLines = priorRes.rows.reduce((sum, item) => sum + Number(item.refunded_amount_cents), 0)
      const service = Number(orderRes.rows[0].service_charge_cents)
      const serviceShare = (value: number) => originalLines === 0 ? 0 : Number((BigInt(service) * BigInt(value) * 2n + BigInt(originalLines)) / (2n * BigInt(originalLines)))
      const serviceRefundCents = serviceShare(priorLines + lineRefundCents) - serviceShare(priorLines)
      const taxRefundCents = refundItems.reduce((sum, item) => sum + item.tax_cents, 0)
      const refundAmountCents = lineRefundCents + serviceRefundCents
      if (refundAmountCents <= 0) throw new ApiError(422, 'validation_failed', 'This refund has no amount.')

      // Lock the order's payments and compute each one's remaining refundable balance under that
      // lock, so two concurrent refunds against the same tender can never both think their
      // allocation fits.
      const paymentsRes = await client.query<{ id: string; amount_cents: string; tip_cents: string }>(
        'select id, amount_cents::text as amount_cents, tip_cents::text from public.pos_payments where store_id=$1 and order_id=$2 order by server_received_at, id for update',
        [storeId, orderId],
      )
      if (!paymentsRes.rowCount) throw new ApiError(422, 'validation_failed', 'Order has no recorded payment to refund against.')
      const priorTendersRes = await client.query<{ payment_id: string; refunded_amount_cents: string; refunded_tip_cents: string }>(
        `select payment_id, sum(amount_cents)::text as refunded_amount_cents, sum(tip_cents)::text as refunded_tip_cents from public.pos_refund_tenders
         where store_id=$1 and payment_id = any($2::uuid[]) group by payment_id`,
        [storeId, paymentsRes.rows.map(row => row.id)],
      )
      const priorTenderByPayment = new Map(priorTendersRes.rows.map(row => [row.payment_id, Number(row.refunded_amount_cents)]))
      const paymentBalances = paymentsRes.rows.map(row => ({ id: row.id, remaining: Number(row.amount_cents) - (priorTenderByPayment.get(row.id) ?? 0) }))
      const balanceById = new Map(paymentBalances.map(row => [row.id, row.remaining]))

      let tenderAllocations: RefundTenderRequest[]
      if (requestedTenders) {
        if (requestedTenders.reduce((sum, tender) => sum + tender.amount_cents, 0) !== refundAmountCents) {
          throw new ApiError(422, 'total_mismatch', 'Tender allocations must sum to the refund amount.')
        }
        for (const tender of requestedTenders) {
          const balance = balanceById.get(tender.payment_id)
          if (balance === undefined) throw new ApiError(422, 'validation_failed', `${tender.payment_id} is not a payment on this order.`)
          if (tender.amount_cents > balance) throw new ApiError(409, 'refund_conflict', `Only ${balance} cents remain refundable on this tender.`)
        }
        tenderAllocations = requestedTenders
      } else {
        tenderAllocations = []
        let remainingToAllocate = refundAmountCents
        for (const payment of paymentBalances) {
          if (remainingToAllocate <= 0) break
          const take = Math.min(payment.remaining, remainingToAllocate)
          if (take > 0) { tenderAllocations.push({ payment_id: payment.id, amount_cents: take }); remainingToAllocate -= take }
        }
        if (remainingToAllocate > 0) throw new ApiError(409, 'refund_conflict', 'This order\'s tenders do not have enough remaining balance to cover this refund.')
      }

      // Refund each original tender's tip in proportion to its cumulative refunded sale amount.
      // Cumulative integer rounding ensures the last partial refund returns every tip cent.
      for (const allocation of tenderAllocations) {
        const payment = paymentsRes.rows.find(row => row.id === allocation.payment_id)!
        const prior = priorTendersRes.rows.find(row => row.payment_id === allocation.payment_id)
        const refundedSale = (priorTenderByPayment.get(payment.id) ?? 0) + allocation.amount_cents
        const denominator = BigInt(payment.amount_cents)
        const cumulativeTip = denominator === 0n ? 0 : Number((BigInt(payment.tip_cents) * BigInt(refundedSale) * 2n + denominator) / (2n * denominator))
        allocation.tip_cents = cumulativeTip - Number(prior?.refunded_tip_cents ?? 0)
      }
      const tipRefundCents = tenderAllocations.reduce((sum, allocation) => sum + (allocation.tip_cents ?? 0), 0)
      const refundRes = await client.query<{ id: string; store_id: string; order_id: string; amount_cents: string; reason: string | null; refunded_by: string; created_at: string }>(
        `insert into public.pos_refunds (store_id, order_id, amount_cents, reason, refunded_by, operation_id, payload_hash, service_charge_cents, tax_cents, merchandise_cents, tip_cents)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id, store_id, order_id, amount_cents::text as amount_cents, reason, refunded_by, created_at`,
        [storeId, orderId, refundAmountCents, reason, userId, operationId, payloadHash, serviceRefundCents, taxRefundCents, lineRefundCents - taxRefundCents, tipRefundCents],
      )
      const refundRow = refundRes.rows[0]

      for (const item of refundItems) {
        await client.query(
          `insert into public.pos_refund_items (store_id, refund_id, order_item_id, product_id, quantity, amount_cents)
           values ($1,$2,$3,$4,$5,$6)`,
          [storeId, refundRow.id, item.order_item_id, item.product_id, item.quantity, item.amount_cents],
        )
      }
      for (const tender of tenderAllocations) {
        await client.query(
          `insert into public.pos_refund_tenders (store_id, refund_id, payment_id, amount_cents, tip_cents) values ($1,$2,$3,$4,$5)`,
          [storeId, refundRow.id, tender.payment_id, tender.amount_cents, tender.tip_cents ?? 0],
        )
      }

      // Reverse stock once per distinct product (checkout already merges same-product cart lines,
      // but this groups defensively rather than assuming that holds for every historical order).
      const byProduct = new Map<string, number>()
      for (const item of refundItems) byProduct.set(item.product_id, (byProduct.get(item.product_id) ?? 0) + item.quantity)

      let position = BigInt((await client.query('select last_position::text from public.pos_sync_feed_state where store_id=$1', [storeId])).rows[0].last_position)
      for (const [productId, quantity] of byProduct) {
        await client.query(
          `insert into public.pos_inventory_movements (store_id, product_id, order_id, operation_id, delta, reason)
           values ($1,$2,$3,gen_random_uuid(),$4,'refund')`,
          [storeId, productId, orderId, quantity],
        )
        const stock = await client.query(`update public.pos_stock set current_stock=current_stock+$3, updated_at=now()
          where store_id=$1 and product_id=$2 returning current_stock`, [storeId, productId, quantity])
        if (!stock.rows[0]) throw new ApiError(422, 'cross_store_reference', 'Stock projection is missing for a refunded product.')
        position += 1n
        await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
          values ($1,$2,'stock',$3,$4)`, [storeId, position.toString(), productId, { product_id: productId, current_stock: stock.rows[0].current_stock }])
      }

      position += 1n
      await client.query(`insert into public.pos_change_feed(store_id,position,entity_type,entity_id,payload)
        values ($1,$2,'refund',$3,$4)`, [storeId, position.toString(), refundRow.id, { order_id: orderId, refund_id: refundRow.id, amount_cents: refundAmountCents }])
      await client.query('update public.pos_sync_feed_state set last_position=$2 where store_id=$1', [storeId, position.toString()])

      await client.query('commit')
      return { refund: refundRow, tenders: tenderAllocations }
    } catch (reason2) {
      await client.query('rollback')
      throw reason2
    } finally {
      client.release()
    }
}

// ---------------------------------------------------------------------------
// GET /orders/:id — server-backed order/receipt detail, so a manager (or, on the terminal
// router, any unlocked cashier terminal in this store) can view or reprint a check that was
// closed on a *different* device. Every historical sale already exists server-side (push()
// above wrote it); the local Dexie receipt reader was previously the only way to view one,
// which meant a receipt was only visible on the exact device that rang it up. Reads only the
// snapshot fields captured at checkout time -- never the live catalog -- same "never
// reconstruct a historical sale" rule receipts/data.ts documents for the local read path.
// ---------------------------------------------------------------------------
async function orderDetail(req: import('express').Request, res: import('express').Response, terminal = false) {
  try {
    const orderId = id(req.params.id, 'Order ID')
    const storeId = id(String(req.query.store_id ?? ''), 'Store ID')
    if (terminal) {
      const session = await requireCashierTerminal(req, db)
      if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    } else {
      await requireStoreManager(req, storeId)
    }
    const orderRes = await db.query(
      `select id, store_id, receipt_number, subtotal_cents::text, discount_cents::text, tax_cents::text,
              service_charge_cents::text, total_cents::text, catalog_version, client_generated_at,
              currency, store_name_snapshot, timezone_snapshot, customer_id, employee_id, manager_id,
              manager_approved_at, order_type, table_id
       from public.pos_orders where store_id=$1 and id=$2`,
      [storeId, orderId],
    )
    const order = orderRes.rows[0]
    if (!order) throw new ApiError(404, 'not_found', 'Order not found in this store.')
    const [items, modifiers, paymentRes, customerRes, refundSummary] = await Promise.all([
      db.query(
        `select id, product_id, snapshot_name, snapshot_sku, snapshot_price_cents::text, snapshot_tax_bps,
                catalog_version, quantity, discount_kind, discount_value, subtotal_cents::text,
                discount_applied_cents::text, taxable_cents::text, tax_cents::text, total_cents::text
         from public.pos_order_items where store_id=$1 and order_id=$2 order by id`,
        [storeId, orderId],
      ),
      db.query(
        `select oim.order_item_id, oim.snapshot_group_name, oim.snapshot_option_name, oim.price_delta_cents
         from public.pos_order_item_modifiers oim
         join public.pos_order_items oi on oi.store_id=oim.store_id and oi.id=oim.order_item_id
         where oim.store_id=$1 and oi.order_id=$2`,
        [storeId, orderId],
      ),
      db.query(
        `select id, method, amount_cents::text, tendered_cents::text, change_cents::text, tip_cents::text, reference,
           (select coalesce(sum(rt.amount_cents),0)::text from public.pos_refund_tenders rt where rt.store_id=p.store_id and rt.payment_id=p.id) as refunded_amount_cents,
           (select coalesce(sum(rt.tip_cents),0)::text from public.pos_refund_tenders rt where rt.store_id=p.store_id and rt.payment_id=p.id) as refunded_tip_cents
         from public.pos_payments p where store_id=$1 and order_id=$2 order by server_received_at, id`,
        [storeId, orderId],
      ),
      order.customer_id
        ? db.query('select id, name, phone_normalized from public.pos_customers where store_id=$1 and id=$2', [storeId, order.customer_id])
        : Promise.resolve({ rows: [] as unknown[] }),
      db.query(`select max(created_at) as refunded_at, coalesce(sum(amount_cents),0)::text as refunded_amount_cents,
        coalesce(sum(tax_cents),0)::text as refunded_tax_cents, coalesce(sum(tip_cents),0)::text as refunded_tip_cents, coalesce(sum(merchandise_cents),0)::text as refunded_merchandise_cents
        from public.pos_refunds where store_id=$1 and order_id=$2`, [storeId, orderId]),
    ])
    const modifiersByItem = new Map<string, unknown[]>()
    for (const modifier of modifiers.rows as { order_item_id: string; snapshot_group_name: string; snapshot_option_name: string; price_delta_cents: number }[]) {
      const list = modifiersByItem.get(modifier.order_item_id) ?? []
      list.push({ group_name: modifier.snapshot_group_name, option_name: modifier.snapshot_option_name, price_delta_cents: modifier.price_delta_cents })
      modifiersByItem.set(modifier.order_item_id, list)
    }
    res.json({
      order: { ...order, ...refundSummary.rows[0], refunded_amount_cents: Number(refundSummary.rows[0].refunded_amount_cents),
        refunded_tax_cents: Number(refundSummary.rows[0].refunded_tax_cents), refunded_tip_cents: Number(refundSummary.rows[0].refunded_tip_cents), refunded_merchandise_cents: Number(refundSummary.rows[0].refunded_merchandise_cents),
        subtotal_cents: Number(order.subtotal_cents), discount_cents: Number(order.discount_cents),
        tax_cents: Number(order.tax_cents), service_charge_cents: Number(order.service_charge_cents), total_cents: Number(order.total_cents) },
      items: (items.rows as Record<string, unknown>[]).map(item => ({ ...item,
        snapshot_price_cents: Number(item.snapshot_price_cents), subtotal_cents: Number(item.subtotal_cents),
        discount_applied_cents: Number(item.discount_applied_cents), taxable_cents: Number(item.taxable_cents),
        tax_cents: Number(item.tax_cents), total_cents: Number(item.total_cents), modifiers: modifiersByItem.get(item.id as string) ?? [] })),
      payments: (paymentRes.rows as Record<string, unknown>[]).map(payment => ({ ...payment, amount_cents: Number(payment.amount_cents),
        tendered_cents: Number(payment.tendered_cents), change_cents: Number(payment.change_cents), tip_cents: Number(payment.tip_cents), refunded_amount_cents: Number(payment.refunded_amount_cents), refunded_tip_cents: Number(payment.refunded_tip_cents) })),
      customer: customerRes.rows[0] ?? null,
    })
  } catch (reason) { sendApiError(res, reason) }
}

ordersRouter.post('/push', (req, res) => void push(req, res))
terminalOrdersRouter.post('/push', (req, res) => void push(req, res, true))
ordersRouter.post('/:id/refund', (req, res) => void refund(req, res))
ordersRouter.get('/:id', (req, res) => void orderDetail(req, res))
terminalOrdersRouter.get('/:id', (req, res) => void orderDetail(req, res, true))
