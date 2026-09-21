import test from 'node:test'
import assert from 'node:assert/strict'
import { customerName, normalizedPhone } from './customer.ts'

test('customer identity needs a name and explicit country code for an optional phone', () => {
  assert.equal(customerName('  Ada   North  '), 'Ada North')
  assert.equal(normalizedPhone('+92 (300) 123-4567'), '923001234567')
  assert.equal(normalizedPhone(''), null)
  assert.equal(normalizedPhone(null), null)
  assert.throws(() => customerName('   '), /required|1 to 30/)
  assert.throws(() => customerName('A'.repeat(31)), /1 to 30/)
  assert.throws(() => normalizedPhone('03001234567'), /country code/)
  assert.throws(() => normalizedPhone('+1'), /4 to 15/)
})
