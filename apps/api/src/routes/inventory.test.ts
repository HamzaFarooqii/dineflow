import test from 'node:test'
import assert from 'node:assert/strict'

// Import the route module after setting a harmless pool URL; these tests never open a connection.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { assertWastageWithinStock } = await import('./inventory.js')

test('rejects wastage that would take stock below zero', () => {
  assert.throws(() => assertWastageWithinStock(5, 10), /only 5 in stock/)
})

test('allows wastage that leaves stock at exactly zero', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(5, 5))
})

test('allows wastage smaller than current stock', () => {
  assert.doesNotThrow(() => assertWastageWithinStock(10, 5))
})
