import type { NextFunction, Request, Response } from 'express'
import type { Pool } from 'pg'

// Reusable public-endpoint rate limiting, built for the QR ordering surface another developer is
// wiring independently (session creation, order submission, status polling -- see
// RATE_LIMIT_BUDGETS below for starting points for each). Nothing in this codebase mounts this
// limiter yet; it is a self-contained primitive plus documented integration points, proven by this
// module's own test (apps/api/test/rate-limit.test.ts), for that feature to attach to once it
// lands. It must never be applied to authenticated terminal/staff routes or to the device-only
// historical-sync path -- those are legitimate traffic, not the public surface this exists to
// protect, and already have their own auth guards (requireCashierTerminal/requireDeviceTerminal/
// requireStoreMember).

export interface RateLimitBudget { windowMs: number; max: number }

// Starting budgets for the three QR integration points named above. Deliberately different: a
// session is created once per visit (tight budget), status polling happens continuously while a
// session is open (loose budget), order submission sits in between and is also money-affecting.
// Whoever wires the QR routes should tune these against real traffic, not treat them as final.
export const RATE_LIMIT_BUDGETS = {
  qrSessionCreate: { windowMs: 60_000, max: 10 },
  qrOrderSubmit: { windowMs: 60_000, max: 5 },
  qrStatusPoll: { windowMs: 10_000, max: 20 },
} as const satisfies Record<string, RateLimitBudget>

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number; limit: number }

// Fixed-window counting, persisted in Postgres (public.rate_limit_buckets, added by
// 202610010002_public_rate_limits.sql) rather than an in-process Map: a plain in-memory counter
// silently stops being a real limit the moment this API runs as more than one process or instance
// behind a load balancer, which nothing in this deployment's architecture rules out -- see that
// migration's own comment. One upsert per check; a row older than any caller's own window is inert
// and only needs periodic reaping for table size, never for correctness.
//
// `now` is injectable so tests can move the clock across window boundaries instead of sleeping
// through real windows (RULES.md's own "use controllable time in tests" instruction).
export async function checkRateLimit(pool: Pool, key: string, budget: RateLimitBudget, now: () => Date = () => new Date()): Promise<RateLimitResult> {
  const nowMs = now().getTime()
  const windowStart = new Date(Math.floor(nowMs / budget.windowMs) * budget.windowMs)
  const result = await pool.query<{ count: number }>(
    `insert into public.rate_limit_buckets (bucket_key, window_start, count)
     values ($1, $2, 1)
     on conflict (bucket_key, window_start) do update set count = rate_limit_buckets.count + 1
     returning count`,
    [key, windowStart.toISOString()],
  )
  const count = result.rows[0].count
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + budget.windowMs - nowMs) / 1000))
  return { allowed: count <= budget.max, remaining: Math.max(0, budget.max - count), retryAfterSeconds, limit: budget.max }
}

export interface RateLimitOptions {
  pool: Pool
  budget: RateLimitBudget
  keyFn: (req: Request) => string
  now?: () => Date
}

// Express middleware factory: the actual integration point a route file mounts per-endpoint, e.g.
// `router.post('/sessions', rateLimiter({ pool: db, budget: RATE_LIMIT_BUDGETS.qrSessionCreate,
// keyFn: byStoreAndRemoteAddress(req => storeIdParam(req)) }), createSession)`. Bounding request
// body size and expensive processing is the caller's own responsibility on that router (a small
// `express.json({ limit })`, same convention every terminal/public router in this codebase already
// follows) -- this middleware only enforces the request count.
export function rateLimiter(options: RateLimitOptions) {
  return async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    try {
      const key = options.keyFn(req)
      const result = await checkRateLimit(options.pool, key, options.budget, options.now)
      res.set('X-RateLimit-Limit', String(result.limit))
      res.set('X-RateLimit-Remaining', String(result.remaining))
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfterSeconds))
        res.status(429).json({ code: 'rate_limited', message: 'Too many requests. Try again shortly.', retry_after_seconds: result.retryAfterSeconds })
        return
      }
      next()
    } catch (reason) { next(reason) }
  }
}

// A key for an endpoint with no session yet (session creation): the store a QR code encodes plus
// the real TCP peer address. Deliberately never reads X-Forwarded-For/X-Real-IP -- those are only
// trustworthy behind a proxy this app has explicitly configured via Express's own
// `app.set('trust proxy', ...)`, which apps/api/src/app.ts does not set, so honoring a forwarded
// header here would let any caller pick their own bucket by sending a fake one.
export function byStoreAndRemoteAddress(storeIdParam: (req: Request) => string) {
  return (req: Request): string => `${storeIdParam(req)}:${req.socket.remoteAddress ?? 'unknown'}`
}

// A key for an endpoint that already has an unguessable session/table token (order submission,
// status polling against a QR session already created) -- scopes the limit to that one session
// rather than to whatever network the request happens to arrive from.
export function byToken(tokenParam: (req: Request) => string) {
  return (req: Request): string => tokenParam(req)
}
