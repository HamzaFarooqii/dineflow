import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as floor.test.ts: pure validation never opens a connection; the PGlite-backed
// tests below monkey-patch db.query/db.connect before use.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { parseRecipeBody, parseUnitBody, saveRecipe } = await import('./catalog.js')
const { db } = await import('../db.js')

const unitA = randomUUID(), unitB = randomUUID(), ingredientA = randomUUID()

test('parseUnitBody trims and validates name, abbreviation and kind', () => {
  assert.deepEqual(parseUnitBody({ name: ' Kilogram ', abbreviation: ' kg ', kind: 'mass' }), { name: 'Kilogram', abbreviation: 'kg', kind: 'mass', factor_to_base: null })
  assert.throws(() => parseUnitBody({ name: '', abbreviation: 'kg', kind: 'mass' }), /Unit name/)
  assert.throws(() => parseUnitBody({ name: 'Kilogram', abbreviation: 'kilograms!!', kind: 'mass' }), /abbreviation/)
  assert.throws(() => parseUnitBody({ name: 'Kilogram', abbreviation: 'kg', kind: 'weight' }), /mass, volume, or count/)
})

test('parseUnitBody accepts an optional positive factor_to_base, or rejects a bad one', () => {
  assert.deepEqual(parseUnitBody({ name: 'Gram', abbreviation: 'g', kind: 'mass', factor_to_base: 1 }), { name: 'Gram', abbreviation: 'g', kind: 'mass', factor_to_base: 1 })
  assert.throws(() => parseUnitBody({ name: 'Gram', abbreviation: 'g', kind: 'mass', factor_to_base: 0 }), /factor_to_base/)
  assert.throws(() => parseUnitBody({ name: 'Gram', abbreviation: 'g', kind: 'mass', factor_to_base: -1 }), /factor_to_base/)
})

test('parseRecipeBody requires a positive yield, a unit, and well-formed unique lines', () => {
  const ok = parseRecipeBody({ yield_quantity: 4, yield_unit_id: unitA, lines: [{ ingredient_id: ingredientA, quantity: 0.25, unit_id: unitB }] })
  assert.equal(ok.lines.length, 1)
  assert.throws(() => parseRecipeBody({ yield_quantity: 0, yield_unit_id: unitA, lines: [] }), /Recipe yield/)
  assert.throws(() => parseRecipeBody({ yield_quantity: '4', yield_unit_id: unitA, lines: [] }), /Recipe yield/)
  assert.throws(() => parseRecipeBody({ yield_quantity: 1, yield_unit_id: 'nope', lines: [] }), /yield unit/)
  assert.throws(() => parseRecipeBody({ yield_quantity: 1, yield_unit_id: unitA }), /lines must be an array/)
  assert.throws(() => parseRecipeBody({ yield_quantity: 1, yield_unit_id: unitA, lines: [{ ingredient_id: ingredientA, quantity: -1, unit_id: unitA }] }), /Line 1 quantity/)
  const dup = { ingredient_id: ingredientA, quantity: 1, unit_id: unitA }
  assert.throws(() => parseRecipeBody({ yield_quantity: 1, yield_unit_id: unitA, lines: [dup, dup] }), /Line 2: this ingredient is already/)
})

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609210001_restaurant_foundation.sql',
  '202609240001_units_and_recipes.sql',
  '202609260001_unit_conversion.sql',
]

// Bisma's planned ingredients/recipe_ingredients shape (docs/day-plans/day3.md), trimmed to the
// columns this module reads/writes — lets the line-saving path be tested before her migration
// exists. If her final migration diverges, this fixture should be replaced by the real file.
const ingredientTables = `
create table public.ingredients (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id),
  name text not null, unit_id uuid not null, cost_per_unit_cents integer not null check (cost_per_unit_cents >= 0),
  active boolean not null default true, unique (store_id, id),
  foreign key (store_id, unit_id) references public.units(store_id, id));
create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(), store_id uuid not null references public.stores(id),
  recipe_id uuid not null, ingredient_id uuid not null, quantity numeric not null check (quantity > 0), unit_id uuid not null,
  foreign key (store_id, recipe_id) references public.recipes(store_id, id),
  foreign key (store_id, ingredient_id) references public.ingredients(store_id, id),
  foreign key (store_id, unit_id) references public.units(store_id, id));`

async function fixtureDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>; connect: () => Promise<import('pg').PoolClient> }
  fixture.query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  // See floor.test.ts: one embedded instance stands in for the pool's transactional client.
  fixture.connect = async () => ({ query: fixture.query, release: () => undefined }) as unknown as import('pg').PoolClient

  const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), product = randomUUID(), portion = randomUUID(), otherUnit = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','recipe-test',$2,'UTC')", [store, owner])
  await database.query("insert into public.stores(id,name,code,created_by,timezone) values ($1,'Two','recipe-test-2',$2,'UTC')", [otherStore, owner])
  await database.query("insert into public.pos_products(id,store_id,sku,name,unit_price_cents) values ($1,$2,'MAIN-1','Risotto',1500)", [product, store])
  await database.query("insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Portion','ptn','count')", [portion, store])
  await database.query("insert into public.units(id,store_id,name,abbreviation,kind) values ($1,$2,'Portion','ptn','count')", [otherUnit, otherStore])
  return { database, store, otherStore, product, portion, otherUnit }
}

test('saveRecipe saves a yield-only recipe before ingredient inventory exists, and refuses lines', async () => {
  const { database, store, product, portion, otherUnit } = await fixtureDatabase()
  try {
    const saved = await saveRecipe(store, product, { yield_quantity: 2, yield_unit_id: portion, lines: [] })
    assert.equal(saved.product_id, product)
    assert.equal(saved.yield_quantity, 2)
    assert.deepEqual(saved.lines, [])

    // Upsert, not a second row: unique (store_id, product_id).
    const again = await saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [] })
    assert.equal(again.id, saved.id)
    assert.equal(again.yield_quantity, 4)

    await assert.rejects(saveRecipe(store, product, { yield_quantity: 1, yield_unit_id: portion, lines: [{ ingredient_id: randomUUID(), quantity: 1, unit_id: portion }] }), /Ingredient inventory is not set up yet/)
    await assert.rejects(saveRecipe(store, product, { yield_quantity: 1, yield_unit_id: otherUnit, lines: [] }), /yield unit does not belong/)
    await assert.rejects(saveRecipe(store, randomUUID(), { yield_quantity: 1, yield_unit_id: portion, lines: [] }), /does not exist in this store/)
  } finally {
    await database.close()
  }
})

test('saveRecipe replaces every ingredient line on save and enforces store + unit matching', async () => {
  const { database, store, otherStore, product, portion, otherUnit } = await fixtureDatabase()
  try {
    await database.exec(ingredientTables)
    const kg = randomUUID(), gram = randomUUID(), rice = randomUUID(), stock = randomUUID(), foreign = randomUUID()
    await database.query("insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Kilogram','kg','mass',1000)", [kg, store])
    await database.query("insert into public.units(id,store_id,name,abbreviation,kind,factor_to_base) values ($1,$2,'Gram','g','mass',1)", [gram, store])
    await database.query("insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents) values ($1,$2,'Rice',$3,400)", [rice, store, kg])
    await database.query("insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents) values ($1,$2,'Stock',$3,50)", [stock, store, portion])
    await database.query("insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents) values ($1,$2,'Rice',$3,400)", [foreign, otherStore, otherUnit])

    const first = await saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [
      { ingredient_id: rice, quantity: 0.4, unit_id: kg },
      { ingredient_id: stock, quantity: 2, unit_id: portion },
    ] })
    assert.equal(first.lines.length, 2)

    const replaced = await saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [{ ingredient_id: rice, quantity: 0.5, unit_id: kg }] })
    assert.deepEqual(replaced.lines.map(line => [line.ingredient_id, line.quantity]), [[rice, 0.5]])
    const count = await database.query<{ n: number }>('select count(*)::int as n from public.recipe_ingredients')
    assert.equal(count.rows[0].n, 1, 'old lines are deleted, not left orphaned')

    await assert.rejects(saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [{ ingredient_id: rice, quantity: 1, unit_id: portion }] }), /no known conversion/)

    // Gram and kilogram both carry a factor_to_base of the same kind, so a gram line against a
    // kilogram-stocked ingredient is now accepted (this is the whole point of the feature).
    const converted = await saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [{ ingredient_id: rice, quantity: 500, unit_id: gram }] })
    assert.deepEqual(converted.lines.map(line => [line.ingredient_id, line.quantity, line.unit_id]), [[rice, 500, gram]])

    await assert.rejects(saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [{ ingredient_id: foreign, quantity: 1, unit_id: kg }] }), /does not belong to this store/)
    await assert.rejects(saveRecipe(store, product, { yield_quantity: 4, yield_unit_id: portion, lines: [{ ingredient_id: rice, quantity: 1, unit_id: otherUnit }] }), /unit that does not belong/)
  } finally {
    await database.close()
  }
})
