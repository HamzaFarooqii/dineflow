import test from 'node:test'
import assert from 'node:assert/strict'
import { roleHasCapability, STAFF_ROLES } from './staff-role.ts'

test('manager has every capability, including ones no other role has', () => {
  assert.equal(roleHasCapability('manager', 'register'), true)
  assert.equal(roleHasCapability('manager', 'floor'), true)
  assert.equal(roleHasCapability('manager', 'kitchen'), true)
  assert.equal(roleHasCapability('manager', 'inventory'), true)
  assert.equal(roleHasCapability('manager', 'staff'), true)
})

test('each non-manager role has exactly its assigned capabilities', () => {
  assert.equal(roleHasCapability('cashier', 'register'), true)
  assert.equal(roleHasCapability('cashier', 'floor'), false)
  assert.equal(roleHasCapability('waiter', 'register'), true)
  assert.equal(roleHasCapability('waiter', 'floor'), true)
  assert.equal(roleHasCapability('waiter', 'kitchen'), false)
  assert.equal(roleHasCapability('chef', 'kitchen'), true)
  assert.equal(roleHasCapability('chef', 'register'), false)
  assert.equal(roleHasCapability('inventory_manager', 'inventory'), true)
  assert.equal(roleHasCapability('inventory_manager', 'register'), false)
})

test('rider has no capability yet -- no dedicated screen exists', () => {
  for (const capability of ['register', 'floor', 'kitchen', 'inventory', 'staff'] as const) {
    assert.equal(roleHasCapability('rider', capability), false)
  }
})

test('STAFF_ROLES lists all six roles exactly once', () => {
  assert.equal(STAFF_ROLES.length, 6)
  assert.equal(new Set(STAFF_ROLES).size, 6)
})
