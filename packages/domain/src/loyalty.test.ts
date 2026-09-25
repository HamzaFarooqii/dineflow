import test from 'node:test'
import assert from 'node:assert/strict'
import { pointsEarned, redemptionValue, tierForLifetimePoints } from './loyalty.ts'

test('earns one point per whole dollar at the base multiplier', () => {
  assert.equal(pointsEarned(2_500, 10_000), 25)
  assert.equal(pointsEarned(0, 10_000), 0)
})

test('rounds down once on the exact scaled total, never crediting a partial point', () => {
  assert.equal(pointsEarned(999, 10_000), 9)
  // $9.99 at 1.5x is 14.985 points → 14. Flooring dollars first would give 9 × 1.5 → 13.
  assert.equal(pointsEarned(999, 15_000), 14)
  assert.equal(pointsEarned(99, 10_000), 0)
})

test('scales by the tier multiplier', () => {
  assert.equal(pointsEarned(10_000, 20_000), 200)
  assert.equal(pointsEarned(10_000, 12_500), 125)
})

test('rejects non-integer or negative totals and non-positive multipliers', () => {
  assert.throws(() => pointsEarned(-1, 10_000), /Order total/)
  assert.throws(() => pointsEarned(10.5, 10_000), /Order total/)
  assert.throws(() => pointsEarned(100, 0), /Tier multiplier/)
})

const bronze = { name: 'Bronze', minLifetimePoints: 0 }
const silver = { name: 'Silver', minLifetimePoints: 500 }
const gold = { name: 'Gold', minLifetimePoints: 2_000 }

test('picks the highest tier whose threshold the lifetime points meet, regardless of input order', () => {
  assert.equal(tierForLifetimePoints(0, [gold, bronze, silver]), bronze)
  assert.equal(tierForLifetimePoints(499, [gold, bronze, silver]), bronze)
  assert.equal(tierForLifetimePoints(500, [gold, bronze, silver]), silver)
  assert.equal(tierForLifetimePoints(10_000, [gold, bronze, silver]), gold)
})

test('returns null when no tier qualifies or none are configured', () => {
  assert.equal(tierForLifetimePoints(100, []), null)
  assert.equal(tierForLifetimePoints(100, [silver, gold]), null)
})

test('on equal thresholds the first-listed tier wins', () => {
  const first = { name: 'A', minLifetimePoints: 100 }, second = { name: 'B', minLifetimePoints: 100 }
  assert.equal(tierForLifetimePoints(150, [first, second]), first)
})

test('redemption returns a fixed LineDiscount only when the balance covers the cost', () => {
  assert.deepEqual(redemptionValue(500, 750, 500), { kind: 'fixed', cents: 750 })
  assert.deepEqual(redemptionValue(500, 750, 1_200), { kind: 'fixed', cents: 750 })
  assert.equal(redemptionValue(500, 750, 499), null)
  assert.equal(redemptionValue(500, 750, 0), null)
})

test('redemption rejects invalid rule values and balances', () => {
  assert.throws(() => redemptionValue(0, 750, 100), /point cost/)
  assert.throws(() => redemptionValue(500, 0, 100), /discount/)
  assert.throws(() => redemptionValue(500, 750, -1), /balance/)
})
