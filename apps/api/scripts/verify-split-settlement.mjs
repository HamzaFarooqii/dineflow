import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const tipColumn = await client.query("select 1 from information_schema.columns where table_name='pos_payments' and column_name='tip_cents'")
  const paymentsUnique = await client.query("select 1 from pg_constraint where conrelid='public.pos_payments'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (store_id, id)'")
  const paymentsNoOrderUnique = await client.query("select 1 from pg_constraint where conrelid='public.pos_payments'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (store_id, order_id)'")
  const refundsNoOrderUnique = await client.query("select 1 from pg_constraint where conrelid='public.pos_refunds'::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (store_id, order_id)'")
  const tendersTable = await client.query("select 1 from information_schema.tables where table_name='pos_refund_tenders'")
  console.log('pos_payments.tip_cents exists:', tipColumn.rowCount === 1)
  console.log('pos_payments unique(store_id,id) exists:', paymentsUnique.rowCount === 1)
  console.log('pos_payments unique(store_id,order_id) removed:', paymentsNoOrderUnique.rowCount === 0)
  console.log('pos_refunds unique(store_id,order_id) removed:', refundsNoOrderUnique.rowCount === 0)
  console.log('pos_refund_tenders table exists:', tendersTable.rowCount === 1)
  if (tipColumn.rowCount !== 1 || paymentsUnique.rowCount !== 1 || paymentsNoOrderUnique.rowCount !== 0 || refundsNoOrderUnique.rowCount !== 0 || tendersTable.rowCount !== 1) process.exit(1)
} finally {
  await client.end()
}
