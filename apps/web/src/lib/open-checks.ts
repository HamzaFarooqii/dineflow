// Client for the open-checks API (apps/api/src/routes/open-checks.ts) -- a durable, server-owned
// running tab. Unlike the register's cart (pure local state until checkout) or a completed sale
// (local-first, outboxed), an open check is deliberately online-only: it exists to be resumed from
// *another* terminal, so its source of truth has to be the server, not this browser. If the
// network is down, create/edit/void/close simply fail with a clear message -- the same tradeoff
// Floor's table-status transitions already make (updateTableStatus in lib/floor.ts), not a new one.
import { accessToken, configuredApiUrl } from './catalog'
import type { OrderType } from '../../../../packages/domain/src/order-type'
import type { LineDiscount } from '../../../../packages/domain/src/money'
import { posDb, type LocalOrder, type LocalOrderItem, type LocalPayment } from './db'

export interface OpenCheckHeader {
  id: string; store_id: string; status: 'open' | 'closed' | 'voided'; order_type: OrderType
  table_id: string | null; table_label?: string | null; customer_id: string | null; employee_id: string | null
  manager_id: string | null; manager_approved_at: string | null; version: number
  subtotal_cents: number; discount_cents: number; tax_cents: number; service_charge_cents: number; total_cents: number
  notes: string | null; opened_at: string; updated_at: string; item_count?: number
}
export interface OpenCheckItemModifier { group_name: string; option_name: string; price_delta_cents: number }
export interface OpenCheckItem {
  id: string; product_id: string; snapshot_name: string; snapshot_sku: string; snapshot_price_cents: number
  snapshot_tax_bps: number; catalog_version: number; quantity: number
  discount_kind: 'percent' | 'fixed' | null; discount_value: number | null
  subtotal_cents: number; discount_applied_cents: number; taxable_cents: number; tax_cents: number; total_cents: number
  modifiers: OpenCheckItemModifier[]
}
export interface OpenCheckDetail { check: OpenCheckHeader; items: OpenCheckItem[] }

export class OpenCheckConflictError extends Error {
  constructor(message: string, public currentVersion?: number) { super(message) }
}

async function openChecksRequest<T>(path: string, method: string, storeId: string, body?: Record<string, unknown>, terminal = false): Promise<T> {
  // path may already carry its own query string (e.g. fetchOpenChecks's `?status=open`) -- split it
  // off and merge into one URLSearchParams instead of concatenating a second literal '?', which
  // produced an unparsable "...?status=open?store_id=..." URL and made store_id invisible server-side.
  const [routePath, existingQuery] = path.split('?')
  const query = new URLSearchParams(existingQuery)
  query.set('store_id', storeId)
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/open-checks' : '/open-checks'}${routePath}?${query}`, {
    method,
    credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    // The server's write handlers (create/edit/void/close) validate store_id from the JSON body,
    // the same convention orders.ts uses -- the query string alone (used by the GET handlers) isn't enough.
    body: body ? JSON.stringify({ store_id: storeId, ...body }) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string; code?: string; version?: number }
  if (!response.ok) {
    if (response.status === 409 && parsed.code === 'status_conflict') throw new OpenCheckConflictError(parsed.message ?? 'This check changed since it was last loaded.')
    throw new Error(parsed.message ?? `Request failed (${response.status}).`)
  }
  return parsed
}

export async function fetchOpenChecks(storeId: string, terminal = false, status: 'open' | 'closed' | 'voided' = 'open'): Promise<OpenCheckHeader[]> {
  const result = await openChecksRequest<{ checks: OpenCheckHeader[] }>(`?status=${status}`, 'GET', storeId, undefined, terminal)
  return result.checks ?? []
}
export async function fetchOpenCheck(storeId: string, checkId: string, terminal = false): Promise<OpenCheckDetail> {
  return openChecksRequest<OpenCheckDetail>(`/${checkId}`, 'GET', storeId, undefined, terminal)
}
export async function createOpenCheck(
  storeId: string,
  params: { orderType: OrderType; tableId: string | null; customerId: string | null; employeeId: string | null },
  terminal = false,
): Promise<OpenCheckDetail> {
  return openChecksRequest<OpenCheckDetail>('', 'POST', storeId, {
    order_type: params.orderType, table_id: params.tableId, customer_id: params.customerId, employee_id: params.employeeId,
  }, terminal)
}

export interface SaveCheckItem {
  id?: string; productId: string; snapshotName: string; snapshotSku: string; snapshotPriceCents: number
  snapshotTaxBps: number; catalogVersion: number; quantity: number; discount: LineDiscount
  modifiers: { optionId: string; groupName: string; optionName: string; priceDeltaCents: number }[]
}
export async function saveOpenCheck(
  storeId: string, checkId: string, expectedVersion: number, items: SaveCheckItem[], serviceChargeBps: number,
  options: { notes?: string | null; customerId?: string | null; managerId?: string | null; managerApprovedAt?: string | null } = {},
  terminal = false,
): Promise<OpenCheckDetail> {
  return openChecksRequest<OpenCheckDetail>(`/${checkId}`, 'PATCH', storeId, {
    expected_version: expectedVersion, service_charge_bps: serviceChargeBps,
    notes: options.notes ?? null, customer_id: options.customerId ?? null, manager_id: options.managerId ?? null, manager_approved_at: options.managerApprovedAt ?? null,
    items: items.map(item => ({
      id: item.id, product_id: item.productId, snapshot_name: item.snapshotName, snapshot_sku: item.snapshotSku,
      snapshot_price_cents: item.snapshotPriceCents, snapshot_tax_bps: item.snapshotTaxBps, catalog_version: item.catalogVersion,
      quantity: item.quantity, discount_kind: item.discount?.kind ?? null,
      discount_value: item.discount ? (item.discount.kind === 'percent' ? item.discount.bps : item.discount.cents) : null,
      modifiers: item.modifiers.map(modifier => ({ option_id: modifier.optionId, group_name: modifier.groupName, option_name: modifier.optionName, price_delta_cents: modifier.priceDeltaCents })),
    })),
  }, terminal)
}
export async function voidOpenCheck(storeId: string, checkId: string, expectedVersion: number, voidedByEmployeeId: string | null, terminal = false): Promise<{ status: string }> {
  return openChecksRequest(`/${checkId}/void`, 'POST', storeId, { expected_version: expectedVersion, voided_by_employee_id: voidedByEmployeeId }, terminal)
}

// Closes the check into a real paid order (the exact same server-side path as a normal register
// sale) and, on success, writes the resulting order/items/payment into local Dexie as already
// `synced` -- so the receipt screen can show it immediately, the same as any other completed sale,
// without waiting on the outbox (there is nothing to sync: the server already has it).
export async function closeOpenCheckAndRecordSale(
  storeId: string, checkId: string, expectedVersion: number,
  method: 'cash' | 'card', tenderedCents: number, reference: string | null,
  serviceChargeBps: number, catalogVersion: number, terminal = false,
): Promise<{ operationId: string; receiptNumber: string; totalCents: number }> {
  const operationId = crypto.randomUUID()
  const now = new Date().toISOString()
  const detail = await fetchOpenCheck(storeId, checkId, terminal)
  if (detail.check.status !== 'open') throw new Error(`This check is ${detail.check.status} and can no longer be closed.`)
  const grandTotalCents = detail.check.total_cents
  if (tenderedCents < grandTotalCents) throw new Error('Amount received must cover the sale.')
  const changeCents = method === 'cash' ? tenderedCents - grandTotalCents : 0

  const config = await posDb.store_config.get(storeId)
  if (!config) throw new Error('Store catalog has not been downloaded to this browser.')
  const prefixRow = await posDb.sync_metadata.get(`receipt_prefix:${storeId}`)
  const prefix = prefixRow?.value ?? `LOCAL-${crypto.randomUUID().toUpperCase()}-`
  const sequenceKey = `receipt_seq:${storeId}`
  let sequence = Number((await posDb.sync_metadata.get(sequenceKey))?.value ?? '0')
  let receiptNumber = ''
  do {
    sequence += 1
    if (!Number.isSafeInteger(sequence)) throw new Error('Receipt sequence is exhausted.')
    receiptNumber = `${prefix}${String(sequence).padStart(6, '0')}`
  } while (await posDb.orders.where('receipt_number').equals(receiptNumber).count())

  const result = await openChecksRequest<{ status: string; operation_id?: string }>(`/${checkId}/close`, 'POST', storeId, {
    operation_id: operationId, expected_version: expectedVersion, receipt_number: receiptNumber, catalog_version: catalogVersion,
    client_generated_at: now, service_charge_bps: serviceChargeBps,
    payment: { method, amount_cents: grandTotalCents, tendered_cents: tenderedCents, change_cents: changeCents, reference },
  }, terminal)
  // A concurrent close (another terminal settled this same check first) returns 'already_closed'
  // with the order id that actually won -- that sale, not this attempt, is what actually happened.
  const finalOrderId = result.status === 'already_closed' && result.operation_id ? result.operation_id : operationId

  await posDb.sync_metadata.put({ key: `receipt_prefix:${storeId}`, value: prefix })
  await posDb.sync_metadata.put({ key: sequenceKey, value: String(sequence) })
  const order: LocalOrder = {
    id: finalOrderId, store_id: storeId, receipt_number: receiptNumber,
    subtotal_cents: detail.check.subtotal_cents, discount_cents: detail.check.discount_cents, tax_cents: detail.check.tax_cents,
    service_charge_bps: serviceChargeBps, service_charge_cents: detail.check.service_charge_cents, total_cents: grandTotalCents,
    catalog_version: catalogVersion, client_generated_at: now, sync_status: 'synced',
    currency: config.currency, store_name_snapshot: config.name, timezone_snapshot: config.timezone,
    accepted_checkpoint: null, failure_reason: null,
    customer_id: detail.check.customer_id, employee_id: detail.check.employee_id,
    manager_id: detail.check.manager_id, manager_approved_at: detail.check.manager_approved_at,
    order_type: detail.check.order_type, table_id: detail.check.table_id,
  }
  const orderItems: LocalOrderItem[] = detail.items.map(item => ({
    id: item.id, order_id: finalOrderId, product_id: item.product_id, snapshot_name: item.snapshot_name, snapshot_sku: item.snapshot_sku,
    snapshot_price_cents: item.snapshot_price_cents, base_price_cents: item.snapshot_price_cents - item.modifiers.reduce((sum, modifier) => sum + modifier.price_delta_cents, 0),
    modifiers: item.modifiers.map(modifier => ({ option_id: '', group_name: modifier.group_name, option_name: modifier.option_name, price_delta_cents: modifier.price_delta_cents })),
    snapshot_tax_bps: item.snapshot_tax_bps, catalog_version: item.catalog_version, quantity: item.quantity,
    subtotal_cents: item.subtotal_cents, discount_kind: item.discount_kind, discount_value: item.discount_value,
    discount_applied_cents: item.discount_applied_cents, taxable_cents: item.taxable_cents, tax_cents: item.tax_cents, total_cents: item.total_cents,
  }))
  const payment: LocalPayment = { id: crypto.randomUUID(), order_id: finalOrderId, method, amount_cents: grandTotalCents, tendered_cents: tenderedCents, change_cents: changeCents, reference }
  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments], async () => {
    await posDb.orders.put(order)
    await posDb.order_items.bulkPut(orderItems)
    await posDb.payments.put(payment)
  })
  return { operationId: finalOrderId, receiptNumber, totalCents: grandTotalCents }
}
