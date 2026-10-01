import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const migrations = [
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
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609250001_loyalty_foundation.sql',
  '202609250002_inventory_batch_tracking.sql',
  '202609260001_unit_conversion.sql',
  '202609260002_staff_roles_and_shifts.sql',
  '202609260003_service_charge.sql',
  '202609270001_modifiers.sql',
  '202609280001_inventory_terminal_tenant_fks.sql',
  '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql',
  '202609290001_kitchen_operations_depth.sql',
  '202609290002_sellable_combos.sql',
  '202610020001_wastage_categories_batch_valuation.sql',
]

test('Day 5 restaurant lifecycle reaches inventory, floor, loyalty, and reports', async t => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of migrations) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8'))
      .replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }

  const owner = randomUUID(), store = randomUUID(), device = randomUUID(), employee = randomUUID()
  const guest = randomUUID(), product = randomUUID(), station = randomUUID(), area = randomUUID(), table = randomUUID()
  const unit = randomUUID(), ingredient = randomUUID(), recipe = randomUUID(), batch = randomUUID(), account = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','day5-e2e',$2,'UTC')", [store, owner])
  await database.query("insert into public.pos_customers(id,store_id,name,client_generated_at) values ($1,$2,'E2E Guest',now())", [guest, store])
  await database.query('insert into public.loyalty_accounts(id,store_id,customer_id) values ($1,$2,$3)', [account, store, guest])
  await database.query("insert into public.kitchen_stations(id,store_id,name) values ($1,$2,'Hot line')", [station, store])
  await database.query("insert into public.floor_areas(id,store_id,name) values ($1,$2,'Main room')", [area, store])
  await database.query("insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats,status) values ($1,$2,$3,'T1',4,'ordering')", [table, store, area])
  await database.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents,station_id) values ($1,$2,'E2E-1','Test dish',1000,$3)", [product, store, station])
  await database.query('insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,20)', [store, product])
  await database.query("insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Piece','pc','count',1)", [unit, store])
  await database.query("insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock,reorder_threshold) values ($1,$2,'Portion',$3,50,10,9)", [ingredient, store, unit])
  await database.query(`insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,reference)
    values ($1,$2,$3,10,10,50,'E2E')`, [batch, store, ingredient])
  await database.query('insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values ($1,$2,$3,1,$4)', [recipe, store, product, unit])
  await database.query('insert into public.recipe_ingredients(store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,2,$4)', [store, recipe, ingredient, unit])

  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const deviceAccess = 'a'.repeat(64), cashierAccess = 'b'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','E2E-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
    [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash)
    values ($1,$2,'Chef','chef',$3,$4)`, [employee, store, '1'.repeat(32), '2'.repeat(64)])
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, employee, digest(cashierAccess)])

  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const fixture = db as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const port = 3191
  const server = createApp({ pool: db, origin: `http://127.0.0.1:${port}`, supabaseUrl: 'http://127.0.0.1:3192', supabaseKey: 'fixture', secureCookies: false })
    .listen(port, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); server.close(); await database.close(); await db.end() })

  const orderId = randomUUID(), itemId = randomUUID()
  const operation = {
    operation_id: orderId,
    order: { id: orderId, store_id: store, receipt_number: 'E2E-0001', catalog_version: 1,
      client_generated_at: new Date().toISOString(), subtotal_cents: 1000, discount_cents: 0, tax_cents: 0,
      service_charge_bps: 0, service_charge_cents: 0, total_cents: 1000, order_type: 'dine_in', table_id: table,
      customer_id: guest, employee_id: null, manager_id: null, manager_approved_at: null },
    items: [{ id: itemId, product_id: product, snapshot_name: 'Test dish', snapshot_sku: 'E2E-1', snapshot_price_cents: 1000,
      snapshot_tax_bps: 0, catalog_version: 1, quantity: 1, discount_kind: null, discount_value: null,
      subtotal_cents: 1000, discount_applied_cents: 0, taxable_cents: 1000, tax_cents: 0, total_cents: 1000 }],
    payment: { id: randomUUID(), method: 'cash', amount_cents: 1000, tendered_cents: 1000, change_cents: 0, reference: null },
  }
  const push = await fetch(`http://127.0.0.1:${port}/pos/orders/push`, {
    method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, Cookie: `terminal_access=${deviceAccess}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(operation),
  })
  assert.equal(push.status, 200, await push.text())

  const ticket = await database.query<{ ticket_id: string; item_id: string }>(
    `select kt.id as ticket_id, kti.id as item_id from public.kitchen_tickets kt
     join public.kitchen_ticket_items kti on kti.store_id=kt.store_id and kti.ticket_id=kt.id where kt.order_id=$1`, [orderId])
  assert.equal(ticket.rows.length, 1)
  const cookie = `terminal_access=${deviceAccess}; terminal_cashier=${cashierAccess}`
  for (const status of ['ready', 'served']) {
    const response = await fetch(`http://127.0.0.1:${port}/pos/kitchen/tickets/${ticket.rows[0].ticket_id}/items/${ticket.rows[0].item_id}`, {
      method: 'PATCH', headers: { Origin: `http://127.0.0.1:${port}`, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: store, status }),
    })
    assert.equal(response.status, 200, await response.text())
  }

  assert.equal(Number((await database.query('select current_stock from public.ingredients where id=$1', [ingredient])).rows[0].current_stock), 8)
  assert.equal(Number((await database.query("select delta from public.stock_movements where kitchen_ticket_item_id=$1 and reason='consumption'", [ticket.rows[0].item_id])).rows[0].delta), -2)
  assert.equal((await database.query('select status from public.restaurant_tables where id=$1', [table])).rows[0].status, 'served')
  assert.equal((await database.query('select points_balance from public.loyalty_accounts where id=$1', [account])).rows[0].points_balance, 10)

  const date = new Date().toISOString().slice(0, 10)
  const { loadDailySummary, loadCustomerReport, loadInventoryReport, loadFoodCostReport, loadKitchenPerformanceReport } = await import('../src/routes/reports.js')
  assert.equal((await loadDailySummary(store, date)).completedOrderCount, 1)
  assert.equal((await loadCustomerReport(store, date, date)).visits, 1)
  assert.equal((await loadInventoryReport(store, date, date)).lowStockCount, 1)
  assert.equal((await loadFoodCostReport(store, date, date)).estimatedFoodCostCents, 100)
  assert.equal((await loadKitchenPerformanceReport(store, date, date)).completedItems, 1)
})
