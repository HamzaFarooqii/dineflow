import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { consumptionChoices, inPickingOrder, movementCost, previewWastage } from '../src/screens/inventory/wastage-estimate'
import { wastageApprovalPayload } from '../../../packages/domain/src/wastage-category'
import type { IngredientBatch, StockMovement } from '../src/lib/inventory'

const batch = (id: string, over: Partial<IngredientBatch>): IngredientBatch => ({
  id, store_id: 's', ingredient_id: 'i', quantity: '10', remaining_quantity: '10', received_at: '2026-09-10T00:00:00Z', expires_at: null,
  cost_per_unit_cents: 100, reference: null, received_by_name: null, allocation_count: 0, consumed_quantity: '0', wasted_quantity: '0', allocated_cost_cents: '0', ...over,
})

test('batches are previewed in the same physical picking order the database uses', () => {
  const ordered = inPickingOrder([
    batch('c-none', { received_at: '2026-09-01T00:00:00Z' }),
    batch('b-late', { expires_at: '2026-12-01T00:00:00Z' }),
    batch('a-new', { expires_at: '2026-11-01T00:00:00Z', received_at: '2026-09-20T00:00:00Z' }),
    batch('a-old', { expires_at: '2026-11-01T00:00:00Z', received_at: '2026-09-10T00:00:00Z' }),
  ])
  assert.deepEqual(ordered.map(item => item.id), ['a-old', 'a-new', 'b-late', 'c-none'])
})

test('a quantity spanning batches previews each batch at its own cost and matches the API example (4@50 + 2@80 = 360)', () => {
  const preview = previewWastage({
    quantity: '6', explicitBatchId: null, ingredientCostCents: 70, currentStock: '14', thresholdCents: 5000,
    batches: [batch('A', { quantity: '4', remaining_quantity: '4', cost_per_unit_cents: 50, expires_at: '2026-10-05T00:00:00Z' }), batch('B', { cost_per_unit_cents: 80, expires_at: '2026-11-05T00:00:00Z' })],
  })
  assert.ok(preview.ok)
  assert.deepEqual(preview.allocations.map(a => [a.batchId, a.quantity, a.unitCostCents, a.costCents]), [['A', '4', 50, 200], ['B', '2', 80, 160]])
  assert.deepEqual([preview.knownCents, preview.estimatedCents, preview.totalCents], [360, 0, 360])
  assert.equal(preview.requiresVerifiedApproval, false)
})

test('quantity no batch covers is previewed as an explicit estimate at the ingredient cost', () => {
  const preview = previewWastage({
    quantity: '5', explicitBatchId: null, ingredientCostCents: 70, currentStock: '6', thresholdCents: null,
    batches: [batch('A', { quantity: '2', remaining_quantity: '2', cost_per_unit_cents: 50 })],
  })
  assert.ok(preview.ok)
  assert.deepEqual([preview.knownCents, preview.estimatedCents], [100, 210])
  assert.equal(preview.allocations[1].basis, 'estimated_ingredient_cost')
  assert.equal(preview.requiresVerifiedApproval, false, 'unknown policy never claims approval is required')
})

test('the approval gate previews at exactly the threshold boundary, with no rounding up', () => {
  const run = (quantity: string) => previewWastage({
    quantity, explicitBatchId: null, ingredientCostCents: 100, currentStock: '1000', thresholdCents: 5000,
    batches: [batch('A', { quantity: '1000', remaining_quantity: '1000', cost_per_unit_cents: 100 })],
  })
  const below = run('49.999999'), at = run('50')
  assert.ok(below.ok && at.ok)
  assert.equal(below.requiresVerifiedApproval, false)
  assert.equal(at.requiresVerifiedApproval, true)
})

test('invalid previews explain themselves instead of guessing', () => {
  const base = { explicitBatchId: null, ingredientCostCents: 100, currentStock: '5', thresholdCents: null, batches: [batch('A', { remaining_quantity: '5' })] }
  assert.deepEqual(previewWastage({ ...base, quantity: '0' }), { ok: false, reason: 'Enter a quantity greater than zero.' })
  assert.deepEqual(previewWastage({ ...base, quantity: 'abc' }), { ok: false, reason: 'Enter a quantity greater than zero.' })
  assert.match((previewWastage({ ...base, quantity: '6' }) as { reason: string }).reason, /Only 5 in stock/)
  assert.match((previewWastage({ ...base, quantity: '3', explicitBatchId: 'missing' }) as { reason: string }).reason, /nothing remaining/)
  assert.match((previewWastage({ ...base, quantity: '9', currentStock: '9', explicitBatchId: 'A' }) as { reason: string }).reason, /Only 5 remaining in that batch/)
})

const movement = (over: Partial<StockMovement>): StockMovement => ({
  id: 'm', store_id: 's', ingredient_id: 'i', batch_id: null, delta: '-1', reason: 'consumption', note: null, kitchen_ticket_item_id: null,
  created_at: '2026-10-02T10:00:00Z', created_by_user_id: null, created_by_name: null, wastage_category: null, stock_effect: null,
  approval_method: null, approval_required: null, approval_threshold_cents: null, approved_by_name: null,
  cost_source: null, known_cost_cents: null, estimated_cost_cents: null, allocations: [], ...over,
})

test('returned-dish choices are the served items that consumed this ingredient, one per item, newest first', () => {
  const choices = consumptionChoices([
    movement({ id: '1', kitchen_ticket_item_id: 'item-b', delta: '-2.5', created_at: '2026-10-02T12:00:00Z' }),
    movement({ id: '2', kitchen_ticket_item_id: 'item-a', delta: '-1', created_at: '2026-10-02T11:00:00Z' }),
    movement({ id: '3', kitchen_ticket_item_id: 'item-a', delta: '-1' }),
    movement({ id: '4', reason: 'wastage', kitchen_ticket_item_id: 'item-z' }),
    movement({ id: '5', reason: 'purchase', delta: '5' }),
  ])
  assert.deepEqual(choices.map(choice => [choice.kitchenTicketItemId, choice.consumed]), [['item-b', '2.5'], ['item-a', '1']])
})

test('movement cost is split by certainty and unknown legacy rows return null rather than a made-up number', () => {
  assert.deepEqual(movementCost(movement({ cost_source: 'allocation_snapshot', known_cost_cents: '360', estimated_cost_cents: '140.5' })), { knownCents: 360, estimatedCents: 141 })
  assert.equal(movementCost(movement({ cost_source: 'unknown', known_cost_cents: '0', estimated_cost_cents: '0' })), null)
  assert.equal(movementCost(movement({ cost_source: null })), null)
  assert.deepEqual(movementCost(movement({ cost_source: 'legacy_batch_derived', known_cost_cents: '120', estimated_cost_cents: '0' })), { knownCents: 120, estimatedCents: 0 })
})

test('the approval payload the terminal binds a PIN to has a stable key order, identical to what the API hashes', () => {
  const payload = wastageApprovalPayload({
    ingredientId: 'ing', quantity: '0.25', category: 'spoiled', stockEffect: 'deduct', note: null, batchId: null, kitchenTicketItemId: null,
  }, 'op-1')
  assert.deepEqual(Object.keys(payload), ['operation_id', 'ingredient_id', 'quantity', 'wastage_category', 'stock_effect', 'note', 'batch_id', 'kitchen_ticket_item_id'])
  // Same recipe as apps/api/src/terminal-auth/manager-approval.ts hashApprovalPayload.
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  assert.equal(hash, createHash('sha256').update('{"operation_id":"op-1","ingredient_id":"ing","quantity":"0.25","wastage_category":"spoiled","stock_effect":"deduct","note":null,"batch_id":null,"kitchen_ticket_item_id":null}').digest('hex'))
})
