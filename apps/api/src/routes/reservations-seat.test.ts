import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Closes the one gap the 2026-09-29 audit found in reservations/waitlist: seat()'s atomic
// table-transition + row-lock logic was proven sound by direct-function-call tests
// (reservations.test.ts), but nothing exercised it over its real HTTP path -- so its idempotent
// replay on a duplicate operation_id, and its tenant-isolation guarantee against a cross-store
// booking id, were "correct by inspection" rather than verified. Same createApp()+fetch harness
// as timekeeping-breaks.test.ts.
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const chain = [
  '202609130001_auth_and_stores.sql',
  '202609150001_catalog_checkout_sync.sql',
  '202609150001_terminal_employee_access.sql',
  '202609150002_terminal_device_sessions.sql',
  '202609150003_team_profile_visibility.sql',
  '202609160001_customers_and_sale_attachment.sql',
  '202609170001_change_feed_product_entity.sql',
  '202609170002_cart_discounts.sql',
  '202609180001_terminal_name_uniqueness.sql',
  '202609180002_pos_orders_report_read_access.sql',
  '202609180005_refunds.sql',
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609230002_table_waiter_assignment.sql',
  '202609280002_reservations_waitlist.sql',
]

test('reservation seat() over HTTP replays idempotently and rejects a cross-store booking id', async t => {
  process.env.DATABASE_URL = 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { db } = await import('../db.js')
  const { createApp } = await import('../app.js')
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    await database.exec((await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', ''))
  }

  // Two independent stores. Store A is where our terminal session lives; store B exists only to
  // prove its booking can never be seated through store A's session, even with a syntactically
  // valid request.
  const ownerA = randomUUID(), storeA = randomUUID(), areaA = randomUUID(), tableA = randomUUID(), reservationA = randomUUID(), deviceA = randomUUID()
  const ownerB = randomUUID(), storeB = randomUUID(), areaB = randomUUID(), tableB = randomUUID(), reservationB = randomUUID()
  await database.query('insert into auth.users(id) values ($1),($2)', [ownerA, ownerB])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Store A','seat-race-a',$2)", [storeA, ownerA])
  await database.query("insert into public.stores(id,name,code,created_by) values ($1,'Store B','seat-race-b',$2)", [storeB, ownerB])
  await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [areaA, storeA, 'Main Hall'])
  await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [tableA, storeA, areaA, 'A1'])
  await database.query('insert into public.floor_areas(id,store_id,name) values ($1,$2,$3)', [areaB, storeB, 'Main Hall'])
  await database.query('insert into public.restaurant_tables(id,store_id,floor_area_id,label,seats) values ($1,$2,$3,$4,4)', [tableB, storeB, areaB, 'B1'])
  await database.query(`insert into public.reservations(id,store_id,guest_name,guest_size,expected_at) values ($1,$2,'Guest A',2,now())`, [reservationA, storeA])
  await database.query(`insert into public.reservations(id,store_id,guest_name,guest_size,expected_at) values ($1,$2,'Guest B',2,now())`, [reservationB, storeB])

  const digest = (value: string) => createHash('sha256').update(value).digest('hex')
  const deviceAccess = 'a'.repeat(64)
  await database.query(`insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by,refresh_hash,refresh_expires_at,access_hash,access_expires_at)
    values ($1,$2,'Counter','SR-',$3,$4,now()+interval '1 day',$5,now()+interval '1 day')`,
    [deviceA, storeA, ownerA, digest('c'.repeat(64)), digest(deviceAccess)])
  await database.query(`insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at)
    values ($1,$2,$3,now()+interval '1 day',$4,now()+interval '1 day')`, [storeA, deviceA, digest(deviceAccess), digest('d'.repeat(64))])
  const waiter = randomUUID()
  const cashierToken = 'e'.repeat(64)
  await database.query(`insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Wanda','cashier',$3,$4)`,
    [waiter, storeA, '1'.repeat(32), '2'.repeat(64)])
  await database.query(`insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at)
    values ($1,$2,$3,$4,1,now()+interval '1 day')`, [storeA, deviceA, waiter, digest(cashierToken)])

  const query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
  const fixture = db as unknown as { query: typeof query; connect: () => Promise<{ query: typeof query; release: () => void }> }
  fixture.query = query
  fixture.connect = async () => ({ query, release: () => undefined })

  const server = createApp({ pool: db, origin: 'http://127.0.0.1:3192', supabaseUrl: 'http://127.0.0.1:3193', supabaseKey: 'fixture', secureCookies: false }).listen(3192, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); server.close(); await database.close(); await db.end() })

  const cookies = `terminal_access=${deviceAccess}; terminal_cashier=${cashierToken}`
  const seat = (reservationId: string, body: Record<string, unknown>) =>
    fetch(`http://127.0.0.1:3192/pos/reservations/reservations/${reservationId}/seat?store_id=${storeA}`,
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:3192', Cookie: cookies, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  const firstOperationId = randomUUID()

  await t.test('first seat succeeds and assigns the table', async () => {
    const response = await seat(reservationA, { table_id: tableA, operation_id: firstOperationId })
    assert.equal(response.status, 200)
    const body = await response.json() as { reservation: { status: string }; table: { status: string } | null; replayed?: boolean }
    assert.equal(body.reservation.status, 'seated')
    assert.equal(body.table?.status, 'seated')
    assert.notEqual(body.replayed, true)
  })

  await t.test('replaying the same operation_id is a no-op, not a second seating', async () => {
    const response = await seat(reservationA, { table_id: tableA, operation_id: firstOperationId })
    assert.equal(response.status, 200)
    const body = await response.json() as { reservation: { status: string }; table: unknown; replayed?: boolean }
    assert.equal(body.reservation.status, 'seated')
    assert.equal(body.replayed, true, 'a duplicate operation_id must replay, not fail or re-seat')
    assert.equal(body.table, null, 'a replay does not re-run the table transition')
  })

  await t.test('a different operation_id against an already-seated booking is rejected, not silently accepted', async () => {
    const response = await seat(reservationA, { table_id: tableA, operation_id: randomUUID() })
    assert.equal(response.status, 409)
    const body = await response.json() as { code: string }
    assert.equal(body.code, 'booking_already_seated')
  })

  await t.test("store A's session cannot seat store B's reservation, even with a syntactically valid request", async () => {
    const response = await seat(reservationB, { table_id: tableA, operation_id: randomUUID() })
    assert.equal(response.status, 404, 'the store-scoped lookup must find nothing, not leak or act on another store\'s booking')
    const body = await response.json() as { code: string }
    assert.equal(body.code, 'not_found')
    const stillWaiting = await database.query('select status from public.reservations where id=$1', [reservationB])
    assert.equal(stillWaiting.rows[0].status, 'booked', "store B's booking must be untouched")
  })

  await t.test("store A's session is rejected outright if it claims to act as store B", async () => {
    const response = await fetch(`http://127.0.0.1:3192/pos/reservations/reservations/${reservationB}/seat?store_id=${storeB}`,
      { method: 'POST', headers: { Origin: 'http://127.0.0.1:3192', Cookie: cookies, 'Content-Type': 'application/json' },
        body: JSON.stringify({ table_id: tableB, operation_id: randomUUID() }) })
    assert.equal(response.status, 403)
    const body = await response.json() as { code: string }
    assert.equal(body.code, 'cross_store_reference')
  })
})
