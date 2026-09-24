import test from 'node:test'
import assert from 'node:assert/strict'
import { isLowStock } from '../src/screens/inventory/IngredientList'
import { expiryTone } from '../src/screens/inventory/BatchList'
import type { Ingredient } from '../src/lib/inventory'

const ingredient = (currentStock: string, reorderThreshold: string | null): Ingredient => ({
  id: 'i1', store_id: 's1', name: 'Flour', unit_id: 'u1', cost_per_unit_cents: 100,
  current_stock: currentStock, reorder_threshold: reorderThreshold, active: true,
})

test('an ingredient with no reorder threshold is never low stock', () => {
  assert.equal(isLowStock(ingredient('0', null)), false)
})

test('an ingredient at or below its reorder threshold is low stock', () => {
  assert.equal(isLowStock(ingredient('5', '5')), true)
  assert.equal(isLowStock(ingredient('3', '5')), true)
})

test('an ingredient above its reorder threshold is not low stock', () => {
  assert.equal(isLowStock(ingredient('10', '5')), false)
})

test('a batch with no expiry date has no tone', () => {
  assert.equal(expiryTone(null), null)
})

test('a batch past its expiry date is danger tone', () => {
  const now = Date.parse('2026-09-24T00:00:00.000Z')
  assert.equal(expiryTone('2026-09-20T00:00:00.000Z', now), 'danger')
})

test('a batch expiring within 3 days is warning tone', () => {
  const now = Date.parse('2026-09-24T00:00:00.000Z')
  assert.equal(expiryTone('2026-09-26T00:00:00.000Z', now), 'warning')
})

test('a batch expiring well in the future has no tone', () => {
  const now = Date.parse('2026-09-24T00:00:00.000Z')
  assert.equal(expiryTone('2026-10-24T00:00:00.000Z', now), null)
})
