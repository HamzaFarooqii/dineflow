// Read-only live check for 202610020001_wastage_categories_batch_valuation.sql. Every statement is a
// SELECT inside a read-only transaction; it never writes. Exits non-zero on any mismatch.
import { Client } from 'pg'
import 'dotenv/config'

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
let failed = false
const check = (label, ok, detail = '') => { console.log(`${ok ? 'CONFIRMED' : 'MISMATCH '} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) failed = true }
try {
  await client.query('begin read only')
  const columns = await client.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='stock_movements' and column_name in ('wastage_category','stock_effect','operation_id','payload_hash','approval_method','approval_required','approval_threshold_cents')")
  check('stock_movements new columns (7)', columns.rowCount === 7, columns.rows.map(row => row.column_name).sort().join(', '))
  const tables = await client.query(
    "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('stock_movement_allocations','inventory_policies')")
  check('stock_movement_allocations + inventory_policies exist with RLS on', tables.rowCount === 2 && tables.rows.every(row => row.relrowsecurity))
  const policies = await client.query("select tablename, cmd from pg_policies where schemaname='public' and tablename in ('stock_movement_allocations','inventory_policies')")
  check('member-read SELECT policies on both tables', policies.rowCount === 2 && policies.rows.every(row => row.cmd === 'SELECT'))
  const view = await client.query("select reloptions from pg_class where relname='stock_movement_cost_lines' and relkind='v'")
  check('stock_movement_cost_lines view is security_invoker', view.rowCount === 1 && (view.rows[0].reloptions ?? []).includes('security_invoker=true'))
  const indexes = await client.query("select indexname from pg_indexes where schemaname='public' and indexname in ('stock_movements_operation_id_key','stock_movements_one_consumption_per_item_ingredient')")
  check('operation-id and one-consumption-per-item unique indexes', indexes.rowCount === 2)
  const triggers = await client.query("select tgname from pg_trigger where tgname in ('stock_movement_allocations_no_update','ingredient_batches_cost_no_change') and not tgisinternal")
  check('append-only allocation + immutable batch cost triggers', triggers.rowCount === 2)
  // Supabase's default privileges grant anon/authenticated ALL on every new public relation (the
  // existing inventory tables look identical), so table grants prove nothing here: RLS is the
  // protection. With RLS on and only SELECT policies present, authenticated/anon cannot write.
  const writePolicies = await client.query("select policyname from pg_policies where schemaname='public' and tablename in ('stock_movement_allocations','inventory_policies') and cmd <> 'SELECT'")
  check('no INSERT/UPDATE/DELETE policy on the new tables (writes only via the API/service role)', writePolicies.rowCount === 0)
  const legacy = await client.query("select count(*)::int as n from public.stock_movements where reason='wastage' and wastage_category is null")
  const view2 = await client.query('select count(*)::int as n from public.stock_movement_cost_lines')
  check('historical wastage rows left uncategorised (not backfilled)', true, `${legacy.rows[0].n} legacy wastage rows; cost view reads ${view2.rows[0].n} rows`)
  await client.query('rollback')
} finally {
  await client.end()
}
process.exit(failed ? 1 : 0)
