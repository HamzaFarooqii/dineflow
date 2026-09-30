import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { PGlite } from '@electric-sql/pglite'

// Proves the reusable public-endpoint rate limiter's contract (apps/api/src/lib/rate-limit.ts):
// allowed/blocked boundaries, per-key isolation, 429 + Retry-After on the limit, and that time is
// fully controllable rather than requiring real sleeps across window boundaries. This is also the
// "small test router/fixture" the QR-session developer's lead can attach during integration --
// mountTestRateLimitedRouter below shows exactly how a real router would wire the middleware.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { checkRateLimit, rateLimiter } = await import('../src/lib/rate-limit.js')
const { db } = await import('../src/db.js')

const root = fileURLToPath(new URL('../../../', import.meta.url))

async function seededDatabase() {
  const database = new PGlite()
  // Same boilerplate every other test file in this suite runs first: the migration's RLS policy
  // references the `authenticated`/`anon` roles, which don't exist in a fresh PGlite instance.
  await database.exec(`create role anon; create role authenticated; create role service_role bypassrls;`)
  const sql = (await readFile(root + 'supabase/migrations/202610010002_public_rate_limits.sql', 'utf8'))
  await database.exec(sql)
  return database
}

function wireFixture(database: PGlite) {
  const fixture = db as unknown as { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }
  fixture.query = async (sql: string, params?: unknown[]) => {
    const result = await database.query(sql, params)
    return { rows: result.rows, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
  }
}

test('checkRateLimit allows up to the budget in a window, then blocks with a retry time inside that window', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const clock = { now: 1_700_000_000_000 } // fixed instant, window-aligned by the budget below
    const budget = { windowMs: 60_000, max: 3 }
    const now = () => new Date(clock.now)
    const key = 'store-a:203.0.113.5'

    for (let i = 1; i <= 3; i++) {
      const result = await checkRateLimit(db, key, budget, now)
      assert.equal(result.allowed, true, `request ${i} should be allowed`)
      assert.equal(result.remaining, 3 - i)
    }
    const blocked = await checkRateLimit(db, key, budget, now)
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.remaining, 0)
    assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60)
  } finally { await database.close() }
})

test('a different key has its own independent budget', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const budget = { windowMs: 60_000, max: 1 }
    const now = () => new Date(1_700_000_000_000)
    const first = await checkRateLimit(db, 'store-a:1.2.3.4', budget, now)
    const second = await checkRateLimit(db, 'store-b:1.2.3.4', budget, now)
    assert.equal(first.allowed, true)
    assert.equal(second.allowed, true) // a different store key is not affected by store-a's count
    const blockedFirst = await checkRateLimit(db, 'store-a:1.2.3.4', budget, now)
    assert.equal(blockedFirst.allowed, false)
  } finally { await database.close() }
})

test('moving the clock into the next window resets the count -- no real sleep required', async () => {
  const database = await seededDatabase()
  try {
    wireFixture(database)
    const budget = { windowMs: 1_000, max: 1 }
    const clock = { now: 1_700_000_000_000 }
    const now = () => new Date(clock.now)
    const key = 'store-a:same-key'
    assert.equal((await checkRateLimit(db, key, budget, now)).allowed, true)
    assert.equal((await checkRateLimit(db, key, budget, now)).allowed, false)
    clock.now += 1_000 // exactly one window later
    assert.equal((await checkRateLimit(db, key, budget, now)).allowed, true)
  } finally { await database.close() }
})

// The reusable middleware, mounted on a throwaway router exactly as a real QR-session router
// would -- proves the Express integration contract (headers, 429 body, next() on success), not
// just the underlying checkRateLimit function.
function mountTestRateLimitedRouter(budget: { windowMs: number; max: number }, now: () => Date) {
  const app = express()
  app.get('/ping', rateLimiter({ pool: db, budget, keyFn: () => 'fixture-key', now }), (_req, res) => {
    res.json({ ok: true })
  })
  return app
}

test('the Express middleware returns 429 with Retry-After once the budget is spent, and 200 with rate-limit headers before that', async () => {
  const database = await seededDatabase()
  let server: ReturnType<ReturnType<typeof mountTestRateLimitedRouter>['listen']> | undefined
  try {
    wireFixture(database)
    const app = mountTestRateLimitedRouter({ windowMs: 60_000, max: 2 }, () => new Date(1_700_000_000_000))
    server = app.listen(3199, '127.0.0.1')
    const first = await fetch('http://127.0.0.1:3199/ping')
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('x-ratelimit-limit'), '2')
    assert.equal(first.headers.get('x-ratelimit-remaining'), '1')
    await fetch('http://127.0.0.1:3199/ping')
    const third = await fetch('http://127.0.0.1:3199/ping')
    assert.equal(third.status, 429)
    assert.ok(Number(third.headers.get('retry-after')) > 0)
    const body = await third.json() as { code: string }
    assert.equal(body.code, 'rate_limited')
  } finally { server?.closeAllConnections(); server?.close(); await database.close() }
})

test('public rate limiting never gates staff/terminal or sync traffic -- it is a standalone primitive nothing in this codebase mounts on an authenticated route', async () => {
  // This is a documentation-as-test assertion: grep every route file for accidental use of
  // rateLimiter/checkRateLimit outside this test and lib/rate-limit.ts itself. If a future change
  // wires it directly into a terminal/staff/device router, that would violate "keep public limits
  // separate from legitimate staff traffic and historical sync" -- this test catches that early.
  const { readdir } = await import('node:fs/promises')
  const routesDir = fileURLToPath(new URL('../src/routes/', import.meta.url))
  const files = await readdir(routesDir)
  for (const file of files) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
    const content = await readFile(routesDir + file, 'utf8')
    assert.equal(content.includes('rate-limit.js'), false, `${file} should not import the public rate limiter -- it is for the new public QR surface only`)
  }
})
