import { parseCents } from '../../../../../packages/domain/src/money'
import type { RewardRule, RewardRuleInput } from '../../lib/loyalty'

// The reward-rule form's text fields, validated here (pure, unit-tested) so the section component
// only deals with state. The discount is typed as a currency amount and stored as integer cents.
export interface RewardRuleDraft { name: string; points: string; amount: string }

export const EMPTY_REWARD_RULE_DRAFT: RewardRuleDraft = { name: '', points: '', amount: '' }

export function draftFromRule(rule: RewardRule): RewardRuleDraft {
  return { name: rule.name, points: String(rule.points_cost), amount: (rule.discount_cents / 100).toFixed(2) }
}

/** Returns the API payload, or throws an Error whose message is safe to show the user. */
export function parseRewardRuleDraft(draft: RewardRuleDraft): RewardRuleInput {
  const name = draft.name.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 60) throw new Error('Reward name must be 1–60 characters.')
  const points = draft.points.trim()
  if (!/^[1-9]\d{0,8}$/.test(points)) throw new Error('Points cost must be a whole number greater than 0.')
  const discountCents = parseCents(draft.amount)
  if (discountCents <= 0) throw new Error('Discount must be greater than 0.')
  return { name, points_cost: Number(points), discount_cents: discountCents }
}
