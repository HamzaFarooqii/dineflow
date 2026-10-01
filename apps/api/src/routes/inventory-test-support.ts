// Shared PGlite fixtures for the Day 2 inventory suites (inventory-wastage.test.ts,
// stock-valuation.test.ts, inventory-cost-contract.test.ts). Not a test file itself.
//
// The migration chain mirrors production order for everything inventory touches, ending in the
// Day 1 manager-approval table and the Day 2 wastage/valuation migration.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Transaction } from '@electric-sql/pglite'

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const root = repoRoot
export const INVENTORY_MIGRATION_CHAIN = [
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
  '202609250002_inventory_batch_tracking.sql',
  '202609260001_unit_conversion.sql',
  '202609270001_modifiers.sql',
  '202609280001_inventory_terminal_tenant_fks.sql',
  '202609280003_purchasing_vendors.sql',
  '202610010001_terminal_manager_approvals.sql',
  '202610020001_wastage_categories_batch_valuation.sql',
]

/** `through` limits the chain (e.g. everything BEFORE the Day 2 migration, to test it against pre-existing rows). */
export async function seededInventoryDatabase(through: readonly string[] = INVENTORY_MIGRATION_CHAIN): Promise<PGlite> {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of through) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  return database
}

type Queryable = Pick<PGlite, 'query'> | Transaction

/** A pg-shaped client over PGlite (or one of its transactions). */
export function clientFor(database: Queryable): import('pg').PoolClient {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    },
  } as unknown as import('pg').PoolClient
}

/**
 * Runs `work` inside ONE PGlite transaction and commits it. PGlite is a single connection, so two
 * of these started with Promise.all run one after the other -- that proves what the SECOND request
 * does once the first has committed (the case the row locks exist to make safe), but it cannot
 * demonstrate real lock contention. See docs/inventory-cost-contract.md "Concurrency" for that limit.
 */
export function inTransaction<T>(database: PGlite, work: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async tx => work(clientFor(tx)))
}

export interface InventoryFixture {
  database: PGlite
  store: string
  otherStore: string
  owner: string
  kg: string
  gram: string
  litre: string
  /** An ingredient stocked in kg at 70 cents/kg with the given aggregate stock and no batches. */
  ingredient: string
}

export async function seedInventoryFixture(database: PGlite, options: { stock?: number; ingredientCostCents?: number } = {}): Promise<InventoryFixture> {
  const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID()
  const kg = randomUUID(), gram = randomUUID(), litre = randomUUID(), ingredient = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  for (const [id, code] of [[store, 'inv-a'], [otherStore, 'inv-b']] as const) {
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,$2,$3,$4,'UTC')", [id, code, code, owner])
    await database.query(`insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Kilogram','kg','mass',1000)`, [id === store ? kg : randomUUID(), id])
  }
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Gram','g','mass',1)`, [gram, store])
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Litre','L','volume')`, [litre, store])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,'Flour',$3,$4,$5)`,
    [ingredient, store, kg, options.ingredientCostCents ?? 70, options.stock ?? 0])
  return { database, store, otherStore, owner, kg, gram, litre, ingredient }
}

export async function addBatch(database: PGlite, fixture: Pick<InventoryFixture, 'store'>, ingredient: string, options: {
  quantity: number; remaining?: number; costCents: number; expiresAt?: string | null; receivedAt?: string
}): Promise<string> {
  const id = randomUUID()
  await database.query(
    `insert into public.ingredient_batches(id,store_id,ingredient_id,quantity,remaining_quantity,cost_per_unit_cents,expires_at,received_at)
     values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz, now()))`,
    [id, fixture.store, ingredient, options.quantity, options.remaining ?? options.quantity, options.costCents, options.expiresAt ?? null, options.receivedAt ?? null],
  )
  return id
}

export interface KitchenItem { product: string; itemId: string }

/** A product whose recipe uses `perSaleQuantity` of `unit` of `ingredient` per sale, with one preparing kitchen item. */
export async function addKitchenItem(database: PGlite, fixture: Pick<InventoryFixture, 'store'>, ingredient: string, unit: string, perSaleQuantity: number, quantitySold = 1): Promise<KitchenItem> {
  const product = randomUUID(), recipe = randomUUID(), orderId = randomUUID(), orderItemId = randomUUID(), ticketId = randomUUID(), itemId = randomUUID()
  const sku = `SKU-${product.slice(0, 8)}`
  await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,$3,'Test dish',1200)`, [product, fixture.store, sku])
  const kg = await database.query<{ id: string }>(`select id from public.units where store_id=$1 and abbreviation='kg'`, [fixture.store])
  await database.query(`insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values ($1,$2,$3,1,$4)`, [recipe, fixture.store, product, kg.rows[0].id])
  await database.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,quantity,unit_id) values ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), fixture.store, recipe, ingredient, perSaleQuantity, unit])
  await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
    subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type)
    values ($1,$2,$3,'USD','One','UTC',1200,0,0,1200,1,now(),'dine_in')`, [orderId, fixture.store, `KTN-${orderId.slice(0, 8)}`])
  await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
    snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
    values ($1,$2,$3,$4,'Test dish',$5,1200,0,1,$6,1200,0,1200,0,1200)`, [orderItemId, fixture.store, orderId, product, sku, quantitySold])
  await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,status) values ($1,$2,$3,'preparing')`, [ticketId, fixture.store, orderId])
  await database.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status) values ($1,$2,$3,$4,'preparing')`, [itemId, fixture.store, ticketId, orderItemId])
  return { product, itemId }
}

export async function stockOf(database: PGlite, ingredient: string): Promise<number> {
  const row = await database.query<{ current_stock: string }>('select current_stock::text as current_stock from public.ingredients where id=$1', [ingredient])
  return Number(row.rows[0].current_stock)
}

export async function remainingOf(database: PGlite, batch: string): Promise<number> {
  const row = await database.query<{ remaining_quantity: string }>('select remaining_quantity::text as remaining_quantity from public.ingredient_batches where id=$1', [batch])
  return Number(row.rows[0].remaining_quantity)
}

/** A terminal device + an active manager whose approval tokens can be inserted for forged/valid redemption tests. */
export async function addTerminal(database: PGlite, fixture: Pick<InventoryFixture, 'store' | 'owner'>): Promise<{ deviceId: string; managerId: string; cashierId: string }> {
  const deviceId = randomUUID(), managerId = randomUUID(), cashierId = randomUUID()
  const tag = deviceId.slice(0, 6) // device and employee names are unique per store
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,$7,$3,$4,$5,now()+interval '1 day',$6,now()+interval '1 day')`,
  [deviceId, fixture.store, `R-${tag}`, fixture.owner, randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''), `Register ${tag}`])
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values
    ($1,$3,$4,'manager',repeat('a',32),repeat('b',64)), ($2,$3,$5,'cashier',repeat('c',32),repeat('d',64))`, [managerId, cashierId, fixture.store, `Manager ${tag}`, `Cashier ${tag}`])
  return { deviceId, managerId, cashierId }
}

/**
 * Builds, from real rows, the scenario documented in packages/domain/src/inventory-cost-summary.fixtures.ts.
 * Everything is stamped inside 2026-10-02 UTC so the period is deterministic.
 */
export async function seedCostContractScenario(database: PGlite, deps: {
  consume: (client: import('pg').PoolClient, store: string, itemId: string, product: string, quantity: number) => Promise<void>
  waste: (f: InventoryFixture, body: Record<string, unknown>) => Promise<unknown>
}): Promise<InventoryFixture & { itemOne: string; itemTwo: string }> {
  const f = await seedInventoryFixture(database, { stock: 14, ingredientCostCents: 70 })
  await addBatch(database, f, f.ingredient, { quantity: 4, costCents: 50, expiresAt: '2026-10-05T00:00:00Z' })
  await addBatch(database, f, f.ingredient, { quantity: 10, costCents: 80, expiresAt: '2026-11-05T00:00:00Z' })
  const one = await addKitchenItem(database, f, f.ingredient, f.kg, 6)
  await deps.consume(clientFor(database), f.store, one.itemId, one.product, 1)
  await deps.waste(f, { wastage_category: 'spoiled', quantity: 3, note: 'walk-in failure' })
  await deps.waste(f, { wastage_category: 'returned_order', kitchen_ticket_item_id: one.itemId, quantity: 2 })
  const two = await addKitchenItem(database, f, f.ingredient, f.kg, 10)
  await deps.consume(clientFor(database), f.store, two.itemId, two.product, 1)
  const batchA = (await database.query<{ id: string }>(`select id from public.ingredient_batches where store_id=$1 and cost_per_unit_cents=50`, [f.store])).rows[0].id
  await database.query(`insert into public.stock_movements(store_id,ingredient_id,batch_id,delta,reason) values ($1,$2,$3,-3,'consumption')`, [f.store, f.ingredient, batchA])
  await database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason) values ($1,$2,-2,'consumption')`, [f.store, f.ingredient])
  await database.query(`insert into public.stock_movements(store_id,ingredient_id,delta,reason,note) values ($1,$2,-1,'adjustment','count correction')`, [f.store, f.ingredient])
  // Stamp every movement/allocation inside the example day, in creation order.
  await database.query(`update public.stock_movements set created_at = '2026-10-02T08:00:00Z'::timestamptz + (extract(epoch from created_at) - (select min(extract(epoch from created_at)) from public.stock_movements)) * interval '1 millisecond' where store_id=$1`, [f.store])
  await database.exec('alter table public.stock_movement_allocations disable trigger stock_movement_allocations_no_update')
  await database.query(`update public.stock_movement_allocations set created_at = '2026-10-02T08:00:00Z' where store_id=$1`, [f.store])
  await database.exec('alter table public.stock_movement_allocations enable trigger stock_movement_allocations_no_update')
  return { ...f, itemOne: one.itemId, itemTwo: two.itemId }
}
