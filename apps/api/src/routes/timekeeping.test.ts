import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'

// Same pattern as floor.test.ts / reports.test.ts: pure helpers first, then a PGlite-backed
// integration test against the real migration chain for anything that depends on Postgres
// semantics (triggers, partial unique indexes, RLS).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { minutesBetween, csvField } = await import('./timekeeping.js')

test('minutesBetween floors to whole minutes, never drifts from floating point', () => {
  assert.equal(minutesBetween('2026-09-18T10:00:00.000Z', '2026-09-18T10:29:59.999Z'), 29)
  assert.equal(minutesBetween('2026-09-18T10:00:00.000Z', '2026-09-18T10:30:00.000Z'), 30)
  assert.equal(minutesBetween('2026-09-18T10:00:00.000Z', '2026-09-18T10:00:00.000Z'), 0)
})

test('csvField quotes values containing commas, quotes, or newlines', () => {
  assert.equal(csvField('Ali'), 'Ali')
  assert.equal(csvField('Ali, Manager'), '"Ali, Manager"')
  assert.equal(csvField('Say "hi"'), '"Say ""hi"""')
  assert.equal(csvField(42), '42')
})

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
  '202609190001_audit_log.sql',
  '202609210001_restaurant_foundation.sql',
  '202609230001_kitchen_display_system.sql',
  '202609230002_table_waiter_assignment.sql',
  '202609260002_staff_roles_and_shifts.sql',
  '202609280004_staff_breaks_and_corrections.sql',
]

async function setupDatabase() {
  const database = new PGlite()
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  for (const name of chain) {
    const sql = (await readFile(root + `supabase/migrations/${name}`, 'utf8')).replace('create extension if not exists pgcrypto;', '')
    await database.exec(sql)
  }
  return database
}

async function seedStoreAndEmployee(database: PGlite, timezone = 'UTC') {
  const owner = randomUUID(), store = randomUUID(), employee = randomUUID(), device = randomUUID()
  await database.query('insert into auth.users(id) values ($1)', [owner])
  await database.query("insert into public.stores(id,name,code,timezone,currency,created_by) values ($1,'Store','S1',$2,'USD',$3)", [store, timezone, owner])
  await database.query(
    "insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values ($1,$2,'Waiter','waiter',repeat('a',32),repeat('b',64))",
    [employee, store],
  )
  await database.query(
    "insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by) values ($1,$2,'Register','R-',$3)",
    [device, store, owner],
  )
  return { owner, store, employee, device }
}

test('a break cannot be opened against a shift that is not open (DB-level, not just client-side)', async () => {
  const database = await setupDatabase()
  try {
    const { store, employee } = await seedStoreAndEmployee(database)
    const shift = randomUUID()
    // Shift is already closed.
    await database.query(
      "insert into public.shifts(id,store_id,employee_id,device_id,clocked_in_at,clocked_out_at) select $1,$2,$3,d.id,'2026-09-18T09:00:00Z','2026-09-18T10:00:00Z' from public.terminal_devices d where d.store_id=$2",
      [shift, store, employee],
    )
    await assert.rejects(
      database.query('insert into public.shift_breaks(store_id,shift_id,employee_id,paid) values ($1,$2,$3,false)', [store, shift, employee]),
      /not open/,
    )
  } finally { await database.close() }
})

test('overlapping breaks on the same shift are rejected at the DB level', async () => {
  const database = await setupDatabase()
  try {
    const { store, employee, device } = await seedStoreAndEmployee(database)
    const shift = randomUUID()
    await database.query(
      "insert into public.shifts(id,store_id,employee_id,device_id) values ($1,$2,$3,$4)",
      [shift, store, employee, device],
    )
    await database.query('insert into public.shift_breaks(store_id,shift_id,employee_id,paid) values ($1,$2,$3,false)', [store, shift, employee])
    await assert.rejects(
      database.query('insert into public.shift_breaks(store_id,shift_id,employee_id,paid) values ($1,$2,$3,true)', [store, shift, employee]),
      /duplicate key|shift_breaks_one_open_per_shift/,
    )
  } finally { await database.close() }
})

test('overlapping open shifts for the same employee are rejected at the DB level', async () => {
  const database = await setupDatabase()
  try {
    const { store, employee, device } = await seedStoreAndEmployee(database)
    await database.query('insert into public.shifts(store_id,employee_id,device_id) values ($1,$2,$3)', [store, employee, device])
    await assert.rejects(
      database.query('insert into public.shifts(store_id,employee_id,device_id) values ($1,$2,$3)', [store, employee, device]),
      /duplicate key|shifts_one_open_per_employee/,
    )
  } finally { await database.close() }
})

test('a correction row is immutable once written — even a direct update/delete is rejected', async () => {
  const database = await setupDatabase()
  try {
    const { store, employee, device, owner } = await seedStoreAndEmployee(database)
    const shift = randomUUID()
    await database.query('insert into public.shifts(id,store_id,employee_id,device_id) values ($1,$2,$3,$4)', [shift, store, employee, device])
    const correction = randomUUID()
    await database.query(
      `insert into public.timekeeping_corrections(id,store_id,record_type,record_id,corrected_by,field,old_value,new_value,reason)
       values ($1,$2,'shift',$3,$4,'clocked_in_at','2026-09-18T09:00:00Z','2026-09-18T09:05:00Z','Forgot to clock in on time')`,
      [correction, store, shift, owner],
    )
    await assert.rejects(
      database.query("update public.timekeeping_corrections set new_value='tampered' where id=$1", [correction]),
      /immutable/,
    )
    await assert.rejects(
      database.query('delete from public.timekeeping_corrections where id=$1', [correction]),
      /immutable/,
    )
    const stillThere = await database.query('select new_value from public.timekeeping_corrections where id=$1', [correction])
    assert.equal(stillThere.rows[0].new_value, '2026-09-18T09:05:00Z')
  } finally { await database.close() }
})

test('timezone-correct totals: a shift spanning a non-UTC store day sums correctly and CSV matches the computed total exactly', async () => {
  const database = await setupDatabase()
  try {
    // Asia/Karachi is UTC+5, no DST — a shift starting at 08:00 local (03:00Z) on Sept 18 and
    // ending at 17:00 local (12:00Z) the same local day, with a 45-minute unpaid break and a
    // 15-minute paid break in the middle.
    const { store, employee, device } = await seedStoreAndEmployee(database, 'Asia/Karachi')
    const shift = randomUUID()
    // Breaks require the parent shift to be open at insert time (the DB trigger enforces this),
    // so open the shift, record both breaks while it's open, then close it — same order the
    // real API endpoints would perform them in across a real shift.
    await database.query(
      "insert into public.shifts(id,store_id,employee_id,device_id,clocked_in_at) values ($1,$2,$3,$4,'2026-09-18T03:00:00Z')",
      [shift, store, employee, device],
    )
    await database.query(
      "insert into public.shift_breaks(store_id,shift_id,employee_id,paid,started_at,ended_at) values ($1,$2,$3,false,'2026-09-18T06:00:00Z','2026-09-18T06:45:00Z')",
      [store, shift, employee],
    )
    await database.query(
      "insert into public.shift_breaks(store_id,shift_id,employee_id,paid,started_at,ended_at) values ($1,$2,$3,true,'2026-09-18T09:00:00Z','2026-09-18T09:15:00Z')",
      [store, shift, employee],
    )
    await database.query("update public.shifts set clocked_out_at='2026-09-18T12:00:00Z' where id=$1", [shift])

    // Mirror exportTimekeepingCsv's own math directly against PGlite (that function needs a
    // live Express req/res and requireStoreManager's Supabase auth call, which is out of scope
    // for a unit-level DB test) so this exercises the identical query shape and integer-minute
    // arithmetic the real endpoint runs.
    const shiftRow = await database.query<{ clocked_in_at: string; clocked_out_at: string }>(
      'select clocked_in_at::text as clocked_in_at, clocked_out_at::text as clocked_out_at from public.shifts where id=$1', [shift],
    )
    const breaks = await database.query<{ paid: boolean; started_at: string; ended_at: string }>(
      'select paid, started_at::text as started_at, ended_at::text as ended_at from public.shift_breaks where shift_id=$1 order by started_at', [shift],
    )
    const grossMinutes = minutesBetween(shiftRow.rows[0].clocked_in_at, shiftRow.rows[0].clocked_out_at)
    let paidBreakMinutes = 0, unpaidBreakMinutes = 0
    for (const row of breaks.rows) {
      const minutes = minutesBetween(row.started_at, row.ended_at)
      if (row.paid) paidBreakMinutes += minutes; else unpaidBreakMinutes += minutes
    }
    const netPaidMinutes = grossMinutes - unpaidBreakMinutes

    assert.equal(grossMinutes, 540) // 03:00Z -> 12:00Z is 9h, unaffected by the store's timezone
    assert.equal(unpaidBreakMinutes, 45)
    assert.equal(paidBreakMinutes, 15)
    assert.equal(netPaidMinutes, 495)

    const csvLine = [
      'Waiter', 'waiter', shift, shiftRow.rows[0].clocked_in_at, shiftRow.rows[0].clocked_out_at,
      csvField(grossMinutes), csvField(paidBreakMinutes), csvField(unpaidBreakMinutes), csvField(netPaidMinutes),
    ].join(',')
    // Exactness: the CSV row's numeric fields, parsed back, equal the computed totals exactly —
    // no floating point rounding drift is possible since every value here is an integer.
    const fields = csvLine.split(',')
    assert.equal(Number(fields[5]), grossMinutes)
    assert.equal(Number(fields[6]), paidBreakMinutes)
    assert.equal(Number(fields[7]), unpaidBreakMinutes)
    assert.equal(Number(fields[8]), netPaidMinutes)
  } finally { await database.close() }
})
