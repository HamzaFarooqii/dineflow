import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { db } = await import('../db.js')
const { applyTableStatusTransition } = await import('./floor.js')

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
  '202609280002_reservations_waitlist.sql',
]

async function loadSchema(database: PGlite) {
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
}

test('reservation seating uses the atomic table transition and cannot be applied twice', async () => {
  const database = new PGlite()
  try {
    await loadSchema(database)
    const owner = randomUUID(), store = randomUUID(), area = randomUUID(), table = randomUUID(), reservation = randomUUID(), waiter = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','reservation-test',$2,'Asia/Karachi')", [store, owner])
    await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [area, store, 'Main Hall'])
    await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [table, store, area, 'T1'])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Waiter One','cashier',repeat('a',32),repeat('b',64))`, [waiter, store])
    await database.query(`insert into public.reservations(id,store_id,guest_name,guest_size,expected_at,restaurant_table_id)
      values ($1,$2,'Bisma',4,now(),$3)`, [reservation, store, table])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }

    const seated = await applyTableStatusTransition(store, table, 'available', 'seated', waiter)
    assert.equal(seated?.status, 'seated')
    assert.equal(seated?.assigned_waiter_id, waiter)
    await database.query(`update public.reservations
      set status='seated', seated_at=now(), seated_table_id=$1, seated_operation_id=$2
      where id=$3 and store_id=$4 and status <> 'seated'`, [table, randomUUID(), reservation, store])

    const stale = await applyTableStatusTransition(store, table, 'available', 'seated', waiter)
    assert.equal(stale, null, 'the same table cannot be seated twice from stale available state')
    const row = await database.query('select status, seated_table_id from public.reservations where id=$1', [reservation])
    assert.equal(row.rows[0].status, 'seated')
    assert.equal(row.rows[0].seated_table_id, table)
  } finally {
    await database.close()
  }
})

test('store timezone controls today filtering boundaries', async () => {
  const database = new PGlite()
  try {
    await loadSchema(database)
    const owner = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Karachi','reservation-tz',$2,'Asia/Karachi')", [store, owner])
    await database.query(`insert into public.reservations(store_id,guest_name,guest_size,expected_at) values
      ($1,'Early',2, timezone('Asia/Karachi', now())::date at time zone 'Asia/Karachi'),
      ($1,'Late',2, (timezone('Asia/Karachi', now())::date + interval '1 day') at time zone 'Asia/Karachi')`, [store])
    const today = await database.query(`select guest_name from public.reservations b join public.stores s on s.id=b.store_id
      where b.store_id=$1
        and expected_at >= timezone(s.timezone, now())::date at time zone s.timezone
        and expected_at < (timezone(s.timezone, now())::date + interval '1 day') at time zone s.timezone
      order by guest_name`, [store])
    assert.deepEqual(today.rows.map(row => row.guest_name), ['Early'])
  } finally {
    await database.close()
  }
})
