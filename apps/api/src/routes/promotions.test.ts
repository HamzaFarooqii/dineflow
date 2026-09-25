import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Schema-level test for the promotions table, same reasoning as loyalty-schema.test.ts: the
// route handlers themselves are thin CRUD wired through requireStoreManager (already covered by
// floor.test.ts's equivalent pattern), so what's worth testing directly against real Postgres
// semantics is the table's own constraints.
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
  '202609250003_promotions.sql',
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

async function seedStore(database: PGlite) {
  const owner = randomUUID(), store = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','promo-test',$2,'UTC')", [store, owner])
  return store
}

test('promotions requires a percent or fixed discount_kind and a positive discount_value', async () => {
  const database = await seededDatabase()
  try {
    const store = await seedStore(database)
    await database.query(
      `insert into public.promotions(id,store_id,name,discount_kind,discount_value) values ($1,$2,'Happy Hour','percent',1500)`,
      [randomUUID(), store],
    )
    await assert.rejects(
      database.query(`insert into public.promotions(id,store_id,name,discount_kind,discount_value) values ($1,$2,'Bad kind','flat',100)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23514',
    )
    await assert.rejects(
      database.query(`insert into public.promotions(id,store_id,name,discount_kind,discount_value) values ($1,$2,'Bad value','fixed',0)`, [randomUUID(), store]),
      (reason: unknown) => errorCode(reason) === '23514',
    )
  } finally {
    await database.close()
  }
})

test('promotions defaults active to true and can be toggled off', async () => {
  const database = await seededDatabase()
  try {
    const store = await seedStore(database)
    const id = randomUUID()
    const inserted = await database.query<{ active: boolean }>(
      `insert into public.promotions(id,store_id,name,discount_kind,discount_value) values ($1,$2,'Happy Hour','percent',1500) returning active`,
      [id, store],
    )
    assert.equal(inserted.rows[0].active, true)
    const updated = await database.query<{ active: boolean }>(
      `update public.promotions set active = false where id = $1 returning active`, [id],
    )
    assert.equal(updated.rows[0].active, false)
  } finally {
    await database.close()
  }
})
