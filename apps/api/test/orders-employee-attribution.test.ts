import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))

test('a live cashier session overrides a forged employee_id; a device-only push falls back to best-effort attribution', async () => {
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
      '202609150001_terminal_employee_access.sql', '202609150002_terminal_device_sessions.sql',
      '202609150003_team_profile_visibility.sql', '202609160001_customers_and_sale_attachment.sql',
      '202609170001_change_feed_product_entity.sql', '202609170002_cart_discounts.sql',
      '202609180001_terminal_name_uniqueness.sql', '202609180002_pos_orders_report_read_access.sql',
      '202609210001_restaurant_foundation.sql', '202609230001_kitchen_display_system.sql', '202609260003_service_charge.sql']) {
      await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
    }
    const owner = randomUUID(), store = randomUUID(), device = randomUUID()
    const cashier = randomUUID(), impersonated = randomUUID(), product = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','emp-attr',$2)", [store, owner])
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const deviceAccess = 'a'.repeat(64), cashierToken = 'b'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','EMP-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
    await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
      ($1,$2,'Cashier','cashier',$4,$5), ($3,$2,'Impersonated','cashier',$4,$5)`,
      [cashier, store, impersonated, '1'.repeat(32), '2'.repeat(64)])
    await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
      values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, cashier, digest(cashierToken)])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'SKU-1','Test item',100)`, [product, store])
    await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,10)', [store, product])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<{ query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; release: () => void }> }
    const query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.query = query
    fixture.connect = async () => ({ query, release: () => undefined })
    server = createApp({ pool: db, origin: 'http://127.0.0.1:3184', supabaseUrl: 'http://127.0.0.1:3185', supabaseKey: 'fixture', secureCookies: false }).listen(3184, '127.0.0.1')

    const buildOperation = (receiptNumber: string, employeeId: string | null) => {
      const operationId = randomUUID()
      return { operationId, body: { operation_id: operationId,
        order: { id: operationId, store_id: store, receipt_number: receiptNumber, catalog_version: 1,
          client_generated_at: new Date().toISOString(), subtotal_cents: 100, discount_cents: 0, tax_cents: 0,
          service_charge_bps: 0, service_charge_cents: 0, total_cents: 100,
          customer_id: null, employee_id: employeeId, manager_id: null, manager_approved_at: null },
        items: [{ id: randomUUID(), product_id: product, snapshot_name: 'Test item', snapshot_sku: 'SKU-1',
          snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity: 1,
          discount_kind: null, discount_value: null, subtotal_cents: 100, discount_applied_cents: 0, taxable_cents: 100, tax_cents: 0, total_cents: 100 }],
        payment: { id: randomUUID(), method: 'cash', amount_cents: 100, tendered_cents: 100, change_cents: 0, reference: null } } }
    }
    const push = (body: unknown, cookie: string) => fetch('http://127.0.0.1:3184/pos/orders/push',
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:3184', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    // A logged-in cashier tries to attribute the sale to a different employee — the server must
    // ignore the forged value and use the authenticated session's own identity instead.
    const forged = buildOperation('EMP-000001', impersonated)
    const liveSession = await push(forged.body, `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`)
    assert.equal(liveSession.status, 200)
    const liveRow = await database.query('select employee_id from public.pos_orders where id=$1', [forged.operationId])
    assert.equal(liveRow.rows[0].employee_id, cashier)

    // A device-only push (no cashier cookie, e.g. a queued sale synced after logout) has no session
    // to verify against, so it falls back to the client-sent value with the existing best-effort check.
    const queued = buildOperation('EMP-000002', cashier)
    const deviceOnly = await push(queued.body, `terminal_access=${deviceAccess}`)
    assert.equal(deviceOnly.status, 200)
    const queuedRow = await database.query('select employee_id from public.pos_orders where id=$1', [queued.operationId])
    assert.equal(queuedRow.rows[0].employee_id, cashier)

    // A device-only push referencing an employee who doesn't exist for this store is accepted
    // without attribution rather than rejected.
    const missing = buildOperation('EMP-000003', randomUUID())
    const missingEmployee = await push(missing.body, `terminal_access=${deviceAccess}`)
    assert.equal(missingEmployee.status, 200)
    const missingRow = await database.query('select employee_id from public.pos_orders where id=$1', [missing.operationId])
    assert.equal(missingRow.rows[0].employee_id, null)
  } finally { server?.closeAllConnections(); server?.close(); await database.close(); await db.end() }
})
