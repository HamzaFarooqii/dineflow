import { useEffect, useMemo, useState } from 'react'
import { allocateEqualSplit, allocateWeightedSplit } from '../../../../packages/domain/src/split-settlement'
import { calculateDiscountedLine, formatCents, parseCents } from '../../../../packages/domain/src/money'
import { validateSettlement, type SettlementTender } from '../lib/checkout'
import type { CartItem } from '../lib/pos-store'
import './split-settlement.css'

interface Draft { id: string; method: 'cash' | 'card'; amount: string; received: string; tip: string; reference: string; confirmed: boolean }
const moneyInput = (cents: number) => (cents / 100).toFixed(2)
const draft = (amount: number): Draft => ({ id: crypto.randomUUID(), method: 'cash', amount: moneyInput(amount), received: moneyInput(amount), tip: '0.00', reference: '', confirmed: false })

export function SplitSettlement({ total, items, currency, disabled, onChange }: {
  total: number; items: CartItem[]; currency: string; disabled: boolean; onChange: (payments: SettlementTender[] | null) => void
}) {
  const [mode, setMode] = useState('equal')
  const [count, setCount] = useState(2)
  const [seats, setSeats] = useState<Record<string, number>>({})
  const [rows, setRows] = useState<Draft[]>(() => allocateEqualSplit(total, 2).map(draft))
  const [allocationError, setAllocationError] = useState('')
  const rebuild = () => {
    try {
      let amounts: number[]
      if (mode === 'equal' || mode === 'custom') amounts = allocateEqualSplit(total, count)
      else {
        const lineAmounts = items.map(item => calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, item.discount).totalCents)
        const weights = mode === 'itemized' ? lineAmounts : Array.from({ length: count }, (_, seat) =>
          lineAmounts.reduce((sum, amount, index) => sum + ((seats[items[index].lineId] ?? 0) === seat ? amount : 0), 0))
        amounts = total === 0 ? weights.map(() => 0) : allocateWeightedSplit(total, weights)
      }
      if (amounts.length > 20) throw new Error('Use per-seat allocation for more than 20 lines.')
      setRows(amounts.map(draft)); setAllocationError('')
    } catch (reason) { setAllocationError(reason instanceof Error ? reason.message : 'Allocation failed.') }
  }
  const result = useMemo(() => {
    try {
      const payments = rows.map(row => {
        const amount = parseCents(row.amount), tip = parseCents(row.tip || '0')
        if (row.method === 'card' && !row.confirmed) throw new Error('Confirm each external card approval before closing.')
        const received = row.method === 'cash' ? parseCents(row.received) : amount + tip
        return { id: row.id, method: row.method, amount_cents: amount, tip_cents: tip,
          tendered_cents: received, change_cents: row.method === 'cash' ? received - amount - tip : 0, reference: row.reference.trim() || null }
      })
      validateSettlement(payments, total)
      return { payments, error: '' }
    } catch (reason) { return { payments: null, error: reason instanceof Error ? reason.message : 'Invalid payment.' } }
  }, [rows, total])
  useEffect(() => onChange(result.payments), [result, onChange])
  const update = (index: number, change: Partial<Draft>) => setRows(current => current.map((row, i) => i === index ? { ...row, ...change } : row))
  return <fieldset className="split-settlement" disabled={disabled}><legend>Allocate and collect payments</legend>
    <div className="settlement-controls"><label>Allocation<select value={mode} onChange={event => setMode(event.target.value)}>
      <option value="equal">Equal</option><option value="itemized">By item</option><option value="seat">By seat</option><option value="custom">Custom cash + card</option>
    </select></label><label>Guests / tenders<input type="number" min="2" max="20" value={count} onChange={event => setCount(Math.max(2, Math.min(20, Number(event.target.value) || 2)))} /></label></div>
    {mode === 'seat' && items.map((item, index) => <label key={item.lineId}>{item.name} × {item.quantity}<select value={seats[item.lineId] ?? 0} onChange={event => setSeats(current => ({ ...current, [item.lineId]: Number(event.target.value) }))}>
      {Array.from({ length: count }, (_, seat) => <option key={seat} value={seat}>Seat {seat + 1}</option>)}
    </select><small>Line {index + 1}</small></label>)}
    <button className="secondary-cta" type="button" onClick={rebuild}>Apply allocation</button>
    <p className="screen-note">Allocate before collecting. Applying a new allocation clears the entered payment details.</p>
    {allocationError && <p role="alert" className="form-notice error">{allocationError}</p>}
    {rows.map((row, index) => <section className="settlement-tender" key={row.id} aria-label={`Payment ${index + 1}`}>
      <h3>Payment {index + 1}</h3><div className="settlement-controls">
      <label>Method<select value={row.method} onChange={event => update(index, { method: event.target.value as Draft['method'], confirmed: false })}><option value="cash">Cash</option><option value="card">Card (external)</option></select></label>
      <label>Sale amount<input inputMode="decimal" value={row.amount} onChange={event => update(index, { amount: event.target.value, confirmed: false })} /></label>
      <label>Tip<input inputMode="decimal" value={row.tip} onChange={event => update(index, { tip: event.target.value, confirmed: false })} /></label>
      {row.method === 'cash' ? <label>Cash received<input inputMode="decimal" value={row.received} onChange={event => update(index, { received: event.target.value })} /></label>
        : <label>External reference<input maxLength={120} value={row.reference} onChange={event => update(index, { reference: event.target.value })} /></label>}
      </div>{row.method === 'card' && <label className="card-confirm"><input type="checkbox" checked={row.confirmed} onChange={event => update(index, { confirmed: event.target.checked })} />External card payment approved</label>}
    </section>)}
    <p aria-live="polite">Sale allocations must total {formatCents(total, currency)}. Tips are additional.</p>
    {result.error && <p className="form-notice error" role="status">{result.error}</p>}
  </fieldset>
}
