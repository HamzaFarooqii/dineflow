import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

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
]

test('report-read migration grants member read on pos_orders and threads employee attribution', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of chain) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }

    const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1),($2),($3)', [owner, member, outsider])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'First','first',$2)", [store, owner])
    await database.query("insert into public.store_memberships(store_id,user_id,role) values ($1,$2,'cashier')", [store, member])

    const employee = randomUUID()
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash)
      values ($1,$2,'Casey','cashier',repeat('a',32),repeat('b',64))`, [employee, store])

    const order = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,tax_cents,total_cents,catalog_version,client_generated_at,employee_id)
      values ($1,$2,'FIRST-000001','USD','First','UTC',0,0,0,1,now(),$3)`, [order, store, employee])

    // A store member can read the order via RLS; a non-member sees nothing.
    await database.query('set role authenticated')
    await database.query('select set_config($1,$2,false)', ['app.uid', member])
    const memberRead = await database.query('select id,employee_id from public.pos_orders where store_id=$1', [store])
    assert.equal(memberRead.rows.length, 1)
    assert.equal(memberRead.rows[0].employee_id, employee)

    await database.query('select set_config($1,$2,false)', ['app.uid', outsider])
    const outsiderRead = await database.query('select id from public.pos_orders where store_id=$1', [store])
    assert.equal(outsiderRead.rows.length, 0)
    await database.query('reset role')

    // employee_id must belong to the same store as the order.
    const otherStore = randomUUID()
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Second','second',$2)", [otherStore, owner])
    await assert.rejects(database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,tax_cents,total_cents,catalog_version,client_generated_at,employee_id)
      values ($1,$2,'SECOND-000001','USD','Second','UTC',0,0,0,1,now(),$3)`, [randomUUID(), otherStore, employee]))
  } finally { await database.close() }
})
