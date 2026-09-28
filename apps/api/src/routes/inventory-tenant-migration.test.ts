import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170002_cart_discounts.sql',
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609240001_units_and_recipes.sql',
  '202609240002_ingredient_inventory.sql',
  '202609240003_inventory_audit_columns.sql',
  '202609240004_inventory_terminal_audit.sql',
  '202609280001_inventory_terminal_tenant_fks.sql',
]

async function migratedDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8'))
      .replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  return database
}

test('inventory attribution foreign keys enforce the restaurant boundary', async () => {
  const database = await migratedDatabase()
  try {
    const owner = randomUUID(), storeA = randomUUID(), storeB = randomUUID()
    const unit = randomUUID(), ingredient = randomUUID(), employeeA = randomUUID(), employeeB = randomUUID()
    await database.query('insert into auth.users(id) values ($1)', [owner])
    await database.query(
      "insert into public.stores(id,name,code,created_by,timezone) values ($1,'One','tenant-a',$3,'UTC'),($2,'Two','tenant-b',$3,'UTC')",
      [storeA, storeB, owner],
    )
    for (const [employee, store] of [[employeeA, storeA], [employeeB, storeB]]) {
      await database.query(
        `insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash)
         values ($1,$2,'Manager','manager',$3,$4)`,
        [employee, store, 'a'.repeat(32), 'b'.repeat(64)],
      )
    }
    await database.query(
      `insert into public.units(id,store_id,name,abbreviation,kind)
       values ($1,$2,'Kilogram','kg','mass')`,
      [unit, storeA],
    )
    await database.query(
      `insert into public.ingredients(id,store_id,name,unit_id,cost_per_unit_cents,current_stock,created_by_employee_id,manager_id,manager_approved_at)
       values ($1,$2,'Flour',$3,50,10,$4,$4,now())`,
      [ingredient, storeA, unit, employeeA],
    )

    await assert.rejects(
      database.query('update public.ingredients set manager_id=$1 where id=$2', [employeeB, ingredient]),
      /foreign key|violates/i,
    )
    await assert.rejects(
      database.query(
        `insert into public.stock_movements(store_id,ingredient_id,delta,reason,created_by_employee_id,manager_id,manager_approved_at)
         values ($1,$2,1,'adjustment',$3,$3,now())`,
        [storeA, ingredient, employeeB],
      ),
      /foreign key|violates/i,
    )
  } finally {
    await database.close()
  }
})
