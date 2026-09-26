import { Router, json, type Request, type Response, type NextFunction } from 'express'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { randomUUID } from 'node:crypto'
import { digest, fail, HttpError, ITERATIONS, pinValue, string, token, uuid, verifier, verify } from './security.js'
import { ApiError } from '../routes/auth.js'
import { STAFF_ROLES, type StaffRole } from '../../../../packages/domain/src/staff-role.js'

const ROLE_PATTERN = new RegExp(`^(${STAFF_ROLES.join('|')})$`)

export interface TerminalAuthOptions {
  pool: Pool
  origin: string
  supabaseUrl: string
  supabaseKey: string
  secureCookies: boolean
}
interface Device extends QueryResultRow { id: string; store_id: string; name: string; receipt_prefix: string; failed_attempts: number; locked_until: Date | null; session_id: string }
interface Employee extends QueryResultRow { id: string; name: string; role: StaffRole; active: boolean; permission_version: number; pin_salt: string; pin_hash: string; failed_attempts: number; locked_until: Date | null }
function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, 'validation_failed', 'A JSON object is required.')
  return req.body as Record<string, unknown>
}
function cookie(req: Request, name: string) {
  return req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
}
export interface CashierTerminalContext { storeId: string; deviceId: string; employeeId: string }
export interface DeviceTerminalContext { storeId: string; deviceId: string }
/** A device may upload sales/customer records after the originating cashier logs out. */
export async function requireDeviceTerminal(req: Request, pool: Pool): Promise<DeviceTerminalContext> {
  const access = cookie(req, 'terminal_access')
  if (!/^[a-f0-9]{64}$/.test(access)) throw new ApiError(401, 'authentication_required', 'Terminal access is required to resume sync.')
  const result = await pool.query<DeviceTerminalContext>(`select d.store_id "storeId", d.id "deviceId"
    from public.terminal_device_sessions ds
    join public.terminal_devices d on d.id=ds.device_id and d.store_id=ds.store_id and d.revoked_at is null
    where ds.access_hash=$1 and ds.access_expires_at>now() and ds.revoked_at is null and ds.rotated_at is null`, [digest(access)])
  if (!result.rows[0]) throw new ApiError(401, 'authentication_required', 'Terminal access expired. Ask a manager to renew this device.')
  return result.rows[0]
}
/** Verifies the two HttpOnly terminal cookies for POS routes. */
export async function requireCashierTerminal(req: Request, pool: Pool): Promise<CashierTerminalContext> {
  const access = cookie(req, 'terminal_access'), cashier = cookie(req, 'terminal_cashier')
  if (!/^[a-f0-9]{64}$/.test(access) || !/^[a-f0-9]{64}$/.test(cashier)) {
    throw new ApiError(401, 'authentication_required', 'Unlock this terminal before selling.')
  }
  const result = await pool.query<CashierTerminalContext>(`select d.store_id "storeId",d.id "deviceId",e.id "employeeId"
    from public.terminal_device_sessions ds
    join public.terminal_devices d on d.id=ds.device_id and d.store_id=ds.store_id and d.revoked_at is null
    join public.terminal_cashier_sessions cs on cs.device_id=d.id and cs.store_id=d.store_id and cs.expires_at>now()
    join public.terminal_employees e on e.id=cs.employee_id and e.store_id=cs.store_id and e.active and e.permission_version=cs.permission_version
    where ds.access_hash=$1 and ds.access_expires_at>now() and ds.revoked_at is null and ds.rotated_at is null and cs.token_hash=$2`, [digest(access), digest(cashier)])
  if (!result.rows[0]) throw new ApiError(401, 'authentication_required', 'Terminal access expired. Unlock the terminal again.')
  return result.rows[0]
}
export function terminalAuthRouter(options: TerminalAuthOptions) {
  const router = Router()
  const names = { refresh: 'terminal_refresh', access: 'terminal_access', cashier: 'terminal_cashier' }
  function setCookie(res: Response, name: string, value: string, seconds: number) {
    res.cookie(name, value, { httpOnly: true, secure: options.secureCookies, sameSite: 'strict', path: '/api', maxAge: seconds * 1000 })
  }
  // Mounted behind a same-origin /api reverse proxy. Never enable wildcard CORS.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (req.method !== 'GET' && req.headers.origin !== options.origin) return next(new HttpError(403, 'origin_rejected', 'Use the configured store application.'))
    next()
  })
  router.use(json({ limit: '16kb' }))
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await options.pool.connect()
    try { await client.query('begin'); const result = await work(client); await client.query('commit'); return result }
    catch (error) { await client.query('rollback'); throw error }
    finally { client.release() }
  }
  async function manager(req: Request, client: PoolClient, storeId: string) {
    const authorization = req.headers.authorization
    if (!authorization?.startsWith('Bearer ')) fail(401, 'authentication_required', 'Sign in with your owner or manager email account.')
    const response = await fetch(`${options.supabaseUrl}/auth/v1/user`, { headers: { Authorization: authorization!, apikey: options.supabaseKey }, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) fail(401, 'authentication_required', 'Sign in again.')
    const user = await response.json() as { id?: string }
    if (!user.id) fail(401, 'authentication_required', 'Sign in again.')
    const membership = await client.query('select user_id from public.store_memberships where store_id=$1 and user_id=$2 and active and role in (\'owner\',\'manager\') for share', [storeId, user.id])
    if (!membership.rowCount) fail(403, 'manager_required', 'An active owner or manager membership is required.')
    return user.id
  }
  // actorId is always the caller's own server-verified user id from manager() above — never a
  // client-supplied value — so an audit row can never be spoofed to attribute an action to
  // someone else.
  async function audit(client: PoolClient, storeId: string, actorId: string, action: string, target: string) {
    await client.query('insert into public.audit_log(store_id, actor_id, action, target) values ($1,$2,$3,$4)', [storeId, actorId, action, target])
  }
  async function device(req: Request, client: PoolClient, refresh = false): Promise<Device> {
    const raw = cookie(req, refresh ? names.refresh : names.access)
    if (!/^[a-f0-9]{64}$/.test(raw)) fail(401, 'authentication_required', 'Provision this terminal or restore its session online.')
    const result = refresh
      ? await client.query<Device>(`select d.*,s.id session_id from public.terminal_device_sessions s join public.terminal_devices d on d.id=s.device_id and d.store_id=s.store_id where s.refresh_hash=$1 and s.refresh_expires_at>now() and s.revoked_at is null and (s.rotated_at is null or s.rotated_at>now()-interval '60 seconds') and d.revoked_at is null for update of d,s`, [digest(raw)])
      : await client.query<Device>(`select d.*,s.id session_id from public.terminal_device_sessions s join public.terminal_devices d on d.id=s.device_id and d.store_id=s.store_id where s.access_hash=$1 and s.access_expires_at>now() and s.revoked_at is null and s.rotated_at is null and d.revoked_at is null for update of d,s`, [digest(raw)])
    if (!result.rows[0]) fail(401, 'authentication_required', 'The terminal session expired or was revoked. Ask a manager to provision it again.')
    return result.rows[0]
  }
  async function rotate(client: PoolClient, terminal: Device) {
    const access = token(), refresh = token()
    // A retry with the previous cookie replaces an unreachable child created by a lost response.
    await client.query('update public.terminal_device_sessions set revoked_at=coalesce(revoked_at,now()) where rotated_from=$1 and revoked_at is null', [terminal.session_id])
    await client.query('update public.terminal_device_sessions set rotated_at=coalesce(rotated_at,now()) where id=$1', [terminal.session_id])
    await client.query("insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at,rotated_from) values($1,$2,$3,now()+interval '15 minutes',$4,now()+interval '30 days',$5)", [terminal.store_id, terminal.id, digest(access), digest(refresh), terminal.session_id])
    return { access, refresh }
  }
  function cookies(res: Response, credentials: { access: string; refresh: string }) {
    setCookie(res, names.access, credentials.access, 900)
    setCookie(res, names.refresh, credentials.refresh, 30 * 86400)
  }
  async function snapshot(client: PoolClient, terminal: Device) {
    const { rows } = await client.query<Employee>('select * from public.terminal_employees where store_id=$1 and active order by name,id', [terminal.store_id])
    return {
      device: { id: terminal.id, store_id: terminal.store_id, name: terminal.name, receipt_prefix: terminal.receipt_prefix },
      validated_at: new Date().toISOString(),
      locked_until: terminal.locked_until,
      employees: rows.map(employee => ({ id: employee.id, name: employee.name, role: employee.role, permission_version: employee.permission_version, locked_until: employee.locked_until, verifier: { version: 1, algorithm: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: employee.pin_salt, hash: employee.pin_hash } })),
    }
  }
  router.post('/devices/provision', async (req, res) => {
    const input = body(req), storeId = uuid(input.store_id)
    const name = string(input.name, 'terminal name', /^.{1,80}$/u).trim()
    if (!name) fail(400, 'validation_failed', 'Enter a terminal name.')
    const result = await transaction(async client => {
      const userId = await manager(req, client, storeId)
      // Possession of a valid refresh credential identifies this browser's previous installation,
      // including when an administrator moves it to another managed store.
      const presented = cookie(req, names.refresh)
      if (/^[a-f0-9]{64}$/.test(presented)) {
        const previous = await client.query<{ device_id: string }>('select device_id from public.terminal_device_sessions where refresh_hash=$1 and refresh_expires_at>now() and revoked_at is null for update', [digest(presented)])
        if (previous.rows[0]) {
          await client.query('update public.terminal_devices set revoked_at=coalesce(revoked_at,now()) where id=$1', [previous.rows[0].device_id])
          await client.query('update public.terminal_device_sessions set revoked_at=coalesce(revoked_at,now()) where device_id=$1', [previous.rows[0].device_id])
        }
      }
      const id = randomUUID(), access = token(), refresh = token()
      let rows: Device[]
      try {
        ;({ rows } = await client.query<Device>('insert into public.terminal_devices(id,store_id,name,receipt_prefix,provisioned_by) values($1,$2,$3,$4,$5) returning *', [id, storeId, name, `${id.toUpperCase()}-`, userId]))
      } catch (reason) {
        if (typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === '23505') {
          fail(409, 'terminal_name_conflict', `A terminal named "${name}" is already active in this store.`)
        }
        throw reason
      }
      await client.query("insert into public.terminal_device_sessions(store_id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at) values($1,$2,$3,now()+interval '15 minutes',$4,now()+interval '30 days')", [storeId, id, digest(access), digest(refresh)])
      return { projection: await snapshot(client, rows[0]), credentials: { access, refresh } }
    })
    cookies(res, result.credentials); setCookie(res, names.cashier, '', 0)
    res.status(201).json(result.projection)
  })
  router.get('/terminal-auth/manage/:storeId', async (req, res) => {
    const storeId = uuid(req.params.storeId)
    const result = await transaction(async client => {
      await manager(req, client, storeId)
      const employees = await client.query('select id,name,role,active,permission_version from public.terminal_employees where store_id=$1 order by name,id', [storeId])
      const devices = await client.query('select id,name,receipt_prefix,created_at,revoked_at from public.terminal_devices where store_id=$1 order by created_at desc', [storeId])
      return { employees: employees.rows, devices: devices.rows }
    })
    res.json(result)
  })
  router.post('/terminal-auth/employees', async (req, res) => {
    const input = body(req), storeId = uuid(input.store_id), updating = input.id !== undefined, id = updating ? uuid(input.id) : randomUUID()
    const name = string(input.name, 'employee name', /^.{1,80}$/u).trim()
    const role = string(input.role, 'employee role', ROLE_PATTERN)
    if (!name || typeof input.active !== 'boolean') fail(400, 'validation_failed', 'Name and active state are required.')
    const pin = input.pin === undefined || input.pin === '' ? undefined : pinValue(input.pin)
    if (!updating && !pin) fail(400, 'validation_failed', 'Set a PIN for the new employee.')
    const employee = await transaction(async client => {
      const userId = await manager(req, client, storeId)
      const credential = pin ? await verifier(pin) : undefined
      const params = [id, storeId, name, role, input.active, credential?.salt, credential?.hash]
      const { rows } = updating
        ? await client.query('update public.terminal_employees set name=$3,role=$4,active=$5,pin_salt=coalesce($6,pin_salt),pin_hash=coalesce($7,pin_hash),permission_version=permission_version+1,updated_at=now() where id=$1 and store_id=$2 returning id,name,role,active,permission_version', params)
        : await client.query('insert into public.terminal_employees(id,store_id,name,role,active,pin_salt,pin_hash) values($1,$2,$3,$4,$5,$6,$7) returning id,name,role,active,permission_version', params)
      if (!rows[0]) fail(404, 'employee_not_found', 'Employee not found in this store.')
      await client.query('update public.terminal_cashier_sessions set expires_at=now() where store_id=$1 and employee_id=$2', [storeId, id])
      await audit(client, storeId, userId, updating ? 'employee.updated' : 'employee.created', `${name} (${role})`)
      return rows[0] as Record<string, unknown>
    })
    res.status(updating ? 200 : 201).json(employee)
  })
  router.post('/terminal-auth/devices/:id/revoke', async (req, res) => {
    const storeId = uuid(body(req).store_id), id = uuid(req.params.id)
    await transaction(async client => {
      const userId = await manager(req, client, storeId)
      const existing = await client.query<{ name: string }>('select name from public.terminal_devices where id=$1 and store_id=$2', [id, storeId])
      const result = await client.query('update public.terminal_devices set revoked_at=coalesce(revoked_at,now()) where id=$1 and store_id=$2', [id, storeId])
      if (!result.rowCount) fail(404, 'device_not_found', 'Terminal not found in this store.')
      await client.query('update public.terminal_device_sessions set revoked_at=coalesce(revoked_at,now()) where device_id=$1 and store_id=$2', [id, storeId])
      await audit(client, storeId, userId, 'terminal.revoked', existing.rows[0]?.name ?? id)
    })
    res.status(204).end()
  })
  router.post('/terminal-auth/devices/:id/reactivate', async (req, res) => {
    const storeId = uuid(body(req).store_id), id = uuid(req.params.id)
    await transaction(async client => {
      const userId = await manager(req, client, storeId)
      // Look the device up first: once the update below fails with a unique violation, the
      // transaction is aborted and no further query on this connection would succeed.
      const existing = await client.query<{ name: string; revoked_at: Date | null }>('select name,revoked_at from public.terminal_devices where id=$1 and store_id=$2', [id, storeId])
      if (!existing.rows[0]) fail(404, 'device_not_found', 'Terminal not found in this store.')
      if (!existing.rows[0].revoked_at) fail(404, 'device_not_found', 'Terminal not found in this store, or it is already active.')
      try {
        await client.query('update public.terminal_devices set revoked_at=null where id=$1 and store_id=$2', [id, storeId])
      } catch (reason) {
        if (typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === '23505') {
          fail(409, 'terminal_name_conflict', `Another active terminal already uses the name "${existing.rows[0].name}". Rename one of them before reactivating.`)
        }
        throw reason
      }
      await audit(client, storeId, userId, 'terminal.reactivated', existing.rows[0].name)
      // A reactivated device keeps its previous device sessions revoked: the browser that was
      // using it must sign in again, matching how a fresh provisioning always starts clean.
    })
    res.status(204).end()
  })
  router.post('/auth/login', async (req, res) => {
    const input = body(req), employeeId = uuid(input.employee_id), pin = pinValue(input.pin)
    const result = await transaction(async client => {
      const terminal = await device(req, client)
      const { rows } = await client.query<Employee>('select * from public.terminal_employees where id=$1 and store_id=$2 for update', [employeeId, terminal.store_id])
      const employee = rows[0]
      const locked = Math.max(terminal.locked_until?.getTime() ?? 0, employee?.locked_until?.getTime() ?? 0)
      if (locked > Date.now()) return { error: new HttpError(429, 'pin_locked', 'Too many attempts. Wait 60 seconds and try again.') }
      if (!employee?.active || !await verify(pin, employee.pin_salt, employee.pin_hash)) {
        await client.query("update public.terminal_devices set locked_until=case when failed_attempts=4 then now()+interval '60 seconds' else locked_until end,failed_attempts=(failed_attempts+1)%5 where id=$1", [terminal.id])
        if (employee) await client.query("update public.terminal_employees set locked_until=case when failed_attempts=4 then now()+interval '60 seconds' else locked_until end,failed_attempts=(failed_attempts+1)%5 where id=$1", [employee.id])
        return { error: new HttpError(terminal.failed_attempts === 4 || employee?.failed_attempts === 4 ? 429 : 401, 'pin_invalid', 'PIN not accepted. After five attempts, access is locked for 60 seconds.') }
      }
      await client.query('update public.terminal_devices set failed_attempts=0,locked_until=null where id=$1', [terminal.id])
      await client.query('update public.terminal_employees set failed_attempts=0,locked_until=null where id=$1', [employee.id])
      await client.query('update public.terminal_cashier_sessions set expires_at=now() where device_id=$1', [terminal.id])
      const raw = token()
      const session = await client.query("insert into public.terminal_cashier_sessions(store_id,device_id,employee_id,token_hash,permission_version,expires_at) values($1,$2,$3,$4,$5,now()+interval '15 minutes') returning employee_id,permission_version,logged_in_at,last_server_validated_at", [terminal.store_id, terminal.id, employee.id, digest(raw), employee.permission_version])
      return { raw, session: session.rows[0], projection: await snapshot(client, { ...terminal, locked_until: null }) }
    })
    if (result.error) { if (result.error.status === 429) res.set('Retry-After', '60'); throw result.error }
    setCookie(res, names.cashier, result.raw!, 900)
    res.json({ ...result.projection, session: result.session })
  })
  router.post('/auth/refresh', async (req, res) => {
    const result = await transaction(async client => {
      const terminal = await device(req, client, true)
      const credentials = await rotate(client, terminal)
      const cashierToken = token()
      const session = await client.query("update public.terminal_cashier_sessions s set token_hash=$3,last_server_validated_at=now(),expires_at=now()+interval '15 minutes' from public.terminal_employees e where s.device_id=$1 and s.token_hash=$2 and s.expires_at>now() and e.id=s.employee_id and e.store_id=s.store_id and e.active and e.permission_version=s.permission_version returning s.employee_id,s.permission_version,s.logged_in_at,s.last_server_validated_at", [terminal.id, digest(cookie(req, names.cashier)), digest(cashierToken)])
      return { credentials, cashierToken, projection: { ...await snapshot(client, terminal), session: session.rows[0] } }
    })
    cookies(res, result.credentials); setCookie(res, names.cashier, result.projection.session ? result.cashierToken : '', result.projection.session ? 900 : 0)
    res.json(result.projection)
  })
  router.post('/auth/logout', async (req, res) => {
    await transaction(async client => {
      const terminal = await device(req, client)
      await client.query('update public.terminal_cashier_sessions set expires_at=now() where device_id=$1', [terminal.id])
    })
    setCookie(res, names.cashier, '', 0); res.status(204).end()
  })
  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) res.status(error.status).json({ code: error.code, message: error.message })
    else if (error instanceof SyntaxError || (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large')) res.status(400).json({ code: 'validation_failed', message: 'Send a JSON request no larger than 16 KiB.' })
    else res.status(500).json({ code: 'server_unavailable', message: 'Terminal service unavailable. Try again shortly.' })
  })
  return router
}
