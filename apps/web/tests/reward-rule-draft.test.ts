import test from 'node:test'
import assert from 'node:assert/strict'
import { draftFromRule, parseRewardRuleDraft } from '../src/screens/loyalty/reward-rule-draft'

test('parses a reward-rule draft into integer points and cents', () => {
  assert.deepEqual(parseRewardRuleDraft({ name: '  Free   dessert ', points: '500', amount: '6.50' }),
    { name: 'Free dessert', points_cost: 500, discount_cents: 650 })
})

test('rejects a blank or over-long name, non-whole points, and a zero or malformed discount', () => {
  assert.throws(() => parseRewardRuleDraft({ name: ' ', points: '500', amount: '5' }), /Reward name/)
  assert.throws(() => parseRewardRuleDraft({ name: 'x'.repeat(61), points: '500', amount: '5' }), /Reward name/)
  assert.throws(() => parseRewardRuleDraft({ name: 'Dessert', points: '0', amount: '5' }), /Points cost/)
  assert.throws(() => parseRewardRuleDraft({ name: 'Dessert', points: '2.5', amount: '5' }), /Points cost/)
  assert.throws(() => parseRewardRuleDraft({ name: 'Dessert', points: '500', amount: '0' }), /greater than 0/)
  assert.throws(() => parseRewardRuleDraft({ name: 'Dessert', points: '500', amount: '5.555' }), /valid amount/)
})

test('an existing rule round-trips through the draft unchanged', () => {
  const rule = { id: 'r1', name: 'Free dessert', points_cost: 500, discount_cents: 650, active: true }
  assert.deepEqual(parseRewardRuleDraft(draftFromRule(rule)), { name: 'Free dessert', points_cost: 500, discount_cents: 650 })
})
