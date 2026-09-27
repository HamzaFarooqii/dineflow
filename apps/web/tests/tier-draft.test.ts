import test from 'node:test'
import assert from 'node:assert/strict'
import { draftFromTier, parseTierDraft } from '../src/screens/loyalty/tier-draft'

test('parses the Gold acceptance example into API values', () => {
  assert.deepEqual(parseTierDraft({ name: '  Gold ', threshold: '2000', multiplier: '1.5' }),
    { name: 'Gold', min_lifetime_points: 2000, point_multiplier_bps: 15000 })
})

test('rejects invalid tier draft values', () => {
  assert.throws(() => parseTierDraft({ name: '', threshold: '0', multiplier: '1' }), /Tier name/)
  assert.throws(() => parseTierDraft({ name: 'Gold', threshold: '-1', multiplier: '1' }), /Lifetime points/)
  assert.throws(() => parseTierDraft({ name: 'Gold', threshold: '2.5', multiplier: '1' }), /Lifetime points/)
  assert.throws(() => parseTierDraft({ name: 'Gold', threshold: '2000', multiplier: '10.1' }), /Multiplier/)
})

test('an existing tier round-trips through its draft', () => {
  const tier = { id: 'tier-1', name: 'Gold', min_lifetime_points: 2000, point_multiplier_bps: 15000 }
  assert.deepEqual(parseTierDraft(draftFromTier(tier)), { name: 'Gold', min_lifetime_points: 2000, point_multiplier_bps: 15000 })
})
