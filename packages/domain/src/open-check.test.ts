import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransitionOpenCheck, isOpenCheckEditable, OPEN_CHECK_TRANSITIONS, type OpenCheckStatus } from './open-check.ts'

test('an open check can only close or void, never move directly between closed and voided', () => {
  assert.ok(canTransitionOpenCheck('open', 'closed'))
  assert.ok(canTransitionOpenCheck('open', 'voided'))
  assert.ok(!canTransitionOpenCheck('closed', 'voided'))
  assert.ok(!canTransitionOpenCheck('voided', 'closed'))
})
test('closed and voided are terminal -- neither can reopen', () => {
  assert.ok(!canTransitionOpenCheck('closed', 'open'))
  assert.ok(!canTransitionOpenCheck('voided', 'open'))
  assert.deepEqual(OPEN_CHECK_TRANSITIONS.closed, [])
  assert.deepEqual(OPEN_CHECK_TRANSITIONS.voided, [])
})
test('only an open check is editable', () => {
  const statuses: OpenCheckStatus[] = ['open', 'closed', 'voided']
  assert.deepEqual(statuses.map(isOpenCheckEditable), [true, false, false])
})
