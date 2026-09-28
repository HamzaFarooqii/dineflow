// Client for the open-checks API (apps/api/src/routes/open-checks.ts) -- a durable, server-owned
// running tab. Unlike the register's cart (pure local state until checkout) or a completed sale
// (local-first, outboxed), an open check is deliberately online-only: it exists to be resumed from
// *another* terminal, so its source of truth has to be the server, not this browser. If the
// network is down, create/edit/void/close simply fail with a clear message -- the same tradeoff
// Floor's table-status transitions already make (updateTableStatus in lib/floor.ts), not a new one.
import { accessToken, configuredApiUrl } from './catalog'
import type { OrderType } from '../../../../packages/domain/src/order-type'
import type { LineDiscount } from '../../../../packages/domain/src/money'
import { posDb } from './db'
import { validateSettlement, type SettlementTender } from './checkout'
import { fetchRemoteReceipt } from '../receipts/data'

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
  const query = new URLSearchParams({ store_id: storeId })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/open-checks' : '/open-checks'}${path}${path.includes('?') ? '&' : '?'}${query}`, {
    method,
    credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: body ? JSON.stringify(body) : undefined,
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
  serviceChargeBps: number, catalogVersion: number, terminal = false, settlement?: SettlementTender[],
): Promise<{ operationId: string; receiptNumber: string; totalCents: number }> {
  const operationId = crypto.randomUUID()
  const now = new Date().toISOString()
  const detail = await fetchOpenCheck(storeId, checkId, terminal)
  if (detail.check.status === 'voided') throw new Error('This check was voided.')
  const grandTotalCents = detail.check.total_cents
  if (!settlement && tenderedCents < grandTotalCents) throw new Error('Amount received must cover the sale.')
  const changeCents = method === 'cash' ? tenderedCents - grandTotalCents : 0

  const payments = settlement ?? [{ id: crypto.randomUUID(), method, amount_cents: grandTotalCents, tendered_cents: tenderedCents, change_cents: changeCents, tip_cents: 0, reference }]
  validateSettlement(payments, grandTotalCents)
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
    payments,
  }, terminal)
  // A concurrent close (another terminal settled this same check first) returns 'already_closed'
  // with the order id that actually won -- that sale, not this attempt, is what actually happened.
  const finalOrderId = result.status === 'already_closed' && result.operation_id ? result.operation_id : operationId

  await posDb.sync_metadata.put({ key: `receipt_prefix:${storeId}`, value: prefix })
  await posDb.sync_metadata.put({ key: sequenceKey, value: String(sequence) })
  // Always read the winning server snapshot: another terminal may have closed with different
  // tenders or receipt number. Never synthesize a receipt from this losing request.
  const receipt = await fetchRemoteReceipt(storeId, finalOrderId, terminal)
  if (!receipt) throw new Error('The check closed, but its receipt could not be loaded. Open Orders to recover it; do not charge again.')
  await posDb.transaction('rw', [posDb.orders, posDb.order_items, posDb.payments], async () => {
    await posDb.orders.put(receipt.order)
    await posDb.order_items.bulkPut(receipt.items)
    await posDb.payments.where('order_id').equals(finalOrderId).delete()
    await posDb.payments.bulkPut(receipt.payments ?? [receipt.payment])
  })
  return { operationId: finalOrderId, receiptNumber: receipt.order.receipt_number, totalCents: receipt.order.total_cents }
}
