import { useEffect, useState } from 'react'
import { clockIn, clockOut, fetchCurrentShift, type Shift } from '../lib/shifts'

// Sits in the cashier topbar (CashierPosLayout), visible on every /pos/* screen. Clock state is
// per employee, not per device -- a shift already open on login just means someone forgot to
// clock out, not this employee working two shifts at once, so this always reflects the real
// server state on mount rather than assuming "not clocked in" by default.
export function ClockButton({ storeId }: { storeId: string }) {
  const [shift, setShift] = useState<Shift | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    if (!storeId) return
    fetchCurrentShift(storeId).then(result => { if (active) { setShift(result.shift); setLoaded(true) } })
      .catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [storeId])

  async function toggle() {
    setBusy(true); setError('')
    try {
      const result = shift ? await clockOut(storeId) : await clockIn(storeId)
      setShift(result.shift)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update your shift.')
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) return null
  return <span className="clock-button-wrap">
    <button type="button" className={shift ? 'clock-button clocked-in' : 'clock-button'} disabled={busy} onClick={() => void toggle()}>
      {busy ? 'Working…' : shift ? 'Clock Out' : 'Clock In'}
    </button>
    {error && <span className="clock-button-error" role="alert">{error}</span>}
  </span>
}
