import test from 'node:test'
import assert from 'node:assert/strict'
import { activePromotions, promotionToLineDiscount, type Promotion } from './promotions.ts'

const base: Promotion = {
  id: 'promo-1', storeId: 'store-1', name: 'Happy Hour', discountKind: 'percent',
  discountValue: 1_500, startsAt: null, endsAt: null, active: true,
}

test('an inactive promotion is excluded even within its window', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  assert.deepEqual(activePromotions([{ ...base, active: false }], now), [])
})

test('a promotion that has not started yet is excluded', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const promotion = { ...base, startsAt: new Date('2026-09-26T00:00:00.000Z') }
  assert.deepEqual(activePromotions([promotion], now), [])
})

test('a promotion past its end date is excluded', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const promotion = { ...base, endsAt: new Date('2026-09-24T00:00:00.000Z') }
  assert.deepEqual(activePromotions([promotion], now), [])
})

test('an open-ended promotion (no start or end) is included once active', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  assert.deepEqual(activePromotions([base], now), [base])
})

test('a promotion within its window is included', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const promotion = { ...base, startsAt: new Date('2026-09-01T00:00:00.000Z'), endsAt: new Date('2026-09-30T00:00:00.000Z') }
  assert.deepEqual(activePromotions([promotion], now), [promotion])
})

test('filters a mixed list down to only the currently active ones', () => {
  const now = new Date('2026-09-25T12:00:00.000Z')
  const live = { ...base, id: 'live' }
  const expired = { ...base, id: 'expired', endsAt: new Date('2026-01-01T00:00:00.000Z') }
  const disabled = { ...base, id: 'disabled', active: false }
  assert.deepEqual(activePromotions([live, expired, disabled], now), [live])
})

test('maps a percent promotion directly onto a percent LineDiscount', () => {
  assert.deepEqual(promotionToLineDiscount({ ...base, discountKind: 'percent', discountValue: 2_000 }), { kind: 'percent', bps: 2_000 })
})

test('maps a fixed promotion directly onto a fixed LineDiscount', () => {
  assert.deepEqual(promotionToLineDiscount({ ...base, discountKind: 'fixed', discountValue: 500 }), { kind: 'fixed', cents: 500 })
})
