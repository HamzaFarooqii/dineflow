import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const tables = await client.query(
    "select table_name from information_schema.tables where table_schema='public' and table_name in ('open_checks','open_check_items','open_check_item_modifiers') order by table_name",
  )
  const index = await client.query("select indexname from pg_indexes where indexname='open_checks_one_open_per_table'")
  console.log('Tables:', tables.rows.map(row => row.table_name))
  console.log('Partial unique index present:', index.rowCount === 1)
  if (tables.rowCount !== 3 || index.rowCount !== 1) process.exit(1)
} finally {
  await client.end()
}
