import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifier, verify, digest, token, pinValue, uuid } from './security.js'
import { CLOCK_SKEW_TOLERANCE_MS, DAY, permissions, verifyOffline } from '../../../web/src/terminal-auth/policy.js'
import type { Employee, CashierSession } from '../../../web/src/terminal-auth/types.js'

test('salted PIN verifiers agree between server and browser Web Crypto', async () => {
  const pin = String(100000 + Math.floor(Math.random() * 900000))
  const first = await verifier(pin), second = await verifier(pin)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
  assert.equal(await verify(pin, first.salt, first.hash), true)
  assert.equal(await verify('bad-pin', first.salt, first.hash), false)
  const employee = { verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: 600000, ...first } } as Employee
  assert.equal(await verifyOffline(pin, employee), true)
  assert.equal(await verifyOffline('bad-pin', employee), false)
  await assert.rejects(verifyOffline(pin, { ...employee, verifier: { ...employee.verifier, iterations: 1 } } as unknown as Employee))
})
test('authorization expires exactly at 72 hours and seven days; rollback/version mismatch deny access', () => {
  const validated = Date.parse('2026-09-15T00:00:00Z')
  const employee = { id: 'employee', role: 'manager', permission_version: 2 } as Employee
  const session: CashierSession = { employee_id: employee.id, permission_version: 2, logged_in_at: new Date(validated).toISOString(), last_server_validated_at: new Date(validated).toISOString() }
  assert.deepEqual(permissions(session, employee, validated + 3 * DAY - 1, validated), { valid: true, managerApproval: true })
  assert.deepEqual(permissions(session, employee, validated + 3 * DAY, validated), { valid: true, managerApproval: false })
  assert.equal(permissions(session, employee, validated + 7 * DAY, validated).valid, false)
  assert.equal(permissions(session, employee, validated - 1, validated).valid, false)
  // A few seconds/minutes of client clock skew behind the server-stamped validation time is
  // tolerated; a rollback beyond that tolerance is not. lastSeen tracks now here so only the
  // skew tolerance (not the separate local-rollback check) is under test.
  assert.equal(permissions(session, employee, validated - CLOCK_SKEW_TOLERANCE_MS, validated - CLOCK_SKEW_TOLERANCE_MS).valid, true)
  assert.equal(permissions(session, employee, validated - CLOCK_SKEW_TOLERANCE_MS - 1, validated - CLOCK_SKEW_TOLERANCE_MS - 1).valid, false)
  assert.equal(permissions(session, { ...employee, permission_version: 3 }, validated, validated).valid, false)
  assert.equal(permissions(session, undefined, validated, validated).valid, false)
})
test('credential and request formats', () => {
  const credential = token()
  assert.match(credential, /^[a-f0-9]{64}$/)
  assert.notEqual(digest(credential), credential)
  for (const pin of [1234, '', '123', '123456789', '12a4']) assert.throws(() => pinValue(pin))
  assert.throws(() => uuid("' or true--"))
})
