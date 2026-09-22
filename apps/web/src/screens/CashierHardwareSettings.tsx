/**
 * CashierHardwareSettings — /pos/settings
 * Cashier-facing terminal hardware & storage checks (FEAT-SET-01), reusing the
 * same components mounted under owner/manager ManagerSetup.tsx (browser
 * storage). No owner-only actions: no device list, no "manage employees" or
 * "terminal provisioning" links.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { liveQuery } from 'dexie'
import { DAY } from '../terminal-auth/policy'
import { browserCapabilities, type BrowserCapabilities, type ShellStatus, type StorageStatus, type TerminalIdentity } from '../terminal-auth/hardware/browserCapabilities'
import { StorageSettings } from '../terminal-auth/hardware/StorageSettings'
import { checkTerminalService } from '../terminal-auth/hardware/terminalService'
import { posDb } from '../lib/db'
import '../terminal-auth/hardware/hardware.css'

interface Snapshot {
  terminal?: TerminalIdentity
  storage?: StorageStatus
  shell?: ShellStatus
  now: number
  online: boolean
  serviceAvailable?: boolean
  errors: string[]
}
const dateLabel = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : 'Not available'
const shellLabels = { ready: 'Ready for offline cashier launch', 'not-ready': 'Not ready for offline launch', unsupported: 'Offline launch is not supported', unavailable: 'Offline app status unavailable' }

export function CashierHardwareSettings({ adapter = browserCapabilities }: { adapter?: BrowserCapabilities }) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [checking, setChecking] = useState(false)
  const [storeName, setStoreName] = useState('')
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const mounted = useRef(false)
  const generation = useRef(0)

  const inspect = useCallback(async () => {
    const current = ++generation.current
    setChecking(true)
    const online = adapter.online()
    setSnapshot(previous => previous ? { ...previous, online, now: adapter.now() } : previous)
    const results = await Promise.allSettled([adapter.readIdentity(), adapter.storage(), adapter.shell(), checkTerminalService()])
    if (!mounted.current || current !== generation.current) return
    const [identity, storage, shell, service] = results
    const errors: string[] = []
    if (identity.status === 'rejected') errors.push('Terminal identity could not be read. Keep browser data intact and ask your manager to check storage access.')
    if (storage.status === 'rejected') errors.push('Browser storage status is unavailable. Try checking again.')
    if (shell.status === 'rejected') errors.push('Offline app status could not be checked.')
    if (service.status !== 'fulfilled' || !service.value) errors.push('Terminal service is unavailable. Reconnect and try again.')
    const terminal = identity.status === 'fulfilled' ? identity.value : undefined
    setSnapshot({ terminal, storage: storage.status === 'fulfilled' ? storage.value : undefined, shell: shell.status === 'fulfilled' ? shell.value : { state: 'unavailable' }, now: adapter.now(), online: adapter.online(), serviceAvailable: service.status === 'fulfilled' && service.value, errors })
    if (terminal) { const config = await posDb.store_config.get(terminal.storeId); if (mounted.current && config) setStoreName(config.name) }
    setChecking(false)
  }, [adapter])

  useEffect(() => {
    mounted.current = true
    void inspect()
    const unsubscribe = adapter.subscribe(() => void inspect())
    return () => { mounted.current = false; ++generation.current; unsubscribe() }
  }, [adapter, inspect])

  const terminal = snapshot?.terminal
  // FEAT-SET-01: last successful sync, live so it updates without a manual "Check device
  // status" click once the sync engine (running elsewhere in the app) completes a push.
  useEffect(() => {
    if (!terminal?.storeId) { setLastSyncedAt(null); return }
    const subscription = liveQuery(() => posDb.sync_metadata.get(`last_synced_at:${terminal.storeId}`))
      .subscribe({ next: row => setLastSyncedAt(row?.value ?? null) })
    return () => subscription.unsubscribe()
  }, [terminal?.storeId])
  const validated = Date.parse(terminal?.validatedAt ?? '')
  const expiry = validated > 0 ? validated + 7 * DAY : NaN
  const clockInvalid = Boolean(terminal && snapshot && (snapshot.now < terminal.lastSeen || snapshot.now < validated))
  const expired = Boolean(terminal && snapshot && (!Number.isFinite(expiry) || snapshot.now >= expiry))
  const state = !snapshot ? 'Checking terminal…' : !terminal ? 'Terminal identity unavailable' : clockInvalid ? 'Clock changed — online validation required' : expired ? 'Offline authorization expired' : 'Authorized locally'

  return <div className="terminal-hardware-settings">
    <p className="kicker">THIS TERMINAL / SETTINGS</p>
    <section className="admin-panel hardware-panel" aria-labelledby="hardware-status-heading">
      <div className="hardware-title"><div><h2 id="hardware-status-heading">Terminal hardware & storage</h2></div>
        <button className="secondary-cta" type="button" disabled={checking} onClick={() => void inspect()}>{checking ? 'Checking…' : 'Check device status'}</button></div>
      <div role="status" aria-live="polite" aria-atomic="true" className="hardware-status">
        <span className={`terminal-state ${terminal && !expired && !clockInvalid ? 'active' : 'muted'}`}>{state}</span>
        <span className={`terminal-state ${snapshot?.online ? 'active' : 'offline'}`}>{snapshot ? snapshot.online ? 'Browser online' : 'Browser offline' : 'Checking connection…'}</span>
        <span className={`terminal-state ${snapshot?.serviceAvailable ? 'active' : 'muted'}`}>{snapshot ? snapshot.serviceAvailable ? 'Terminal service available' : 'Terminal service unavailable' : 'Checking terminal service…'}</span>
        <span>{snapshot?.shell ? shellLabels[snapshot.shell.state] : 'Checking offline app…'}</span>
      </div>
      <p className="hardware-help">Device status checks this browser, local terminal identity, and the terminal service. It does not confirm that closed checks have synchronized.</p>
      {snapshot?.errors.map(error => <p key={error} role="alert" className="form-notice error">{error}</p>)}
      {terminal && <dl className="hardware-details identity-details">
        <div><dt>Terminal name</dt><dd>{terminal.name}</dd></div>
        <div><dt>Restaurant</dt><dd>{storeName || terminal.storeId}</dd></div>
        <div><dt>Receipt prefix</dt><dd>{terminal.receiptPrefix}</dd></div>
        <div><dt>Last successful sync</dt><dd>{lastSyncedAt ? dateLabel(Date.parse(lastSyncedAt)) : 'Not yet synced on this device'}</dd></div>
        <div><dt>Last authorization validation</dt><dd>{dateLabel(validated)}</dd></div>
        <div><dt>Offline authorization expiry</dt><dd>{dateLabel(expiry)}</dd></div>
        <div><dt>Signed in as</dt><dd>{terminal.cashierName ?? 'Terminal locked'}</dd></div>
      </dl>}
      {(expired || clockInvalid) && <p role="alert" className="form-notice error">{expired ? 'Offline authorization has expired. Connect and open cashier sign in to refresh terminal access.' : 'This device’s clock moved backwards. Connect and refresh terminal access.'}</p>}
    </section>
    <section className="admin-panel hardware-panel" aria-labelledby="sync-center-heading">
      <div className="hardware-title"><div><h2 id="sync-center-heading">Sync center</h2><p>Review queued and rejected checks for this terminal.</p></div>
        <Link className="secondary-cta" to="/pos/sync">Open sync center</Link></div>
    </section>
    <div className="hardware-grid">
      <StorageSettings status={snapshot?.storage} adapter={adapter} onChanged={() => void inspect()} />
      <section className="admin-panel hardware-panel" aria-labelledby="hardware-recovery-heading">
        <h2 id="hardware-recovery-heading">Recovery guidance</h2>
        <ul className="hardware-recovery">
          <li><strong>Offline app unavailable:</strong> connect and reopen cashier sign in to let the production app save its offline shell. Development mode does not prepare offline launch. Keep working online until the shell is ready.</li>
          <li><strong>Authorization expired or clock changed:</strong> connect and use Refresh terminal access at sign in. If access still fails, ask a manager to provision this device again.</li>
          <li><strong>Storage unsupported, denied or full:</strong> use a supported browser and tell your manager. Do not clear site data to troubleshoot — persistent storage is not a backup for unsynced checks.</li>
        </ul>
      </section>
    </div>
  </div>
}
