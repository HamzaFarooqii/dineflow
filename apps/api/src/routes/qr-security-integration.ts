import type { Pool } from 'pg'
import { ApiError } from './auth.js'
import { requireCashierCapability } from '../terminal-auth/routes.js'
import { checkRateLimit, RATE_LIMIT_BUDGETS } from '../lib/rate-limit.js'
import { setQrSecurityHooks, type QrPublicContext, type QrSecurityHooks, type QrStaffContext } from './qr-security-hooks.js'

// Real implementation of the hook points qr-security-hooks.ts left as allow-all, built from the
// Day 1 security branch's own primitives so the QR surface uses the exact same guards as every
// other restaurant feature rather than a parallel, QR-specific copy:
//   - public rate limiting: lib/rate-limit.ts's Postgres-backed checkRateLimit, the same budgets
//     that branch shipped (unmounted, for this exact purpose) in RATE_LIMIT_BUDGETS.
//   - staff role enforcement: terminal-auth/routes.ts's requireCashierCapability, the same guard
//     floor.ts/kitchen.ts/open-checks.ts/etc. all call -- a terminal confirming/rejecting/listing
//     guest orders needs the 'register' capability (cashier/waiter/manager), exactly like
//     open-checks.ts's own terminal access rule, since accepting a guest order onto the table's
//     check is a front-of-house register action, not a kitchen/inventory/rider one.
//
// Session issuance (POST /public/qr/sessions) has no resolved store/table yet -- the code hasn't
// been looked up -- so it can only be keyed on the caller's own remote address, not on a store.
// Order submission and status polling run after resolveQrSession, so they key on that session's
// own id (lib/rate-limit.ts's byToken), scoping the limit to one guest's phone rather than
// whatever network or proxy hop the request arrives through.
function remoteAddressKey(ctx: QrPublicContext): string {
  return `qr:${ctx.req.socket.remoteAddress ?? 'unknown'}`
}
function sessionKey(ctx: QrPublicContext): string {
  // orderSubmission/statusPolling only ever run after resolveQrSession succeeds, so sessionId is
  // always set here; the null case can't be reached but is kept out of the public contract rather
  // than asserted away.
  if (!ctx.sessionId) throw new ApiError(401, 'session_invalid', 'Scan the QR code on your table to start.')
  return `qr-session:${ctx.sessionId}`
}

async function enforceRateLimit(pool: Pool, key: string, budget: { windowMs: number; max: number }) {
  const result = await checkRateLimit(pool, key, budget)
  if (!result.allowed) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again shortly.')
}

export function buildQrSecurityHooks(pool: Pool): QrSecurityHooks {
  return {
    async sessionIssuance(ctx: QrPublicContext) {
      await enforceRateLimit(pool, remoteAddressKey(ctx), RATE_LIMIT_BUDGETS.qrSessionCreate)
    },
    async orderSubmission(ctx: QrPublicContext) {
      await enforceRateLimit(pool, sessionKey(ctx), RATE_LIMIT_BUDGETS.qrOrderSubmit)
    },
    async statusPolling(ctx: QrPublicContext) {
      await enforceRateLimit(pool, sessionKey(ctx), RATE_LIMIT_BUDGETS.qrStatusPoll)
    },
    async staffConfirmation(ctx: QrStaffContext) {
      // A manager/owner web session already proved full store authority via requireStoreManager
      // before this hook runs (qr-ordering.ts's staffAccess) -- manager is a capability superset
      // by convention (packages/domain/src/staff-role.ts), so there is nothing further to check.
      if (ctx.actor.kind === 'manager') return
      const session = await requireCashierCapability(ctx.req, pool, 'register')
      if (session.storeId !== ctx.storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
    },
  }
}

export function installQrSecurityHooks(pool: Pool) {
  setQrSecurityHooks(buildQrSecurityHooks(pool))
}
