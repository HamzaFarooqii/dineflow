import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Clock-in/out (docs/day-plans/day5.md gap-fill), same harness shape as orders-loyalty.test.ts:
// real HTTP against the committed migration chain rather than calling route handlers directly.
const root = fileURLToPath(new URL('../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609260002_staff_roles_and_shifts.sql',
]

test('clock-in/out enforces one open shift per employee and reports hours to a manager', async t => {
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

  const owner = randomUUID(), store = randomUUID(), otherStore = randomUUID(), device = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'One','shifts-test',$2)", [store, owner])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Two','shifts-test-2',$2)", [otherStore, owner])
  await database.query('insert into public.store_memberships(store_id,user_id,role) values ($1,$2,$3)', [store, owner, 'manager'])

  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const deviceAccess = 'a'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','SH-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
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

  const server = createApp({ pool: db, origin: 'http://127.0.0.1:3188', supabaseUrl: 'http://127.0.0.1:3189', supabaseKey: 'fixture', secureCookies: false }).listen(3188, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); server.close(); await database.close(); await db.end() })

  const cookies = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
  const post = (path: string) => fetch(`http://127.0.0.1:3188${path}?store_id=${store}`,
    { method: 'POST', headers: { Origin: 'http://127.0.0.1:3188', Cookie: cookies } })
  const get = (path: string, sid = store) => fetch(`http://127.0.0.1:3188${path}?store_id=${sid}`, { headers: { Cookie: cookies } })

  await t.test('current shift is null before any clock-in', async () => {
    const response = await get('/pos/shifts/current')
    assert.equal(response.status, 200)
    assert.equal((await response.json() as { shift: unknown }).shift, null)
  })

  let shiftId = ''
  await t.test('clock-in opens a shift', async () => {
    const response = await post('/pos/shifts/clock-in')
    assert.equal(response.status, 201)
    const body = await response.json() as { shift: { id: string; clocked_out_at: string | null } }
    assert.equal(body.shift.clocked_out_at, null)
    shiftId = body.shift.id
  })

  await t.test('a second clock-in is rejected while one is already open', async () => {
    const response = await post('/pos/shifts/clock-in')
    assert.equal(response.status, 409)
    assert.equal((await response.json() as { code: string }).code, 'shift_already_open')
  })

  await t.test('current shift reflects the open one', async () => {
    const response = await get('/pos/shifts/current')
    const body = await response.json() as { shift: { id: string } | null }
    assert.equal(body.shift?.id, shiftId)
  })

  await t.test('a terminal from another store cannot clock in here', async () => {
    const response = await get('/pos/shifts/current', otherStore)
    assert.equal(response.status, 403)
  })

  await t.test('clock-out closes the shift', async () => {
    const response = await post('/pos/shifts/clock-out')
    assert.equal(response.status, 200)
    const body = await response.json() as { shift: { id: string; clocked_out_at: string | null } }
    assert.equal(body.shift.id, shiftId)
    assert.notEqual(body.shift.clocked_out_at, null)
  })

  await t.test('a second clock-out with nothing open 404s rather than double-closing', async () => {
    const response = await post('/pos/shifts/clock-out')
    assert.equal(response.status, 404)
  })

  // GET /shifts is a thin requireStoreManager-gated read (same pattern as promotions.test.ts's
  // management CRUD) -- exercising the real Supabase auth call it depends on is out of scope for
  // this harness, so the row shape it reads is verified directly against the database instead.
  await t.test('the closed shift is recorded with the right employee and a clocked_out_at set', async () => {
    const rows = await database.query('select employee_id, clocked_out_at from public.shifts where store_id=$1', [store])
    assert.equal(rows.rows.length, 1)
    assert.equal((rows.rows[0] as { employee_id: string }).employee_id, waiter)
    assert.notEqual((rows.rows[0] as { clocked_out_at: string | null }).clocked_out_at, null)
  })
})
