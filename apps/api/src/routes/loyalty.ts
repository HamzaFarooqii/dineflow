import { Router, type Request, type Response } from 'express'
import { db } from '../db.js'
import { requireStoreMember, requireStoreManager, sendApiError, ApiError } from './auth.js'
import { requireCashierTerminal } from '../terminal-auth/routes.js'
import { tierForLifetimePoints } from '../../../../packages/domain/src/loyalty.js'

export const loyaltyRouter = Router()
export const terminalLoyaltyRouter = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function storeIdParam(req: Request): string {
  const storeId = String(req.query.store_id ?? '')
  if (!UUID_RE.test(storeId)) throw new ApiError(400, 'validation_failed', 'A valid store_id is required.')
  return storeId
}

function idParam(req: Request, name = 'id'): string {
  const id = String(req.params[name] ?? '')
  if (!UUID_RE.test(id)) throw new ApiError(422, 'validation_failed', `A valid ${name} is required.`)
  return id
}

// Reads (and enrollment, below) are open to any signed-in store member on the web and to any
// unlocked cashier terminal — a cashier needs to see a guest's balance before checkout. Only the
// reward-rule catalog's writes are owner/manager-only.
async function requireReader(req: Request, storeId: string, terminal: boolean): Promise<void> {
  if (terminal) {
    const session = await requireCashierTerminal(req, db)
    if (session.storeId !== storeId) throw new ApiError(403, 'cross_store_reference', 'This terminal belongs to a different store.')
  } else {
    await requireStoreMember(req, storeId)
  }
}

// --- Tiers -----------------------------------------------------------------------------------

export interface TierRow { id: string; name: string; min_lifetime_points: number; point_multiplier_bps: number }

// Threshold then name: tierForLifetimePoints breaks threshold ties by list order, so this order
// is what makes the result deterministic.
async function loadTiers(storeId: string): Promise<TierRow[]> {
  const result = await db.query<TierRow>(
    `select id, name, min_lifetime_points, point_multiplier_bps from public.loyalty_tiers
     where store_id = $1 order by min_lifetime_points, name`,
    [storeId],
  )
  return result.rows
}

async function listTiers(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireReader(req, storeId, terminal)
    res.json({ tiers: await loadTiers(storeId) })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Accounts --------------------------------------------------------------------------------
//
// Enrollment is explicit opt-in (POST .../enroll), never a side effect of a read: a GET for a
// guest who hasn't joined returns account: null rather than silently creating one. See the Day 4
// PR description for the reasoning. The checkout-wiring hook awards points only to an existing
// account, so it never has to create one on the checkout path either.

export interface LoyaltyAccountView {
  id: string; customer_id: string; points_balance: number; lifetime_points: number; enrolled_at: string
  tier: TierRow | null
}

interface AccountRow { id: string; customer_id: string; points_balance: number; lifetime_points: number; enrolled_at: string }

async function assertCustomerInStore(storeId: string, customerId: string) {
  const customer = await db.query('select 1 from public.pos_customers where store_id = $1 and id = $2', [storeId, customerId])
  // A guest created offline exists only on the terminal until it syncs — the same 404 covers both.
  if (!customer.rowCount) throw new ApiError(404, 'customer_not_found', 'This guest is not saved to the restaurant yet. Sync the guest first.')
}

export async function loadAccountView(storeId: string, customerId: string): Promise<LoyaltyAccountView | null> {
  const result = await db.query<AccountRow>(
    `select id, customer_id, points_balance, lifetime_points, enrolled_at from public.loyalty_accounts
     where store_id = $1 and customer_id = $2`,
    [storeId, customerId],
  )
  const account = result.rows[0]
  if (!account) return null
  const tiers = await loadTiers(storeId)
  const tier = tierForLifetimePoints(account.lifetime_points, tiers.map(row => ({ ...row, minLifetimePoints: row.min_lifetime_points })))
  return { ...account, tier: tier ? { id: tier.id, name: tier.name, min_lifetime_points: tier.min_lifetime_points, point_multiplier_bps: tier.point_multiplier_bps } : null }
}

async function getAccount(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireReader(req, storeId, terminal)
    const customerId = idParam(req, 'customerId')
    await assertCustomerInStore(storeId, customerId)
    res.json({ customer_id: customerId, account: await loadAccountView(storeId, customerId) })
  } catch (reason) { sendApiError(res, reason) }
}

// Idempotent: enrolling an already-enrolled guest returns their existing account (200) rather
// than a conflict, so a double-tap or a retried request is harmless.
async function enroll(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireReader(req, storeId, terminal)
    const customerId = idParam(req, 'customerId')
    await assertCustomerInStore(storeId, customerId)
    const inserted = await db.query(
      `insert into public.loyalty_accounts (store_id, customer_id) values ($1, $2)
       on conflict (store_id, customer_id) do nothing returning id`,
      [storeId, customerId],
    )
    res.status(inserted.rowCount ? 201 : 200).json({ customer_id: customerId, account: await loadAccountView(storeId, customerId) })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Point ledger ----------------------------------------------------------------------------

interface LedgerRow {
  id: string; account_id: string; delta: number; reason: string; order_id: string | null
  created_at: string; created_by_name: string | null
}

// Same display-name convention as inventory.ts's movements: a signed-in owner/manager
// ("Full Name (owner)") or the terminal employee who made a manual adjustment. Earn/redeem rows
// tied to an order leave both null — the order itself carries its employee.
//
// cursor_time is created_at as an ISO string with microseconds, so the page cursor keeps
// Postgres's full precision — a JS Date would truncate it to milliseconds and could skip rows
// that share a millisecond at a page boundary.
const LEDGER_SELECT = `
  l.id, l.account_id, l.delta, l.reason, l.order_id, l.created_at, to_char(l.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time,
  case
    when p.full_name is not null and p.full_name <> '' then p.full_name || coalesce(' (' || sm.role || ')', '')
    when e.name is not null then e.name
    else null
  end as created_by_name
  from public.loyalty_point_ledger l
  left join public.profiles p on p.id = l.created_by_user_id
  left join public.store_memberships sm on sm.store_id = l.store_id and sm.user_id = l.created_by_user_id
  left join public.terminal_employees e on e.store_id = l.store_id and e.id = l.created_by_employee_id`

interface LedgerCursor { time: string; id: string }
function ledgerCursorParam(req: Request): LedgerCursor | null {
  const value = req.query.before
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length > 160) throw new ApiError(400, 'validation_failed', 'Invalid before cursor.')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new ApiError(400, 'validation_failed', 'Invalid before cursor.') }
  const row = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const { time, id } = row
  if (typeof time !== 'string' || Number.isNaN(Date.parse(time)) || typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new ApiError(400, 'validation_failed', 'Invalid before cursor.')
  }
  return { time, id }
}

function ledgerLimitParam(req: Request): number {
  const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new ApiError(400, 'validation_failed', 'Limit must be 1 to 200.')
  return rawLimit
}

async function listLedger(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireReader(req, storeId, terminal)
    const customerId = idParam(req, 'customerId')
    const limit = ledgerLimitParam(req)
    const cursor = ledgerCursorParam(req)
    const account = await db.query<{ id: string }>('select id from public.loyalty_accounts where store_id = $1 and customer_id = $2', [storeId, customerId])
    if (!account.rows[0]) throw new ApiError(404, 'loyalty_account_not_found', 'This guest is not enrolled in loyalty.')
    const result = await db.query<LedgerRow & { cursor_time: string }>(
      `select ${LEDGER_SELECT}
       where l.store_id = $1 and l.account_id = $2
         and ($3::timestamptz is null or (l.created_at, l.id) < ($3::timestamptz, $4::uuid))
       order by l.created_at desc, l.id desc limit $5`,
      [storeId, account.rows[0].id, cursor?.time ?? null, cursor?.id ?? null, limit + 1],
    )
    const page = result.rows.slice(0, limit)
    const last = page.at(-1)
    res.json({
      entries: page.map(({ cursor_time: _cursorTime, ...entry }): LedgerRow => entry),
      next_cursor: result.rows.length > limit && last
        ? Buffer.from(JSON.stringify({ time: last.cursor_time, id: last.id })).toString('base64url')
        : null,
    })
  } catch (reason) { sendApiError(res, reason) }
}

// --- Reward rules (catalog) ------------------------------------------------------------------

export interface RewardRuleRow { id: string; name: string; points_cost: number; discount_cents: number; active: boolean }
const REWARD_RULE_COLUMNS = 'id, name, points_cost, discount_cents, active'

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ApiError(422, 'validation_failed', `${label} must be a positive whole number.`)
  return value
}

function ruleName(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > 60) throw new ApiError(422, 'validation_failed', 'Reward name must be 1–60 characters.')
  return text
}

/** Validates a create (all fields required) or a partial update (at least one field). */
export function parseRewardRuleBody(raw: unknown, partial: boolean): Partial<Omit<RewardRuleRow, 'id'>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(422, 'validation_failed', 'A JSON object is required.')
  const body = raw as Record<string, unknown>
  const parsed: Partial<Omit<RewardRuleRow, 'id'>> = {}
  if (!partial || body.name !== undefined) parsed.name = ruleName(body.name)
  if (!partial || body.points_cost !== undefined) parsed.points_cost = positiveInt(body.points_cost, 'Points cost')
  if (!partial || body.discount_cents !== undefined) parsed.discount_cents = positiveInt(body.discount_cents, 'Discount')
  if (partial && body.active !== undefined) {
    if (typeof body.active !== 'boolean') throw new ApiError(422, 'validation_failed', 'active must be true or false.')
    parsed.active = body.active
  }
  if (partial && !Object.keys(parsed).length) throw new ApiError(422, 'validation_failed', 'Nothing to update.')
  return parsed
}

// Active rules only by default (what the register/guest picker offers); management passes
// include_inactive=true to see deactivated rules too.
async function listRewardRules(req: Request, res: Response, terminal = false) {
  try {
    const storeId = storeIdParam(req)
    await requireReader(req, storeId, terminal)
    const includeInactive = req.query.include_inactive === 'true'
    const result = await db.query<RewardRuleRow>(
      `select ${REWARD_RULE_COLUMNS} from public.reward_rules
       where store_id = $1 ${includeInactive ? '' : 'and active = true'}
       order by points_cost, name`,
      [storeId],
    )
    res.json({ reward_rules: result.rows })
  } catch (reason) { sendApiError(res, reason) }
}

async function createRewardRule(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const rule = parseRewardRuleBody(req.body, false)
    const inserted = await db.query<RewardRuleRow>(
      `insert into public.reward_rules (store_id, name, points_cost, discount_cents) values ($1, $2, $3, $4)
       returning ${REWARD_RULE_COLUMNS}`,
      [storeId, rule.name, rule.points_cost, rule.discount_cents],
    )
    res.status(201).json(inserted.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

async function updateRewardRule(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const ruleId = idParam(req)
    const changes = parseRewardRuleBody(req.body, true)
    const updates: string[] = []
    const values: unknown[] = []
    for (const [column, value] of Object.entries(changes)) { values.push(value); updates.push(`${column} = $${values.length}`) }
    values.push(ruleId, storeId)
    const result = await db.query<RewardRuleRow>(
      `update public.reward_rules set ${updates.join(', ')} where id = $${values.length - 1} and store_id = $${values.length}
       returning ${REWARD_RULE_COLUMNS}`,
      values,
    )
    if (!result.rowCount) throw new ApiError(404, 'reward_rule_not_found', 'Reward not found in this store.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

// Deactivate, never delete: Hamza's checkout wiring will record redemptions against these rules,
// and a deactivated rule simply stops being offered.
async function deactivateRewardRule(req: Request, res: Response) {
  try {
    const storeId = storeIdParam(req)
    await requireStoreManager(req, storeId)
    const ruleId = idParam(req)
    const result = await db.query<RewardRuleRow>(
      `update public.reward_rules set active = false where id = $1 and store_id = $2 returning ${REWARD_RULE_COLUMNS}`,
      [ruleId, storeId],
    )
    if (!result.rowCount) throw new ApiError(404, 'reward_rule_not_found', 'Reward not found in this store.')
    res.json(result.rows[0])
  } catch (reason) { sendApiError(res, reason) }
}

loyaltyRouter.get('/tiers', (req, res) => listTiers(req, res))
loyaltyRouter.get('/accounts/:customerId', (req, res) => getAccount(req, res))
loyaltyRouter.post('/accounts/:customerId/enroll', (req, res) => enroll(req, res))
loyaltyRouter.get('/accounts/:customerId/ledger', (req, res) => listLedger(req, res))
loyaltyRouter.get('/reward-rules', (req, res) => listRewardRules(req, res))
loyaltyRouter.post('/reward-rules', (req, res) => createRewardRule(req, res))
loyaltyRouter.patch('/reward-rules/:id', (req, res) => updateRewardRule(req, res))
loyaltyRouter.patch('/reward-rules/:id/deactivate', (req, res) => deactivateRewardRule(req, res))

// Terminals read and enroll; the reward catalog is managed from the web only.
terminalLoyaltyRouter.get('/tiers', (req, res) => listTiers(req, res, true))
terminalLoyaltyRouter.get('/accounts/:customerId', (req, res) => getAccount(req, res, true))
terminalLoyaltyRouter.post('/accounts/:customerId/enroll', (req, res) => enroll(req, res, true))
terminalLoyaltyRouter.get('/accounts/:customerId/ledger', (req, res) => listLedger(req, res, true))
terminalLoyaltyRouter.get('/reward-rules', (req, res) => listRewardRules(req, res, true))
