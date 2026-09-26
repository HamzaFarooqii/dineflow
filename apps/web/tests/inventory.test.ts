import test from 'node:test'
import assert from 'node:assert/strict'
import { isLowStock, isOutOfStock } from '../src/screens/inventory/inventory-status'
import { applyInventoryView } from '../src/screens/inventory/IngredientList'
import { withRunningBalance } from '../src/screens/inventory/StockLedger'
import type { Ingredient, StockMovement } from '../src/lib/inventory'

const ingredient = (overrides: Partial<Ingredient> & { name: string; current_stock: string }): Ingredient => ({
  id: overrides.name, store_id: 's1', unit_id: 'u1', cost_per_unit_cents: 100,
  reorder_threshold: null, active: true, created_by_user_id: null, created_by_name: null,
  updated_at: '2026-09-20T00:00:00.000Z', active_batch_count: 0, nearest_expiry: null,
  ...overrides,
})

test('an ingredient with no reorder threshold is never low stock', () => {
  assert.equal(isLowStock(ingredient({ name: 'Flour', current_stock: '0' })), false)
})

test('an ingredient at or below its reorder threshold is low stock', () => {
  assert.equal(isLowStock(ingredient({ name: 'Flour', current_stock: '5', reorder_threshold: '5' })), true)
  assert.equal(isLowStock(ingredient({ name: 'Flour', current_stock: '3', reorder_threshold: '5' })), true)
})

test('an ingredient above its reorder threshold is not low stock', () => {
  assert.equal(isLowStock(ingredient({ name: 'Flour', current_stock: '10', reorder_threshold: '5' })), false)
})

test('an ingredient at zero or negative stock is out of stock, even with no reorder threshold set', () => {
  assert.equal(isOutOfStock(ingredient({ name: 'Flour', current_stock: '0' })), true)
  assert.equal(isOutOfStock(ingredient({ name: 'Flour', current_stock: '-2' })), true)
})

test('an ingredient with positive stock is not out of stock', () => {
  assert.equal(isOutOfStock(ingredient({ name: 'Flour', current_stock: '1' })), false)
})

test('applyInventoryView filters by name search, case-insensitively', () => {
  const list = [ingredient({ name: 'Milk', current_stock: '10' }), ingredient({ name: 'Flour', current_stock: '10' })]
  const result = applyInventoryView(list, 'mil', 'all', 'name')
  assert.deepEqual(result.map(item => item.name), ['Milk'])
})

test('applyInventoryView filters by ingredient status', () => {
  const list = [
    ingredient({ name: 'Milk', current_stock: '0' }),
    ingredient({ name: 'Flour', current_stock: '3', reorder_threshold: '5' }),
    ingredient({ name: 'Sugar', current_stock: '50' }),
  ]
  assert.deepEqual(applyInventoryView(list, '', 'out_of_stock', 'name').map(item => item.name), ['Milk'])
  assert.deepEqual(applyInventoryView(list, '', 'low_stock', 'name').map(item => item.name), ['Flour'])
  assert.deepEqual(applyInventoryView(list, '', 'in_stock', 'name').map(item => item.name), ['Sugar'])
})

test('applyInventoryView hides an inactive ingredient from every filter except "inactive" itself', () => {
  const list = [
    ingredient({ name: 'Milk', current_stock: '0' }),
    ingredient({ name: 'Old Flour', current_stock: '3', active: false }),
  ]
  assert.deepEqual(applyInventoryView(list, '', 'all', 'name').map(item => item.name), ['Milk'])
  assert.deepEqual(applyInventoryView(list, '', 'out_of_stock', 'name').map(item => item.name), ['Milk'])
  assert.deepEqual(applyInventoryView(list, '', 'inactive', 'name').map(item => item.name), ['Old Flour'])
})

test('applyInventoryView filters "expiring_soon" using nearest_expiry, independent of stock status', () => {
  const now = Date.parse('2026-09-25T00:00:00.000Z')
  const list = [
    ingredient({ name: 'Milk', current_stock: '10', nearest_expiry: '2026-09-26T00:00:00.000Z' }),
    ingredient({ name: 'Flour', current_stock: '10', nearest_expiry: '2026-11-01T00:00:00.000Z' }),
    ingredient({ name: 'Sugar', current_stock: '10', nearest_expiry: null }),
  ]
  assert.deepEqual(applyInventoryView(list, '', 'expiring_soon', 'name', now).map(item => item.name), ['Milk'])
})

test('applyInventoryView sorts by name, stock level, recently updated, and nearest expiry', () => {
  const list = [
    ingredient({ name: 'Sugar', current_stock: '30', updated_at: '2026-09-20T00:00:00.000Z', nearest_expiry: null }),
    ingredient({ name: 'Milk', current_stock: '5', updated_at: '2026-09-24T00:00:00.000Z', nearest_expiry: '2026-10-01T00:00:00.000Z' }),
    ingredient({ name: 'Flour', current_stock: '15', updated_at: '2026-09-22T00:00:00.000Z', nearest_expiry: '2026-09-27T00:00:00.000Z' }),
  ]
  assert.deepEqual(applyInventoryView(list, '', 'all', 'name').map(i => i.name), ['Flour', 'Milk', 'Sugar'])
  assert.deepEqual(applyInventoryView(list, '', 'all', 'stock_level').map(i => i.name), ['Milk', 'Flour', 'Sugar'])
  assert.deepEqual(applyInventoryView(list, '', 'all', 'recently_updated').map(i => i.name), ['Milk', 'Flour', 'Sugar'])
  assert.deepEqual(applyInventoryView(list, '', 'all', 'expiry').map(i => i.name), ['Flour', 'Milk', 'Sugar'])
})

const movement = (overrides: Partial<StockMovement> & { delta: string }): StockMovement => ({
  id: overrides.delta, store_id: 's1', ingredient_id: 'i1', batch_id: null, reason: 'purchase',
  note: null, kitchen_ticket_item_id: null, created_at: '2026-09-25T00:00:00.000Z',
  created_by_user_id: null, created_by_name: null,
  ...overrides,
})

test('withRunningBalance walks backward from current stock through newest-first movements', () => {
  // Newest first (as the API returns them): +5 wastage-reversed... just two movements for clarity.
  const movements = [movement({ delta: '-2', reason: 'wastage' }), movement({ delta: '10', reason: 'purchase' })]
  const rows = withRunningBalance(movements, 8) // current stock is 8, after -2 then +10 from 0
  assert.equal(rows[0].newStock, 8)
  assert.equal(rows[0].previousStock, 10) // undoing the -2 wastage
  assert.equal(rows[1].newStock, 10)
  assert.equal(rows[1].previousStock, 0) // undoing the +10 purchase
})

test('withRunningBalance rounds away floating-point drift across many small movements', () => {
  const movements = Array.from({ length: 5 }, () => movement({ delta: '-0.1', reason: 'wastage' }))
  const rows = withRunningBalance(movements, 0.5)
  assert.equal(rows.at(-1)!.previousStock, 1) // 0.5 + 5*0.1, not 0.9999999999999999
})
