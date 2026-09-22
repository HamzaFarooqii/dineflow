import Dexie, { type Table } from 'dexie'
import { ApiError, request } from './api'
import { DAY, permissions, verifyOffline } from './policy'
import type { CashierSession, Projection } from './types'

export interface TerminalCache extends Projection {
  key: 'current'
  attempts: number
  localLockedUntil: number
  lastSeen: number
}
class TerminalDatabase extends Dexie {
  access!: Table<TerminalCache, string>
  constructor() { super('dineflow-terminal-access'); this.version(1).stores({ access: 'key' }) }
}
const database = new TerminalDatabase()
export const readTerminal = () => database.access.get('current')
export async function withTerminalLock<T>(work: () => Promise<T>) {
  if (!navigator.locks) throw new Error('This browser cannot coordinate terminal access. Use a supported browser over HTTPS.')
  return navigator.locks.request('dineflow-terminal-access', work)
}
export async function provisionTerminal(storeId: string, name: string) {
  return withTerminalLock(async () => {
    const projection = await request<Projection>('/devices/provision', { store_id: storeId, name }, true)
    return saveProjection(projection)
  })
}
export async function saveProjection(projection: Projection) {
  const previous = await readTerminal()
  const same = previous?.device.id === projection.device.id
  // Replace the entire employee projection: removed/deactivated credentials disappear.
  const value: TerminalCache = { ...projection, key: 'current', attempts: same ? previous.attempts : 0, localLockedUntil: Math.max(Date.parse(projection.locked_until ?? '') || 0, same ? previous.localLockedUntil : 0), lastSeen: Date.now() }
  await database.access.put(value)
  return value
}
export async function lockTerminal() {
  await withTerminalLock(async () => {
    const cache = await readTerminal()
    if (cache) await database.access.put({ ...cache, session: undefined })
    if (navigator.onLine) await request('/auth/logout', {}).catch(() => undefined)
  })
}
export async function refreshTerminal() {
  return withTerminalLock(async () => {
    try {
      const previous = await readTerminal()
      const projection = await request<Projection>('/auth/refresh', {})
      // Local lock/logout must not be undone by an older HttpOnly cashier cookie.
      if (!previous?.session) projection.session = undefined
      return await saveProjection(projection)
    }
    catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        const cache = await readTerminal()
        if (cache) await database.access.put({ ...cache, employees: [], session: undefined, validated_at: new Date(0).toISOString() })
      }
      throw error
    }
  })
}
export async function currentAccess() {
  return withTerminalLock(async () => {
    const cache = await readTerminal()
    if (!cache) return undefined
    const now = Date.now()
    const employee = cache.employees.find(row => row.id === cache.session?.employee_id)
    const policy = cache.session ? permissions(cache.session, employee, now, cache.lastSeen) : { valid: false, managerApproval: false }
    // Clock rollback invalidates the cache until a server refresh; reloading cannot heal it.
    if (now < cache.lastSeen) cache.validated_at = new Date(0).toISOString()
    cache.lastSeen = Math.max(now, cache.lastSeen)
    if (!policy.valid) cache.session = undefined
    await database.access.put(cache)
    return { cache, employee, policy }
  })
}
export async function loginCashier(employeeId: string, pin: string) {
  return withTerminalLock(async () => {
    let cache = await readTerminal()
    if (!cache) throw new Error('Ask a manager to provision this browser online first.')
    const now = Date.now()
    if (now < cache.lastSeen) {
      await database.access.put({ ...cache, validated_at: new Date(0).toISOString(), session: undefined })
      throw new Error('The device clock moved backwards. Connect and refresh terminal access.')
    }
    const employee = cache.employees.find(row => row.id === employeeId)
    if (!employee || !/^\d{4,8}$/.test(pin)) throw new Error('Select an employee and enter a PIN with 4 to 8 digits.')
    const until = Math.max(cache.localLockedUntil, Date.parse(employee.locked_until ?? '') || 0)
    if (until > now) throw new Error(`PIN access is locked. Try again in ${Math.ceil((until - now) / 1000)} seconds.`)
    // Count before crypto/network work, so closing a tab cannot erase an attempt.
    const attempts = cache.attempts + 1
    cache = { ...cache, session: undefined, attempts: attempts % 5, localLockedUntil: attempts >= 5 ? now + 60_000 : 0, lastSeen: now }
    await database.access.put(cache)
    if (navigator.onLine) {
      try {
        const result = await request<Projection>('/auth/login', { employee_id: employeeId, pin })
        const saved = await saveProjection(result)
        await database.access.put({ ...saved, attempts: 0, localLockedUntil: 0 })
        return
      } catch (error) {
        // HTTP rejections never downgrade to offline authentication.
        if (error instanceof ApiError) {
          if (error.status === 429) await database.access.put({ ...cache, localLockedUntil: Date.now() + 60_000 })
          if (error.code === 'authentication_required') await database.access.put({ ...cache, employees: [], validated_at: new Date(0).toISOString() })
          throw error
        }
        if (!(error instanceof TypeError) && !(error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError'))) throw error
      }
    }
    const age = now - Date.parse(cache.validated_at)
    if (!Number.isFinite(age) || age < 0 || age >= 7 * DAY) throw new Error('Offline authorization expired. Connect and refresh terminal access.')
    if (!await verifyOffline(pin, employee)) throw new Error('PIN not accepted. After five attempts, access is locked for 60 seconds.')
    const session: CashierSession = { employee_id: employee.id, permission_version: employee.permission_version, logged_in_at: new Date(now).toISOString(), last_server_validated_at: cache.validated_at }
    await database.access.put({ ...cache, attempts: 0, localLockedUntil: 0, session })
  })
}
