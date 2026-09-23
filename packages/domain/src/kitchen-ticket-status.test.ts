import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTicketStatus, KITCHEN_TICKET_ITEM_TRANSITIONS, type KitchenTicketStatus } from './kitchen-ticket-status.ts'

test('a ticket with no items yet, or all-queued items, is queued', () => {
  assert.equal(deriveTicketStatus([]), 'queued')
  assert.equal(deriveTicketStatus(['queued', 'queued']), 'queued')
})
test('any active item in progress makes the ticket preparing', () => {
  assert.equal(deriveTicketStatus(['queued', 'preparing']), 'preparing')
  assert.equal(deriveTicketStatus(['ready', 'preparing']), 'preparing')
})
test('the ticket is ready only once every active item is ready or served', () => {
  assert.equal(deriveTicketStatus(['ready', 'served']), 'ready')
  assert.equal(deriveTicketStatus(['ready', 'preparing']), 'preparing')
})
test('the ticket is served only once every active item is served', () => {
  assert.equal(deriveTicketStatus(['served', 'served']), 'served')
  assert.equal(deriveTicketStatus(['served', 'ready']), 'ready')
})
test('cancelled items are ignored unless every item on the ticket is cancelled', () => {
  assert.equal(deriveTicketStatus(['served', 'cancelled']), 'served')
  assert.equal(deriveTicketStatus(['cancelled', 'cancelled']), 'cancelled')
})
test('item transitions are forward-only, ending at served, with cancellation available until then', () => {
  const statuses: KitchenTicketStatus[] = ['queued', 'preparing', 'ready', 'served', 'cancelled']
  for (const status of statuses) assert.ok(Array.isArray(KITCHEN_TICKET_ITEM_TRANSITIONS[status]))
  assert.deepEqual(KITCHEN_TICKET_ITEM_TRANSITIONS.served, [])
  assert.deepEqual(KITCHEN_TICKET_ITEM_TRANSITIONS.cancelled, [])
  assert.ok(KITCHEN_TICKET_ITEM_TRANSITIONS.queued.includes('preparing'))
  assert.ok(!KITCHEN_TICKET_ITEM_TRANSITIONS.queued.includes('ready'))
})
