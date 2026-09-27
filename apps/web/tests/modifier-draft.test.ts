import test from 'node:test'
import assert from 'node:assert/strict'
import { parseModifierDraft } from '../src/screens/menu/modifier-draft'

test('parses required size and optional add-ons with integer deltas', () => {
  assert.deepEqual(parseModifierDraft([
    { name: 'Size', selection: 'single', required: true, options: [{ name: 'Regular', price: '0', active: true }, { name: 'Large', price: '2.00', active: true }] },
    { name: 'Add-ons', selection: 'multi', required: false, options: [{ name: 'Extra syrup', price: '.50', active: true }] },
  ]), [
    { name: 'Size', selection: 'single', required: true, options: [{ name: 'Regular', price_delta_cents: 0, active: true }, { name: 'Large', price_delta_cents: 200, active: true }] },
    { name: 'Add-ons', selection: 'multi', required: false, options: [{ name: 'Extra syrup', price_delta_cents: 50, active: true }] },
  ])
})

test('rejects incomplete groups and malformed prices', () => {
  assert.throws(() => parseModifierDraft([{ name: 'Size', selection: 'single', required: true, options: [] }]), /at least one option/)
  assert.throws(() => parseModifierDraft([{ name: 'Size', selection: 'single', required: true, options: [{ name: 'Large', price: '2.999', active: true }] }]), /valid price/)
})
