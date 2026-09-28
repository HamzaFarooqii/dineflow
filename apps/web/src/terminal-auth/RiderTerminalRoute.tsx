import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { currentAccess } from './cache'
import { usePosStore } from '../lib/pos-store'
import { signedInOwnerTerminalAccess } from './ownerTerminalAccess'

// Same shape as CashierTerminalRoute, plus one more check: the signed-in employee must actually
// have the 'delivery' capability (i.e. be a rider). This is a client-side convenience only — the
// server enforces the real boundary (delivery.ts's requireRiderTerminal) independently of
// anything this component decides, so a bypass here can never grant real access, only a
// confusing UI. Kept separate from CashierTerminalRoute rather than adding a capability prop to
// it, since every other terminal screen intentionally accepts any active employee.
export function RiderTerminalRoute({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean>()
  const location = useLocation()
  useEffect(() => {
    let active = true
    setAllowed(undefined)
    const check = () => { void currentAccess().then(async state => {
      if (!active) return
      const ownerAccess = state?.cache ? await signedInOwnerTerminalAccess(state.cache.device.store_id) : 'allowed'
      if (!active) return
      const isRider = state?.employee?.role === 'rider'
      const valid = Boolean(state?.cache && state.employee && state.policy.valid && ownerAccess !== 'mismatch' && isRider)
      if (!valid) usePosStore.getState().clearCart()
      setAllowed(valid)
    }).catch(() => { if (active) { usePosStore.getState().clearCart(); setAllowed(false) } }) }
    check()
    const interval = window.setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', check) }
  }, [location.pathname])
  if (allowed === undefined) return <main className="route-pending" role="status">Checking rider access…</main>
  return allowed ? <>{children}</> : <Navigate to="/pos/login" replace state={{ from: location.pathname }} />
}
