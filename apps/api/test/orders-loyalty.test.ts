import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Day 4 checkout-wiring (Hamza's task 2, docs/day-plans/day4.md): points earned/redeemed on a
// real order push, over real HTTP against the committed migration chain, same harness shape as
// orders-employee-attribution.test.ts (push()) and loyalty-api.test.ts (loyalty schema/seed).
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
  '202609250003_promotions.sql',
]

test('order checkout awards and redeems loyalty points atomically with the sale', async t => {
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

  const owner = randomUUID(), store = randomUUID(), device = randomUUID()
  const product = randomUUID()
  const noAccountGuest = randomUUID(), baseGuest = randomUUID(), tieredGuest = randomUUID(), redeemer = randomUUID(), poorGuest = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','loyalty-checkout',$2)", [store, owner])
  await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values
    ($1,$6,'No Account',now()),($2,$6,'Base Rate',now()),($3,$6,'Tiered',now()),($4,$6,'Redeemer',now()),($5,$6,'Poor',now())`,
    [noAccountGuest, baseGuest, tieredGuest, redeemer, poorGuest, store])
  await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test item',5000)`, [product, store])
  await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,100)', [store, product])

  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const deviceAccess = 'a'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','LC-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
    [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
  const employee = randomUUID()
  const cashierToken = 'e'.repeat(64)
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Cashier','cashier',$3,$4)`,
    [employee, store, '1'.repeat(32), '2'.repeat(64)])
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employee, digest(cashierToken)])

  // Tiers: Bronze (base 1x, implicit), Gold at 2,000 lifetime points, 1.5x.
  await database.query(`insert into public.loyalty_tiers(store_id,name,min_lifetime_points,point_multiplier_bps) values ($1,'Gold',2000,15000)`, [store])

  const baseAccount = randomUUID(), tieredAccount = randomUUID(), redeemerAccount = randomUUID(), poorAccount = randomUUID()
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id,points_balance,lifetime_points) values ($1,$2,$3,0,0)', [baseAccount, store, baseGuest])
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id,points_balance,lifetime_points) values ($1,$2,$3,0,3000)', [tieredAccount, store, tieredGuest])
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id,points_balance,lifetime_points) values ($1,$2,$3,500,500)', [redeemerAccount, store, redeemer])
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id,points_balance,lifetime_points) values ($1,$2,$3,10,10)', [poorAccount, store, poorGuest])

  const ruleId = randomUUID()
  await database.query(`insert into public.reward_rules(id,store_id,name,points_cost,discount_cents) values ($1,$2,'Free drink',300,500)`, [ruleId, store])

  // One promotion live now, one scheduled in the future, one deactivated -- exercises the
  // terminal-read endpoint's active-and-in-window filter (Day 4 checkout-wiring gap: the
  // management CRUD was owner/manager-only by design, but nothing let a terminal even read
  // promotions to apply one until this).
  const liveNow = randomUUID(), future = randomUUID(), disabled = randomUUID()
  await database.query(`insert into public.promotions(id,store_id,name,discount_kind,discount_value,active) values ($1,$2,'Live Now','percent',1000,true)`, [liveNow, store])
  await database.query(`insert into public.promotions(id,store_id,name,discount_kind,discount_value,active,starts_at) values ($1,$2,'Future','percent',1000,true,now()+interval '1 day')`, [future, store])
  await database.query(`insert into public.promotions(id,store_id,name,discount_kind,discount_value,active) values ($1,$2,'Disabled','percent',1000,false)`, [disabled, store])

  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const fixture = db as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const server = createApp({ pool: db, origin: 'http://127.0.0.1:3186', supabaseUrl: 'http://127.0.0.1:3187', supabaseKey: 'fixture', secureCookies: false }).listen(3186, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); server.close(); await database.close(); await db.end() })

  function buildOperation(customerId: string | null, { discountCents = 0, loyaltyRedemption }: { discountCents?: number; loyaltyRedemption?: { reward_rule_id: string } } = {}) {
    const operationId = randomUUID()
    const totalCents = 5000 - discountCents
    return { operationId, body: { operation_id: operationId,
      order: { id: operationId, store_id: store, receipt_number: `LC-${operationId.slice(0, 8)}`, catalog_version: 1,
        client_generated_at: new Date().toISOString(), subtotal_cents: 5000, discount_cents: discountCents, tax_cents: 0, total_cents: totalCents,
        customer_id: customerId, employee_id: null, manager_id: null, manager_approved_at: null },
      items: [{ id: randomUUID(), product_id: product, snapshot_name: 'Test item', snapshot_sku: 'SKU-1',
        snapshot_price_cents: 5000, snapshot_tax_bps: 0, catalog_version: 1, quantity: 1,
        discount_kind: discountCents ? 'fixed' : null, discount_value: discountCents || null,
        subtotal_cents: 5000, discount_applied_cents: discountCents, taxable_cents: totalCents, tax_cents: 0, total_cents: totalCents }],
      payment: { id: randomUUID(), method: 'cash', amount_cents: totalCents, tendered_cents: totalCents, change_cents: 0, reference: null },
      ...(loyaltyRedemption ? { loyalty_redemption: loyaltyRedemption } : {}) } }
  }
  // The terminal path (device-only push, no cashier session) needs no Supabase auth — matches
  // orders-employee-attribution.test.ts's "queued sale synced after logout" case.
  const push = (body: unknown) => fetch('http://127.0.0.1:3186/pos/orders/push',
    { method: 'POST', headers: { Origin: 'http://127.0.0.1:3186', Cookie: `terminal_access=${deviceAccess}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  await t.test('a guest with no loyalty account earns nothing and the sale still succeeds', async () => {
    const op = buildOperation(noAccountGuest)
    const response = await push(op.body)
    assert.equal(response.status, 200)
    assert.equal((await database.query('select 1 from public.loyalty_accounts where customer_id=$1', [noAccountGuest])).rows.length, 0)
    assert.equal((await database.query('select 1 from public.loyalty_point_ledger where order_id=$1', [op.operationId])).rows.length, 0)
  })

  await t.test('a $50.00 sale earns 50 points at the base 1x rate', async () => {
    const op = buildOperation(baseGuest)
    const response = await push(op.body)
    assert.equal(response.status, 200)
    const account = await database.query('select points_balance,lifetime_points from public.loyalty_accounts where id=$1', [baseAccount])
    assert.equal(account.rows[0].points_balance, 50)
    assert.equal(account.rows[0].lifetime_points, 50)
    const ledger = await database.query('select delta,reason,order_id from public.loyalty_point_ledger where account_id=$1', [baseAccount])
    assert.deepEqual([ledger.rows[0].delta, ledger.rows[0].reason, ledger.rows[0].order_id], [50, 'earned', op.operationId])
  })

  await t.test('a guest already past the Gold threshold earns at 1.5x, based on lifetime points before this order', async () => {
    const op = buildOperation(tieredGuest)
    const response = await push(op.body)
    assert.equal(response.status, 200)
    // $50 × 1.5x = 75 points, not 50 — proves the tier multiplier (not the base rate) was applied.
    const account = await database.query('select points_balance,lifetime_points from public.loyalty_accounts where id=$1', [tieredAccount])
    assert.equal(account.rows[0].points_balance, 75)
    assert.equal(account.rows[0].lifetime_points, 3075)
  })

  await t.test('redeeming a reward deducts its point cost, applies the discount, and still earns points on the discounted total', async () => {
    const op = buildOperation(redeemer, { discountCents: 500, loyaltyRedemption: { reward_rule_id: ruleId } })
    const response = await push(op.body)
    assert.equal(response.status, 200)
    const account = await database.query('select points_balance,lifetime_points from public.loyalty_accounts where id=$1', [redeemerAccount])
    // 500 (starting balance) - 300 (redeemed) + 45 (earned on the $45 discounted total) = 245.
    assert.equal(account.rows[0].points_balance, 245)
    // Redeeming never touches lifetime_points; only the 45 earned points do.
    assert.equal(account.rows[0].lifetime_points, 545)
    const ledger = await database.query(
      'select delta,reason from public.loyalty_point_ledger where account_id=$1 and order_id=$2 order by delta', [redeemerAccount, op.operationId])
    assert.deepEqual(ledger.rows.map(row => [row.delta, row.reason]), [[-300, 'redeemed'], [45, 'earned']])
  })

  await t.test('a redemption clamps to whatever balance is actually available rather than failing the sale', async () => {
    // This guest has only 10 points but the discount (already computed client-side) was applied
    // as if the reward's full cost was covered — the sale must not be reversed over a stale balance.
    const op = buildOperation(poorGuest, { discountCents: 500, loyaltyRedemption: { reward_rule_id: ruleId } })
    const response = await push(op.body)
    assert.equal(response.status, 200)
    const account = await database.query('select points_balance from public.loyalty_accounts where id=$1', [poorAccount])
    // 10 - 10 (clamped, not 300) + 45 (earned) = 45.
    assert.equal(account.rows[0].points_balance, 45)
  })

  await t.test('retrying the exact same operation does not double-award points', async () => {
    const op = buildOperation(baseGuest)
    const first = await push(op.body)
    assert.equal(first.status, 200)
    const second = await push(op.body)
    assert.equal(second.status, 200)
    assert.deepEqual(await first.json(), await second.json())
    const ledgerCount = await database.query('select count(*)::int as n from public.loyalty_point_ledger where order_id=$1', [op.operationId])
    assert.equal(ledgerCount.rows[0].n, 1)
  })

  await t.test('loyalty_redemption without a customer on the sale is rejected', async () => {
    const op = buildOperation(null, { discountCents: 500, loyaltyRedemption: { reward_rule_id: ruleId } })
    const response = await push(op.body)
    assert.equal(response.status, 422)
  })

  await t.test('GET /pos/promotions returns only the currently-active, in-window promotion', async () => {
    const cashierCookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
    const response = await fetch(`http://127.0.0.1:3186/pos/promotions?store_id=${store}`,
      { headers: { Origin: 'http://127.0.0.1:3186', Cookie: cashierCookie } })
    assert.equal(response.status, 200)
    const body = await response.json() as { promotions: Array<{ id: string; name: string }> }
    assert.deepEqual(body.promotions.map(promotion => promotion.id), [liveNow])
    // A different store's terminal must not see this store's promotions.
    assert.equal((await fetch(`http://127.0.0.1:3186/pos/promotions?store_id=${randomUUID()}`,
      { headers: { Origin: 'http://127.0.0.1:3186', Cookie: cashierCookie } })).status, 403)
  })
})
