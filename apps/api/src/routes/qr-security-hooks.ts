import type { Request } from 'express'

// Integration point for the shared public rate limiter and role enforcement (owned by the
// security branch, deliberately NOT implemented here so this branch builds and tests alone).
//
// Every public QR request calls exactly one hook BEFORE doing any database work beyond token
// lookup. A hook rejects by throwing an ApiError (e.g. new ApiError(429, 'rate_limited', ...)); it
// allows by returning. The defaults below allow everything, which is safe ONLY because the whole
// public surface is fail-closed behind QR_ORDERING_ENABLED (see qrOrderingEnabled). Do not enable
// that flag in an environment until real limiters are registered through setQrSecurityHooks.
export interface QrPublicContext { req: Request; storeId: string | null; tableId: string | null; sessionId: string | null }
export interface QrStaffContext {
  req: Request; storeId: string; action: 'list' | 'confirm' | 'reject'
  actor: { kind: 'manager'; userId: string } | { kind: 'terminal'; employeeId: string }
}

export interface QrSecurityHooks {
  /** POST /public/qr/sessions -- key on client IP; no session exists yet. */
  sessionIssuance(ctx: QrPublicContext): Promise<void>
  /** POST /public/qr/orders -- key on session id and IP. */
  orderSubmission(ctx: QrPublicContext): Promise<void>
  /** GET /public/qr/orders and /public/qr/menu -- key on session id and IP. */
  statusPolling(ctx: QrPublicContext): Promise<void>
  /** Staff list/confirm/reject -- role enforcement (e.g. only waiter/manager roles may confirm). */
  staffConfirmation(ctx: QrStaffContext): Promise<void>
}

const allow = async () => undefined
const defaults: QrSecurityHooks = { sessionIssuance: allow, orderSubmission: allow, statusPolling: allow, staffConfirmation: allow }
export const qrSecurityHooks: QrSecurityHooks = { ...defaults }

export function setQrSecurityHooks(overrides: Partial<QrSecurityHooks>) { Object.assign(qrSecurityHooks, overrides) }
export function resetQrSecurityHooks() { Object.assign(qrSecurityHooks, defaults) }

// Fail-closed master switch, read per request so it can be turned off without a redeploy of code.
export function qrOrderingEnabled(): boolean { return process.env.QR_ORDERING_ENABLED === 'true' }
