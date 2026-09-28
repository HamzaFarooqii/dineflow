import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { mergeCustomersCore, loadPreferenceState } = await import('./customer-profile.js')
const { db } = await import('../db.js')

const root = fileURLToPath(new URL('../../../../', import.meta.url))
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
  '202609250001_loyalty_foundation.sql',
  '202609280004_customer_profile_tools.sql',
]

async function freshDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  return database
}

// A thin PoolClient-shaped wrapper so mergeCustomersCore (which takes a real pg PoolClient in
// production) can run directly against PGlite in tests, matching purchasing.test.ts's pattern
// for receivePurchaseOrderCore.
function clientOf(database: PGlite) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    },
  } as unknown as import('pg').PoolClient
}

async function seedStoreAndOwner(database: PGlite) {
  const owner = randomUUID(), store = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','cp-test',$2,'UTC')", [store, owner])
  return { owner, store }
}

async function seedCustomer(database: PGlite, store: string, name: string) {
  const id = randomUUID()
  await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,$3,now())`, [id, store, name])
  return id
}

test('merge moves loyalty balance and order associations exactly once, and is idempotent-refused on retry', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const source = await seedCustomer(database, store, 'Duplicate Guest')
    const target = await seedCustomer(database, store, 'Main Guest')

    // Give the source guest a loyalty balance.
    await database.query('insert into public.loyalty_accounts(store_id,customer_id,points_balance,lifetime_points) values ($1,$2,120,300)', [store, source])

    // Give the source guest an order.
    const order = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id)
      values ($1,$2,$3,'USD','One','UTC',1000,0,0,1000,1,now(),$4)`, [order, store, order.slice(0, 8), source])

    const client = clientOf(database)
    await database.query('begin')
    const merge = await mergeCustomersCore(client, store, source, target, owner, 'Duplicate profile, same guest confirmed by phone call.')
    await database.query('commit')

    assert.equal(merge.source_customer_id, source)
    assert.equal(merge.target_customer_id, target)

    const targetAccount = await database.query<{ points_balance: number; lifetime_points: number }>(
      'select points_balance,lifetime_points from public.loyalty_accounts where store_id=$1 and customer_id=$2', [store, target])
    assert.equal(targetAccount.rows[0].points_balance, 120)
    assert.equal(targetAccount.rows[0].lifetime_points, 300)

    const sourceAccount = await database.query<{ points_balance: number }>(
      'select points_balance from public.loyalty_accounts where store_id=$1 and customer_id=$2', [store, source])
    assert.equal(sourceAccount.rows[0].points_balance, 0)

    const movedOrder = await database.query<{ customer_id: string }>('select customer_id from public.pos_orders where id=$1', [order])
    assert.equal(movedOrder.rows[0].customer_id, target)

    const sourceCustomer = await database.query<{ active: boolean }>('select active from public.pos_customers where id=$1', [source])
    assert.equal(sourceCustomer.rows[0].active, false)

    // Retrying the merge (e.g. a duplicate manager action) must be refused, not repeat the move.
    await database.query('begin')
    await assert.rejects(() => mergeCustomersCore(client, store, source, target, owner, 'Retry.'), /already been merged|already_merged/)
    await database.query('rollback')

    const targetAccountAfterRetry = await database.query<{ points_balance: number }>(
      'select points_balance from public.loyalty_accounts where store_id=$1 and customer_id=$2', [store, target])
    assert.equal(targetAccountAfterRetry.rows[0].points_balance, 120, 'balance must not be moved twice')
  } finally { await database.close() }
})

test('merge audit row is immutable -- no update or delete grant on customer_merges', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const source = await seedCustomer(database, store, 'Duplicate Guest')
    const target = await seedCustomer(database, store, 'Main Guest')
    const client = clientOf(database)
    await database.query('begin')
    await mergeCustomersCore(client, store, source, target, owner, 'Confirmed same guest.')
    await database.query('commit')

    const grants = await database.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants where table_name='customer_merges' and grantee='authenticated'`)
    const privileges = grants.rows.map(row => row.privilege_type)
    assert.ok(privileges.includes('SELECT'))
    assert.ok(!privileges.includes('UPDATE'))
    assert.ok(!privileges.includes('DELETE'))
  } finally { await database.close() }
})

test('duplicate phone numbers remain valid for two separate, unmerged guests', async () => {
  const database = await freshDatabase()
  try {
    const { store } = await seedStoreAndOwner(database)
    const first = randomUUID(), second = randomUUID()
    await database.query(`insert into public.pos_customers(id,store_id,name,phone_normalized,client_generated_at) values ($1,$2,'Guest A','923001234567',now())`, [first, store])
    // No uniqueness constraint on phone -- this must not throw.
    await database.query(`insert into public.pos_customers(id,store_id,name,phone_normalized,client_generated_at) values ($1,$2,'Guest B','923001234567',now())`, [second, store])
    const rows = await database.query('select id from public.pos_customers where store_id=$1 and phone_normalized=$2', [store, '923001234567'])
    assert.equal(rows.rows.length, 2)
  } finally { await database.close() }
})

test('preferences are tenant isolated and history keeps every add/remove event with its author', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const otherOwner = randomUUID(), otherStore = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [otherOwner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','cp-test-2',$2,'UTC')", [otherStore, otherOwner])
    const guest = await seedCustomer(database, store, 'Regular')
    const otherGuest = await seedCustomer(database, otherStore, 'Other Store Guest')

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,action,created_by_user_id) values ($1,$2,'favorite','Window seat','add',$3)`, [store, guest, owner])
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,action,created_by_user_id) values ($1,$2,'preference','No peanuts (allergy)','add',$3)`, [store, guest, owner])
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,action,created_by_user_id) values ($1,$2,'favorite','Window seat','remove',$3)`, [store, guest, owner])
    // A row for a guest in a different store must never leak into this guest's state.
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,action,created_by_user_id) values ($1,$2,'favorite','Should not appear','add',$3)`, [otherStore, otherGuest, otherOwner])

    const state = await loadPreferenceState(store, guest)
    assert.equal(state.history.length, 3, 'every event stays in history, including the retired one')
    assert.deepEqual(state.current.map(row => row.label).sort(), ['No peanuts (allergy)'])
    assert.ok(state.current.every(row => row.created_by_user_id === owner))
  } finally { await database.close() }
})

test('deactivate then reactivate a guest preserves the row (soft delete only)', async () => {
  const database = await freshDatabase()
  try {
    const { store } = await seedStoreAndOwner(database)
    const guest = await seedCustomer(database, store, 'Regular')
    await database.query('update public.pos_customers set active=false, updated_at=now() where store_id=$1 and id=$2', [store, guest])
    let row = await database.query<{ active: boolean }>('select active from public.pos_customers where id=$1', [guest])
    assert.equal(row.rows[0].active, false)
    await database.query('update public.pos_customers set active=true, updated_at=now() where store_id=$1 and id=$2', [store, guest])
    row = await database.query<{ active: boolean }>('select active from public.pos_customers where id=$1', [guest])
    assert.equal(row.rows[0].active, true)
    const stillThere = await database.query('select id from public.pos_customers where id=$1', [guest])
    assert.equal(stillThere.rows.length, 1, 'the row itself is never deleted')
  } finally { await database.close() }
})

test('merging into a deactivated target, or into a guest already merged away, is rejected', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const a = await seedCustomer(database, store, 'A')
    const b = await seedCustomer(database, store, 'B')
    const c = await seedCustomer(database, store, 'C')
    const client = clientOf(database)

    await database.query('update public.pos_customers set active=false where id=$1', [b])
    await database.query('begin')
    await assert.rejects(() => mergeCustomersCore(client, store, a, b, owner, 'Target is deactivated.'))
    await database.query('rollback')

    // B was merged into C first; A must not be allowed to merge into B afterwards (dead-end target).
    await database.query('update public.pos_customers set active=true where id=$1', [b])
    await database.query('begin')
    await mergeCustomersCore(client, store, b, c, owner, 'B into C.')
    await database.query('commit')
    await database.query('begin')
    await assert.rejects(() => mergeCustomersCore(client, store, a, b, owner, 'A into already-merged B.'))
    await database.query('rollback')
  } finally { await database.close() }
})

test('merge carries the source guest\'s current favorites/preferences onto the target, without duplicating or losing history', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const source = await seedCustomer(database, store, 'Duplicate Guest')
    const target = await seedCustomer(database, store, 'Main Guest')
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id) values ($1,$2,'preference','No peanuts (allergy)',null,'add',$3)`, [store, source, owner])
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id) values ($1,$2,'favorite','Corner booth',null,'add',$3)`, [store, source, owner])
    // Already retired on the source before the merge -- must not be carried forward.
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id) values ($1,$2,'favorite','Corner booth','','remove',$3)`, [store, source, owner])
    // Target already has this one -- must not be duplicated.
    await database.query(`insert into public.customer_preference_events(store_id,customer_id,kind,label,note,action,created_by_user_id) values ($1,$2,'preference','No peanuts (allergy)',null,'add',$3)`, [store, target, owner])

    const client = clientOf(database)
    await database.query('begin')
    await mergeCustomersCore(client, store, source, target, owner, 'Duplicate profile.')
    await database.query('commit')

    const targetEvents = await database.query<{ label: string }>(`select label from public.customer_preference_events where store_id=$1 and customer_id=$2 and action='add'`, [store, target])
    assert.equal(targetEvents.rows.filter(row => row.label === 'No peanuts (allergy)').length, 1, 'no duplicate for an entry the target already has')
    assert.equal(targetEvents.rows.filter(row => row.label === 'Corner booth').length, 0, 'a retired favorite on the source is not carried forward')

    const sourceEvents = await database.query('select id from public.customer_preference_events where store_id=$1 and customer_id=$2', [store, source])
    assert.equal(sourceEvents.rows.length, 3, 'the source\'s own history is untouched by the merge')
  } finally { await database.close() }
})

test('merging a guest that has already been merged as a source is rejected, not repeated', async () => {
  const database = await freshDatabase()
  try {
    const { owner, store } = await seedStoreAndOwner(database)
    const a = await seedCustomer(database, store, 'A')
    const b = await seedCustomer(database, store, 'B')
    const c = await seedCustomer(database, store, 'C')
    const client = clientOf(database)
    await database.query('begin')
    await mergeCustomersCore(client, store, a, b, owner, 'First merge.')
    await database.query('commit')
    await database.query('begin')
    await assert.rejects(() => mergeCustomersCore(client, store, a, c, owner, 'Try to merge the already-merged guest again.'))
    await database.query('rollback')
  } finally { await database.close() }
})
