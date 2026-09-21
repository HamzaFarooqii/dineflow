import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// These 8 tables have RLS enabled with an explicit deny-all policy for anon/authenticated
// (see supabase/migrations/202609200001_service_role_only_rls_policies.sql) — they are meant to
// be reached only from apps/api's service-role connection. A client-side `.from()` call against
// any of them would always return zero rows, silently, which is exactly the kind of bug that
// ships unnoticed in a POS. This test fails the build the moment such a call is introduced.
const SERVICE_ROLE_ONLY_TABLES = [
  'pos_change_feed',
  'pos_inventory_movements',
  'pos_operation_ledger',
  'pos_sync_feed_state',
  'terminal_cashier_sessions',
  'terminal_device_sessions',
  'terminal_devices',
  'terminal_employees',
]

function walk(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) files.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full)
  }
  return files
}

test('apps/web/src never calls .from() on a service-role-only table', () => {
  const srcDir = join(__dirname, '..', 'src')
  const offenders: string[] = []
  for (const file of walk(srcDir)) {
    const content = readFileSync(file, 'utf8')
    for (const table of SERVICE_ROLE_ONLY_TABLES) {
      if (new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]\\s*\\)`).test(content)) {
        offenders.push(`${file}: .from('${table}')`)
      }
    }
  }
  assert.deepEqual(offenders, [], `Found client-side queries against service-role-only tables:\n${offenders.join('\n')}`)
})
