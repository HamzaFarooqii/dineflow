import test from 'node:test'
import assert from 'node:assert/strict'
import { computeBatchStatus, daysUntilExpiry } from './batch-status.ts'

const now = Date.parse('2026-09-25T00:00:00.000Z')

test('a depleted batch is depleted regardless of expiry', () => {
  assert.equal(computeBatchStatus({ remainingQuantity: 0, originalQuantity: 50, expiresAt: '2030-01-01T00:00:00.000Z' }, now), 'depleted')
  assert.equal(computeBatchStatus({ remainingQuantity: -1, originalQuantity: 50, expiresAt: null }, now), 'depleted')
})

test('expired takes priority over low-remaining', () => {
  assert.equal(computeBatchStatus({ remainingQuantity: 40, originalQuantity: 50, expiresAt: '2026-09-20T00:00:00.000Z' }, now), 'expired')
})

test('a batch expiring within 3 days is expiring_soon even with plenty remaining', () => {
  assert.equal(computeBatchStatus({ remainingQuantity: 45, originalQuantity: 50, expiresAt: '2026-09-27T00:00:00.000Z' }, now), 'expiring_soon')
})

test('a batch at or below 20% remaining, with no near expiry, is low_remaining', () => {
  assert.equal(computeBatchStatus({ remainingQuantity: 10, originalQuantity: 50, expiresAt: null }, now), 'low_remaining')
  assert.equal(computeBatchStatus({ remainingQuantity: 11, originalQuantity: 50, expiresAt: null }, now), 'active')
})

test('a healthy batch with no expiry date is active', () => {
  assert.equal(computeBatchStatus({ remainingQuantity: 50, originalQuantity: 50, expiresAt: null }, now), 'active')
})

test('daysUntilExpiry rounds up to whole days and is null without an expiry date', () => {
  assert.equal(daysUntilExpiry(null), null)
  assert.equal(daysUntilExpiry('2026-09-30T00:00:00.000Z', now), 5)
  assert.equal(daysUntilExpiry('2026-09-20T00:00:00.000Z', now), -5)
})
