import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Import the route module after setting a harmless pool URL; the PGlite-backed test below
// monkey-patches db.query before use, same pattern as reports.test.ts's loadDailySummary test.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { loadCustomerSummary } = await import('./customers.js')
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
]

test('loadCustomerSummary sums lifetime spend and counts visits, scoped to the store and guest', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID()
    const guest = randomUUID(), otherGuest = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','crm-test',$2,'UTC')", [store, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','crm-test-2',$2,'UTC')", [otherStore, owner])
    await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'Regular Guest',now())`, [guest, store])
    await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'Other Guest',now())`, [otherGuest, store])

    const insertOrder = async (id: string, storeId: string, customerId: string, totalCents: number, generatedAt: string) => {
      await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id)
        values ($1,$2,$3,'USD','One','UTC',$4,0,0,$4,1,$5,$6)`, [id, storeId, id.slice(0, 8), totalCents, generatedAt, customerId])
    }
    await insertOrder(randomUUID(), store, guest, 1_500, '2026-09-20T10:00:00.000Z')
    await insertOrder(randomUUID(), store, guest, 2_000, '2026-09-22T10:00:00.000Z')
    await insertOrder(randomUUID(), store, otherGuest, 9_999, '2026-09-21T10:00:00.000Z') // a different guest, same store — excluded
    // An order in a different store must never be summed into this store's total, even though
    // the query only filters on customer_id -- store_id scoping is what keeps it tenant-safe.
    const otherStoreGuest = randomUUID()
    await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'Other Store Guest',now())`, [otherStoreGuest, otherStore])
    await insertOrder(randomUUID(), otherStore, otherStoreGuest, 50_000, '2026-09-23T10:00:00.000Z')

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    const result = await loadCustomerSummary(store, guest)
    assert.equal(result.visit_count, 2)
    assert.equal(result.lifetime_spend_cents, 3_500)
    assert.equal(result.recent_visits.length, 2)
    assert.equal(result.recent_visits[0].total_cents, 2_000) // most recent first
    assert.equal(result.recent_visits[1].total_cents, 1_500)
  } finally {
    await database.close()
  }
})

test('loadCustomerSummary is zero for a guest with no orders', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), store = randomUUID(), guest = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','crm-empty',$2,'UTC')", [store, owner])
    await database.query(`insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'New Guest',now())`, [guest, store])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    const result = await loadCustomerSummary(store, guest)
    assert.equal(result.visit_count, 0)
    assert.equal(result.lifetime_spend_cents, 0)
    assert.deepEqual(result.recent_visits, [])
  } finally {
    await database.close()
  }
})
