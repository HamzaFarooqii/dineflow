import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveSlaState, DEFAULT_PREP_TARGET_SECONDS } from './kitchen-sla.ts'

const firedAt = new Date('2026-09-29T12:00:00.000Z')

test('an item that has not fired yet is always calm, regardless of how long it has waited', () => {
  assert.equal(deriveSlaState(null, 600, new Date('2026-09-29T13:00:00.000Z')), 'calm')
})
test('just under the target is still warning, not late', () => {
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 599_000)), 'warning')
})
test('exactly at the target is late', () => {
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 600_000)), 'late')
})
test('past the target is late', () => {
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 900_000)), 'late')
})
test('just under 80% of the target is still calm', () => {
  // 80% of 600s = 480s
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 479_000)), 'calm')
})
test('exactly at 80% of the target is warning', () => {
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 480_000)), 'warning')
})
test('between 80% and 100% of the target is warning', () => {
  assert.equal(deriveSlaState(firedAt, 600, new Date(firedAt.getTime() + 550_000)), 'warning')
})
test('the moment it fires is calm', () => {
  assert.equal(deriveSlaState(firedAt, 600, firedAt), 'calm')
})
test('DEFAULT_PREP_TARGET_SECONDS is a sane positive default for products with no configured prep time', () => {
  assert.ok(DEFAULT_PREP_TARGET_SECONDS > 0)
})
