import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))

// QA_REPORT.md fix plan item 8: a duplicate/replayed POST /pos/orders/push with the same
// operation_id was a genuinely UNVERIFIED scenario — the outbox's unique-indexed operation_id
// makes accidental client-side duplication structurally unlikely, but the actual server-side
// dedupe behavior (pos_operation_ledger) had no test exercising it against a real DB, only the
// pure validateOperation() unit tests in orders.test.ts (which never open a connection).
test('a replayed operation_id with the same payload is a no-op; a reused one with a different payload is rejected', async () => {
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
    const owner = randomUUID(), store = randomUUID(), device = randomUUID(), product = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','dup-submit',$2)", [store, owner])
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    const deviceAccess = 'a'.repeat(64)
    await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
      values ($1,$2,'Counter','DUP-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
      [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
    await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
      values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
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

    const operationId = randomUUID()
    const buildBody = (quantity: number) => ({ operation_id: operationId,
      order: { id: operationId, store_id: store, receipt_number: 'DUP-000001', catalog_version: 1,
        client_generated_at: new Date().toISOString(), subtotal_cents: 100 * quantity, discount_cents: 0, tax_cents: 0,
        service_charge_bps: 0, service_charge_cents: 0, total_cents: 100 * quantity,
        customer_id: null, employee_id: null, manager_id: null, manager_approved_at: null },
      items: [{ id: randomUUID(), product_id: product, snapshot_name: 'Test item', snapshot_sku: 'SKU-1',
        snapshot_price_cents: 100, snapshot_tax_bps: 0, catalog_version: 1, quantity,
        discount_kind: null, discount_value: null, subtotal_cents: 100 * quantity, discount_applied_cents: 0, taxable_cents: 100 * quantity, tax_cents: 0, total_cents: 100 * quantity }],
      payment: { id: randomUUID(), method: 'cash', amount_cents: 100 * quantity, tendered_cents: 100 * quantity, change_cents: 0, reference: null } })
    const push = (body: unknown) => fetch('http://127.0.0.1:3184/pos/orders/push',
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:3184', Cookie: `terminal_access=${deviceAccess}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

    // A true replay resends byte-identical JSON (the same client-generated item/payment IDs too,
    // not just the same operation_id) — e.g. a retried request whose first response never reached
    // the client. Build the one-item body once and reuse it for both pushes below.
    const oneItemBody = buildBody(1)

    // First submission of a one-item sale: accepted, stock decremented by exactly 1.
    const first = await push(oneItemBody)
    assert.equal(first.status, 200)
    const firstResult = await first.json() as { status: string; accepted_checkpoint: string }
    assert.equal(firstResult.status, 'accepted')
    const stockAfterFirst = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, product])
    assert.equal(stockAfterFirst.rows[0].current_stock, 9)

    // Exact replay: same operation_id, identical body. Must be a true no-op: same result, no
    // second order row, no further stock/inventory-movement change, not even a second change-feed
    // entry.
    const replay = await push(oneItemBody)
    assert.equal(replay.status, 200)
    const replayResult = await replay.json() as { status: string; accepted_checkpoint: string }
    assert.deepEqual(replayResult, firstResult)
    const ordersAfterReplay = await database.query('select id from public.pos_orders where store_id=$1', [store])
    assert.equal(ordersAfterReplay.rows.length, 1)
    const stockAfterReplay = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, product])
    assert.equal(stockAfterReplay.rows[0].current_stock, 9)
    const movementsAfterReplay = await database.query('select id from public.pos_inventory_movements where store_id=$1 and operation_id=$2', [store, operationId])
    assert.equal(movementsAfterReplay.rows.length, 1)

    // Reusing the same operation_id for a genuinely different sale (e.g. a UUID collision, or a
    // client bug) must be rejected outright rather than silently accepted or silently ignored —
    // losing or misattributing a paid sale would be worse than a loud, explicit error here.
    const conflicting = await push(buildBody(2))
    assert.equal(conflicting.status, 409)
    const conflictBody = await conflicting.json() as { code: string }
    assert.equal(conflictBody.code, 'operation_id_conflict')
    const stockAfterConflict = await database.query<{ current_stock: number }>('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, product])
    assert.equal(stockAfterConflict.rows[0].current_stock, 9)
  } finally { server?.closeAllConnections(); server?.close(); await database.close(); await db.end() }
})
