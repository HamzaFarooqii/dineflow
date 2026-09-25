import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Every /loyalty endpoint exercised over real HTTP against the committed migration chain: the
// web routes through a fake Supabase identity server (terminal-auth.test.ts's approach), the
// /pos routes through seeded terminal cookies (customer-api.test.ts's approach).
const root = fileURLToPath(new URL('../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180005_refunds.sql',
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609230002_table_waiter_assignment.sql',
  '202609250001_loyalty_foundation.sql',
]

test('loyalty API: accounts, enrollment, ledger, tiers and reward-rule CRUD', async t => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
  }

  const owner = randomUUID(), cashierUser = randomUUID(), store = randomUUID(), otherStore = randomUUID()
  const guest = randomUUID(), newGuest = randomUUID(), otherStoreGuest = randomUUID()
  const device = randomUUID(), employee = randomUUID()
  await database.query('insert into auth.users(id) values ($1),($2)', [owner, cashierUser])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','loyalty-one',$3),($2,'Two','loyalty-two',$3)", [store, otherStore, owner])
  await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'owner'),($1,$3,'cashier')", [store, owner, cashierUser])
  await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$3,'Enrolled Guest',now()),($2,$3,'New Guest',now()),($4,$5,'Elsewhere',now())`,
    [guest, newGuest, store, otherStoreGuest, otherStore])

  const access = 'a'.repeat(64), cashier = 'b'.repeat(64)
  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','LOY-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`, [device, store, owner, digest('c'.repeat(64)), digest(access)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(access), digest('d'.repeat(64))])
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Alex','cashier',$3,$4)`, [employee, store, '1'.repeat(32), '2'.repeat(64)])
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employee, digest(cashier)])

  // Tiers and an existing account with history. 2,000 lifetime points → Silver (Gold starts at 5,000),
  // while the spendable balance (800) is lower — tier must follow lifetime points, not balance.
  await database.query(`insert into public.loyalty_tiers(store_id,name,min_lifetime_points,point_multiplier_bps)
    values ($1,'Bronze',0,10000),($1,'Silver',1000,12500),($1,'Gold',5000,15000)`, [store])
  const account = randomUUID()
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id,points_balance,lifetime_points) values ($1,$2,$3,800,2000)', [account, store, guest])
  for (const [delta, reason, at] of [[2000, 'earned', '2026-09-20T10:00:00Z'], [-700, 'redeemed', '2026-09-21T10:00:00Z'], [-500, 'redeemed', '2026-09-22T10:00:00Z']] as const) {
    await database.query('insert into public.loyalty_point_ledger(store_id,account_id,delta,reason,created_at) values ($1,$2,$3,$4,$5)', [store, account, delta, reason, at])
  }

  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const fixture = db as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const identity = createServer((req, res) => {
    const user = req.headers.authorization === 'Bearer test-owner' ? owner : req.headers.authorization === 'Bearer test-cashier' ? cashierUser : null
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(user ? { id: user } : {}))
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => identity.once('listening', resolve))
  const identityAddress = identity.address()
  assert(identityAddress && typeof identityAddress !== 'string')
  process.env.SUPABASE_URL = `http://127.0.0.1:${identityAddress.port}`
  process.env.SUPABASE_PUBLISHABLE_KEY = 'fixture'

  const origin = 'http://loyalty.test'
  const server = createApp({ pool: db, origin, supabaseUrl: process.env.SUPABASE_URL, supabaseKey: 'fixture', secureCookies: false }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); identity.closeAllConnections(); server.close(); identity.close(); await database.close(); await db.end() })

  const web = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => fetch(`${base}/loyalty${path}`, {
    method: init.method ?? 'GET',
    headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${init.token ?? 'test-owner'}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const pos = (path: string, method = 'GET') => fetch(`${base}/pos/loyalty${path}`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: `terminal_access=${access}; terminal_cashier=${cashier}` },
  })
  const s = `store_id=${store}`

  await t.test('GET /tiers lists the store tiers in threshold order', async () => {
    const response = await web(`/tiers?${s}`)
    assert.equal(response.status, 200)
    const body = await response.json() as { tiers: Array<{ name: string }> }
    assert.deepEqual(body.tiers.map(tier => tier.name), ['Bronze', 'Silver', 'Gold'])
    assert.equal((await pos(`/tiers?${s}`)).status, 200)
  })

  await t.test('GET /accounts/:customerId returns balance, lifetime points and the lifetime-based tier', async () => {
    const response = await pos(`/accounts/${guest}?${s}`)
    assert.equal(response.status, 200)
    const body = await response.json() as { account: { points_balance: number; lifetime_points: number; tier: { name: string } | null } }
    assert.equal(body.account.points_balance, 800)
    assert.equal(body.account.lifetime_points, 2000)
    assert.equal(body.account.tier?.name, 'Silver')
  })

  await t.test('GET /accounts/:customerId never enrolls as a side effect', async () => {
    const response = await web(`/accounts/${newGuest}?${s}`)
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { account: unknown }).account, null)
    assert.equal((await database.query('select 1 from public.loyalty_accounts where customer_id=$1', [newGuest])).rows.length, 0)
  })

  await t.test('GET /accounts/:customerId rejects another store\'s guest and another store\'s terminal', async () => {
    assert.equal((await web(`/accounts/${otherStoreGuest}?${s}`)).status, 404)
    assert.equal((await pos(`/accounts/${guest}?store_id=${otherStore}`)).status, 403)
    assert.equal((await web(`/accounts/${guest}?${s}`, { token: 'nobody' })).status, 401)
  })

  await t.test('POST /accounts/:customerId/enroll opts a guest in, idempotently', async () => {
    const first = await pos(`/accounts/${newGuest}/enroll?${s}`, 'POST')
    assert.equal(first.status, 201)
    const body = await first.json() as { account: { points_balance: number; lifetime_points: number; tier: { name: string } | null } }
    assert.equal(body.account.points_balance, 0)
    assert.equal(body.account.tier?.name, 'Bronze')
    const again = await web(`/accounts/${newGuest}/enroll?${s}`, { method: 'POST' })
    assert.equal(again.status, 200)
    assert.equal((await database.query('select 1 from public.loyalty_accounts where customer_id=$1', [newGuest])).rows.length, 1)
    assert.equal((await web(`/accounts/${otherStoreGuest}/enroll?${s}`, { method: 'POST' })).status, 404)
  })

  await t.test('GET /accounts/:customerId/ledger pages newest-first with a cursor', async () => {
    const first = await web(`/accounts/${guest}/ledger?${s}&limit=2`)
    assert.equal(first.status, 200)
    const page1 = await first.json() as { entries: Array<{ delta: number; reason: string }>; next_cursor: string | null }
    assert.deepEqual(page1.entries.map(entry => entry.delta), [-500, -700])
    assert.ok(page1.next_cursor)
    const second = await pos(`/accounts/${guest}/ledger?${s}&limit=2&before=${encodeURIComponent(page1.next_cursor!)}`)
    const page2 = await second.json() as { entries: Array<{ delta: number; reason: string }>; next_cursor: string | null }
    assert.deepEqual(page2.entries.map(entry => [entry.delta, entry.reason]), [[2000, 'earned']])
    assert.equal(page2.next_cursor, null)
    assert.equal((await web(`/accounts/${guest}/ledger?${s}&before=not-a-cursor`)).status, 400)
    assert.equal((await web(`/accounts/${otherStoreGuest}/ledger?${s}`)).status, 404)
  })

  let ruleId = ''
  await t.test('POST /reward-rules creates a rule for an owner/manager only', async () => {
    const created = await web(`/reward-rules?${s}`, { method: 'POST', body: { name: ' Free dessert ', points_cost: 500, discount_cents: 650 } })
    assert.equal(created.status, 201)
    const rule = await created.json() as { id: string; name: string; active: boolean }
    assert.equal(rule.name, 'Free dessert')
    assert.equal(rule.active, true)
    ruleId = rule.id
    assert.equal((await web(`/reward-rules?${s}`, { method: 'POST', body: { name: 'Nope', points_cost: 1, discount_cents: 1 }, token: 'test-cashier' })).status, 403)
    assert.equal((await web(`/reward-rules?${s}`, { method: 'POST', body: { name: 'Bad', points_cost: 0, discount_cents: 100 } })).status, 422)
    // The terminal can read the catalog but not manage it.
    assert.equal((await pos(`/reward-rules?${s}`, 'POST')).status, 404)
  })

  await t.test('PATCH /reward-rules/:id updates only the given fields', async () => {
    const updated = await web(`/reward-rules/${ruleId}?${s}`, { method: 'PATCH', body: { discount_cents: 700 } })
    assert.equal(updated.status, 200)
    const rule = await updated.json() as { name: string; points_cost: number; discount_cents: number }
    assert.deepEqual([rule.name, rule.points_cost, rule.discount_cents], ['Free dessert', 500, 700])
    assert.equal((await web(`/reward-rules/${randomUUID()}?${s}`, { method: 'PATCH', body: { name: 'Ghost' } })).status, 404)
    assert.equal((await web(`/reward-rules/${ruleId}?${s}`, { method: 'PATCH', body: {} })).status, 422)
  })

  await t.test('PATCH /reward-rules/:id/deactivate hides a rule from the default list, not from management', async () => {
    const deactivated = await web(`/reward-rules/${ruleId}/deactivate?${s}`, { method: 'PATCH' })
    assert.equal(deactivated.status, 200)
    assert.equal((await deactivated.json() as { active: boolean }).active, false)
    const offered = await pos(`/reward-rules?${s}`)
    assert.equal(offered.status, 200)
    assert.equal((await offered.json() as { reward_rules: unknown[] }).reward_rules.length, 0)
    const all = await web(`/reward-rules?${s}&include_inactive=true`)
    assert.equal((await all.json() as { reward_rules: unknown[] }).reward_rules.length, 1)
    const reactivated = await web(`/reward-rules/${ruleId}?${s}`, { method: 'PATCH', body: { active: true } })
    assert.equal((await reactivated.json() as { active: boolean }).active, true)
  })
})
