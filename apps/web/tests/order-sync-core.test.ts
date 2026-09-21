import test from 'node:test'
import assert from 'node:assert/strict'
import { classifySyncState, canRetrySync } from '../src/lib/order-sync-core'
import type { OutboxEntry } from '../src/lib/db'

const base: Pick<OutboxEntry, 'status' | 'failure_kind' | 'lease_owner' | 'lease_expires_at'> = {
  status: 'pending', failure_kind: null, lease_owner: null, lease_expires_at: null,
}

test('classifySyncState maps outbox fields to the five FEAT-STAT-02 states', () => {
  assert.equal(classifySyncState({ ...base, status: 'synced' }), 'synced')
  assert.equal(classifySyncState(base), 'pending')
  assert.equal(classifySyncState({ ...base, status: 'failed', failure_kind: 'connectivity' }), 'pending')
  assert.equal(classifySyncState({ ...base, failure_kind: 'dependency' }), 'blocked')
  assert.equal(classifySyncState({ ...base, status: 'failed', failure_kind: 'validation' }), 'rejected')
  assert.equal(classifySyncState({ ...base, status: 'failed', failure_kind: 'authentication' }), 'rejected')
})

test('classifySyncState treats a currently-held lease as in-flight, but not once it expires', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z')
  const leased = { ...base, lease_owner: 'worker-1', lease_expires_at: '2026-09-18T12:00:30.000Z' }
  assert.equal(classifySyncState(leased, now), 'in_flight')
  assert.equal(classifySyncState(leased, now + 31_000), 'pending')
})

test('synced always wins even if stale lease/failure fields were left behind', () => {
  assert.equal(classifySyncState({ status: 'synced', failure_kind: 'validation', lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00.000Z' }), 'synced')
})

// canRetrySync must mirror retryOrderForStore's own gate in order-sync-core.ts exactly: it allows
// retrying everything except a synced entry or a genuine server-side 'validation' rejection. Both
// 'validation' and 'authentication' map to the same 'rejected' SyncState badge, so a naive
// state-based check (retry only pending/blocked) would wrongly block a retryable auth failure too.
test('canRetrySync allows every failure kind except validation, and never a synced entry', () => {
  assert.equal(canRetrySync({ status: 'pending', failure_kind: null }), true)
  assert.equal(canRetrySync({ status: 'failed', failure_kind: 'connectivity' }), true)
  assert.equal(canRetrySync({ status: 'failed', failure_kind: 'authentication' }), true)
  assert.equal(canRetrySync({ status: 'pending', failure_kind: 'dependency' }), true)
  assert.equal(canRetrySync({ status: 'failed', failure_kind: 'validation' }), false)
  assert.equal(canRetrySync({ status: 'synced', failure_kind: null }), false)
  assert.equal(canRetrySync({ status: 'synced', failure_kind: 'validation' }), false)
})
