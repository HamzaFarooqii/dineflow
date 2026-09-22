import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'

test('focused migration and terminal HTTP lifecycle on embedded PostgreSQL', async t => {
  // Set before importing app.js: it transitively imports db.js, whose module-level DATABASE_URL
  // check runs at import time — this file never actually uses that real Pool (it substitutes the
  // fake `pool` below), but the import must still succeed. Dynamic + fixture-first, matching every
  // other test file in this directory, so this file no longer depends on an ambient env var that
  // happens to be set on some machines and not on a clean CI runner.
  process.env.DATABASE_URL ??= 'postgresql://fixture@127.0.0.1:5432/fixture'
  const { createApp } = await import('../src/app.js')
  const db = new PGlite()
  // Supabase platform prerequisites; application tables use the committed migrations.
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key, raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create function auth.jwt() returns jsonb language sql as 'select ''{}''::jsonb';`)
  const base = await readFile(new URL('../../../supabase/migrations/202609130001_auth_and_stores.sql', import.meta.url), 'utf8')
  // PGlite already provides gen_random_uuid; pgcrypto extension packaging is unavailable here.
  await db.exec(base.replace('create extension if not exists pgcrypto;', ''))
  await db.exec(await readFile(new URL('../../../supabase/migrations/202609150001_terminal_employee_access.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../../../supabase/migrations/202609150002_terminal_device_sessions.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../../../supabase/migrations/202609180001_terminal_name_uniqueness.sql', import.meta.url), 'utf8'))
  // terminal-auth/routes.ts writes an audit_log row on employee create/update and device
  // revoke/reactivate (Track B reporting) — without this migration those inserts 500 against a
  // table that doesn't exist here, which is what was actually failing every downstream test below.
  await db.exec(await readFile(new URL('../../../supabase/migrations/202609190001_audit_log.sql', import.meta.url), 'utf8'))
  const owner = randomUUID(), cashier = randomUUID(), store = randomUUID(), otherStore = randomUUID()
  await db.query('insert into auth.users(id) values($1),($2)', [owner, cashier])
  await db.query("insert into public.stores(id,name,code,created_by) values($1,'Test store','test-a',$3),($2,'Other store','test-b',$3)", [store, otherStore, owner])
  await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner'),($1,$3,'cashier')", [store, owner, cashier])
  // One embedded connection; serialize transactions, matching a pool size of one.
  let tail = Promise.resolve()
  const pool = { async connect() {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    return { query: async (sql: string, values?: unknown[]) => {
      const result = await db.query(sql, values)
      return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }, release }
  } } as unknown as Pool
  const identity = createServer((req, res) => {
    const user = req.headers.authorization === 'Bearer test-owner' ? owner : req.headers.authorization === 'Bearer test-cashier' ? cashier : null
    res.writeHead(user ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(user ? { id: user } : {}))
  }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => identity.once('listening', resolve))
  const identityAddress = identity.address()
  assert(identityAddress && typeof identityAddress !== 'string')
  const origin = 'http://terminal.test'
  const server = createApp({ pool, origin, supabaseUrl: `http://127.0.0.1:${identityAddress.port}`, supabaseKey: 'test-publishable', secureCookies: true }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const baseUrl = `http://127.0.0.1:${address.port}`
  t.after(async () => { server.closeAllConnections(); identity.closeAllConnections(); server.close(); identity.close(); await db.close() })
  const jar = new Map<string, string>()
  async function call(path: string, data?: unknown, auth?: string, cookieOverride?: string) {
    const response = await fetch(baseUrl + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), Cookie: cookieOverride ?? [...jar].map(([key, value]) => `${key}=${value}`).join('; ') }, body: data === undefined ? undefined : JSON.stringify(data) })
    for (const entry of response.headers.getSetCookie()) { const [key, value] = entry.split(';')[0].split('='); jar.set(key, value) }
    return response
  }
  await t.test('RLS denies browser reads and writes to credentials', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await assert.rejects(db.query('select * from public.terminal_employees'))
      await assert.rejects(db.query('select * from public.terminal_devices'))
      await assert.rejects(db.query('select * from public.terminal_cashier_sessions'))
      await assert.rejects(db.query('select * from public.terminal_device_sessions'))
      await db.exec('reset role')
    }
    const tables = await db.query<{ tablename: string; rowsecurity: boolean }>("select tablename,rowsecurity from pg_tables where schemaname='public' and tablename like 'terminal_%'")
    assert.equal(tables.rows.length, 4)
    assert(tables.rows.every(row => row.rowsecurity))
  })
  await t.test('manager authorization and origin checks', async () => {
    assert.equal((await call('/devices/provision', { store_id: store, name: 'Counter' })).status, 401)
    assert.equal((await call('/devices/provision', { store_id: store, name: 'Counter' }, 'test-cashier')).status, 403)
    assert.equal((await call('/devices/provision', { store_id: otherStore, name: 'Counter' }, 'test-owner')).status, 403)
    assert.equal((await fetch(baseUrl + '/auth/refresh', { method: 'POST' })).status, 403)
    const bad = await fetch(baseUrl + '/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{' })
    assert.equal(bad.status, 400)
    assert.equal((await call('/terminal-auth/employees', { id: '', store_id: store, name: 'Invalid update', role: 'cashier', active: true }, 'test-owner')).status, 400)
  })
  let employeeId = '', deviceId = '', prefix = ''
  const pin = String(100000 + Math.floor(Math.random() * 900000))
  await t.test('employee setup and provisioning never expose credentials to manager lists', async () => {
    const response = await call('/terminal-auth/employees', { store_id: store, name: 'Test employee', role: 'manager', active: true, pin }, 'test-owner')
    assert.equal(response.status, 201)
    const employee = await response.json() as { id: string }
    employeeId = employee.id
    const provision = await call('/devices/provision', { store_id: store, name: 'Counter' }, 'test-owner')
    assert.equal(provision.status, 201)
    assert.match(provision.headers.getSetCookie()[0], /HttpOnly/)
    assert.match(provision.headers.getSetCookie()[0], /Secure/)
    assert.match(provision.headers.getSetCookie()[0], /SameSite=Strict/)
    const data = await provision.json() as { device: { id: string; receipt_prefix: string }; employees: { verifier: { iterations: number } }[] }
    deviceId = data.device.id; prefix = data.device.receipt_prefix
    assert.equal(data.employees[0].verifier.iterations, 600000)
    const management = await (await call(`/terminal-auth/manage/${store}`, undefined, 'test-owner')).text()
    assert(!management.includes('pin_hash')); assert(!management.includes('verifier')); assert(!management.includes(pin))
  })
  await t.test('five attempts persist lockout; refreshing cannot reset it', async () => {
    const wrongPin = String((Number(pin) + 1) % 1000000).padStart(6, '0')
    for (let index = 0; index < 5; index++) assert.equal((await call('/auth/login', { employee_id: employeeId, pin: wrongPin })).status, index === 4 ? 429 : 401)
    assert.equal((await call('/auth/refresh', {})).status, 200)
    assert.equal((await call('/auth/login', { employee_id: employeeId, pin })).status, 429)
    await db.exec("update public.terminal_devices set locked_until=now()-interval '1 second'; update public.terminal_employees set locked_until=now()-interval '1 second'")
    assert.equal((await call('/auth/login', { employee_id: employeeId, pin })).status, 200)
  })
  await t.test('refresh rotates credentials and validates current cashier permissions', async () => {
    const oldCookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
    const refreshed = await call('/auth/refresh', {})
    assert.equal(refreshed.status, 200)
    assert((await refreshed.json() as { session?: unknown }).session)
    // Simulate a committed rotation whose response was lost: the old refresh cookie can
    // retry briefly and replaces the unreachable child session.
    assert.equal((await call('/auth/refresh', {}, undefined, oldCookie)).status, 200)
    const activeChildren = await db.query<{ count: string }>("select count(*)::text count from public.terminal_device_sessions where rotated_from is not null and rotated_at is null and revoked_at is null")
    assert.equal(activeChildren.rows[0].count, '1')
    await db.exec("update public.terminal_device_sessions set rotated_at=now()-interval '61 seconds' where refresh_hash is not null and rotated_at is not null")
    assert.equal((await call('/auth/refresh', {}, undefined, oldCookie)).status, 401)
    assert.equal((await call('/terminal-auth/employees', { id: employeeId, store_id: otherStore, name: 'Cross store', role: 'cashier', active: true }, 'test-owner')).status, 403)
    assert.equal((await call('/terminal-auth/employees', { id: employeeId, store_id: store, name: 'Test employee', role: 'cashier', active: false }, 'test-owner')).status, 200)
    const projection = await (await call('/auth/refresh', {})).json() as { session?: unknown; employees: unknown[] }
    assert.equal(projection.session, undefined); assert.equal(projection.employees.length, 0)
    assert.equal((await call('/auth/login', { employee_id: employeeId, pin })).status, 401)
  })
  await t.test('cross-store employee cannot authenticate on this terminal', async () => {
    const credential = await db.query<{ pin_salt: string; pin_hash: string }>('select pin_salt,pin_hash from public.terminal_employees where id=$1', [employeeId])
    const foreignId = randomUUID()
    await db.query("insert into public.terminal_employees(id,store_id,name,role,pin_salt,pin_hash) values($1,$2,'Other cashier','cashier',$3,$4)", [foreignId, otherStore, credential.rows[0].pin_salt, credential.rows[0].pin_hash])
    assert.equal((await call('/auth/login', { employee_id: foreignId, pin })).status, 401)
  })
  await t.test('revoked devices reject refresh and reprovision never reuses receipt prefixes', async () => {
    assert.equal((await call(`/terminal-auth/devices/${deviceId}/revoke`, { store_id: store }, 'test-owner')).status, 204)
    assert.equal((await call('/auth/refresh', {})).status, 401)
    const projection = await (await call('/devices/provision', { store_id: store, name: 'Counter restored' }, 'test-owner')).json() as { device: { id: string; receipt_prefix: string } }
    assert.notEqual(projection.device.id, deviceId); assert.notEqual(projection.device.receipt_prefix, prefix)
    await db.exec("update public.terminal_device_sessions set refresh_expires_at=now()-interval '1 second'")
    assert.equal((await call('/auth/refresh', {})).status, 401)
  })
  await t.test('cross-store reprovisioning revokes the previous browser installation', async () => {
    await db.query("insert into public.store_memberships(store_id,user_id,role) values($1,$2,'owner')", [otherStore, owner])
    // Restore a valid browser credential after the preceding expiry scenario.
    assert.equal((await call('/devices/provision', { store_id: store, name: 'Counter before move' }, 'test-owner')).status, 201)
    const previousDevice = (await db.query<{ id: string }>('select id from public.terminal_devices where store_id=$1 and revoked_at is null order by created_at desc limit 1', [store])).rows[0].id
    const response = await call('/devices/provision', { store_id: otherStore, name: 'Other counter' }, 'test-owner')
    assert.equal(response.status, 201)
    const previous = await db.query<{ revoked_at: Date | null }>('select revoked_at from public.terminal_devices where id=$1', [previousDevice])
    assert(previous.rows[0].revoked_at)
    const sessions = await db.query<{ count: string }>('select count(*)::text count from public.terminal_device_sessions where device_id=$1 and revoked_at is null', [previousDevice])
    assert.equal(sessions.rows[0].count, '0')
  })
  await t.test('two active terminals in a store cannot share a name, case-insensitively', async () => {
    assert.equal((await call('/devices/provision', { store_id: store, name: 'Duplicate Name' }, 'test-owner')).status, 201)
    // Provisioning normally auto-revokes the calling browser's previous device, which would
    // mask a genuine name collision between two different terminals. Use a bare cookie jar
    // (no refresh cookie presented) to model a second, unrelated browser provisioning a device.
    const collision = await call('/devices/provision', { store_id: store, name: 'duplicate name' }, 'test-owner', '')
    assert.equal(collision.status, 409)
    assert.equal((await collision.json() as { code: string }).code, 'terminal_name_conflict')
    const stillActive = await db.query<{ count: string }>("select count(*)::text count from public.terminal_devices where store_id=$1 and name='Duplicate Name' and revoked_at is null", [store])
    assert.equal(stillActive.rows[0].count, '1')
    // A different store is unaffected by the same name.
    assert.equal((await call('/devices/provision', { store_id: otherStore, name: 'Duplicate Name' }, 'test-owner', '')).status, 201)
  })
  await t.test('reactivating a revoked terminal restores it, unless its name is now taken', async () => {
    assert.equal((await call(`/terminal-auth/devices/${randomUUID()}/reactivate`, { store_id: store }, 'test-owner')).status, 404) // unknown device
    const activeAlready = (await db.query<{ id: string }>("select id from public.terminal_devices where store_id=$1 and name='Duplicate Name' and revoked_at is null", [store])).rows[0].id
    assert.equal((await call(`/terminal-auth/devices/${activeAlready}/reactivate`, { store_id: store }, 'test-owner')).status, 404) // already active

    const provisioned = await (await call('/devices/provision', { store_id: store, name: 'Reactivate Me' }, 'test-owner')).json() as { device: { id: string } }
    const reactivateMe = provisioned.device.id
    assert.equal((await call(`/terminal-auth/devices/${reactivateMe}/revoke`, { store_id: store }, 'test-owner')).status, 204)
    assert.equal((await call(`/terminal-auth/devices/${reactivateMe}/reactivate`, { store_id: store }, 'test-owner')).status, 204)
    const reactivated = await db.query<{ revoked_at: Date | null }>('select revoked_at from public.terminal_devices where id=$1', [reactivateMe])
    assert.equal(reactivated.rows[0].revoked_at, null)
    const management = await (await call(`/terminal-auth/manage/${store}`, undefined, 'test-owner')).json() as { devices: { id: string; revoked_at: string | null }[] }
    assert.equal(management.devices.find(device => device.id === reactivateMe)?.revoked_at, null)

    // Revoke it again, let another device take its name, then reactivating it must collide.
    assert.equal((await call(`/terminal-auth/devices/${reactivateMe}/revoke`, { store_id: store }, 'test-owner')).status, 204)
    assert.equal((await call('/devices/provision', { store_id: store, name: 'Reactivate Me' }, 'test-owner')).status, 201)
    const conflict = await call(`/terminal-auth/devices/${reactivateMe}/reactivate`, { store_id: store }, 'test-owner')
    assert.equal(conflict.status, 409)
    assert.equal((await conflict.json() as { code: string }).code, 'terminal_name_conflict')
    const stillRevoked = await db.query<{ revoked_at: Date | null }>('select revoked_at from public.terminal_devices where id=$1', [reactivateMe])
    assert(stillRevoked.rows[0].revoked_at)
  })
})
