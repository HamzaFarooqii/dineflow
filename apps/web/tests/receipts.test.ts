import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { posDb } from '../src/lib/db'
import { completeLocalSale } from '../src/lib/checkout'
import { readReceipt, saleDay, saleDate } from '../src/receipts/data'

test('receipt reads are scoped, snapshot-based, read-only and preserve external card evidence', async () => {
  await posDb.delete(); await posDb.open()
  try {
    await posDb.store_config.put({ id: 'store-a', store_id: 'store-a', name: 'Original store', currency: 'USD', timezone: 'Asia/Karachi', catalog_version: 1, service_charge_bps: 0 })
    const sale = await completeLocalSale([{ storeId: 'store-a', productId: 'product-a', name: 'Original name', sku: 'ORIGINAL', unitPriceCents: 199, taxRateBps: 500, quantity: 2, catalogVersion: 1, discount: null }], 'store-a', 'card', 418, 'APPROVED-123')
    await posDb.store_config.update('store-a', { name: 'Renamed store' })
    await posDb.products.put({ id: 'product-a', store_id: 'store-a', name: 'Renamed item', sku: 'NEW', unit_price_cents: 9900, barcode: null, category_id: null, tax_rate_id: null, active: true, revision: 2 })
    const snapshot = () => Promise.all(posDb.tables.map(table => table.toArray()))
    const before = await snapshot()
    assert.equal(await readReceipt('other-store', sale.operationId), null)
    assert.equal(await readReceipt('store-a', 'missing'), null)
    const receipt = await readReceipt('store-a', sale.operationId)
    assert.equal(receipt?.order.store_name_snapshot, 'Original store')
    assert.equal(receipt?.items[0].snapshot_name, 'Original name')
    assert.equal(receipt?.items[0].snapshot_price_cents, 199)
    assert.equal(receipt?.payment.reference, 'APPROVED-123')
    assert.equal(receipt?.payment.change_cents, 0)
    assert.deepEqual(await snapshot(), before)
    const late = { ...receipt!.order, client_generated_at: '2026-09-16T23:30:00.000Z' }
    assert.equal(saleDay(late), '2026-09-17')
    assert.match(saleDate(late), /17 Sept 2026/)
    await posDb.payments.clear()
    await assert.rejects(readReceipt('store-a', sale.operationId), /incomplete/)
  } finally { await posDb.delete() }
})
