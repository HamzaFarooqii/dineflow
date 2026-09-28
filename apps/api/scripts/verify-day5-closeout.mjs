import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
const checks = [
  {
    name: 'modifier tables',
    sql: `select count(*)::int as count from information_schema.tables
      where table_schema='public' and table_name in
      ('modifier_groups','modifier_options','product_modifier_groups','pos_order_item_modifiers')`,
    pass: rows => rows[0]?.count === 4,
  },
  {
    name: 'modifier RLS',
    sql: `select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in
      ('modifier_groups','modifier_options','product_modifier_groups','pos_order_item_modifiers')
      and c.relrowsecurity`,
    pass: rows => rows[0]?.count === 4,
  },
  {
    name: 'modifier member-read policies',
    sql: `select count(*)::int as count from pg_policies where schemaname='public'
      and tablename in ('modifier_groups','modifier_options','product_modifier_groups','pos_order_item_modifiers')
      and cmd='SELECT'`,
    pass: rows => rows[0]?.count === 4,
  },
  {
    name: 'inventory terminal tenant foreign keys',
    sql: `select count(*)::int as count from pg_constraint where conname in
      ('ingredients_created_by_employee_store_fkey','ingredients_manager_store_fkey',
       'stock_movements_created_by_employee_store_fkey','stock_movements_manager_store_fkey')
      and pg_get_constraintdef(oid) like 'FOREIGN KEY (store_id, %'`,
    pass: rows => rows[0]?.count === 4,
  },
  {
    name: 'RLS on every public store-scoped table',
    sql: `select c.relname from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      join information_schema.columns col on col.table_schema=n.nspname and col.table_name=c.relname
      where n.nspname='public' and c.relkind='r' and col.column_name='store_id' and not c.relrowsecurity
      order by c.relname`,
    pass: rows => rows.length === 0,
    describe: rows => rows.length ? `missing on: ${rows.map(row => row.relname).join(', ')}` : '',
  },
]

let failed = false
await client.connect()
try {
  for (const check of checks) {
    const { rows } = await client.query(check.sql)
    const ok = check.pass(rows)
    failed ||= !ok
    const detail = check.describe?.(rows)
    console.log(`${ok ? 'CONFIRMED' : 'MISMATCH '} ${check.name}${detail ? ` - ${detail}` : ''}`)
  }
} finally {
  await client.end()
}

if (failed) process.exitCode = 1
