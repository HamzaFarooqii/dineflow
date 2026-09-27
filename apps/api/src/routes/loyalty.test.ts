import test from 'node:test'
import assert from 'node:assert/strict'

// Pure validation only — never opens a connection. The HTTP behaviour of every endpoint is
// covered in test/loyalty-api.test.ts.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/validation_only'
const { parseRewardRuleBody, parseTierBody } = await import('./loyalty.js')

test('parseTierBody validates create and partial update payloads', () => {
  assert.deepEqual(parseTierBody({ name: '  Gold  ', min_lifetime_points: 2000, point_multiplier_bps: 15000 }, false),
    { name: 'Gold', min_lifetime_points: 2000, point_multiplier_bps: 15000 })
  assert.deepEqual(parseTierBody({ min_lifetime_points: 2500 }, true), { min_lifetime_points: 2500 })
  assert.throws(() => parseTierBody({ name: '', min_lifetime_points: 0, point_multiplier_bps: 10000 }, false), /Tier name/)
  assert.throws(() => parseTierBody({ name: 'Gold', min_lifetime_points: -1, point_multiplier_bps: 10000 }, false), /non-negative/)
  assert.throws(() => parseTierBody({ name: 'Gold', min_lifetime_points: 0, point_multiplier_bps: 100001 }, false), /100,000/)
  assert.throws(() => parseTierBody({}, true), /Nothing to update/)
})

test('parseRewardRuleBody requires every field on create and trims the name', () => {
  assert.deepEqual(parseRewardRuleBody({ name: '  Free dessert ', points_cost: 500, discount_cents: 650 }, false),
    { name: 'Free dessert', points_cost: 500, discount_cents: 650 })
  assert.throws(() => parseRewardRuleBody({ points_cost: 500, discount_cents: 650 }, false), /Reward name/)
  assert.throws(() => parseRewardRuleBody({ name: 'x'.repeat(61), points_cost: 500, discount_cents: 650 }, false), /Reward name/)
  assert.throws(() => parseRewardRuleBody({ name: 'Dessert', points_cost: '500', discount_cents: 650 }, false), /Points cost/)
  assert.throws(() => parseRewardRuleBody({ name: 'Dessert', points_cost: 500, discount_cents: 6.5 }, false), /Discount/)
  assert.throws(() => parseRewardRuleBody(null, false), /JSON object/)
})

test('parseRewardRuleBody accepts a partial update, including re-activation, but not an empty one', () => {
  assert.deepEqual(parseRewardRuleBody({ points_cost: 750 }, true), { points_cost: 750 })
  assert.deepEqual(parseRewardRuleBody({ active: true }, true), { active: true })
  assert.throws(() => parseRewardRuleBody({ active: 'yes' }, true), /active/)
  assert.throws(() => parseRewardRuleBody({}, true), /Nothing to update/)
  // active is only settable through update; create always starts a rule active.
  assert.equal('active' in parseRewardRuleBody({ name: 'Dessert', points_cost: 1, discount_cents: 1, active: false }, false), false)
})
