import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('combos','combo_groups','combo_group_options') order by table_name",
  )
  const column = await client.query("select 1 from information_schema.columns where table_name='pos_order_items' and column_name='combo_parent_item_id'")
  console.log('Tables:', tables.rows.map(row => row.table_name))
  console.log('pos_order_items.combo_parent_item_id present:', column.rowCount === 1)
  if (tables.rowCount !== 3 || column.rowCount !== 1) process.exit(1)
} finally {
  await client.end()
}
