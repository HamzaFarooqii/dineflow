import { accessToken, configuredApiUrl } from './catalog'

export interface LoyaltyTier { id: string; name: string; min_lifetime_points: number; point_multiplier_bps: number }

export interface LoyaltyAccount {
  id: string
  customer_id: string
  points_balance: number
  lifetime_points: number
  enrolled_at: string
  tier: LoyaltyTier | null
}

export interface RewardRule { id: string; name: string; points_cost: number; discount_cents: number; active: boolean }

export type RewardRuleInput = Pick<RewardRule, 'name' | 'points_cost' | 'discount_cents'>

// Same transport split as inventory.ts: a cashier terminal goes to /pos/loyalty over its
// HttpOnly cookies; the management web app goes to /loyalty with the Supabase bearer token.
async function loyaltyRequest<T>(path: string, storeId: string, terminal: boolean, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const query = new URLSearchParams({ store_id: storeId, ...init.query })
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/loyalty' : '/loyalty'}${path}?${query}`, {
    method: init.method ?? 'GET',
    credentials: terminal ? 'include' : 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(terminal ? {} : { Authorization: `Bearer ${await accessToken()}` }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  })
  const parsed = await response.json().catch(() => ({})) as T & { message?: string }
  if (!response.ok) throw new Error(parsed.message ?? `Loyalty request failed (${response.status}).`)
  return parsed
}

/** The guest's account, or null when they haven't opted in. Never enrolls as a side effect. */
export async function fetchLoyaltyAccount(storeId: string, customerId: string, terminal: boolean): Promise<LoyaltyAccount | null> {
  return (await loyaltyRequest<{ account: LoyaltyAccount | null }>(`/accounts/${encodeURIComponent(customerId)}`, storeId, terminal)).account
}

export async function enrollInLoyalty(storeId: string, customerId: string, terminal: boolean): Promise<LoyaltyAccount> {
  const { account } = await loyaltyRequest<{ account: LoyaltyAccount | null }>(`/accounts/${encodeURIComponent(customerId)}/enroll`, storeId, terminal, { method: 'POST' })
  if (!account) throw new Error('Enrollment did not return an account.')
  return account
}

export async function fetchRewardRules(storeId: string, terminal: boolean, includeInactive = false): Promise<RewardRule[]> {
  return (await loyaltyRequest<{ reward_rules: RewardRule[] }>('/reward-rules', storeId, terminal, includeInactive ? { query: { include_inactive: 'true' } } : {})).reward_rules
}

// Reward-rule writes are management-only (owner/manager on the web); there is no terminal path.
export function createRewardRule(storeId: string, input: RewardRuleInput): Promise<RewardRule> {
  return loyaltyRequest<RewardRule>('/reward-rules', storeId, false, { method: 'POST', body: input })
}

export function updateRewardRule(storeId: string, ruleId: string, changes: Partial<RewardRuleInput> & { active?: boolean }): Promise<RewardRule> {
  return loyaltyRequest<RewardRule>(`/reward-rules/${encodeURIComponent(ruleId)}`, storeId, false, { method: 'PATCH', body: changes })
}

export function deactivateRewardRule(storeId: string, ruleId: string): Promise<RewardRule> {
  return loyaltyRequest<RewardRule>(`/reward-rules/${encodeURIComponent(ruleId)}/deactivate`, storeId, false, { method: 'PATCH' })
}
