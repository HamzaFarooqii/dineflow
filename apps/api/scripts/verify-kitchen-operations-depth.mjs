import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const columns = await client.query(
    "select column_name from information_schema.columns where table_name='kitchen_ticket_items' and column_name in ('course','prep_time_target_seconds','held_at')",
  )
  const table = await client.query("select 1 from information_schema.tables where table_name='kitchen_course_fire_log'")
  const index = await client.query("select 1 from pg_indexes where indexname='kitchen_tickets_by_store_status_created'")
  console.log('kitchen_ticket_items new columns:', columns.rows.map(row => row.column_name).sort())
  console.log('kitchen_course_fire_log table exists:', table.rowCount === 1)
  console.log('history index present:', index.rowCount === 1)
  if (columns.rowCount !== 3 || table.rowCount !== 1 || index.rowCount !== 1) process.exit(1)
} finally {
  await client.end()
}
