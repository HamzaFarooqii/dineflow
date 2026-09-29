import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const columns = await client.query(
    "select column_name from information_schema.columns where table_name='pos_refunds' and column_name in ('operation_id','payload_hash','tip_cents','service_charge_cents','tax_cents','merchandise_cents')",
  )
  const tenderTip = await client.query("select 1 from information_schema.columns where table_name='pos_refund_tenders' and column_name='tip_cents'")
  const operationIndex = await client.query("select 1 from pg_indexes where indexname='pos_refunds_operation'")
  console.log('pos_refunds new columns present:', columns.rows.map(row => row.column_name).sort())
  console.log('pos_refund_tenders.tip_cents present:', tenderTip.rowCount === 1)
  console.log('pos_refunds_operation partial unique index present:', operationIndex.rowCount === 1)
  if (columns.rowCount !== 6 || tenderTip.rowCount !== 1 || operationIndex.rowCount !== 1) process.exit(1)
} finally {
  await client.end()
}
