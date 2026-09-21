import type { CashierSession, Employee } from './types'
export const DAY = 86_400_000
// Absorbs ordinary client/server clock drift (seconds, from imperfect NTP sync) without weakening
// the multi-day rollback guard: a real clock-rollback attempt to extend the 7-day/72-hour windows
// needs hours of skew, far past this tolerance.
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000
export function permissions(session: CashierSession, employee: Employee | undefined, now: number, lastSeen: number) {
  const age = now - Date.parse(session.last_server_validated_at)
  const valid = Boolean(employee && employee.id === session.employee_id && employee.permission_version === session.permission_version && now >= lastSeen && age >= -CLOCK_SKEW_TOLERANCE_MS && age < 7 * DAY)
  return { valid, managerApproval: valid && employee?.role === 'manager' && age < 3 * DAY }
}
export async function verifyOffline(pin: string, employee: Employee) {
  const v = employee.verifier
  if (v.version !== 1 || v.algorithm !== 'PBKDF2-SHA256' || v.iterations !== 600000 || !/^[a-f0-9]{32}$/.test(v.salt) || !/^[a-f0-9]{64}$/.test(v.hash)) throw new Error('Unsupported PIN verifier. Connect to refresh terminal access.')
  const salt = Uint8Array.from(v.salt.match(/../g)!, byte => parseInt(byte, 16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: v.iterations, hash: 'SHA-256' }, key, 256)
  const hash = [...new Uint8Array(derived)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return hash === v.hash
}
