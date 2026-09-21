import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ManagedDevice } from '../types'
import { DAY } from '../policy'
import { browserCapabilities, type BrowserCapabilities, type ShellStatus, type StorageStatus, type TerminalIdentity } from './browserCapabilities'
import { StorageSettings } from './StorageSettings'
import { checkTerminalService } from './terminalService'
import './hardware.css'

interface Snapshot {
  terminal?: TerminalIdentity
  storage?: StorageStatus
  shell?: ShellStatus
  now: number
  online: boolean
  serviceAvailable?: boolean
  errors: string[]
  identityUnavailable: boolean
}
const dateLabel = (value: number) => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : 'Not available'

export function TerminalHardwareSettings({ storeId, storeName, devices, adapter = browserCapabilities }: {
  storeId: string
  storeName: string
  devices: ManagedDevice[]
  adapter?: BrowserCapabilities
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>()
  const [checking, setChecking] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const inspect = useCallback(async () => {
    const current = ++generation.current
    setChecking(true)
    const online = adapter.online()
    // Connectivity changes appear immediately even if a browser API is slow.
    setSnapshot(previous => previous ? { ...previous, online, now: adapter.now() } : previous)
    const results = await Promise.allSettled([adapter.readIdentity(), adapter.storage(), adapter.shell(), checkTerminalService()])
    if (!mounted.current || current !== generation.current) return
    const [identity, storage, shell, service] = results
    const errors: string[] = []
    if (identity.status === 'rejected') errors.push('Terminal identity could not be read. Keep browser data intact and ask your manager to check storage access.')
    if (storage.status === 'rejected') errors.push('Browser storage status is unavailable. Try checking again.')
    if (shell.status === 'rejected') errors.push('Offline app status could not be checked.')
    if (service.status !== 'fulfilled' || !service.value) errors.push('Terminal service is unavailable. Reconnect and try again.')
    setSnapshot({ terminal: identity.status === 'fulfilled' ? identity.value : undefined, storage: storage.status === 'fulfilled' ? storage.value : undefined, shell: shell.status === 'fulfilled' ? shell.value : { state: 'unavailable' }, now: adapter.now(), online: adapter.online(), serviceAvailable: service.status === 'fulfilled' && service.value, errors, identityUnavailable: identity.status === 'rejected' })
    setChecking(false)
  }, [adapter])
  useEffect(() => {
    mounted.current = true
    void inspect()
    const unsubscribe = adapter.subscribe(() => void inspect())
    return () => { mounted.current = false; ++generation.current; unsubscribe() }
  }, [adapter, inspect, storeId, devices])

  const terminal = snapshot?.terminal?.storeId === storeId ? snapshot.terminal : undefined
  const otherStore = snapshot?.terminal && !terminal
  const device = devices.find(row => row.id === terminal?.id)
  const validated = Date.parse(terminal?.validatedAt ?? '')
  const expiry = validated > 0 ? validated + 7 * DAY : NaN
  const clockInvalid = Boolean(terminal && snapshot && (snapshot.now < terminal.lastSeen || snapshot.now < validated))
  const expired = Boolean(terminal && snapshot && (!Number.isFinite(expiry) || snapshot.now >= expiry))
  const state = !snapshot ? 'Checking terminal…' : snapshot.identityUnavailable ? 'Terminal identity unavailable' : !terminal ? 'Not provisioned for this store' : device?.revoked_at ? 'Revoked — manager setup required' : clockInvalid ? 'Clock changed — online validation required' : expired ? 'Offline authorization expired' : device ? 'Authorized locally' : 'Local identity found — server state unavailable'
  const shellLabels = { ready: 'Ready for offline cashier launch', 'not-ready': 'Not ready for offline launch', unsupported: 'Offline launch is not supported', unavailable: 'Offline app status unavailable' }
  return <div className="terminal-hardware-settings">
    <section className="admin-panel hardware-panel" aria-labelledby="hardware-status-heading">
      <div className="hardware-title"><div><p className="kicker">THIS BROWSER</p><h2 id="hardware-status-heading">Terminal hardware & storage</h2></div><button className="secondary-cta" type="button" disabled={checking} onClick={() => void inspect()}>{checking ? 'Checking…' : 'Check device status'}</button></div>
      <div role="status" aria-live="polite" aria-atomic="true" className="hardware-status">
        <span className={`terminal-state ${terminal && !expired && !clockInvalid && !device?.revoked_at ? 'active' : 'muted'}`}>{state}</span>
        <span className={`terminal-state ${snapshot?.online ? 'active' : 'offline'}`}>{snapshot ? snapshot.online ? 'Browser online' : 'Browser offline' : 'Checking connection…'}</span>
        <span className={`terminal-state ${snapshot?.serviceAvailable ? 'active' : 'muted'}`}>{snapshot ? snapshot.serviceAvailable ? 'Terminal service available' : 'Terminal service unavailable' : 'Checking terminal service…'}</span>
        <span>{snapshot?.shell ? shellLabels[snapshot.shell.state] : 'Checking offline app…'}</span>
      </div>
      <p className="hardware-help">Device status checks this browser, local terminal identity, and the terminal service. It does not confirm that sales have synchronized.</p>
      {snapshot?.errors.map(error => <p key={error} role="alert" className="form-notice error">{error}</p>)}
      {terminal ? <dl className="hardware-details identity-details">
        <div><dt>Terminal name</dt><dd>{terminal.name}</dd></div>
        <div><dt>Device ID</dt><dd>{terminal.id}</dd></div>
        <div><dt>Store</dt><dd>{storeName}</dd></div>
        <div><dt>Store ID</dt><dd>{terminal.storeId}</dd></div>
        <div><dt>Receipt prefix</dt><dd>{terminal.receiptPrefix}</dd></div>
        <div><dt>Last authorization validation</dt><dd>{dateLabel(validated)}</dd></div>
        <div><dt>Offline authorization expiry</dt><dd>{dateLabel(expiry)}</dd></div>
        <div><dt>Last known cashier</dt><dd>{terminal.cashierName ?? 'Terminal locked'}</dd></div>
      </dl> : snapshot && !snapshot.identityUnavailable && <p>{otherStore ? 'This browser is provisioned for a different store. Select that store to inspect its terminal identity.' : 'This browser has no terminal identity for this store. Use “Set up this browser” below while online.'}</p>}
      <div className="hardware-actions"><Link className="secondary-cta" to="/settings/employees">Manage cashier employees</Link><Link className="secondary-cta" to="/pos/login">Open cashier sign in</Link><a className="text-button" href="#terminal-browser-setup">Go to terminal provisioning</a></div>
    </section>
    <div className="hardware-grid"><StorageSettings status={snapshot?.storage} adapter={adapter} onChanged={() => void inspect()} />
      <section className="admin-panel hardware-panel" aria-labelledby="hardware-recovery-heading">
        <h2 id="hardware-recovery-heading">Recovery guidance</h2>
        <ul className="hardware-recovery">
          <li><strong>Offline app unavailable:</strong> connect and open cashier sign in to let the production app save its offline shell. Return here and check status. Development mode does not prepare offline launch. Keep working online until the shell is ready.</li>
          <li><strong>Authorization expired or clock changed:</strong> correct the device clock, reconnect, open cashier sign in and use Refresh terminal access. If the refresh credential has expired or the device is revoked, an owner or manager must provision it again.</li>
          <li><strong>Storage unsupported, denied or full:</strong> use a supported browser and ask your manager about recovery and backups. Do not clear site data to troubleshoot. Persistent storage is not a backup.</li>
          <li><strong>Before reprovisioning:</strong> preserve existing browser data and resolve or back up any unsynced sales through the approved recovery process. Reprovisioning creates a new device identity and receipt prefix; it does not restore unsynced sales. Storage loss can permanently destroy them.</li>
        </ul>
      </section>
    </div>
  </div>
}
