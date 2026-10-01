import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Day 2 (profitability): loadProfitabilityReport's correctness, tested directly against real
// Postgres semantics (PGlite), same pattern as reports.test.ts's loadDailySummary coverage.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { loadProfitabilityReport, noActualCostAdapter } = await import('./reports.js')
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
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609230002_table_waiter_assignment.sql',
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609250002_inventory_batch_tracking.sql',
  '202609260001_unit_conversion.sql',
  '202609260003_service_charge.sql',
  '202609270001_modifiers.sql',
  '202609280002_open_checks.sql',
  '202609280003_split_settlement.sql',
  '202609280004_refund_settlement_integrity.sql',
  '202609290001_kitchen_operations_depth.sql',
  '202609290002_sellable_combos.sql',
]

async function seededDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
  }
  return database
}

function wireFixture(database: PGlite) {
  const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
  fixture.query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
}

interface Fixture { database: PGlite; store: string; owner: string }

async function baseFixture(): Promise<Fixture> {
  const database = await seededDatabase()
  wireFixture(database)
  const owner = randomUUID(), store = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','profit-test',$2,'UTC')", [store, owner])
  return { database, store, owner }
}

// Inserts one order with one or more items and one or more payments. `items` carry everything
// the report reads: product_id, quantity, taxable_cents (post-discount, pre-tax revenue basis),
// and optionally a combo_parent_item_id to model a combo component. `payments` default to a
// single cash tender covering the order's own total.
async function insertOrder(database: PGlite, params: {
  store: string; orderId?: string; generatedAtUtc: string
  subtotalCents: number; discountCents?: number; taxCents?: number; serviceChargeCents?: number
  items: { productId: string; quantity: number; taxableCents: number; comboParentItemId?: string | null; snapshotPriceCents?: number; taxBps?: number }[]
  payments?: { method: 'cash' | 'card'; amountCents: number; tipCents?: number }[]
}): Promise<string> {
  const orderId = params.orderId ?? randomUUID()
  const discountCents = params.discountCents ?? 0
  const taxCents = params.taxCents ?? 0
  const serviceChargeCents = params.serviceChargeCents ?? 0
  const totalCents = params.subtotalCents - discountCents + taxCents + serviceChargeCents
  await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
      subtotal_cents,discount_cents,tax_cents,service_charge_cents,total_cents,catalog_version,client_generated_at,order_type)
    values ($1,$2,$3,'USD','One','UTC',$4,$5,$6,$7,$8,1,$9,'dine_in')`,
    [orderId, params.store, `R-${orderId.slice(0, 8)}`, params.subtotalCents, discountCents, taxCents, serviceChargeCents, totalCents, params.generatedAtUtc])
  for (const item of params.items) {
    // subtotal_cents must equal taxable_cents when there's no line discount (the
    // pos_order_items_taxable_matches check constraint) -- taxableCents is the line's total
    // revenue, so subtotal_cents is set to the same value, not price-per-unit x quantity.
    const priceCents = item.snapshotPriceCents ?? Math.round(item.taxableCents / item.quantity)
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,combo_parent_item_id)
      values ($1,$2,$3,$4,'Item','SKU',$5,$6,1,$7,$8,0,$8,0,$8,$9)`,
      [randomUUID(), params.store, orderId, item.productId, priceCents, item.taxBps ?? 0, item.quantity, item.taxableCents, item.comboParentItemId ?? null])
  }
  const payments = params.payments ?? [{ method: 'cash' as const, amountCents: totalCents, tipCents: 0 }]
  for (const payment of payments) {
    const tip = payment.tipCents ?? 0
    const tendered = payment.method === 'cash' ? payment.amountCents + tip : payment.amountCents + tip
    await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,tip_cents,client_generated_at)
      values ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
      [randomUUID(), params.store, orderId, payment.method, payment.amountCents, tendered, tip, params.generatedAtUtc])
  }
  return orderId
}

async function insertRefund(database: PGlite, params: {
  store: string; orderId: string; owner: string; createdAtUtc: string
  merchandiseCents: number; taxCents?: number; tipCents?: number; serviceChargeCents?: number
}): Promise<void> {
  const amount = params.merchandiseCents + (params.taxCents ?? 0) + (params.tipCents ?? 0) + (params.serviceChargeCents ?? 0)
  await database.query(`insert into public.pos_refunds(id,store_id,order_id,amount_cents,refunded_by,created_at,merchandise_cents,tax_cents,tip_cents,service_charge_cents)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [randomUUID(), params.store, params.orderId, amount, params.owner, params.createdAtUtc, params.merchandiseCents, params.taxCents ?? 0, params.tipCents ?? 0, params.serviceChargeCents ?? 0])
}

async function insertRecipe(database: PGlite, params: { store: string; productId: string; portionCostCents: number }): Promise<void> {
  // One unit ("each", a count unit with factorToBase 1) used for both the ingredient and the
  // recipe line, one ingredient, yield 1 -- the simplest possible complete, costed recipe whose
  // portion cost is exactly params.portionCostCents, so tests can assert an exact expected total.
  const unit = randomUUID(), ingredient = randomUUID(), recipe = randomUUID()
  // Name/abbreviation must be unique per store -- suffixed so a test can insert more than one
  // recipe (and so more than one unit) against the same store.
  await database.query(`insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,$3,$4,'count',1)`,
    [unit, params.store, `Each ${unit.slice(0, 8)}`, unit.slice(0, 8)])
  await database.query(`insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock) values ($1,$2,$3,$4,$5,1000)`,
    [ingredient, params.store, `Ingredient ${ingredient.slice(0, 8)}`, unit, params.portionCostCents])
  await database.query(`insert into public.recipes(id,store_id,product_id,yield_quantity,yield_unit_id) values ($1,$2,$3,1,$4)`, [recipe, params.store, params.productId, unit])
  await database.query(`insert into public.recipe_ingredients(id,store_id,recipe_id,ingredient_id,unit_id,quantity) values ($1,$2,$3,$4,$5,1)`,
    [randomUUID(), params.store, recipe, ingredient, unit])
}

async function insertProduct(database: PGlite, store: string, active = true): Promise<string> {
  const product = randomUUID()
  await database.query(`insert into public.pos_products(id,store_id,sku,name,unit_price_cents,active) values ($1,$2,$3,'Product',1000,$4)`,
    [product, store, `SKU-${product.slice(0, 8)}`, active])
  await database.query(`insert into public.pos_stock(store_id,product_id,current_stock) values ($1,$2,100)`, [store, product])
  return product
}

test('base reconciliation: gross sales, discount, tax, tips, and service charge are all accounted for exactly once, with no COGS when no recipe exists', async () => {
  const { database, store } = await baseFixture()
  try {
    const product = await insertProduct(database, store)
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 10_000, discountCents: 1_000, taxCents: 900, serviceChargeCents: 500,
      items: [{ productId: product, quantity: 1, taxableCents: 9_000 }],
      payments: [{ method: 'cash', amountCents: 10_400, tipCents: 200 }] })

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    const t = report.totals
    assert.equal(t.grossMerchandiseSalesCents, 10_000)
    assert.equal(t.discountCents, 1_000)
    assert.equal(t.merchandiseRefundsCents, 0)
    assert.equal(t.netMerchandiseRevenueCents, 9_000, 'gross - discount - refunds, not subtracted twice')
    assert.equal(t.estimatedCostOfGoodsCents, 0, 'no recipe exists for this product')
    assert.equal(t.costCoverageBps, 0, 'there was revenue, but none of it has a cost -- 0%, not null')
    assert.equal(t.grossProfitCents, 9_000)
    assert.equal(t.taxCents, 900)
    assert.equal(t.tipsCents, 200)
    assert.equal(t.serviceChargeCents, 500)
    assert.equal(report.actualCostAvailable, false)
    assert.equal(report.costBasis, 'estimated_recipe')
  } finally { await database.close() }
})

test('a partial refund issued in a LATER period reduces that later period, not the original sale\'s day, and never reduces cost of goods', async () => {
  const { database, store, owner } = await baseFixture()
  try {
    const product = await insertProduct(database, store)
    await insertRecipe(database, { store, productId: product, portionCostCents: 300 })
    // 3 units sold on day 1, revenue 3000 cents (1000/unit, no tax/discount for simplicity).
    const orderId = await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 3_000, items: [{ productId: product, quantity: 3, taxableCents: 3_000 }] })
    // A partial refund for 1 of the 3 units (1000 cents merchandise), issued 3 days later.
    await insertRefund(database, { store, orderId, owner, createdAtUtc: '2026-06-04T12:00:00.000Z', merchandiseCents: 1_000 })

    const saleDay = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(saleDay.totals.grossMerchandiseSalesCents, 3_000, "the sale day's own gross is untouched by a later refund")
    assert.equal(saleDay.totals.merchandiseRefundsCents, 0)
    assert.equal(saleDay.totals.netMerchandiseRevenueCents, 3_000)
    assert.equal(saleDay.totals.estimatedCostOfGoodsCents, 900, 'cost of goods is for all 3 units originally sold -- a later refund never un-consumes ingredients')

    const refundDay = await loadProfitabilityReport(store, '2026-06-04', '2026-06-04')
    assert.equal(refundDay.totals.grossMerchandiseSalesCents, 0, 'no new sale happened this day')
    assert.equal(refundDay.totals.merchandiseRefundsCents, 1_000)
    assert.equal(refundDay.totals.netMerchandiseRevenueCents, -1_000, 'zero/negative revenue is reported honestly, not clamped')
    assert.equal(refundDay.totals.estimatedCostOfGoodsCents, 0, 'no items were sold this day')
    assert.equal(refundDay.totals.grossProfitCents, -1_000)

    const whole = await loadProfitabilityReport(store, '2026-06-01', '2026-06-04')
    assert.equal(whole.totals.netMerchandiseRevenueCents, 2_000, 'across the whole range, the two days net out correctly')
    assert.equal(whole.totals.estimatedCostOfGoodsCents, 900)
  } finally { await database.close() }
})

test('multiple tenders on one order (split cash+card, each with its own tip) are aggregated once, never multiplied', async () => {
  const { database, store } = await baseFixture()
  try {
    const product = await insertProduct(database, store)
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 4_000, items: [{ productId: product, quantity: 1, taxableCents: 4_000 }],
      payments: [{ method: 'cash', amountCents: 2_000, tipCents: 100 }, { method: 'card', amountCents: 2_000, tipCents: 150 }] })

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(report.totals.grossMerchandiseSalesCents, 4_000, 'the order-level sum must not be multiplied by its 2 payment rows')
    assert.equal(report.totals.tipsCents, 250, 'tips from both tenders sum once each')
  } finally { await database.close() }
})

test('a combo: revenue lives on the parent line only, but cost of goods is charged against each real component', async () => {
  const { database, store } = await baseFixture()
  try {
    const comboProduct = await insertProduct(database, store) // the combo itself: never has a recipe
    const componentA = await insertProduct(database, store)
    const componentB = await insertProduct(database, store)
    await insertRecipe(database, { store, productId: componentA, portionCostCents: 200 })
    await insertRecipe(database, { store, productId: componentB, portionCostCents: 150 })
    const orderId = randomUUID()
    const parentItemId = randomUUID()
    await database.query(`insert into public.pos_orders(id,store_id,receipt_number,currency,store_name_snapshot,timezone_snapshot,
        subtotal_cents,discount_cents,tax_cents,service_charge_cents,total_cents,catalog_version,client_generated_at,order_type)
      values ($1,$2,'R-combo','USD','One','UTC',1200,0,0,0,1200,1,$3,'dine_in')`, [orderId, store, '2026-06-01T12:00:00.000Z'])
    // Parent combo line: full price, no recipe of its own.
    await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
        snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents)
      values ($1,$2,$3,$4,'Combo','SKU-C',1200,0,1,1,1200,0,1200,0,1200)`, [parentItemId, store, orderId, comboProduct])
    // Components: zero price (revenue already counted on the parent), but real recipe cost.
    for (const component of [componentA, componentB]) {
      await database.query(`insert into public.pos_order_items(id,store_id,order_id,product_id,snapshot_name,snapshot_sku,
          snapshot_price_cents,snapshot_tax_bps,catalog_version,quantity,subtotal_cents,discount_applied_cents,taxable_cents,tax_cents,total_cents,combo_parent_item_id)
        values ($1,$2,$3,$4,'Component','SKU-X',0,0,1,1,0,0,0,0,0,$5)`, [randomUUID(), store, orderId, component, parentItemId])
    }
    await database.query(`insert into public.pos_payments(id,store_id,order_id,method,amount_cents,tendered_cents,change_cents,tip_cents,client_generated_at)
      values ($1,$2,$3,'cash',1200,1200,0,0,$4)`, [randomUUID(), store, orderId, '2026-06-01T12:00:00.000Z'])

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(report.totals.grossMerchandiseSalesCents, 1_200, 'revenue is the combo price once, not doubled by its components')
    assert.equal(report.totals.estimatedCostOfGoodsCents, 350, "cost of goods is each real component's own recipe (200 + 150), not the combo's (which has none)")
    assert.equal(report.totals.grossProfitCents, 850)
  } finally { await database.close() }
})

test('a sale of a product that has since been deactivated still counts -- historical sales of now-inactive products are included', async () => {
  const { database, store } = await baseFixture()
  try {
    const product = await insertProduct(database, store, true)
    await insertRecipe(database, { store, productId: product, portionCostCents: 400 })
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 1_000, items: [{ productId: product, quantity: 1, taxableCents: 1_000 }] })
    await database.query('update public.pos_products set active=false where id=$1', [product])

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(report.totals.grossMerchandiseSalesCents, 1_000, 'the historical sale still counts after the product was deactivated')
    assert.equal(report.totals.estimatedCostOfGoodsCents, 400, 'its recipe is still used for costing')
  } finally { await database.close() }
})

test('missing costs: a mix of a costed and an uncosted product gives a partial, honest coverage percentage', async () => {
  const { database, store } = await baseFixture()
  try {
    const costed = await insertProduct(database, store)
    const uncosted = await insertProduct(database, store)
    await insertRecipe(database, { store, productId: costed, portionCostCents: 100 })
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 2_000, items: [
        { productId: costed, quantity: 1, taxableCents: 1_000 },
        { productId: uncosted, quantity: 1, taxableCents: 1_000 },
      ] })

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(report.totals.costCoverageBps, 5_000, 'exactly half of the revenue has a cost basis')
    assert.equal(report.totals.estimatedCostOfGoodsCents, 100, 'only the costed product contributes to cost of goods')
  } finally { await database.close() }
})

test('zero activity: a day with no orders and no refunds reports honest zeros, not an error', async () => {
  const { database, store } = await baseFixture()
  try {
    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01')
    assert.equal(report.totals.grossMerchandiseSalesCents, 0)
    assert.equal(report.totals.netMerchandiseRevenueCents, 0)
    assert.equal(report.totals.costCoverageBps, null, 'no item revenue at all -- null, not a misleading 0% or 100%')
    assert.equal(report.totals.grossMarginBps, null, 'no revenue to compute a margin against')
    assert.equal(report.days.length, 1)
  } finally { await database.close() }
})

test('date boundaries: a sale near local midnight lands on the correct store-timezone day, and every day in range appears even with zero activity', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const owner = randomUUID(), store = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    // UTC+5: a sale at 2026-06-01T20:00:00Z is 2026-06-02 01:00 local -- the next calendar day.
    await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','profit-test-2',$2,'Asia/Karachi')", [store, owner])
    const product = await insertProduct(database, store)
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T20:00:00.000Z',
      subtotalCents: 500, items: [{ productId: product, quantity: 1, taxableCents: 500 }] })

    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-03')
    assert.deepEqual(report.days.map(day => day.date), ['2026-06-01', '2026-06-02', '2026-06-03'], 'every day in range appears, including the zero-activity ones')
    assert.equal(report.days[0].grossMerchandiseSalesCents, 0, 'the sale does not land on the UTC day')
    assert.equal(report.days[1].grossMerchandiseSalesCents, 500, 'it lands on the correct store-local day instead')
    assert.equal(report.days[2].grossMerchandiseSalesCents, 0)
  } finally { await database.close() }
})

test('the actualCostAdapter seam: a non-null adapter result is preferred over the recipe estimate, and is reported honestly as actual_batch', async () => {
  const { database, store } = await baseFixture()
  try {
    const product = await insertProduct(database, store)
    await insertRecipe(database, { store, productId: product, portionCostCents: 100 })
    await insertOrder(database, { store, generatedAtUtc: '2026-06-01T12:00:00.000Z',
      subtotalCents: 1_000, items: [{ productId: product, quantity: 2, taxableCents: 1_000 }] })

    const adapter = async () => new Map([[product, 777]])
    const report = await loadProfitabilityReport(store, '2026-06-01', '2026-06-01', adapter)
    assert.equal(report.actualCostAvailable, true)
    assert.equal(report.costBasis, 'actual_batch')
    assert.equal(report.totals.estimatedCostOfGoodsCents, 1_554, 'actual per-unit cost (777) x quantity (2), not the recipe estimate (100)')
  } finally { await database.close() }
})

test('noActualCostAdapter is the honest default: always unavailable, never invented', async () => {
  assert.equal(await noActualCostAdapter('store', '2026-01-01', '2026-01-01'), null)
})
