import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
test('customer migration allows duplicate phones and rejects cross-store order references', async () => {
  const database = new PGlite()
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql', '202609160001_customers_and_sale_attachment.sql']) {
      const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
      await database.exec(sql)
    }
    const owner = randomUUID(), first = randomUUID(), second = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'First','first',$3),($2,'Second','second',$3)", [first, second, owner])
    const a = randomUUID(), b = randomUUID(), c = randomUUID()
    for (const [id, store] of [[a, first], [b, first], [c, second]]) {
      await database.query(`insert into public.pos_customers(id,store_id,name,phone_normalized,client_generated_at)
        values ($1,$2,'Person','923001234567',now())`, [id, store])
    }
    assert.equal((await database.query('select id from public.pos_customers where store_id=$1 and phone_normalized=$2', [first, '923001234567'])).rows.length, 2)
    await assert.rejects(database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id)
      values ($1,$2,'FIRST-000001','USD','First','UTC',0,0,0,1,now(),$3)`, [randomUUID(), first, c]))
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,tax_cents,total_cents,catalog_version,client_generated_at,customer_id)
      values ($1,$2,'FIRST-000002','USD','First','UTC',0,0,0,1,now(),$3)`, [randomUUID(), first, a])
  } finally { await database.close() }
})
