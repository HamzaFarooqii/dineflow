import { useEffect, useState } from 'react'
import { fetchCurrentBreak, fetchCurrentShift, startBreak, endBreak, type ShiftBreak } from '../lib/shifts'

// Sits next to ClockButton in the cashier topbar. Only usable while the employee has an open
// shift (mirrors the server-side rule: a break can only be started against a shift that's
// currently open) — hidden entirely when there's no open shift, same "reflect real server
// state on mount" approach as ClockButton, so a page reload never assumes "no break" by default.
export function BreakButton({ storeId }: { storeId: string }) {
  const [hasOpenShift, setHasOpenShift] = useState(false)
  const [activeBreak, setActiveBreak] = useState<ShiftBreak | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    if (!storeId) return
    Promise.all([fetchCurrentShift(storeId), fetchCurrentBreak(storeId)])
      .then(([shiftResult, breakResult]) => {
        if (!active) return
        setHasOpenShift(Boolean(shiftResult.shift))
        setActiveBreak(breakResult.break)
        setLoaded(true)
      })
      .catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [storeId])

  async function toggle(paid: boolean) {
    setBusy(true); setError('')
    try {
      const result = activeBreak ? await endBreak(storeId) : await startBreak(storeId, paid)
      setActiveBreak(result.break)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update your break.')
    } finally {
      setBusy(false)
    }
  }

  if (!loaded || !hasOpenShift) return null
  return <span className="break-button-wrap">
    {activeBreak
      ? <button type="button" className="break-button on-break" disabled={busy} onClick={() => void toggle(activeBreak.paid)} aria-label="End break">
          {busy ? 'Working…' : `End ${activeBreak.paid ? 'Paid' : 'Unpaid'} Break`}
        </button>
      : <span className="break-button-choices">
          <button type="button" className="break-button" disabled={busy} onClick={() => void toggle(true)} aria-label="Start paid break">{busy ? 'Working…' : 'Paid Break'}</button>
          <button type="button" className="break-button" disabled={busy} onClick={() => void toggle(false)} aria-label="Start unpaid break">{busy ? 'Working…' : 'Unpaid Break'}</button>
        </span>}
    {error && <span className="clock-button-error" role="alert">{error}</span>}
  </span>
}
