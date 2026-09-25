import { useEffect, useState } from 'react'
import { StatusBadge } from '../../components/StatusBadge'
import type { LocalCustomer } from '../../lib/db'
import { enrollInLoyalty, fetchLoyaltyAccount, type LoyaltyAccount, type LoyaltyTier } from '../../lib/loyalty'
import './loyalty.css'

const points = new Intl.NumberFormat('en-US')

// A guest's tier as a chip. Tiers are a neutral fact about the guest, not a state that needs
// action, so every tier uses `info`; "no tier" is `muted` (docs/DESIGN_SYSTEM.md status tones).
export function LoyaltyTierBadge({ tier }: { tier: LoyaltyTier | null }) {
  return <StatusBadge tone={tier ? 'info' : 'muted'}>{tier ? tier.name : 'No tier'}</StatusBadge>
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; account: LoyaltyAccount | null }

// Points balance + tier for one guest, shown in the guest picker and the guest directory so a
// cashier sees it before checkout. Enrollment is explicit opt-in: a guest who hasn't joined shows
// "Not enrolled" with an Enroll action — nothing here enrolls anyone implicitly.
export function LoyaltyBalance({ storeId, terminal, customer }: { storeId: string; terminal: boolean; customer: LocalCustomer }) {
  const synced = customer.sync_status === 'synced'
  const [online, setOnline] = useState(navigator.onLine)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [enrolling, setEnrolling] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])

  useEffect(() => {
    if (!synced || !online) return
    let active = true
    setState({ kind: 'loading' })
    fetchLoyaltyAccount(storeId, customer.id, terminal)
      .then(account => { if (active) setState({ kind: 'loaded', account }) })
      .catch(reason => { if (active) setState({ kind: 'error', message: reason instanceof Error ? reason.message : 'Loyalty balance is unavailable.' }) })
    return () => { active = false }
  }, [storeId, customer.id, terminal, synced, online, attempt])

  const enroll = async () => {
    setEnrolling(true)
    try { setState({ kind: 'loaded', account: await enrollInLoyalty(storeId, customer.id, terminal) }) }
    catch (reason) { setState({ kind: 'error', message: reason instanceof Error ? reason.message : 'Enrollment failed.' }) }
    finally { setEnrolling(false) }
  }

  if (!synced) return <small className="loyalty-balance-note">Loyalty available once this guest syncs.</small>
  if (!online) return <small className="loyalty-balance-note">Connect to see loyalty points.</small>
  if (state.kind === 'loading') return <small className="loyalty-balance-note" role="status">Checking loyalty…</small>
  if (state.kind === 'error') {
    return <div className="loyalty-balance"><small className="loyalty-balance-error" role="alert">{state.message}</small>
      <button type="button" className="text-action" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>
  }
  const { account } = state
  if (!account) {
    return <div className="loyalty-balance"><StatusBadge tone="muted">Not enrolled</StatusBadge>
      <button type="button" className="text-action" disabled={enrolling} onClick={() => void enroll()} aria-label={`Enroll ${customer.name} in loyalty`}>{enrolling ? 'Enrolling…' : 'Enroll in loyalty'}</button></div>
  }
  return <div className="loyalty-balance" aria-label={`${customer.name} loyalty`}>
    <LoyaltyTierBadge tier={account.tier} />
    <span className="loyalty-balance-points"><strong>{points.format(account.points_balance)}</strong> pts</span>
    <small>{points.format(account.lifetime_points)} lifetime</small>
  </div>
}
