import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// No API/domain code lands on this branch (that's Ahmed's Day 4 task) -- this migration is
// schema-only, so what's worth testing directly is the schema's own guarantees: the constraints
// that must hold before anything is built on top of them. Same reasoning as floor.test.ts testing
// applyTableStatusTransition's real Postgres semantics rather than trusting the SQL by eye.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'

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
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609230002_table_waiter_assignment.sql',
  '202609250001_loyalty_foundation.sql',
]

async function seededDatabase() {
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

function errorCode(reason: unknown): string | undefined {
  return reason && typeof reason === 'object' && 'code' in reason ? String((reason as { code?: string }).code) : undefined
}

async function seedTwoStoresWithCustomers(database: PGlite) {
  const owner = randomUUID(), storeA = randomUUID(), storeB = randomUUID(), customerA = randomUUID(), customerB = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','loyalty-test-a',$2,'UTC')", [storeA, owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','loyalty-test-b',$2,'UTC')", [storeB, owner])
  await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'Guest A',now())`, [customerA, storeA])
  await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'Guest B',now())`, [customerB, storeB])
  return { storeA, storeB, customerA, customerB }
}

test('loyalty_tiers rejects a duplicate name within a store, and a negative threshold', async () => {
  const database = await seededDatabase()
  try {
    const owner = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','tier-test',$2,'UTC')", [store, owner])
    await database.query(`insert into public.loyalty_tiers(id,store_id,name,min_lifetime_points) values ($1,$2,'Bronze',0)`, [randomUUID(), store])

    await assert.rejects(
      database.query(`insert into public.loyalty_tiers(id,store_id,name,min_lifetime_points) values ($1,$2,'Bronze',500)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23505',
    )
    await assert.rejects(
      database.query(`insert into public.loyalty_tiers(id,store_id,name,min_lifetime_points) values ($1,$2,'Silver',-1)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23514',
    )
  } finally {
    await database.close()
  }
})

test('loyalty_accounts allows at most one account per customer per store, and rejects a cross-store customer_id', async () => {
  const database = await seededDatabase()
  try {
    const { storeA, storeB, customerA, customerB } = await seedTwoStoresWithCustomers(database)
    await database.query(`insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)`, [randomUUID(), storeA, customerA])

    await assert.rejects(
      database.query(`insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)`, [randomUUID(), storeA, customerA]),
      (reason: unknown) => errorCode(reason) === '23505',
      'a second account for the same customer in the same store must be rejected',
    )
    // storeB's own customer is fine to enroll in storeB...
    await database.query(`insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)`, [randomUUID(), storeB, customerB])
    // ...but customerB does not exist in storeA (composite FK tenant isolation), unlike a bare id FK.
    await assert.rejects(
      database.query(`insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)`, [randomUUID(), storeA, customerB]),
      (reason: unknown) => errorCode(reason) === '23503',
    )
  } finally {
    await database.close()
  }
})

test('loyalty_point_ledger only accepts its four known reasons and enforces tenant-scoped FKs', async () => {
  const database = await seededDatabase()
  try {
    const { storeA, storeB, customerA } = await seedTwoStoresWithCustomers(database)
    const account = randomUUID()
    await database.query(`insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)`, [account, storeA, customerA])

    await database.query(
      `insert into public.loyalty_point_ledger(id,store_id,account_id,delta,reason) values ($1,$2,$3,10,'earned')`,
      [randomUUID(), storeA, account],
    )
    await assert.rejects(
      database.query(`insert into public.loyalty_point_ledger(id,store_id,account_id,delta,reason) values ($1,$2,$3,10,'bonus')`, [randomUUID(), storeA, account]),
      (reason: unknown) => errorCode(reason) === '23514',
      'an unrecognized reason must be rejected',
    )
    // account belongs to storeA -- referencing it from storeB must fail (composite FK).
    await assert.rejects(
      database.query(`insert into public.loyalty_point_ledger(id,store_id,account_id,delta,reason) values ($1,$2,$3,10,'earned')`, [randomUUID(), storeB, account]),
      (reason: unknown) => errorCode(reason) === '23503',
    )
  } finally {
    await database.close()
  }
})

test('reward_rules requires a positive points_cost and discount_cents', async () => {
  const database = await seededDatabase()
  try {
    const owner = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','reward-test',$2,'UTC')", [store, owner])

    await database.query(`insert into public.reward_rules(id,store_id,name,points_cost,discount_cents) values ($1,$2,'Free dessert',500,500)`, [randomUUID(), store])
    await assert.rejects(
      database.query(`insert into public.reward_rules(id,store_id,name,points_cost,discount_cents) values ($1,$2,'Bad rule',0,500)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23514',
    )
    await assert.rejects(
      database.query(`insert into public.reward_rules(id,store_id,name,points_cost,discount_cents) values ($1,$2,'Bad rule 2',500,0)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23514',
    )
  } finally {
    await database.close()
  }
})
