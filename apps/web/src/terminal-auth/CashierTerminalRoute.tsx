import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { currentAccess } from './cache'
import { usePosStore } from '../lib/pos-store'
import { signedInOwnerTerminalAccess } from './ownerTerminalAccess'

export function CashierTerminalRoute({ children }: { children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean>()
  const location = useLocation()
  useEffect(() => {
    let active = true
    setAllowed(undefined)
    const check = () => { void currentAccess().then(async state => {
      if (!active) return
      const ownerAccess = state?.cache ? await signedInOwnerTerminalAccess(state.cache.device.store_id) : 'allowed'
      if (!active) return
      const valid = Boolean(state?.cache && state.employee && state.policy.valid && ownerAccess !== 'mismatch')
      if (!valid) usePosStore.getState().clearCart()
      setAllowed(valid)
    }).catch(() => { if (active) { usePosStore.getState().clearCart(); setAllowed(false) } }) }
    check()
    const interval = window.setInterval(check, 60_000)
    document.addEventListener('visibilitychange', check)
    return () => { active = false; window.clearInterval(interval); document.removeEventListener('visibilitychange', check) }
  }, [location.pathname])
  if (allowed === undefined) return <main className="route-pending" role="status">Checking terminal access…</main>
  return allowed ? <>{children}</> : <Navigate to="/pos/login" replace state={{ from: location.pathname }} />
}
