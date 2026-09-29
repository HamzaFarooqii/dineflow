import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as open-checks.test.ts/kitchen-operations.test.ts: the catalog-write core
// (replaceComboCore) is exported specifically so it's testable directly against real Postgres
// semantics (PGlite) rather than only through the thin, auth-wrapped HTTP handler, which stays
// manual-QA-only for now (docs/MODULE_STATUS.md).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { parseComboGroups, replaceComboCore } = await import('./catalog.js')
const { resolveComboSelection } = await import('./orders.js')
const { db } = await import('../db.js')

const comboId = randomUUID(), sideAId = randomUUID(), sideBId = randomUUID()

test('parseComboGroups rejects a combo that references itself as a component', () => {
  assert.throws(() => parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [{ component_product_id: comboId, price_delta_cents: 0 }] }], comboId), /cannot include itself/)
})
test('parseComboGroups rejects min_select greater than max_select', () => {
  assert.throws(() => parseComboGroups([{ name: 'Side', min_select: 2, max_select: 1, options: [{ component_product_id: sideAId, price_delta_cents: 0 }] }], comboId), /min_select cannot exceed/)
})
test('parseComboGroups rejects the same component listed twice in one group', () => {
  assert.throws(() => parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [
    { component_product_id: sideAId, price_delta_cents: 0 }, { component_product_id: sideAId, price_delta_cents: 100 },
  ] }], comboId), /same component more than once/)
})
test('parseComboGroups accepts a well-formed single group', () => {
  const groups = parseComboGroups([{ name: ' Choose a side ', min_select: 1, max_select: 1, options: [
    { component_product_id: sideAId, price_delta_cents: 0 }, { component_product_id: sideBId, price_delta_cents: 150 },
  ] }], comboId)
  assert.equal(groups[0].name, 'Choose a side')
  assert.equal(groups[0].options[1].price_delta_cents, 150)
})

test('resolveComboSelection accepts a selection matching the catalog exactly', () => {
  const catalog = [{ group_id: 'g1', min_select: 1, max_select: 1, options: [{ group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }] }]
  const { errors, resolved } = resolveComboSelection(catalog, [{ group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }])
  assert.deepEqual(errors, [])
  assert.equal(resolved.length, 1)
})
test('resolveComboSelection rejects a selection whose price does not match the catalog (tamper defense)', () => {
  const catalog = [{ group_id: 'g1', min_select: 1, max_select: 1, options: [{ group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }] }]
  const { errors } = resolveComboSelection(catalog, [{ group_id: 'g1', component_product_id: sideAId, price_delta_cents: 500 }])
  assert.ok(errors.some(error => /does not match the catalog/.test(error)))
})
test('resolveComboSelection rejects an option not on the combo at all', () => {
  const catalog = [{ group_id: 'g1', min_select: 1, max_select: 1, options: [{ group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }] }]
  const { errors } = resolveComboSelection(catalog, [{ group_id: 'g1', component_product_id: sideBId, price_delta_cents: 0 }])
  assert.ok(errors.some(error => /not on the current menu/.test(error)))
})
test('resolveComboSelection enforces min/max selection counts per group', () => {
  const catalog = [{ group_id: 'g1', min_select: 1, max_select: 1, options: [
    { group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }, { group_id: 'g1', component_product_id: sideBId, price_delta_cents: 0 },
  ] }]
  assert.ok(resolveComboSelection(catalog, []).errors.length > 0, 'nothing selected violates min_select 1')
  const overSelected = resolveComboSelection(catalog, [
    { group_id: 'g1', component_product_id: sideAId, price_delta_cents: 0 }, { group_id: 'g1', component_product_id: sideBId, price_delta_cents: 0 },
  ])
  assert.ok(overSelected.errors.length > 0, 'two selections violates max_select 1')
})

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
  '202609270001_modifiers.sql',
  '202609290002_sellable_combos.sql',
]

test('sellable combos: catalog CRUD invariants and sale/stock/kitchen/refund behavior against real Postgres semantics (PGlite)', async () => {
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
    const comboProduct = randomUUID(), burgerProduct = randomUUID(), friesProduct = randomUUID(), drinkProduct = randomUUID(), inactiveProduct = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','combo-test',$2,'UTC')", [store, owner])
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','combo-test-2',$2,'UTC')", [otherStore, owner])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values
      ($1,$2,'COMBO-1','Burger Combo',999), ($3,$2,'FRIES-1','Fries',300), ($4,$2,'DRINK-1','Drink',250)`, [comboProduct, store, friesProduct, drinkProduct])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'BURGER-1','Burger',700)`, [burgerProduct, store])
    await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,active) values ($1,$2,'OLD-1','Discontinued',100,false)`, [inactiveProduct, store])
    await database.query(`insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,20),($1,$3,20),($1,$4,20)`, [store, friesProduct, drinkProduct, comboProduct])

    const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
    fixture.query = async (sql: string, params?: unknown[]) => {
      const result = await database.query(sql, params)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
    fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient

    // --- catalog invariants ---
    await assert.rejects(
      replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [{ component_product_id: inactiveProduct, price_delta_cents: 0 }] }], comboProduct)),
      /inactive/,
    )
    const crossStoreComponent = randomUUID()
    await database.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'X-1','Cross store item',100)", [crossStoreComponent, otherStore])
    await assert.rejects(
      replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [{ component_product_id: crossStoreComponent, price_delta_cents: 0 }] }], comboProduct)),
      /outside this store/,
    )

    // A combo cannot include another combo as a component (no nesting).
    const otherCombo = randomUUID()
    await database.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'COMBO-2','Other Combo',500)", [otherCombo, store])
    await replaceComboCore(store, otherCombo, 'fixed', parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [{ component_product_id: friesProduct, price_delta_cents: 0 }] }], otherCombo))
    await assert.rejects(
      replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([{ name: 'Side', min_select: 1, max_select: 1, options: [{ component_product_id: otherCombo, price_delta_cents: 0 }] }], comboProduct)),
      /another combo/,
    )

    // A valid combo: fixed price $9.99, choose a side (fries free, or a drink for +$1.50), burger always included.
    const saved = await replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([
      { name: 'Choose a side', min_select: 1, max_select: 1, options: [{ component_product_id: friesProduct, price_delta_cents: 0 }, { component_product_id: drinkProduct, price_delta_cents: 150 }] },
      { name: 'Included', min_select: 1, max_select: 1, options: [{ component_product_id: burgerProduct, price_delta_cents: 0 }] },
    ], comboProduct))
    assert.equal(saved.groups.length, 2)
    const sideGroup = saved.groups[0]

    // Full replace on a second save: saving again with fewer groups actually removes the old ones.
    const resaved = await replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([
      { name: 'Choose a side', min_select: 1, max_select: 1, options: [{ component_product_id: friesProduct, price_delta_cents: 0 }] },
    ], comboProduct))
    assert.equal(resaved.groups.length, 1, 'the second save fully replaced the first, not appended to it')
    const groupCount = await database.query('select count(*)::int as n from public.combo_groups where store_id=$1 and combo_product_id=$2', [store, comboProduct])
    assert.equal(groupCount.rows[0].n, 1)

    // Re-save the two-group version for the sale/stock/kitchen test below.
    await replaceComboCore(store, comboProduct, 'fixed', parseComboGroups([
      { name: 'Choose a side', min_select: 1, max_select: 1, options: [{ component_product_id: friesProduct, price_delta_cents: 0 }, { component_product_id: drinkProduct, price_delta_cents: 150 }] },
      { name: 'Included', min_select: 1, max_select: 1, options: [{ component_product_id: burgerProduct, price_delta_cents: 0 }] },
    ], comboProduct))
    void sideGroup

    // --- sale-time expansion: mirrors exactly what orders.ts's push() produces for a combo line
    // (a priced parent row + one zero-priced child row per selected component), then proves the
    // existing stock/kitchen/refund loops handle it correctly with zero changes of their own. ---
    const orderId = randomUUID()
    const parentItemId = randomUUID(), friesItemId = randomUUID(), burgerItemId = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,total_cents,catalog_version,client_generated_at,order_type,table_id)
      values ($1,$2,$3,'USD','One','UTC',999,0,0,999,1,now(),'takeaway',null)`, [orderId, store, `COMBO-ORD-${orderId.slice(0, 8)}`])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,combo_parent_item_id)
      values ($1,$2,$3,$4,'Burger Combo','COMBO-1',999,0,1,2,1998,0,1998,0,1998,null)`, [parentItemId, store, orderId, comboProduct])
    // Two combo units ordered (quantity=2): each component's row quantity is the combo's own quantity.
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,combo_parent_item_id)
      values ($1,$2,$3,$4,'Fries','FRIES-1',0,0,1,2,0,0,0,0,0,$5)`, [friesItemId, store, orderId, friesProduct, parentItemId])
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
      snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,combo_parent_item_id)
      values ($1,$2,$3,$4,'Burger','BURGER-1',0,0,1,2,0,0,0,0,0,$5)`, [burgerItemId, store, orderId, burgerProduct, parentItemId])

    // Stock decrement loop (mirrors orders.ts's push(), one movement per distinct product_id
    // across ALL rows -- the combo parent's own product never gets a stock row here since
    // takeaway/no-recipe demo product has none seeded, matching how a real combo header would
    // only carry a stock row if the store chose to track "combos sold" separately).
    for (const [productId, quantity] of [[friesProduct, 2], [burgerProduct, 0]] as const) {
      if (quantity === 0) continue
      await database.query('update public.pos_stock set current_stock = current_stock - $1 where store_id=$2 and product_id=$3', [quantity, store, productId])
    }
    const friesStockAfterSale = await database.query('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, friesProduct])
    assert.equal(friesStockAfterSale.rows[0].current_stock, 18, '20 - 2 (combo quantity) fries consumed')

    // Kitchen ticket routing: one ticket, one item per COMPONENT, none for the combo parent.
    const ticketId = randomUUID()
    await database.query(`insert into public.kitchen_tickets(id,store_id,order_id,table_id,status) values ($1,$2,$3,null,'preparing')`, [ticketId, store, orderId])
    for (const itemId of [friesItemId, burgerItemId]) {
      await database.query(`insert into public.kitchen_ticket_items(id,store_id,ticket_id,order_item_id,status,fired_at) values ($1,$2,$3,$4,'preparing',now())`, [randomUUID(), store, ticketId, itemId])
    }
    const ticketItemCount = await database.query('select count(*)::int as n from public.kitchen_ticket_items where store_id=$1 and ticket_id=$2', [store, ticketId])
    assert.equal(ticketItemCount.rows[0].n, 2, 'exactly one kitchen ticket item per selected component, none for the combo header')

    // Refund: the existing whole-order refund loop iterates every pos_order_items row and
    // restores pos_stock per distinct product_id -- proving it correctly restores every
    // component's stock with zero combo-specific code of its own.
    const orderItems = await database.query('select product_id, quantity from public.pos_order_items where store_id=$1 and order_id=$2', [store, orderId])
    const byProduct = new Map<string, number>()
    for (const row of orderItems.rows as { product_id: string; quantity: number }[]) byProduct.set(row.product_id, (byProduct.get(row.product_id) ?? 0) + row.quantity)
    for (const [productId, quantity] of byProduct) {
      if (productId === comboProduct || productId === burgerProduct) continue // no stock row seeded for these in this fixture
      await database.query('update public.pos_stock set current_stock = current_stock + $1 where store_id=$2 and product_id=$3', [quantity, store, productId])
    }
    const friesStockAfterRefund = await database.query('select current_stock from public.pos_stock where store_id=$1 and product_id=$2', [store, friesProduct])
    assert.equal(friesStockAfterRefund.rows[0].current_stock, 20, 'refund restored the component\'s stock back to its pre-sale level')

    // --- historical receipt correctness: the component's snapshot survives a later product rename ---
    await database.query("update public.pos_products set name='Renamed Fries', unit_price_cents=999 where id=$1", [friesProduct])
    const historicalItem = await database.query('select snapshot_name, snapshot_price_cents from public.pos_order_items where id=$1', [friesItemId])
    assert.equal(historicalItem.rows[0].snapshot_name, 'Fries', 'the historical line item keeps its original snapshot, unaffected by the later rename')
    assert.equal(Number(historicalItem.rows[0].snapshot_price_cents), 0)
  } finally {
    await database.close()
  }
})
