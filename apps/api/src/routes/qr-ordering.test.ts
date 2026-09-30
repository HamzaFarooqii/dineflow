import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { Request } from 'express'
import { PGlite } from '@electric-sql/pglite'

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const qr = await import('./qr-ordering.js')
const hooks = await import('./qr-security-hooks.js')
const { ApiError } = await import('./auth.js')
const { editOpenCheckCore, closeOpenCheckCore, parseCheckItems } = await import('./open-checks.js')
const { applyTableStatusTransition } = await import('./floor.js')
const { createApp } = await import('../app.js')
const { db } = await import('../db.js')

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql', '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql', '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql', '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql', '202609180005_refunds.sql',
  '202609210001_restaurant_foundation.sql', '202609230001_kitchen_display_system.sql', '202609230002_table_waiter_assignment.sql',
  '202609240001_units_and_recipes.sql', '202609240002_ingredient_inventory.sql', '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql', '202609250002_inventory_batch_tracking.sql', '202609260001_unit_conversion.sql',
  '202609260003_service_charge.sql', '202609270001_modifiers.sql', '202609280002_open_checks.sql', '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql', '202609290001_kitchen_operations_depth.sql', '202609290002_sellable_combos.sql',
  '202609300001_qr_table_ordering.sql',
]

const database = new PGlite()
await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as 'select null::uuid';
  create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
for (const name of chain) await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))

// A pg client is one connection, so whole transactions are serialized here. Real Postgres gets the
// same ordering from the restaurant_tables row lock taken first in every write path.
let gate: Promise<void> = Promise.resolve()
const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
const run = async (sql: string, params?: unknown[]) => {
  const result = await database.query(sql, params)
  return { rows: result.rows as any[], rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
}
fixture.query = run
fixture.connect = async () => {
  const previous = gate
  let release!: () => void
  gate = new Promise<void>(resolve => { release = resolve })
  await previous
  return { query: run, release } as unknown as import('pg').PoolClient
}

await database.exec('alter table public.pos_products add column image_url text')
const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), area = randomUUID(), otherArea = randomUUID()
const taxRate = randomUUID(), sizeGroup = randomUUID(), large = randomUUID(), small = randomUUID(), sauceGroup = randomUUID(), sauce = randomUUID()
const burger = randomUUID(), fries = randomUUID(), soldOut = randomUUID(), comboProduct = randomUUID(), strangerProduct = randomUUID(), plate = randomUUID(), noOptionsProduct = randomUUID(), emptyGroup = randomUUID()
const foreignTable = randomUUID(), manager = randomUUID()
await database.query('insert into auth.users(id) values ($1)', [owner])
await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','qr-a',$2,'UTC'),($3,'Two','qr-b',$2,'UTC')", [store, owner, otherStore])
await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3),($4,$5,$3)', [area, store, 'Main', otherArea, otherStore])
await database.query("insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,'Foreign',2)", [foreignTable, otherStore, otherArea])
await database.query("insert into public.pos_tax_rates(id,store_id,name,rate_bps) values ($1,$2,'Std',1000)", [taxRate, store])
await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,tax_rate_id) values
  ($1,$2,'BUR','Burger',1000,$3),($4,$2,'FRY','Fries',300,null)`, [burger, store, taxRate, fries])
await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,is_available) values ($1,$2,'OUT','Sold out',500,false)`, [soldOut, store])
await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,sells_directly) values ($1,$2,'PLT','Plate',100,false)`, [plate, store])
await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'CMB','Combo',1500),($3,$4,'STR','Stranger',100),($5,$2,'NOP','Needs option',400)`, [comboProduct, store, strangerProduct, otherStore, noOptionsProduct])
await database.query("insert into public.combos(product_id,store_id,pricing_mode) values ($1,$2,'fixed')", [comboProduct, store])
await database.query("insert into public.modifier_groups(id,store_id,name,selection,required) values ($1,$2,'Size','single',true),($3,$2,'Sauce','multi',false),($4,$2,'Empty','single',true)", [sizeGroup, store, sauceGroup, emptyGroup])
await database.query("insert into public.modifier_options(id,store_id,group_id,name,price_delta_cents) values ($1,$2,$3,'Large',200),($4,$2,$3,'Small',0),($5,$2,$6,'Garlic',50)", [large, store, sizeGroup, small, sauce, sauceGroup])
await database.query('insert into public.product_modifier_groups(store_id,product_id,group_id) values ($1,$2,$3),($1,$2,$4),($1,$5,$6)', [store, burger, sizeGroup, sauceGroup, noOptionsProduct, emptyGroup])
await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Waiter','manager',repeat('a',32),repeat('b',64))`, [manager, store])
await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,50),($1,$3,50)', [store, burger, fries])

process.env.QR_ORDERING_ENABLED = 'true'

async function newTable(status = 'seated', opts: { mode?: string; confirm?: boolean } = {}) {
  const id = randomUUID()
  await database.query(
    `insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats,status,qr_mode,qr_require_confirmation) values ($1,$2,$3,$4,4,$5,$6,$7)`,
    [id, store, area, `T-${id.slice(0, 6)}`, status, opts.mode ?? 'menu_and_order', opts.confirm ?? true])
  const { code } = await qr.rotateQrCode(store, id)
  return { id, code }
}
async function phone(code: string) {
  const issued = await qr.issueQrSession(code)
  const req = { headers: { authorization: `Bearer ${issued.session_token}` } } as unknown as Request
  return { issued, req, session: () => qr.resolveQrSession(req) }
}
const order = (items: unknown[], extra: Record<string, unknown> = {}) => qr.parseSubmission({ operation_id: randomUUID(), items, ...extra })
const burgerLine = (extra: Record<string, unknown> = {}) => ({ product_id: burger, quantity: 1, modifier_option_ids: [large], ...extra })
const rejectsWith = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (reason: any) => { assert.equal(reason.code, code, reason.message); return true })
const throwsWith = (fn: () => unknown, code: string) => assert.throws(fn, (reason: any) => { assert.equal(reason.code, code, reason.message); return true })
const q = async (sql: string, params: unknown[] = []) => (await database.query(sql, params)).rows as any[]

test('feature flag: every public route fails closed while disabled', async () => {
  const server = createApp({ pool: {} as never, origin: 'http://app.test', supabaseUrl: 'http://x', supabaseKey: 'k', secureCookies: false }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  after(() => { server.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/qr`
  process.env.QR_ORDERING_ENABLED = 'false'
  try {
    for (const [method, path] of [['POST', '/sessions'], ['GET', '/menu'], ['POST', '/orders'], ['GET', '/orders']]) {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', origin: 'http://app.test' }, body: method === 'POST' ? '{}' : undefined })
      assert.equal(response.status, 404)
      assert.equal((await response.json() as any).code, 'feature_disabled')
    }
    delete process.env.QR_ORDERING_ENABLED
    assert.equal((await fetch(base + '/menu')).status, 404, 'unset is disabled too')
  } finally { process.env.QR_ORDERING_ENABLED = 'true' }
  const t = await newTable()
  const created = await fetch(base + '/sessions', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://app.test' }, body: JSON.stringify({ code: t.code }) })
  assert.equal(created.status, 201)
  assert.equal(created.headers.get('cache-control'), 'no-store')
  const body = await created.json() as any
  const menu = await fetch(base + '/menu', { headers: { authorization: `Bearer ${body.session_token}` } })
  assert.equal(menu.status, 200)
  // unauthenticated and malformed bearer tokens
  assert.equal((await fetch(base + '/menu')).status, 401)
  assert.equal((await fetch(base + '/orders', { headers: { authorization: 'Bearer nope' } })).status, 401)
  // a client-supplied table id in the session request is rejected, not trusted
  const spoof = await fetch(base + '/sessions', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://app.test' }, body: JSON.stringify({ code: t.code, table_id: foreignTable, store_id: otherStore }) })
  assert.equal(spoof.status, 422)
})

test('security hooks are called and can reject each public action', async () => {
  const t = await newTable()
  const server = createApp({ pool: {} as never, origin: 'http://app.test', supabaseUrl: 'http://x', supabaseKey: 'k', secureCookies: false }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  after(() => { server.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/public/qr`
  const json = { 'content-type': 'application/json', origin: 'http://app.test' }
  const p = await phone(t.code)
  const auth = { ...json, authorization: `Bearer ${p.issued.session_token}` }
  const seen: Array<[string, string | null]> = []
  const limited = (name: string) => async (ctx: { sessionId: string | null }) => { seen.push([name, ctx.sessionId]); throw new ApiError(429, 'rate_limited', 'slow down') }
  hooks.setQrSecurityHooks({ sessionIssuance: limited('issue'), orderSubmission: limited('order'), statusPolling: limited('poll') })
  try {
    assert.equal((await fetch(base + '/sessions', { method: 'POST', headers: json, body: JSON.stringify({ code: t.code }) })).status, 429)
    assert.equal((await fetch(base + '/orders', { method: 'POST', headers: auth, body: JSON.stringify({ operation_id: randomUUID(), items: [{ product_id: fries, quantity: 1 }] }) })).status, 429)
    assert.equal((await fetch(base + '/orders', { headers: auth })).status, 429)
    assert.equal((await fetch(base + '/menu', { headers: auth })).status, 429)
    assert.deepEqual(seen.map(entry => entry[0]), ['issue', 'order', 'poll', 'poll'])
    assert.equal(seen[1][1], (await p.session()).sessionId, 'submission hook receives the verified session id')
    assert.equal((await q('select count(*)::int as n from public.qr_submissions where table_id=$1', [t.id]))[0].n, 0, 'rejected before any work')
  } finally { hooks.resetQrSecurityHooks() }
  assert.equal((await fetch(base + '/menu', { headers: auth })).status, 200)
})

test('sessions: invalid, expired, revoked, rotated, and code lifecycle', async () => {
  const t = await newTable()
  await rejectsWith(qr.issueQrSession('a'.repeat(64)), 'qr_invalid')
  const p = await phone(t.code)
  assert.equal((await p.session()).tableId, t.id)
  assert.equal(p.issued.mode, 'menu_and_order')
  // the raw code and session token are never stored
  const stored = await q('select qr_code_hash from public.restaurant_tables where id=$1', [t.id])
  assert.notEqual(stored[0].qr_code_hash, t.code)
  assert.equal((await q('select count(*)::int as n from public.qr_sessions where token_hash=$1', [p.issued.session_token]))[0].n, 0)

  await database.query("update public.qr_sessions set expires_at = now() - interval '1 second', created_at = now() - interval '1 hour' where token_hash <> ''")
  await rejectsWith(p.session(), 'session_expired')
  const fresh = await phone(t.code)

  // rotating kills the old code and every session
  const rotated = await qr.rotateQrCode(store, t.id)
  await rejectsWith(fresh.session(), 'session_revoked')
  await rejectsWith(qr.issueQrSession(t.code), 'qr_invalid')
  const again = await phone(rotated.code)
  assert.equal((await again.session()).tableId, t.id)

  await qr.revokeQrCode(store, t.id)
  await rejectsWith(again.session(), 'session_revoked')
  await rejectsWith(qr.issueQrSession(rotated.code), 'qr_invalid')
})

test('issuance requires a table that is in service', async () => {
  for (const status of ['available', 'dirty', 'reserved', 'out_of_service']) {
    const t = await newTable(status)
    await rejectsWith(qr.issueQrSession(t.code), 'table_not_in_service')
  }
})

test('table lifecycle revokes sessions: cleaned, disabled, transferred, paid', async () => {
  for (const [, act] of [
    ['cleaned', (id: string) => database.query("update public.restaurant_tables set status='available' where id=$1", [id])],
    ['dirty after payment', (id: string) => database.query("update public.restaurant_tables set status='dirty' where id=$1", [id])],
    ['out of service', (id: string) => database.query("update public.restaurant_tables set status='out_of_service' where id=$1", [id])],
    ['disabled', (id: string) => database.query('update public.restaurant_tables set active=false where id=$1', [id])],
  ] as const) {
    const t = await newTable()
    const p = await phone(t.code)
    await p.session()
    await act(t.id)
    await rejectsWith(p.session(), 'session_revoked')
  }
  // a party that stays seated keeps its session through status moves between in-service states
  const t = await newTable('ordering')
  const p = await phone(t.code)
  await database.query("update public.restaurant_tables set status='bill_requested' where id=$1", [t.id])
  assert.equal((await p.session()).tableStatus, 'bill_requested')
  // ...but cannot order from a phone any more
  await rejectsWith(qr.submitQrOrder(await p.session(), order([burgerLine()])), 'table_not_accepting_orders')
  // and a new party at a reused table cannot resurrect the old session
  await database.query("update public.restaurant_tables set status='available' where id=$1", [t.id])
  await database.query("update public.restaurant_tables set status='seated' where id=$1", [t.id])
  await rejectsWith(p.session(), 'session_revoked')
})

test('public menu is a safe projection', async () => {
  const menu = await qr.loadPublicMenu(store)
  const names = menu.products.map(product => product.name)
  for (const name of ['Burger', 'Fries']) assert.equal(names.includes(name), true)
  for (const name of ['Sold out', 'Plate', 'Combo', 'Stranger', 'Needs option']) assert.equal(names.includes(name), false, name)
  assert.ok(true, 'sold-out, direct-sale-off, combo, needs-unavailable-option and other-store products are excluded')
  const text = JSON.stringify(menu)
  for (const leak of ['stock', 'tax', 'employee', 'store_id', 'sku', 'cost']) assert.equal(text.includes(leak), false, `menu leaks ${leak}`)
  const burgerEntry = menu.products.find(product => product.name === 'Burger')!
  assert.equal(burgerEntry.price_cents, 1000)
  assert.deepEqual(burgerEntry.modifier_groups.map(group => group.name).sort(), ['Sauce', 'Size'])
  await database.query('update public.pos_products set unavailable_until = now() + interval \'1 hour\' where id=$1', [fries])
  assert.equal((await qr.loadPublicMenu(store)).products.some(product => product.name === 'Fries'), false)
  await database.query('update public.pos_products set unavailable_until = null where id=$1', [fries])
})

test('submission parsing rejects tampering and client-supplied authority', () => {
  for (const key of ['price_cents', 'unit_price_cents', 'tax_bps', 'discount_value', 'manager_id', 'employee_id', 'snapshot_price_cents', 'payment', 'total_cents']) {
    throwsWith(() => order([burgerLine({ [key]: 1 })]), 'forbidden_field')
  }
  for (const key of ['store_id', 'table_id', 'check_id', 'employee_id', 'discount_cents', 'payments', 'status']) {
    throwsWith(() => order([burgerLine()], { [key]: randomUUID() }), 'forbidden_field')
  }
  for (const quantity of [0, -1, 21, 1.5, '2', null]) assert.throws(() => order([burgerLine({ quantity })]), /quantity/)
  assert.throws(() => order([]), /1 to 30/)
  assert.throws(() => order(new Array(31).fill(burgerLine())), /1 to 30/)
  assert.throws(() => order([burgerLine({ modifier_option_ids: [large, large] })]), /repeats/)
  assert.throws(() => order([burgerLine()], { note: 'x'.repeat(301) }), /Note/)
  assert.throws(() => qr.parseSubmission({ items: [burgerLine()] }), /Operation ID/)
})

test('confirmation mode: pending, no check, no kitchen ticket; confirm appends once', async () => {
  const t = await newTable()
  const p = await phone(t.code)
  const parsed = order([burgerLine({ quantity: 2, modifier_option_ids: [large, sauce] }), { product_id: fries, quantity: 1 }], { note: 'no onions' })
  const result = await qr.submitQrOrder(await p.session(), parsed)
  assert.equal(result.replayed, false)
  assert.equal(result.submission.status, 'awaiting_confirmation')
  assert.equal(JSON.stringify(result).includes('check_id'), false)
  assert.equal((await q('select count(*)::int as n from public.open_checks where table_id=$1', [t.id]))[0].n, 0)
  assert.equal((await q('select status from public.restaurant_tables where id=$1', [t.id]))[0].status, 'seated')
  assert.equal((await q('select count(*)::int as n from public.kitchen_tickets'))[0].n, 0)

  const pending = await qr.listStaffSubmissions(store, 'pending')
  assert.equal(pending.some(row => row.id === result.submission.id && row.table_id === t.id), true)

  const confirmed = await qr.confirmQrSubmission(store, result.submission.id, { employeeId: manager, userId: null, auto: false })
  assert.equal(confirmed.replayed, false)
  const check = (await q('select * from public.open_checks where id=$1', [confirmed.check_id]))[0]
  // 2 x (1000+200+50) = 2500 @10% -> 250 ; fries 300 @0
  assert.equal(Number(check.subtotal_cents), 2800)
  assert.equal(Number(check.tax_cents), 250)
  assert.equal(Number(check.total_cents), 3050)
  assert.equal(check.version, 2)
  assert.equal((await q('select status from public.restaurant_tables where id=$1', [t.id]))[0].status, 'ordering')
  assert.equal((await q('select count(*)::int as n from public.open_check_item_modifiers where option_id is not null'))[0].n >= 2, true)
  assert.equal((await q('select count(*)::int as n from public.kitchen_tickets'))[0].n, 0, 'confirming never fires the kitchen')

  const replay = await qr.confirmQrSubmission(store, result.submission.id, { employeeId: manager, userId: null, auto: false })
  assert.equal(replay.replayed, true)
  assert.equal((await q('select count(*)::int as n from public.open_check_items where check_id=$1', [confirmed.check_id]))[0].n, 2, 'exactly one effect')
  await rejectsWith(qr.rejectQrSubmission(store, result.submission.id, { employeeId: manager, userId: null, auto: false }), 'submission_confirmed')

  const tracked = await qr.listSessionSubmissions(await p.session())
  assert.equal(tracked[0].status, 'added_to_check')
  const shape = JSON.stringify(tracked)
  for (const leak of ['check_id', 'employee', 'table_id', 'session', 'store_id', 'preparing', 'kitchen']) assert.equal(shape.includes(leak), false, `tracking leaks ${leak}`)
})

test('reject flow and confirm-after-reject', async () => {
  const t = await newTable()
  const p = await phone(t.code)
  const sub = await qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }]))
  const staff = { employeeId: manager, userId: null, auto: false }
  const rejected = await qr.rejectQrSubmission(store, sub.submission.id, staff)
  assert.equal(rejected.status, 'rejected')
  assert.equal((await qr.rejectQrSubmission(store, sub.submission.id, staff)).replayed, true)
  await rejectsWith(qr.confirmQrSubmission(store, sub.submission.id, staff), 'submission_rejected')
  assert.equal((await qr.listSessionSubmissions(await p.session()))[0].status, 'declined')
  assert.equal((await q('select count(*)::int as n from public.open_checks where table_id=$1', [t.id]))[0].n, 0)
  // wrong store cannot decide it
  await rejectsWith(qr.confirmQrSubmission(otherStore, sub.submission.id, staff), 'not_found')
})

test('auto-confirm mode appends immediately, with live service charge, onto one check', async () => {
  await database.query('update public.stores set service_charge_bps=1000 where id=$1', [store])
  try {
    const t = await newTable('seated', { confirm: false })
    const a = await phone(t.code), b = await phone(t.code)
    const first = await qr.submitQrOrder(await a.session(), order([burgerLine()]))
    assert.equal(first.submission.status, 'added_to_check')
    const second = await qr.submitQrOrder(await b.session(), order([{ product_id: fries, quantity: 2 }]))
    assert.equal(second.submission.status, 'added_to_check')
    const checks = await q("select * from public.open_checks where table_id=$1 and status='open'", [t.id])
    assert.equal(checks.length, 1, 'one open check per table')
    // burger 1200 + fries 600 = 1800 subtotal, tax 120, service 180
    assert.equal(Number(checks[0].service_charge_cents), 180)
    assert.equal(Number(checks[0].total_cents), 1800 + 120 + 180)
    assert.equal(checks[0].employee_id, null)
    // a customer cannot see the other phone's order
    assert.equal((await qr.listSessionSubmissions(await a.session())).length, 1)
    assert.equal((await qr.listSessionSubmissions(await b.session())).length, 1)
  } finally { await database.query('update public.stores set service_charge_bps=0 where id=$1', [store]) }
})

test('duplicate and concurrent submissions have exactly one effect; reused operation id with new content conflicts', async () => {
  const t = await newTable('seated', { confirm: false })
  const p = await phone(t.code), other = await phone(t.code)
  const parsed = order([burgerLine()])
  const results = await Promise.all([1, 2, 3].map(async () => qr.submitQrOrder(await p.session(), parsed)))
  assert.equal(results.filter(result => !result.replayed).length, 1)
  assert.equal(new Set(results.map(result => result.submission.id)).size, 1)
  assert.equal((await q('select count(*)::int as n from public.open_check_items where check_id in (select id from public.open_checks where table_id=$1)', [t.id]))[0].n, 1)
  await rejectsWith(qr.submitQrOrder(await p.session(), { ...order([{ product_id: fries, quantity: 1 }]), operationId: parsed.operationId }), 'operation_id_conflict')
  // the same operation id from a different phone is a different submission (keys are per session)
  const other2 = await qr.submitQrOrder(await other.session(), { ...parsed })
  assert.equal(other2.replayed, false)
  // two phones racing
  const race = await Promise.all([qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }])), qr.submitQrOrder(await other.session(), order([{ product_id: fries, quantity: 2 }]))])
  assert.equal(race.every(result => result.submission.status === 'added_to_check'), true)
  assert.equal((await q("select count(*)::int as n from public.open_checks where table_id=$1 and status='open'", [t.id]))[0].n, 1)
  assert.equal((await q('select count(*)::int as n from public.open_check_items where check_id in (select id from public.open_checks where table_id=$1)', [t.id]))[0].n, 4)
})

test('pricing and item validation is server-side', async () => {
  const t = await newTable()
  const s = await (await phone(t.code)).session()
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: strangerProduct, quantity: 1 }])), 'unknown_item')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: randomUUID(), quantity: 1 }])), 'unknown_item')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: soldOut, quantity: 1 }])), 'item_unavailable')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: plate, quantity: 1 }])), 'item_unavailable')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: comboProduct, quantity: 1 }])), 'combo_unavailable_via_qr')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: burger, quantity: 1 }])), 'validation_failed') // required size missing
  await rejectsWith(qr.submitQrOrder(s, order([burgerLine({ modifier_option_ids: [large, small] })])), 'validation_failed') // single group twice
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: fries, quantity: 1, modifier_option_ids: [large] }])), 'unknown_item') // option of another product
  await rejectsWith(qr.submitQrOrder(s, order([burgerLine({ modifier_option_ids: [randomUUID()] })])), 'unknown_item')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: noOptionsProduct, quantity: 1 }])), 'validation_failed')
  assert.equal((await q('select count(*)::int as n from public.qr_submissions where table_id=$1', [t.id]))[0].n, 0, 'failed submissions leave nothing behind')
  // a catalog price change between menu and submit is picked up (customers never send prices)
  await database.query('update public.pos_products set unit_price_cents=1100 where id=$1', [burger])
  try {
    const ok = await qr.submitQrOrder(s, order([burgerLine()]))
    assert.equal(ok.submission.items[0].total_cents, Math.round(1300 * 1.1))
  } finally { await database.query('update public.pos_products set unit_price_cents=1000 where id=$1', [burger]) }
})

test('mode changes take effect live without revoking sessions', async () => {
  const t = await newTable()
  const p = await phone(t.code)
  const pendingSub = await qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }]))
  await qr.updateQrSettings(store, t.id, { mode: 'menu_only' })
  const s = await p.session()
  assert.equal(s.mode, 'menu_only')
  await rejectsWith(qr.submitQrOrder(s, order([{ product_id: fries, quantity: 1 }])), 'ordering_disabled')
  await qr.updateQrSettings(store, t.id, { mode: 'waiter_only' })
  assert.equal((await p.session()).mode, 'waiter_only')
  await rejectsWith(qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }])), 'ordering_disabled')
  // the earlier pending submission is still visible and staff can still confirm it
  assert.equal((await qr.confirmQrSubmission(store, pendingSub.submission.id, { employeeId: manager, userId: null, auto: false })).status, 'confirmed')
  await qr.updateQrSettings(store, t.id, { mode: 'menu_and_order', require_confirmation: false })
  assert.equal((await qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }]))).submission.status, 'added_to_check')
  await assert.rejects(qr.updateQrSettings(store, t.id, { mode: 'everything' }), /Mode/)
  await assert.rejects(qr.updateQrSettings(store, t.id, {}), /Nothing/)
  await assert.rejects(qr.updateQrSettings(store, t.id, { table_id: 'x' }), /cannot include/)
  await rejectsWith(qr.updateQrSettings(otherStore, t.id, { mode: 'menu_only' }), 'table_not_found')
})

test('pending submission cannot be confirmed once the table stops taking orders', async () => {
  const t = await newTable()
  const p = await phone(t.code)
  const sub = await qr.submitQrOrder(await p.session(), order([{ product_id: fries, quantity: 1 }]))
  await database.query("update public.restaurant_tables set status='available' where id=$1", [t.id])
  await rejectsWith(qr.confirmQrSubmission(store, sub.submission.id, { employeeId: manager, userId: null, auto: false }), 'table_not_accepting_orders')
  assert.equal((await qr.rejectQrSubmission(store, sub.submission.id, { employeeId: manager, userId: null, auto: false })).status, 'rejected')
})

test('cross-tenant: manager controls cannot touch another store table', async () => {
  await rejectsWith(qr.rotateQrCode(store, foreignTable), 'table_not_found')
  await rejectsWith(qr.revokeQrCode(store, foreignTable), 'table_not_found')
  assert.equal((await qr.listQrTables(store)).some((row: any) => row.id === foreignTable), false)
})

test('QR lines survive staff flow: stale staff edit conflicts, then close pays and fires the kitchen once', async () => {
  const t = await newTable()
  const p = await phone(t.code)
  const sub = await qr.submitQrOrder(await p.session(), order([burgerLine({ quantity: 2 })]))
  const { check_id } = await qr.confirmQrSubmission(store, sub.submission.id, { employeeId: manager, userId: null, auto: false })
  const before = (await q('select * from public.open_checks where id=$1', [check_id]))[0]
  assert.equal((await q('select count(*)::int as n from public.kitchen_tickets'))[0].n, 0)

  // staff working from a pre-append version get a compare-and-swap conflict instead of erasing the customer's lines
  await assert.rejects(editOpenCheckCore(store, check_id, {
    expectedVersion: before.version - 1, items: parseCheckItems([{ product_id: fries, snapshot_name: 'Fries', snapshot_sku: 'FRY', snapshot_price_cents: 300, snapshot_tax_bps: 0, catalog_version: 1, quantity: 1 }]),
    serviceChargeBps: 0, notes: null, customerId: null, managerId: null, managerApprovedAt: null,
  }), /changed since it was last loaded/)

  const total = Number(before.total_cents)
  const operationId = randomUUID()
  const closed = await closeOpenCheckCore(store, check_id, {
    operationId, expectedVersion: before.version, receiptNumber: `QR-${operationId.slice(0, 8)}`, catalogVersion: 1, clientGeneratedAt: new Date().toISOString(),
    serviceChargeBps: 0, payments: [{ id: randomUUID(), method: 'cash' as const, amountCents: total, tenderedCents: total, changeCents: 0, tipCents: 0, reference: null }],
    employeeIdOverride: null, loyaltyRedemptionRewardRuleId: null,
  }, 'qr-hash') as { status: string }
  assert.equal(closed.status, 'accepted')
  const paid = await q('select total_cents from public.pos_orders where id=$1', [operationId])
  assert.equal(Number(paid[0].total_cents), total)
  const mods = await q('select snapshot_option_name from public.pos_order_item_modifiers where store_id=$1', [store])
  assert.equal(mods.some(row => row.snapshot_option_name === 'Large'), true, 'modifier survived open check -> paid order')
  assert.equal((await q('select count(*)::int as n from public.kitchen_tickets where order_id=$1', [operationId]))[0].n, 1)
  // the table is dirty now, so the customer's session is over
  await rejectsWith(p.session(), 'session_revoked')
})

test('tracking is scoped to the session and a table A session cannot act on table B', async () => {
  const a = await newTable(), b = await newTable()
  const pa = await phone(a.code), pb = await phone(b.code)
  await qr.submitQrOrder(await pa.session(), order([{ product_id: fries, quantity: 1 }]))
  assert.equal((await qr.listSessionSubmissions(await pb.session())).length, 0)
  const sa = await pa.session()
  assert.equal(sa.tableId, a.id)
  await qr.submitQrOrder(await pb.session(), order([{ product_id: fries, quantity: 3 }]))
  assert.equal((await q('select count(*)::int as n from public.qr_submissions where table_id=$1', [a.id]))[0].n, 1)
  assert.equal((await q('select count(*)::int as n from public.qr_submissions where table_id=$1', [b.id]))[0].n, 1)
})
