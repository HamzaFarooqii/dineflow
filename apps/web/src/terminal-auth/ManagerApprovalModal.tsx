import { useEffect, useRef, useState } from 'react'
import { verifyOffline } from './policy'
import type { TerminalCache } from './cache'
import './terminal-auth.css'

const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
const MANAGER_APPROVAL_WINDOW = 3 * 86_400_000 // 72 hours, matching policy.ts's managerApproval rule (age < 3 * DAY)
const LOCKOUT_AFTER_ATTEMPTS = 5
const LOCKOUT_MS = 60_000

export interface ManagerApprovalEvidence { managerId: string; managerName: string; approvedAt: string }

// Elegant, focus-trapped overlay reusing the CashierLogin PIN keypad style so a manager can
// authorize a discount above the cashier's 20% independent authority (FEAT-AUTH-02), entirely offline.
export function ManagerApprovalModal({ cache, title = 'Authorize this discount', reason, actionLabel = 'Approve discount', onApprove, onClose }: {
  cache: TerminalCache
  title?: string
  reason: string
  actionLabel?: string
  onApprove: (evidence: ManagerApprovalEvidence) => void
  onClose: () => void
}) {
  const managers = cache.employees.filter(row => row.role === 'manager')
  // Always start unselected, even with a single manager on this terminal — approving an action
  // requires that manager to actively choose themselves from the list, not just enter a PIN
  // against whatever the form happened to preselect.
  const [managerId, setManagerId] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempts, setAttempts] = useState(0)
  const [lockedUntil, setLockedUntil] = useState(0)
  const [now, setNow] = useState(Date.now())
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)

  useEffect(() => {
    closeButton.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onClose(); return }
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled])')]
        if (!focusable.length) return
        const first = focusable[0], last = focusable.at(-1)!
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])

  useEffect(() => {
    if (!lockedUntil) return
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [lockedUntil])

  const age = now - Date.parse(cache.validated_at)
  const withinWindow = Number.isFinite(age) && age >= 0 && age < MANAGER_APPROVAL_WINDOW
  const locked = lockedUntil > now
  const secondsLeft = locked ? Math.ceil((lockedUntil - now) / 1000) : 0

  function appendDigit(value: string) { if (!busy && !locked) setPin(current => current.length < 8 ? `${current}${value}` : current) }

  async function submit() {
    const employee = managers.find(row => row.id === managerId)
    if (!employee || locked || busy) return
    setBusy(true); setError('')
    try {
      const ok = await verifyOffline(pin, employee)
      if (!ok) {
        const nextAttempts = attempts + 1
        setAttempts(nextAttempts); setPin('')
        if (nextAttempts >= LOCKOUT_AFTER_ATTEMPTS) { setLockedUntil(Date.now() + LOCKOUT_MS); setAttempts(0) }
        setError(`PIN not accepted. ${nextAttempts >= LOCKOUT_AFTER_ATTEMPTS ? 'Access is locked for 60 seconds.' : `${LOCKOUT_AFTER_ATTEMPTS - nextAttempts} attempt${LOCKOUT_AFTER_ATTEMPTS - nextAttempts === 1 ? '' : 's'} left before a 60-second lockout.`}`)
        return
      }
      onApprove({ managerId: employee.id, managerName: employee.name, approvedAt: new Date().toISOString() })
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'PIN could not be verified.') }
    finally { setBusy(false) }
  }

  const pinLength = Math.max(4, Math.min(8, pin.length || 4))
  const canSubmit = !busy && !locked && withinWindow && Boolean(managerId) && pin.length >= 4

  return <div className="manager-approval-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="manager-approval-dialog cashier-card" role="dialog" aria-modal="true" aria-labelledby="manager-approval-title">
      <div className="manager-approval-head"><div><p className="kicker">MANAGER APPROVAL</p><h1 id="manager-approval-title">{title}</h1></div>
        <button ref={closeButton} type="button" className="text-action" onClick={onClose}>Close</button></div>
      <p className="manager-approval-reason">{reason}</p>
      {!withinWindow && <p className="form-notice error" role="alert">Manager approval requires online validation within the last 72 hours. Connect this terminal and refresh terminal access, then try again.</p>}
      {!managers.length && <p className="form-notice error" role="alert">No manager is provisioned on this terminal. Ask an owner to add one, then refresh terminal access.</p>}
      {managers.length > 0 && <>
        <label className="cashier-label">Manager<select value={managerId} required disabled={busy || locked} onChange={event => { setManagerId(event.target.value); setPin(''); setError('') }}>
          <option value="">Choose a manager</option>{managers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <div className="cashier-label"><span>Enter manager PIN</span>
          <input className="sr-only" aria-label="Manager PIN" type="password" inputMode="numeric" pattern="[0-9]{4,8}" value={pin}
            onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} autoComplete="off" disabled={locked} />
          <div className="pin-slots" aria-hidden="true">{Array.from({ length: pinLength }, (_, index) => <span key={index}>{index < pin.length ? '•' : ''}</span>)}</div>
        </div>
        <div className="pin-keypad" aria-label="Manager PIN keypad">
          {keypad.map(value => <button key={value} type="button" disabled={busy || locked} onClick={() => appendDigit(value)}>{value}</button>)}
          <button type="button" disabled={busy || locked} aria-label="Delete PIN digit" onClick={() => setPin(current => current.slice(0, -1))}>⌫</button>
          <button type="button" disabled={busy || locked} onClick={() => appendDigit('0')}>0</button>
          <button type="button" disabled={busy || locked} onClick={() => setPin('')}>Clear</button>
        </div>
        {locked && <p className="form-notice error" role="alert">Too many attempts. Try again in {secondsLeft} second{secondsLeft === 1 ? '' : 's'}.</p>}
        {error && !locked && <p className="form-notice error" role="alert">{error}</p>}
        <button className="cta cashier-unlock-button" type="button" disabled={!canSubmit} onClick={() => void submit()}>{busy ? 'Verifying…' : actionLabel}</button>
      </>}
    </section>
  </div>
}
