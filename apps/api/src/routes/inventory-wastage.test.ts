import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { WASTAGE_CATEGORIES, wastageApprovalPayload, type WastageOperationFields } from '../../../../packages/domain/src/wastage-category.js'
import {
  addBatch, addKitchenItem, addTerminal, clientFor, inTransaction, remainingOf, seededInventoryDatabase, seedInventoryFixture, stockOf,
  type InventoryFixture,
} from './inventory-test-support.js'

// recordWastageCore is the real write path behind POST /inventory|/pos/inventory/ingredients/:id/wastage;
// the HTTP handler only adds authentication and the response envelope. Run against PGlite so the
// constraints, locks-by-statement-order and approval-token redemption are the real ones.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { parseWastageInput, recordWastageCore } = await import('./inventory.js')
const { consumeRecipeIngredients } = await import('./kitchen.js')
const { hashApprovalPayload } = await import('../terminal-auth/manager-approval.js')
const { digest } = await import('../terminal-auth/security.js')

type Actor = Parameters<typeof recordWastageCore>[4]
const web = (f: InventoryFixture): Actor => ({ kind: 'web', userId: f.owner })

function record(f: InventoryFixture, body: Record<string, unknown>, actor: Actor = web(f), ingredient = f.ingredient, store = f.store) {
  const input = parseWastageInput({ operation_id: randomUUID(), quantity: 1, wastage_category: 'spoiled', ...body })
  return inTransaction(f.database, client => recordWastageCore({ client, approvalPool: client }, store, ingredient, input, actor))
}

const rejectsWith = (status: number, code: string) => (error: unknown) => {
  const e = error as { status?: number; code?: string }
  assert.equal(e.status, status, String((error as Error).message))
  assert.equal(e.code, code)
  return true
}

async function fixture(options: Parameters<typeof seedInventoryFixture>[1] = { stock: 20 }) {
  const database = await seededInventoryDatabase()
  return seedInventoryFixture(database, options)
}

async function movements(database: PGlite, ingredient: string) {
  return (await database.query<{ id: string; reason: string; delta: string; note: string | null; wastage_category: string | null; stock_effect: string | null; approval_method: string | null; manager_id: string | null }>(
    `select id, reason, delta::text as delta, note, wastage_category, stock_effect, approval_method, manager_id from public.stock_movements where ingredient_id=$1 and reason='wastage' order by created_at, id`, [ingredient])).rows
}

test('every structured category records as reason wastage with the category and the free-text note preserved', async () => {
  const f = await fixture({ stock: 100 })
  try {
    await addBatch(f.database, f, f.ingredient, { quantity: 100, costCents: 70 })
    for (const category of WASTAGE_CATEGORIES.filter(item => item !== 'returned_order')) {
      await record(f, { wastage_category: category, note: `note for ${category}`, quantity: 1 })
    }
    const rows = await movements(f.database, f.ingredient)
    assert.equal(rows.length, WASTAGE_CATEGORIES.length - 1)
    assert.ok(rows.every(row => row.reason === 'wastage' && row.stock_effect === 'deduct' && Number(row.delta) === -1 && row.approval_method === 'web_manager_session'))
    assert.deepEqual(rows.map(row => row.wastage_category).sort(), WASTAGE_CATEGORIES.filter(item => item !== 'returned_order').sort())
    assert.ok(rows.every(row => row.note === `note for ${row.wastage_category}`))
    assert.equal(await stockOf(f.database, f.ingredient), 100 - rows.length)
  } finally { await f.database.close() }
})

test('input validation: free-text reasons, missing operation id, required notes and stock-effect rules are rejected', () => {
  const body = { operation_id: randomUUID(), quantity: 1, wastage_category: 'spoiled' }
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'Spoilage' }), /wastage_category must be one of/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: undefined }), /wastage_category must be one of/)
  assert.throws(() => parseWastageInput({ ...body, operation_id: undefined }), /operation_id/)
  assert.throws(() => parseWastageInput({ ...body, operation_id: 'nope' }), /operation_id/)
  assert.throws(() => parseWastageInput({ ...body, quantity: 0 }), /positive/)
  assert.throws(() => parseWastageInput({ ...body, quantity: 'abc' }), /positive/)
  assert.throws(() => parseWastageInput({ ...body, quantity: '0.0000001' }), /at least 0.000001/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'other' }), /note is required/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'discrepancy', note: '  ' }), /note is required/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'spoiled', stock_effect: 'already_consumed', kitchen_ticket_item_id: randomUUID() }), /does not allow/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'returned_order', stock_effect: 'deduct' }), /does not allow/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'returned_order' }), /must reference the kitchen_ticket_item_id/)
  assert.throws(() => parseWastageInput({ ...body, kitchen_ticket_item_id: randomUUID() }), /only valid for returned-dish/)
  assert.throws(() => parseWastageInput({ ...body, wastage_category: 'returned_order', kitchen_ticket_item_id: randomUUID(), batch_id: randomUUID() }), /cannot be chosen/)
  assert.doesNotThrow(() => parseWastageInput({ ...body, wastage_category: 'returned_order', kitchen_ticket_item_id: randomUUID() }))
  assert.equal(parseWastageInput({ ...body, quantity: 0.1 + 0.2 }).quantityMicro, 300_000n)
})

test('duplicate operation id with the same payload replays; the same id with different content is a conflict; nothing is written twice', async () => {
  const f = await fixture()
  try {
    const batch = await addBatch(f.database, f, f.ingredient, { quantity: 20, costCents: 70 })
    const operation_id = randomUUID()
    const first = await record(f, { operation_id, quantity: 3, note: 'dropped tray' })
    const replay = await record(f, { operation_id, quantity: 3, note: 'dropped tray' })
    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.movementId, first.movementId)
    assert.equal(await stockOf(f.database, f.ingredient), 17)
    assert.equal(await remainingOf(f.database, batch), 17)
    assert.equal((await movements(f.database, f.ingredient)).length, 1)
    assert.equal((await f.database.query('select 1 from public.stock_movement_allocations')).rows.length, 1)

    await assert.rejects(record(f, { operation_id, quantity: 4, note: 'dropped tray' }), rejectsWith(409, 'operation_conflict'))
    await assert.rejects(record(f, { operation_id, quantity: 3, note: 'dropped tray', wastage_category: 'damaged' }), rejectsWith(409, 'operation_conflict'))
    await assert.rejects(record(f, { operation_id, quantity: 3, note: 'a different note' }), rejectsWith(409, 'operation_conflict'))
    const other = randomUUID()
    await f.database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Sugar',$3,10,10)`, [other, f.store, f.kg])
    await assert.rejects(record(f, { operation_id, quantity: 3, note: 'dropped tray' }, web(f), other), rejectsWith(409, 'operation_conflict'))
    assert.equal(await stockOf(f.database, f.ingredient), 17, 'conflicts changed nothing')
  } finally { await f.database.close() }
})

test('concurrent identical operations record exactly once', async () => {
  const f = await fixture()
  try {
    await addBatch(f.database, f, f.ingredient, { quantity: 20, costCents: 70 })
    const operation_id = randomUUID()
    const results = await Promise.all([record(f, { operation_id, quantity: 5 }), record(f, { operation_id, quantity: 5 })])
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true])
    assert.equal(await stockOf(f.database, f.ingredient), 15)
    assert.equal((await movements(f.database, f.ingredient)).length, 1)
  } finally { await f.database.close() }
})

test('wastage beyond aggregate stock is rejected and writes nothing', async () => {
  const f = await fixture({ stock: 5 })
  try {
    const batch = await addBatch(f.database, f, f.ingredient, { quantity: 5, costCents: 70 })
    await assert.rejects(record(f, { quantity: 5.000001 }), rejectsWith(422, 'validation_failed'))
    assert.equal(await stockOf(f.database, f.ingredient), 5)
    assert.equal(await remainingOf(f.database, batch), 5)
    assert.equal((await movements(f.database, f.ingredient)).length, 0)
    await record(f, { quantity: 5 }) // exactly the stock is allowed
    assert.equal(await stockOf(f.database, f.ingredient), 0)
  } finally { await f.database.close() }
})

test('wastage spans batches in picking order and snapshots each batch cost', async () => {
  const f = await fixture({ stock: 14 })
  try {
    const soon = await addBatch(f.database, f, f.ingredient, { quantity: 4, costCents: 50, expiresAt: '2026-10-05T00:00:00Z' })
    const later = await addBatch(f.database, f, f.ingredient, { quantity: 10, costCents: 80, expiresAt: '2026-11-05T00:00:00Z' })
    await record(f, { quantity: 6 })
    const allocations = await f.database.query<{ batch_id: string; quantity: string; cost_cents: string }>('select batch_id, quantity::text as quantity, cost_cents::text as cost_cents from public.stock_movement_allocations order by sequence')
    assert.deepEqual(allocations.rows.map(a => [a.batch_id, Number(a.quantity), Number(a.cost_cents)]), [[soon, 4, 200], [later, 2, 160]])
    assert.equal(await remainingOf(f.database, soon), 0)
    assert.equal(await remainingOf(f.database, later), 8)
    assert.equal(await stockOf(f.database, f.ingredient), 8)
    assert.equal((await f.database.query('select batch_id from public.stock_movements where reason=$1', ['wastage'])).rows[0].batch_id, null)
  } finally { await f.database.close() }
})

test('wastage within aggregate stock but beyond batch coverage keeps the uncovered part as an explicit estimate', async () => {
  const f = await fixture({ stock: 6, ingredientCostCents: 70 })
  try {
    await addBatch(f.database, f, f.ingredient, { quantity: 2, costCents: 50 })
    await record(f, { quantity: 5 })
    const lines = await f.database.query<{ known: string; estimated: string; has_estimate: boolean }>(
      `select known_cost_cents::text as known, estimated_cost_cents::text as estimated, has_estimate from public.stock_movement_cost_lines where reason='wastage'`)
    assert.deepEqual([Number(lines.rows[0].known), Number(lines.rows[0].estimated), lines.rows[0].has_estimate], [100, 210, true])
  } finally { await f.database.close() }
})

test('an explicit batch is honoured, must cover the quantity, and must belong to this store and ingredient', async () => {
  const f = await fixture({ stock: 30 })
  try {
    const first = await addBatch(f.database, f, f.ingredient, { quantity: 5, costCents: 50, expiresAt: '2026-10-05T00:00:00Z' })
    const chosen = await addBatch(f.database, f, f.ingredient, { quantity: 5, costCents: 90, expiresAt: '2026-12-05T00:00:00Z' })
    await record(f, { quantity: 2, batch_id: chosen })
    assert.equal(await remainingOf(f.database, chosen), 3)
    assert.equal(await remainingOf(f.database, first), 5, 'the soonest-expiring batch is not touched when another is chosen')
    assert.equal((await f.database.query('select batch_id from public.stock_movements where reason=$1', ['wastage'])).rows[0].batch_id, chosen)
    await assert.rejects(record(f, { quantity: 8, batch_id: chosen }), /only 3 remaining in it/)

    const sugar = randomUUID()
    await f.database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Sugar',$3,10,10)`, [sugar, f.store, f.kg])
    const wrongIngredient = await addBatch(f.database, f, sugar, { quantity: 5, costCents: 10 })
    await assert.rejects(record(f, { quantity: 1, batch_id: wrongIngredient }), /does not belong to this ingredient/)

    const otherUnit = await f.database.query<{ id: string }>('select id from public.units where store_id=$1 limit 1', [f.otherStore])
    const foreign = randomUUID(), foreignBatch = randomUUID()
    await f.database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Salt',$3,10,10)`, [foreign, f.otherStore, otherUnit.rows[0].id])
    await f.database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents) values ($1,$2,$3,5,5,10)`, [foreignBatch, f.otherStore, foreign])
    await assert.rejects(record(f, { quantity: 1, batch_id: foreignBatch }), /does not belong to this ingredient/)
    assert.equal(await remainingOf(f.database, foreignBatch), 5)
    await assert.rejects(record(f, { quantity: 1 }, web(f), foreign), rejectsWith(404, 'ingredient_not_found'))
  } finally { await f.database.close() }
})

test('fractional wastage is exact: 0.1 + 0.2 kg leaves 0.3 kg removed', async () => {
  const f = await fixture({ stock: 1 })
  try {
    const batch = await addBatch(f.database, f, f.ingredient, { quantity: 1, costCents: 1000 })
    await record(f, { quantity: 0.1 })
    await record(f, { quantity: 0.2 })
    assert.equal(await remainingOf(f.database, batch), 0.7)
    assert.equal(await stockOf(f.database, f.ingredient), 0.7)
    const total = await f.database.query<{ cost: string }>('select sum(cost_cents)::text as cost from public.stock_movement_allocations')
    assert.equal(Number(total.rows[0].cost), 300)
  } finally { await f.database.close() }
})

test('concurrent wastage and consumption of one ingredient stay consistent in either order', async () => {
  for (const consumptionFirst of [false, true]) {
    const f = await fixture({ stock: 5 })
    try {
      const batch = await addBatch(f.database, f, f.ingredient, { quantity: 5, costCents: 100 })
      const { product, itemId } = await addKitchenItem(f.database, f, f.ingredient, f.kg, 3)
      const wasteTask = () => record(f, { quantity: 4 }).then(() => 'wasted' as const, (error: { code?: string }) => error.code ?? 'error')
      const consumeTask = () => inTransaction(f.database, client => consumeRecipeIngredients(client, f.store, itemId, product, 1)).then(() => 'consumed' as const)
      const outcomes = consumptionFirst ? (await Promise.all([consumeTask(), wasteTask()])).reverse() : await Promise.all([wasteTask(), consumeTask()])
      const stock = await stockOf(f.database, f.ingredient)
      const remaining = await remainingOf(f.database, batch)
      if (outcomes[0] === 'wasted') {
        assert.equal(stock, -2, 'waste took 4 of 5, then service consumed 3 and went negative as policy allows')
        assert.equal(remaining, 0)
      } else {
        assert.equal(outcomes[0], 'validation_failed', 'wastage after consumption has only 2 left, so it is rejected')
        assert.equal(stock, 2)
        assert.equal(remaining, 2)
      }
      assert.equal(outcomes[1], 'consumed', 'service is never blocked')
    } finally { await f.database.close() }
  }
})

// --- approval ----------------------------------------------------------------------------------

function terminalActor(terminal: { deviceId: string; cashierId: string }, extra: Partial<Extract<Actor, { kind: 'terminal' }>> = {}): Actor {
  return { kind: 'terminal', employeeId: terminal.cashierId, deviceId: terminal.deviceId, approvalToken: null, legacyManagerId: null, legacyManagerApprovedAt: null, ...extra }
}

function fieldsFor(f: InventoryFixture, input: ReturnType<typeof parseWastageInput>): WastageOperationFields {
  return {
    ingredientId: f.ingredient, quantity: (Number(input.quantityMicro) / 1_000_000).toString(), category: input.category, stockEffect: input.stockEffect,
    note: input.note, batchId: input.batchId, kitchenTicketItemId: input.kitchenTicketItemId,
  }
}

async function issueToken(f: InventoryFixture, terminal: { deviceId: string; managerId: string }, payload: unknown, options: { expired?: boolean; consumed?: boolean } = {}) {
  const token = randomUUID() + randomUUID()
  await f.database.query(
    `insert into public.terminal_manager_approvals(store_id,device_id,manager_id,action,payload_hash,token_hash,expires_at,consumed_at)
     values ($1,$2,$3,'inventory.wastage.record',$4,$5, now() ${options.expired ? "- interval '1 minute'" : "+ interval '2 minutes'"}, ${options.consumed ? 'now()' : 'null'})`,
    [f.store, terminal.deviceId, terminal.managerId, hashApprovalPayload(payload), digest(token)])
  return token
}

test('threshold boundary: cost strictly below passes with legacy evidence; at or above needs a verified approval', async () => {
  const f = await fixture({ stock: 1000, ingredientCostCents: 100 })
  try {
    const terminal = await addTerminal(f.database, f)
    await addBatch(f.database, f, f.ingredient, { quantity: 1000, costCents: 100 })
    const legacy = terminalActor(terminal, { legacyManagerId: terminal.managerId, legacyManagerApprovedAt: new Date().toISOString() })

    // default threshold 5000 cents; 100 c/kg
    await record(f, { quantity: 49.99 }, legacy) // 4999 c
    await record(f, { quantity: 49.999999 }, legacy) // 4999.9999 c -- a hair under, no rounding up into the gate
    for (const quantity of [50, 50.000001, 500]) {
      await assert.rejects(record(f, { quantity }, legacy), rejectsWith(403, 'verified_approval_required'))
    }
    const rows = await movements(f.database, f.ingredient)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.approval_method === 'terminal_legacy_evidence'))
    assert.equal(await stockOf(f.database, f.ingredient), 1000 - 49.99 - 49.999999, 'rejected entries moved no stock')
  } finally { await f.database.close() }
})

test('the threshold is per-store configurable, including 0 (gate everything) and web sessions are never gated', async () => {
  const f = await fixture({ stock: 100, ingredientCostCents: 100 })
  try {
    const terminal = await addTerminal(f.database, f)
    await addBatch(f.database, f, f.ingredient, { quantity: 100, costCents: 100 })
    const legacy = terminalActor(terminal, { legacyManagerId: terminal.managerId, legacyManagerApprovedAt: new Date().toISOString() })
    await f.database.query('insert into public.inventory_policies(store_id,wastage_approval_threshold_cents) values ($1,0)', [f.store])
    await assert.rejects(record(f, { quantity: 0.01 }, legacy), rejectsWith(403, 'verified_approval_required'))
    await record(f, { quantity: 50 }) // owner/manager web session: its own authority
    await f.database.query('update public.inventory_policies set wastage_approval_threshold_cents = 100000 where store_id=$1', [f.store])
    await record(f, { quantity: 40 }, legacy) // 4000 c, now well under
    const rows = await movements(f.database, f.ingredient)
    assert.deepEqual(rows.map(row => row.approval_method), ['web_manager_session', 'terminal_legacy_evidence'])
    const policy = await f.database.query<{ approval_required: boolean; approval_threshold_cents: number }>('select approval_required, approval_threshold_cents from public.stock_movements where reason=$1 order by created_at, id', ['wastage'])
    assert.deepEqual(policy.rows.map(row => [row.approval_required, row.approval_threshold_cents]), [[true, 0], [false, 100000]])
  } finally { await f.database.close() }
})

test('a legitimate verified approval token is accepted once, bound to this exact payload and operation', async () => {
  const f = await fixture({ stock: 100, ingredientCostCents: 100 })
  try {
    const terminal = await addTerminal(f.database, f)
    await addBatch(f.database, f, f.ingredient, { quantity: 100, costCents: 100 })
    const operationId = randomUUID()
    const body = { operation_id: operationId, quantity: 60, wastage_category: 'expired', note: 'walk-in failure' }
    const input = parseWastageInput(body)
    const token = await issueToken(f, terminal, wastageApprovalPayload(fieldsFor(f, input), operationId))
    const actor = terminalActor(terminal, { approvalToken: token })
    const result = await record(f, body, actor)
    assert.equal(result.replayed, false)
    const [row] = await movements(f.database, f.ingredient)
    assert.equal(row.approval_method, 'terminal_verified_token')
    assert.equal(row.manager_id, terminal.managerId, 'the manager comes from the server-verified token, not from the client')
    assert.ok((await f.database.query('select consumed_at from public.terminal_manager_approvals')).rows[0].consumed_at)

    // The same token cannot authorise a second, different operation...
    await assert.rejects(record(f, { ...body, operation_id: randomUUID(), quantity: 30 }, actor), rejectsWith(422, 'approval_invalid'))
    // ...but a retry of the SAME operation replays the original result without needing the spent token.
    assert.equal((await record(f, body, actor)).replayed, true)
    assert.equal(await stockOf(f.database, f.ingredient), 40)
  } finally { await f.database.close() }
})

test('forged, mismatched, expired, spent and cross-device approvals are all rejected and write nothing', async () => {
  const f = await fixture({ stock: 100, ingredientCostCents: 100 })
  try {
    const terminal = await addTerminal(f.database, f)
    const otherDevice = await addTerminal(f.database, f)
    await addBatch(f.database, f, f.ingredient, { quantity: 100, costCents: 100 })
    const body = { quantity: 60, wastage_category: 'expired', note: 'x' }
    const attempt = async (token: string | null, mutate: Record<string, unknown> = {}, actor: Actor = terminalActor(terminal, { approvalToken: token })) =>
      record(f, { ...body, ...mutate }, actor)
    const bound = (operationId: string, mutate: Record<string, unknown> = {}) =>
      wastageApprovalPayload(fieldsFor(f, parseWastageInput({ operation_id: operationId, ...body, ...mutate })), operationId)

    // 1. a made-up token
    await assert.rejects(attempt('forged-token-' + randomUUID()), rejectsWith(422, 'approval_invalid'))
    // 2. a real token issued for a smaller quantity, replayed against a bigger one
    const opSmall = randomUUID()
    const small = await issueToken(f, terminal, bound(opSmall, { quantity: 1 }))
    await assert.rejects(attempt(small, { operation_id: opSmall }), rejectsWith(422, 'approval_invalid'))
    // 3. a real token issued for another operation id
    const tokenForA = await issueToken(f, terminal, bound(randomUUID()))
    await assert.rejects(attempt(tokenForA, { operation_id: randomUUID() }), rejectsWith(422, 'approval_invalid'))
    // 4. expired
    const opExpired = randomUUID()
    await assert.rejects(attempt(await issueToken(f, terminal, bound(opExpired), { expired: true }), { operation_id: opExpired }), rejectsWith(422, 'approval_invalid'))
    // 5. already consumed
    const opSpent = randomUUID()
    await assert.rejects(attempt(await issueToken(f, terminal, bound(opSpent), { consumed: true }), { operation_id: opSpent }), rejectsWith(422, 'approval_invalid'))
    // 6. valid for a different device
    const opDevice = randomUUID()
    const wrongDevice = await issueToken(f, otherDevice, bound(opDevice))
    await assert.rejects(attempt(wrongDevice, { operation_id: opDevice }), rejectsWith(422, 'approval_invalid'))
    // 7. forged legacy evidence above the threshold: a real manager id and a timestamp prove nothing
    await assert.rejects(attempt(null, {}, terminalActor(terminal, { legacyManagerId: terminal.managerId, legacyManagerApprovedAt: new Date().toISOString() })), rejectsWith(403, 'verified_approval_required'))

    assert.equal((await movements(f.database, f.ingredient)).length, 0)
    assert.equal(await stockOf(f.database, f.ingredient), 100)
  } finally { await f.database.close() }
})

test('below the threshold the pre-existing legacy rules still hold: a manager is required and must be an active manager of this store', async () => {
  const f = await fixture({ stock: 100, ingredientCostCents: 10 })
  try {
    const terminal = await addTerminal(f.database, f)
    const stranger = await addTerminal(f.database, { store: f.otherStore, owner: f.owner })
    await addBatch(f.database, f, f.ingredient, { quantity: 100, costCents: 10 })
    const now = new Date().toISOString()
    await assert.rejects(record(f, { quantity: 1 }, terminalActor(terminal)), rejectsWith(422, 'validation_failed')) // no manager at all
    await assert.rejects(record(f, { quantity: 1 }, terminalActor(terminal, { legacyManagerId: terminal.cashierId, legacyManagerApprovedAt: now })), /not an active manager/)
    await assert.rejects(record(f, { quantity: 1 }, terminalActor(terminal, { legacyManagerId: stranger.managerId, legacyManagerApprovedAt: now })), /not an active manager/)
    assert.equal((await movements(f.database, f.ingredient)).length, 0)
    await record(f, { quantity: 1 }, terminalActor(terminal, { legacyManagerId: terminal.managerId, legacyManagerApprovedAt: now }))
    assert.equal((await movements(f.database, f.ingredient)).length, 1)
  } finally { await f.database.close() }
})

// --- returned dishes ---------------------------------------------------------------------------

test('a returned dish is costed from what it consumed and never deducts those ingredients a second time', async () => {
  const f = await fixture({ stock: 14 })
  try {
    const soon = await addBatch(f.database, f, f.ingredient, { quantity: 4, costCents: 50, expiresAt: '2026-10-05T00:00:00Z' })
    const later = await addBatch(f.database, f, f.ingredient, { quantity: 10, costCents: 80, expiresAt: '2026-11-05T00:00:00Z' })
    const { product, itemId } = await addKitchenItem(f.database, f, f.ingredient, f.kg, 6)
    await consumeRecipeIngredients(clientFor(f.database), f.store, itemId, product, 1) // 4 kg @50 + 2 kg @80
    const stockAfterServe = await stockOf(f.database, f.ingredient)
    assert.equal(stockAfterServe, 8)

    await record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: itemId, quantity: 5, note: 'guest sent it back' })
    assert.equal(await stockOf(f.database, f.ingredient), stockAfterServe, 'aggregate stock is untouched')
    assert.equal(await remainingOf(f.database, soon), 0)
    assert.equal(await remainingOf(f.database, later), 8, 'batches are untouched')
    const [row] = await movements(f.database, f.ingredient)
    assert.deepEqual([row.stock_effect, Number(row.delta), row.wastage_category], ['already_consumed', 0, 'returned_order'])
    assert.equal((await f.database.query(`select 1 from public.stock_movements where reason='consumption'`)).rows.length, 1, 'no second consumption row')

    const cost = await f.database.query<{ known: string; estimated: string; quantity: string }>(
      `select known_cost_cents::text as known, estimated_cost_cents::text as estimated, quantity::text as quantity from public.stock_movement_cost_lines where reason='wastage'`)
    assert.deepEqual([Number(cost.rows[0].quantity), Number(cost.rows[0].known), Number(cost.rows[0].estimated)], [5, 4 * 50 + 1 * 80, 0])

    // The remaining 1 kg of that dish (the 80c one) can still be returned; one more is too much.
    await record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: itemId, quantity: 1 })
    await assert.rejects(record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: itemId, quantity: 0.5 }), /Only 0 of what that item consumed/)
    const second = await f.database.query<{ unit_cost_cents: number }>(
      `select a.unit_cost_cents from public.stock_movement_allocations a join public.stock_movements m on m.id=a.stock_movement_id where m.reason='wastage' order by m.created_at, m.id, a.sequence`)
    assert.deepEqual(second.rows.map(r => r.unit_cost_cents), [50, 80, 80])
    assert.equal(await stockOf(f.database, f.ingredient), stockAfterServe)
  } finally { await f.database.close() }
})

test('a returned dish must reference a served item that actually consumed that ingredient', async () => {
  const f = await fixture({ stock: 10 })
  try {
    await addBatch(f.database, f, f.ingredient, { quantity: 10, costCents: 50 })
    const { itemId } = await addKitchenItem(f.database, f, f.ingredient, f.kg, 1) // never served -> no consumption movement
    await assert.rejects(record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: itemId, quantity: 1 }), /did not consume this ingredient/)
    assert.equal(await stockOf(f.database, f.ingredient), 10)
  } finally { await f.database.close() }
})

test('incorrect_order can either deduct (never served) or re-label an already-served dish', async () => {
  const f = await fixture({ stock: 10 })
  try {
    await addBatch(f.database, f, f.ingredient, { quantity: 10, costCents: 50 })
    await record(f, { wastage_category: 'incorrect_order', quantity: 2, note: 'wrong sauce, binned before serving' })
    assert.equal(await stockOf(f.database, f.ingredient), 8)
    const { product, itemId } = await addKitchenItem(f.database, f, f.ingredient, f.kg, 1)
    await consumeRecipeIngredients(clientFor(f.database), f.store, itemId, product, 1)
    await record(f, { wastage_category: 'incorrect_order', stock_effect: 'already_consumed', kitchen_ticket_item_id: itemId, quantity: 1 })
    assert.equal(await stockOf(f.database, f.ingredient), 7, 'only the serve deducted; the re-labelling did not')
  } finally { await f.database.close() }
})

test('a pre-Day-2 consumption (no allocation rows) is re-labelled using its recorded batch, or as an estimate when it had none', async () => {
  const f = await fixture({ stock: 10, ingredientCostCents: 70 })
  try {
    const batch = await addBatch(f.database, f, f.ingredient, { quantity: 10, costCents: 40 })
    const withBatch = await addKitchenItem(f.database, f, f.ingredient, f.kg, 1)
    const withoutBatch = await addKitchenItem(f.database, f, f.ingredient, f.kg, 1)
    await f.database.query(`insert into public.stock_movements(store_id,ingredient_id,batch_id,delta,reason,kitchen_ticket_item_id) values ($1,$2,$3,-2,'consumption',$4)`, [f.store, f.ingredient, batch, withBatch.itemId])
    await f.database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason,kitchen_ticket_item_id) values ($1,$2,-2,'consumption',$3)`, [f.store, f.ingredient, withoutBatch.itemId])
    await record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: withBatch.itemId, quantity: 1 })
    await record(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: withoutBatch.itemId, quantity: 1 })
    const lines = await f.database.query<{ known: string; estimated: string }>(
      `select known_cost_cents::text as known, estimated_cost_cents::text as estimated from public.stock_movement_cost_lines where reason='wastage' order by created_at, movement_id`)
    assert.deepEqual(lines.rows.map(row => [Number(row.known), Number(row.estimated)]).sort(), [[0, 70], [40, 0]].sort())
  } finally { await f.database.close() }
})
