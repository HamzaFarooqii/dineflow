import test from 'node:test'
import assert from 'node:assert/strict'
import { formatCostPerUnit, formatQuantity, formatQuantityNumber } from './inventory-quantity.ts'

test('formatQuantityNumber trims trailing decimal zeros without touching whole numbers', () => {
  assert.equal(formatQuantityNumber('50'), '50')
  assert.equal(formatQuantityNumber('2.50'), '2.5')
  assert.equal(formatQuantityNumber('2.00'), '2')
  assert.equal(formatQuantityNumber('2.505'), '2.505')
})

test('formatQuantity always attaches the unit abbreviation', () => {
  assert.equal(formatQuantity('50', { abbreviation: 'L' }), '50 L')
  assert.equal(formatQuantity(2.5, { abbreviation: 'kg' }), '2.5 kg')
})

test('formatCostPerUnit attaches the unit abbreviation to an already-formatted cost', () => {
  assert.equal(formatCostPerUnit('$150.00', { abbreviation: 'L' }), '$150.00 / L')
})
