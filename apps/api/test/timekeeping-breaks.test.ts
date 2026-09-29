import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Regression test for a real race found during the post-weekend-merge audit: starting a break
// does a plain select-then-insert (apps/api/src/routes/timekeeping.ts's startBreak), so a second
// "start break" request that wins a race against the pre-check's own SELECT can only be caught by
// the insert's own unique-violation, not the pre-check. Before the fix, that violation fell
// through to sendApiError's generic 23505 branch, which is hard-coded checkout copy
// ("A sale already uses this receipt...") -- confusing, not a data-integrity bug (the constraint
// itself always held), but a real bug in what the caller sees. Same HTTP harness shape as
// shifts.test.ts.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609260002_staff_roles_and_shifts.sql',
  '202609280004_staff_breaks_and_corrections.sql',
]

test('a break-start race loses to the DB constraint, not to a checkout-flavored generic error', async t => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../src/db.js')
  const { createApp } = await import('../src/app.js')
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
  }

  const owner = randomUUID(), store = randomUUID(), device = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','break-race-test',$2)", [store, owner])

  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const deviceAccess = 'a'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','BR-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
    [device, store, owner, digest('c'.repeat(64)), digest(deviceAccess)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [store, device, digest(deviceAccess), digest('d'.repeat(64))])
  const waiter = randomUUID()
  const cashierToken = 'e'.repeat(64)
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Wanda','waiter',$3,$4)`,
    [waiter, store, '1'.repeat(32), '2'.repeat(64)])
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [store, device, waiter, digest(cashierToken)])

  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const fixture = db as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const server = createApp({ pool: db, origin: 'http://127.0.0.1:3190', supabaseUrl: 'http://127.0.0.1:3191', supabaseKey: 'fixture', secureCookies: false }).listen(3190, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); server.close(); await database.close(); await db.end() })

  const cookies = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
  const post = (path: string) => fetch(`http://127.0.0.1:3190${path}?store_id=${store}`,
    { method: 'POST', headers: { Origin: 'http://127.0.0.1:3190', Cookie: cookies } })

  const clockIn = await post('/pos/shifts/clock-in')
  assert.equal(clockIn.status, 201)

  // Fire two genuinely concurrent "start break" requests. The pre-check alone (a plain
  // select-then-insert) cannot prevent both from passing the SELECT before either INSERT commits
  // -- this is real interleaved concurrency (two independent fetches against a live HTTP server),
  // not a simulated/pre-seeded scenario, so it actually exercises the race rather than just the
  // pre-check's already-tested happy path.
  const [first, second] = await Promise.all([post('/pos/shifts/breaks/start'), post('/pos/shifts/breaks/start')])
  const statuses = [first.status, second.status].sort()
  assert.deepEqual(statuses, [201, 409], 'exactly one request wins the race')
  const loser = first.status === 409 ? first : second
  const body = await loser.json() as { code: string; message: string }
  assert.equal(body.code, 'break_already_open')
  assert.match(body.message, /break is already in progress/)
  assert.doesNotMatch(body.message, /receipt|payment/i)
})
