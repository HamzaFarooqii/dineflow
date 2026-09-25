import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
test('device customer API enforces search scope and returns durable replay results', async () => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const database = new PGlite()
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined
  try {
    await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
      create function auth.uid() returns uuid language sql as 'select null::uuid';
      create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
    for (const name of ['202609130001_auth_and_stores.sql', '202609150001_catalog_checkout_sync.sql',
      '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql', '202609160001_customers_and_sale_attachment.sql']) {
      await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
    }
    const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), device = randomUUID(), employee = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','customer-one',$3),($2,'Two','customer-two',$3)", [store, otherStore, owner])
    const access = 'a'.repeat(64), cashier = 'b'.repeat(64)
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','TEST-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`, [device, store, owner, digest('c'.repeat(64)), digest(access)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(access), digest('d'.repeat(64))])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash)
      values ($1,$2,'Alex','cashier',$3,$4)`, [employee, store, '1'.repeat(32), '2'.repeat(64)])
    await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
      values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employee, digest(cashier)])
    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })
    server = createApp({ pool: db, origin: 'http://127.0.0.1:3182', supabaseUrl: 'http://127.0.0.1:3183', supabaseKey: 'fixture', secureCookies: false }).listen(3182, '127.0.0.1')
    const headers = { Origin: 'http://127.0.0.1:3182', Cookie: `terminal_access=${access}; terminal_cashier=${cashier}`, 'Content-Type': 'application/json' }
    const operationId = randomUUID(), customerId = randomUUID()
    const payload = { operation_id: operationId, entity_type: 'customer', schema_version: 1,
      customer: { id: customerId, store_id: store, name: 'Alex Customer', phone_normalized: '923001234567', client_generated_at: new Date().toISOString() } }
    const post = (body: unknown) => fetch('http://127.0.0.1:3182/pos/customers/push', { method: 'POST', headers, body: JSON.stringify(body) })
    const first = await post(payload)
    assert.equal(first.status, 200)
    const accepted = await first.json() as { status: string; accepted_checkpoint: string }
    assert.equal(accepted.status, 'accepted')
    const replay = await post(payload)
    assert.equal(replay.status, 200)
    assert.equal((await replay.json() as { accepted_checkpoint: string; status: string }).accepted_checkpoint, accepted.accepted_checkpoint)
    assert.equal((await database.query('select id from public.pos_customers where id=$1', [customerId])).rows.length, 1)
    assert.equal((await database.query('select operation_id from public.pos_operation_ledger where operation_id=$1', [operationId])).rows.length, 1)
    assert.equal((await post({ ...payload, customer: { ...payload.customer, name: 'Changed' } })).status, 409)
    const crossStore = await post({ ...payload, operation_id: randomUUID(), customer: { ...payload.customer, id: randomUUID(), store_id: otherStore } })
    assert.equal(crossStore.status, 403)
    const second = await post({ ...payload, operation_id: randomUUID(), customer: { ...payload.customer, id: randomUUID(), name: 'Second customer' } })
    assert.equal(second.status, 200)
    assert.equal((await fetch('http://127.0.0.1:3182/pos/customers', { headers })).status, 400)
    const search = await fetch('http://127.0.0.1:3182/pos/customers?phone=%2B923001234567&limit=1', { headers })
    assert.equal(search.status, 200)
    const firstPage = await search.json() as { customers: unknown[]; next_cursor: string | null }
    assert.equal(firstPage.customers.length, 1)
    assert.ok(firstPage.next_cursor)
    const next = await fetch(`http://127.0.0.1:3182/pos/customers?phone=%2B923001234567&limit=1&cursor=${encodeURIComponent(firstPage.next_cursor!)}`, { headers })
    assert.equal(next.status, 200)
    assert.equal((await next.json() as { customers: unknown[]; next_cursor: string | null }).customers.length, 1)
    assert.equal((await fetch('http://127.0.0.1:3182/pos/customers?phone=%2B923001234567', { headers: { ...headers, Cookie: `terminal_access=${access}` } })).status, 401)
    const nameSearch = await fetch('http://127.0.0.1:3182/pos/customers?name=Alex', { headers })
    assert.equal(nameSearch.status, 200)
    const nameMatches = await nameSearch.json() as { customers: Array<{ name: string }> }
    assert.equal(nameMatches.customers.length, 1)
    assert.equal(nameMatches.customers[0].name, 'Alex Customer')
    assert.equal((await fetch('http://127.0.0.1:3182/pos/customers?name=Second', { headers })).status, 200)
    assert.equal((await (await fetch('http://127.0.0.1:3182/pos/customers?name=Second', { headers })).json() as { customers: unknown[] }).customers.length, 1)
  } finally { server?.closeAllConnections(); server?.close(); await database.close(); await db.end() }
})
