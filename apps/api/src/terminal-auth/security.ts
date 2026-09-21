import { randomBytes, createHash, pbkdf2, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive = promisify(pbkdf2)
export const ITERATIONS = 600_000
export const token = () => randomBytes(32).toString('hex')
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
export function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message) }
export function string(value: unknown, label: string, pattern: RegExp) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(400, 'validation_failed', `Invalid ${label}.`)
  return value as string
}
export const uuid = (value: unknown) => string(value, 'identifier', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
export const pinValue = (value: unknown) => string(value, 'PIN (4 to 8 digits)', /^\d{4,8}$/)
export async function verifier(pin: string) {
  const salt = randomBytes(16).toString('hex')
  return { salt, hash: (await derive(pin, Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256')).toString('hex') }
}
export async function verify(pin: string, salt: string, hash: string) {
  const actual = await derive(pin, Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256')
  const expected = Buffer.from(hash, 'hex')
  return expected.length === actual.length && timingSafeEqual(actual, expected)
}
