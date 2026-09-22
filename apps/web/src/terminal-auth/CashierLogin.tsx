import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import { currentAccess, lockTerminal, loginCashier, readTerminal, refreshTerminal, type TerminalCache } from './cache'
import { signedInOwnerTerminalAccess } from './ownerTerminalAccess'
import './terminal-auth.css'

const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

export function CashierLogin() {
  const [cache, setCache] = useState<TerminalCache>()
  const [employeeId, setEmployeeId] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  const [offlineReady, setOfflineReady] = useState(false)
  const [managerApproval, setManagerApproval] = useState(false)
  const [ownerStoreMismatch, setOwnerStoreMismatch] = useState(false)
  const navigate = useNavigate()

  async function load() {
    const state = await currentAccess()
    const ownerAccess = state?.cache ? await signedInOwnerTerminalAccess(state.cache.device.store_id) : 'allowed'
    setOwnerStoreMismatch(ownerAccess === 'mismatch')
    setCache(ownerAccess === 'mismatch' ? undefined : state?.cache); setManagerApproval(ownerAccess === 'mismatch' ? false : state?.policy.managerApproval ?? false)
  }

  useEffect(() => {
    registerSW({ onOfflineReady: () => setOfflineReady(true), onRegisterError: () => setError('The offline app could not be cached. Keep this page open and retry online.') })
    let active = true
    const update = async () => {
      try { if (navigator.onLine && await readTerminal()) await refreshTerminal(); if (active) await load() }
      catch (reason) { if (active) { setError(reason instanceof Error ? reason.message : 'Unable to restore terminal access.'); await load() } }
      finally { if (active) setBusy(false) }
    }
    void update()
    const connection = () => { setOnline(navigator.onLine); if (navigator.onLine) { setBusy(true); void update() } }
    const interval = window.setInterval(() => { void load().catch(reason => setError(String(reason))) }, 5_000)
    const refresh = window.setInterval(() => { if (navigator.onLine) void update() }, 60_000)
    window.addEventListener('online', connection); window.addEventListener('offline', connection)
    return () => { active = false; clearInterval(interval); clearInterval(refresh); window.removeEventListener('online', connection); window.removeEventListener('offline', connection) }
  }, [])

  async function unlock() {
    setBusy(true); setError('')
    try { await loginCashier(employeeId, pin); setPin(''); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to unlock this terminal.'); setPin('') }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (cache?.employees?.length && cache.session) {
      navigate('/pos/register')
    }
  }, [cache, navigate])

  async function refresh() {
    setBusy(true); setError('')
    try { await refreshTerminal(); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to refresh terminal.'); await load() }
    finally { setBusy(false) }
  }

  function appendDigit(value: string) { if (!busy) setPin(current => current.length < 8 ? `${current}${value}` : current) }
  const employee = cache?.employees.find(row => row.id === cache.session?.employee_id)
  const pinLength = Math.max(4, Math.min(8, pin.length || 4))

  return <main className="cashier-page"><header className="cashier-brand"><Link to="/pos/login"><span aria-hidden="true">D</span> Dineflow</Link></header><section className="cashier-card">
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {busy && <p className="cashier-loading" role="status">Checking terminal access…</p>}
    {ownerStoreMismatch && !busy && <div className="cashier-empty"><span className="cashier-hero-icon" aria-hidden="true">▣</span><h1>This terminal belongs to a different restaurant.</h1><p>Provision this browser for the signed-in restaurant before service staff can use it. The previous terminal data was kept so unresolved checks are not lost.</p><Link className="cta" to="/settings/terminals">Set up this terminal <b aria-hidden="true">→</b></Link></div>}
    {!ownerStoreMismatch && !cache && !busy && <div className="cashier-empty"><span className="cashier-hero-icon" aria-hidden="true">▣</span><h1>Set up this terminal first.</h1><p>This browser needs online manager provisioning before service staff can open the terminal.</p><Link className="cta" to="/settings/terminals">Set up terminal <b aria-hidden="true">→</b></Link></div>}
    {!ownerStoreMismatch && cache && employee && cache.session ? <section className="cashier-success" aria-label="Cashier session"><span className="success-lock" aria-hidden="true">♙</span><h1>Hello, {employee.name}</h1><p className="success-badge">✓ PIN accepted</p><p>You can open the register and start service.</p><div className="success-terminal"><span aria-hidden="true">▣</span><div><div><strong>{cache.device.name}</strong><span className="terminal-state active">Active</span></div><small>Receipt prefix: {cache.device.receipt_prefix}</small></div></div><Link className="cta cashier-open-register" to="/pos/register">Open register</Link><button className="secondary-cta cashier-lock" type="button" disabled={busy} onClick={() => { setBusy(true); void lockTerminal().then(load).catch(reason => setError(String(reason))).finally(() => setBusy(false)) }}>Lock terminal</button>{employee.role === 'manager' && <p className="terminal-help">{managerApproval ? 'Manager approval access is current.' : 'Manager approval requires online validation after 72 hours.'}</p>}</section> : !ownerStoreMismatch && cache && <section className="cashier-unlock"><div className="cashier-heading"><span className="cashier-terminal-icon" aria-hidden="true">▣</span><div><div className="cashier-title-row"><h1>Unlock {cache.device.name}</h1><span className={`terminal-state ${online ? 'active' : 'offline'}`}>{online ? 'Connected' : 'Offline'}</span></div><p>Receipt prefix: <strong>{cache.device.receipt_prefix}</strong></p></div></div>{cache.employees.length ? <><label className="cashier-label">Select staff member<select value={employeeId} required disabled={busy} onChange={event => { setEmployeeId(event.target.value); setPin('') }}><option value="">Choose your name</option>{cache.employees.map(row => <option key={row.id} value={row.id}>{row.name} · {row.role}</option>)}</select></label><div className="cashier-label"><span>Enter PIN</span><input className="sr-only" aria-label="PIN" type="password" inputMode="numeric" pattern="[0-9]{4,8}" value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 8))} autoComplete="off" /><div className="pin-slots" aria-hidden="true">{Array.from({ length: pinLength }, (_, index) => <span key={index}>{index < pin.length ? '•' : ''}</span>)}</div></div><div className="pin-keypad" aria-label="PIN keypad">{keypad.map(value => <button key={value} type="button" disabled={busy} onClick={() => appendDigit(value)}>{value}</button>)}<button type="button" disabled={busy} aria-label="Delete PIN digit" onClick={() => setPin(current => current.slice(0, -1))}>⌫</button><button type="button" disabled={busy} onClick={() => appendDigit('0')}>0</button><button type="button" disabled={busy} onClick={() => setPin('')}>Clear</button></div><button className="cta cashier-unlock-button" type="button" disabled={busy || !employeeId || pin.length < 4} onClick={() => void unlock()}>Unlock terminal</button></> : <p>No staff are saved on this terminal. Ask a manager to add an active staff member, then refresh terminal access.</p>}<button className="secondary-cta cashier-refresh" type="button" disabled={!online || busy} onClick={() => void refresh()}>Refresh terminal access</button><p className="terminal-help">Offline PIN access is available for up to 7 days after online validation.{offlineReady ? ' Offline sign-in app saved.' : ''}</p></section>}
  </section><footer className="cashier-footer"><Link to="/login">Owner or manager sign in →</Link></footer></main>
}
