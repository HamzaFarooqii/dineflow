// Deletes the store(s) owned by the given email addresses, plus everything scoped to that
// store: products, categories, tax rates, orders/payments/refunds, customers, terminals,
// cashier employees, audit log, sync/change-feed state. Store memberships and pending
// invites are removed automatically (they cascade). The owner's auth account itself is
// NOT deleted — only their store and its data.
//
// Usage (run from apps/api):
//   node --env-file=.env scripts/delete-store-by-owner-email.mjs owner1@example.com owner2@example.com
//
// Defaults to a DRY RUN: it prints what it would delete and does nothing else.
// Add --confirm to actually delete: append it anywhere in the argument list.
//
// This is a destructive, irreversible operation against the live database. Read the dry-run
// output carefully before adding --confirm.

import { Client } from 'pg'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const emails = args.filter(arg => arg !== '--confirm').map(email => email.trim().toLowerCase())

if (!emails.length) {
  console.error('Usage: node --env-file=.env scripts/delete-store-by-owner-email.mjs <email> [<email>...] [--confirm]')
  process.exit(1)
}

// Deepest dependents first, so every DELETE only ever removes rows whose remaining
// foreign keys point at rows already gone (or about to go in the same transaction).
const CLEANUP_ORDER = [
  'pos_refund_items', 'pos_refunds', 'pos_inventory_movements', 'pos_order_items',
  'pos_payments', 'pos_orders', 'pos_stock', 'pos_products', 'pos_categories',
  'pos_tax_rates', 'pos_customers', 'pos_change_feed', 'pos_operation_ledger',
  'pos_sync_feed_state', 'audit_log',
  'terminal_cashier_sessions', 'terminal_device_sessions', 'terminal_devices', 'terminal_employees',
]

const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

async function main() {
  await client.connect()

  const { rows: users } = await client.query(
    'select id, email from auth.users where lower(email) = any($1::text[])',
    [emails],
  )
  const foundEmails = new Set(users.map(u => u.email.toLowerCase()))
  for (const email of emails) if (!foundEmails.has(email)) console.warn(`No account found for ${email} — skipping.`)
  if (!users.length) { console.log('Nothing to do.'); return }

  const { rows: stores } = await client.query(
    `select s.id, s.name, s.created_at, m.user_id, u.email
     from public.stores s
     join public.store_memberships m on m.store_id = s.id and m.role = 'owner'
     join auth.users u on u.id = m.user_id
     where m.user_id = any($1::uuid[])`,
    [users.map(u => u.id)],
  )
  if (!stores.length) { console.log('These accounts own no stores. Nothing to do.'); return }

  console.log(confirm ? 'Deleting the following stores:' : 'DRY RUN — would delete the following stores (pass --confirm to actually delete):')
  for (const store of stores) console.log(`  - "${store.name}" (${store.id}), owned by ${store.email}, created ${store.created_at}`)

  const storeIds = stores.map(s => s.id)
  if (!confirm) return

  await client.query('begin')
  try {
    for (const table of CLEANUP_ORDER) {
      const result = await client.query(`delete from public.${table} where store_id = any($1::uuid[])`, [storeIds])
      if (result.rowCount) console.log(`  deleted ${result.rowCount} row(s) from ${table}`)
    }
    const storesResult = await client.query('delete from public.stores where id = any($1::uuid[])', [storeIds])
    console.log(`  deleted ${storesResult.rowCount} store(s)`)
    await client.query('commit')
    console.log('Done.')
  } catch (error) {
    await client.query('rollback')
    console.error('Failed — rolled back, nothing was deleted.', error)
    process.exitCode = 1
  }
}

main().finally(() => client.end())
