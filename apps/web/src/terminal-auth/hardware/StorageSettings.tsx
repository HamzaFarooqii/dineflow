import { useState } from 'react'
import type { BrowserCapabilities, StorageStatus } from './browserCapabilities'

const persistenceLabels = { granted: 'Granted', 'not-granted': 'Not granted', unsupported: 'Not supported', unavailable: 'Could not check' }
export function formatBytes(value?: number) {
  if (value === undefined) return 'Unavailable'
  if (value < 1024) return `${value} bytes`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

export function StorageSettings({ status, adapter, onChanged }: { status?: StorageStatus; adapter: BrowserCapabilities; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  async function request() {
    setBusy(true); setNotice(''); setError('')
    try {
      const granted = await adapter.requestPersistence()
      setNotice(granted ? 'Persistent storage granted. Keep your recovery procedures in place.' : 'The browser did not grant persistent storage. You can retry after checking browser settings.')
      onChanged()
    } catch { setError('Could not request persistent storage. Check browser permissions or ask your manager to use a supported browser.') }
    finally { setBusy(false) }
  }
  return <section className="admin-panel hardware-panel" aria-labelledby="storage-heading">
    <h2 id="storage-heading">Browser storage</h2>
    <p>Persistent storage reduces browser eviction risk. It does not guarantee recovery or protect against clearing site data, device failure, or storage loss.</p>
    <dl className="hardware-details">
      <div><dt>Persistent storage</dt><dd>{status ? persistenceLabels[status.persistence] : 'Checking…'}</dd></div>
      <div><dt>Estimated usage</dt><dd>{formatBytes(status?.usage)}</dd></div>
      <div><dt>Estimated quota</dt><dd>{formatBytes(status?.quota)}</dd></div>
    </dl>
    {status?.quota !== undefined && status.usage !== undefined && <progress aria-label="Estimated browser storage usage" value={Math.min(status.usage, status.quota)} max={status.quota} />}
    <p className="hardware-help">Estimates cover this entire site in this browser profile, including other app data. Available space can change.</p>
    {status?.estimateUnavailable && <p>Usage or quota estimates are unavailable in this browser.</p>}
    {status?.persistence === 'unsupported' && <p>Use a supported browser over HTTPS or localhost. Keep the terminal connected and ask your manager about backup and recovery before using it offline.</p>}
    <button type="button" className="secondary-cta" disabled={!status?.canRequest || status.persistence === 'granted' || busy} onClick={() => void request()}>{busy ? 'Requesting storage…' : 'Request persistent storage'}</button>
    <p role="status" aria-live="polite">{notice}</p>
    {error && <p role="alert" className="form-notice error">{error}</p>}
  </section>
}
