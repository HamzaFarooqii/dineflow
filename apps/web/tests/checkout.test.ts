import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import Dexie from 'dexie'
import { completeLocalSale } from '../src/lib/checkout'
import { createLocalCustomer, searchLocalCustomers } from '../src/lib/customer-local'
import { posDb } from '../src/lib/db'
import { pushOrdersForStore, retryOrderForStore } from '../src/lib/order-sync-core'
import type { CartItem } from '../src/lib/pos-store'

const storeId = '90ca1d78-8027-4db8-8247-f4d8794b2680'
const productId = 'ff439cac-818c-43cc-924e-62f5cc049322'
const cart: CartItem[] = [{ storeId, productId, name: 'Test item', sku: 'TEST-001',
  unitPriceCents: 199, taxRateBps: 500, catalogVersion: 1, quantity: 2, discount: null }]
Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })

test('cash checkout commits the receipt, sale, payment, stock overlay and outbox together', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null, null, 'employee-1')
  assert.match(sale.receiptNumber, /^LOCAL-[0-9A-F-]{36}-000001$/)
  const order = await posDb.orders.get(sale.operationId)
  assert.equal(order?.total_cents, 418)
  assert.equal(order?.employee_id, 'employee-1')
  assert.equal((await posDb.order_items.where('order_id').equals(sale.operationId).toArray()).length, 1)
  assert.equal((await posDb.payments.where('order_id').equals(sale.operationId).first())?.change_cents, 82)
  assert.equal((await posDb.stock_adjustments.get([sale.operationId, productId]))?.delta, -2)
  const outbox = await posDb.outbox.where('operation_id').equals(sale.operationId).first()
  assert.equal(outbox?.status, 'pending')
  assert.equal(JSON.parse(outbox!.payload).operation_id, sale.operationId)
  assert.equal((await posDb.sync_metadata.get(`receipt_seq:${storeId}`))?.value, '1')
  await posDb.delete()
})

test('a failed outbox write rolls back the sale and receipt sequence', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const originalAdd = posDb.outbox.add
  posDb.outbox.add = () => Dexie.Promise.reject(new Error('simulated storage failure'))
  try {
    await assert.rejects(completeLocalSale(cart, storeId, 'cash', 500, null), /simulated storage failure/)
  } finally { posDb.outbox.add = originalAdd }
  assert.equal(await posDb.orders.count(), 0)
  assert.equal(await posDb.order_items.count(), 0)
  assert.equal(await posDb.payments.count(), 0)
  assert.equal(await posDb.stock_adjustments.count(), 0)
  assert.equal(await posDb.outbox.count(), 0)
  assert.equal(await posDb.sync_metadata.get(`receipt_seq:${storeId}`), undefined)
  await posDb.delete()
})

test('checkout refuses a cart carried over from another store', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  await assert.rejects(completeLocalSale([{ ...cart[0], storeId: 'other-store' }], storeId, 'cash', 500, null), /another store/)
  assert.equal(await posDb.orders.count(), 0)
  assert.equal(await posDb.outbox.count(), 0)
  await posDb.delete()
})

test('accepted push marks the order and outbox synced and covers local stock exactly once', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null)
  const send = async (entry: { operation_id: string }) => ({ ok: true, status: 200,
    body: { status: 'accepted', operation_id: entry.operation_id, accepted_checkpoint: '5' } })
  assert.equal(await pushOrdersForStore(storeId, send), 1)
  assert.equal((await posDb.orders.get(sale.operationId))?.sync_status, 'synced')
  assert.equal((await posDb.outbox.where('operation_id').equals(sale.operationId).first())?.status, 'synced')
  assert.equal((await posDb.stock_adjustments.get([sale.operationId, productId]))?.accepted_checkpoint, '5')
  assert.equal(await pushOrdersForStore(storeId, send), 0)
  await posDb.delete()
})

test('rejected push preserves the paid sale for review but rolls back its stock delta', async () => {
  await posDb.delete()
  await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC',
    currency: 'USD', catalog_version: 1 })
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null)
  assert.equal((await posDb.stock_adjustments.get([sale.operationId, productId]))?.delta, -2)
  const send = async () => ({ ok: false, status: 422, body: { code: 'total_mismatch', message: 'Sale needs review.' } })
  assert.equal(await pushOrdersForStore(storeId, send), 0)
  assert.equal((await posDb.orders.get(sale.operationId))?.sync_status, 'failed')
  const outbox = await posDb.outbox.where('operation_id').equals(sale.operationId).first()
  assert.equal(outbox?.failure_kind, 'validation')
  assert.equal(outbox?.reason_code, 'total_mismatch')
  // A validation failure never gets an accepted_checkpoint, so loadCatalog's checkpoint-based
  // cleanup (catalog.ts) would otherwise never purge this stock delta, leaving displayed stock
  // permanently short by the rejected sale's quantity. It must be rolled back immediately instead.
  assert.equal(await posDb.stock_adjustments.get([sale.operationId, productId]), undefined)
  await retryOrderForStore(sale.operationId, storeId, send)
  assert.equal((await posDb.outbox.where('operation_id').equals(sale.operationId).first())?.attempt_count, 1)
  await posDb.delete()
})

test('an existing browser database upgrades queued orders with their store scope', async () => {
  await posDb.delete()
  const oldDb = new Dexie('dineflow')
  oldDb.version(2).stores({
    orders: 'id, &receipt_number, client_generated_at, sync_status',
    outbox: '++id, &operation_id, status, next_attempt_at',
  })
  await oldDb.open()
  const id = crypto.randomUUID()
  await oldDb.table('orders').put({ id, store_id: storeId, receipt_number: 'OLD-000001',
    client_generated_at: '2026-09-15T09:00:00.000Z', sync_status: 'pending' })
  await oldDb.table('outbox').add({ operation_id: id, order_id: id, status: 'pending',
    next_attempt_at: '2026-09-15T09:00:00.000Z' })
  oldDb.close()
  await posDb.open()
  assert.equal((await posDb.outbox.where('operation_id').equals(id).first())?.store_id, storeId)
  assert.equal((await posDb.orders.where('[store_id+client_generated_at]')
    .between([storeId, Dexie.minKey], [storeId, Dexie.maxKey]).toArray()).length, 1)
  await posDb.delete()
})

test('offline customer creation and attached sale survive reload; dependency uploads first', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const customer = await createLocalCustomer(storeId, '  Ada   North  ', '+92 300 1234567')
  assert.equal(customer.name, 'Ada North')
  assert.equal(customer.phone_normalized, '923001234567')
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null, customer.id)
  assert.equal((await posDb.orders.get(sale.operationId))?.customer_id, customer.id)
  const queuedSale = await posDb.outbox.where('operation_id').equals(sale.operationId).first()
  assert.deepEqual(queuedSale?.depends_on, [customer.creating_operation_id])
  posDb.close(); await posDb.open()
  assert.equal((await posDb.customers.get(customer.id))?.name, 'Ada North')
  assert.equal((await posDb.orders.get(sale.operationId))?.customer_id, customer.id)
  const sent: string[] = []
  const send = async (entry: { entity_type?: string; operation_id: string }) => {
    sent.push(entry.entity_type ?? 'order')
    return { ok: true, status: 200, body: { status: 'accepted', operation_id: entry.operation_id, accepted_checkpoint: String(sent.length) } }
  }
  assert.equal(await pushOrdersForStore(storeId, send), 2)
  assert.deepEqual(sent, ['customer', 'order'])
  assert.equal((await posDb.orders.get(sale.operationId))?.sync_status, 'synced')
  assert.equal((await posDb.customers.get(customer.id))?.sync_status, 'synced')
  await posDb.delete()
})

test('a permanently rejected customer upload does not block the dependent paid order from syncing', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const customer = await createLocalCustomer(storeId, 'Bea South', '+923001234567')
  const sale = await completeLocalSale(cart, storeId, 'cash', 500, null, customer.id)
  const sent: string[] = []
  // Mirrors the real server (orders.ts): a permanently rejected customer does not block the sale —
  // the order still accepts, just without the customer link, so the sale is never lost.
  await pushOrdersForStore(storeId, async entry => {
    sent.push(entry.entity_type ?? 'order')
    if (entry.entity_type === 'customer') return { ok: false, status: 422, body: { code: 'validation_failed', message: 'Customer needs review.' } }
    return { ok: true, status: 200, body: { status: 'accepted', operation_id: entry.operation_id, accepted_checkpoint: '1' } }
  })
  assert.deepEqual(sent, ['customer', 'order'])
  assert.equal((await posDb.orders.get(sale.operationId))?.customer_id, customer.id)
  assert.equal((await posDb.orders.get(sale.operationId))?.sync_status, 'synced')
  assert.equal((await posDb.outbox.where('operation_id').equals(sale.operationId).first())?.status, 'synced')
  assert.equal((await posDb.stock_adjustments.get([sale.operationId, productId]))?.accepted_checkpoint, '1')
  await posDb.delete()
})

test('a cashier-level discount (20% or less) completes without manager approval and is snapshotted on the order item', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const discounted: CartItem[] = [{ ...cart[0], discount: { kind: 'percent', bps: 1_000 } }]
  const sale = await completeLocalSale(discounted, storeId, 'cash', 500, null)
  const order = await posDb.orders.get(sale.operationId)
  assert.equal(order?.discount_cents, 40)
  assert.equal(order?.manager_id, null)
  const item = (await posDb.order_items.where('order_id').equals(sale.operationId).toArray())[0]
  assert.equal(item.discount_kind, 'percent')
  assert.equal(item.discount_value, 1_000)
  assert.equal(item.discount_applied_cents, 40)
  assert.equal(item.taxable_cents, 358)
  await posDb.delete()
})

test('a discount above 20% is refused without manager evidence and accepted with it, on a cashier terminal', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const discounted: CartItem[] = [{ ...cart[0], discount: { kind: 'percent', bps: 2_500 } }]
  await assert.rejects(completeLocalSale(discounted, storeId, 'cash', 500, null, null, null, null, true), /manager approval/)
  assert.equal(await posDb.orders.count(), 0)
  const sale = await completeLocalSale(discounted, storeId, 'cash', 500, null, null, null, { managerId: 'manager-1', approvedAt: '2026-09-17T10:00:00.000Z' }, true)
  const order = await posDb.orders.get(sale.operationId)
  assert.equal(order?.manager_id, 'manager-1')
  assert.equal(order?.manager_approved_at, '2026-09-17T10:00:00.000Z')
  await posDb.delete()
})

test('a discount above 20% completes without manager evidence on the web register, since every web session is already owner/manager', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const discounted: CartItem[] = [{ ...cart[0], discount: { kind: 'percent', bps: 2_500 } }]
  const sale = await completeLocalSale(discounted, storeId, 'cash', 500, null)
  const order = await posDb.orders.get(sale.operationId)
  assert.equal(order?.manager_id, null)
  await posDb.delete()
})

test('duplicate normalized phones stay separate and checkout rejects cross-store customer', async () => {
  await posDb.delete(); await posDb.open()
  await posDb.store_config.put({ id: storeId, store_id: storeId, name: 'Test store', timezone: 'UTC', currency: 'USD', catalog_version: 1 })
  const first = await createLocalCustomer(storeId, 'One', '+923001234567')
  const second = await createLocalCustomer(storeId, 'Two', '+92 300 1234567')
  assert.notEqual(first.id, second.id)
  assert.equal((await searchLocalCustomers(storeId, '+923001234567')).length, 2)
  const other = await createLocalCustomer('920f23e0-fb21-4ab8-ae7c-2454f3f9031c', 'Other', '+923001234567')
  await assert.rejects(completeLocalSale(cart, storeId, 'cash', 500, null, other.id), /does not belong/)
  assert.equal(await posDb.orders.count(), 0)
  await posDb.delete()
})
