import { useEffect, useRef, useState } from 'react'
import qrcode from 'qrcode-generator'
import { SelectField } from '../../components/SelectField'
import { StatusBadge } from '../../components/StatusBadge'
import { QR_MODE_LABELS, fetchQrTables, orderUrl, revokeQrCode, rotateQrCode, updateQrSettings, type QrMode, type QrTableState } from '../../lib/qr-ordering'

function QrImage({ value, label }: { value: string; label: string }) {
  const svg = (() => { const qr = qrcode(0, 'M'); qr.addData(value); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }) })()
  return <div className="qr-image" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />
}

// Manager-only controls in the Floor table drawer. The raw code exists only in this component's state,
// right after generate/rotate -- the server keeps just its hash, so it cannot be shown again.
export function QrTablePanel({ storeId, tableId, tableLabel }: { storeId: string; tableId: string; tableLabel: string }) {
  const [state, setState] = useState<QrTableState | null>(null)
  const [issued, setIssued] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const alive = useRef(true)
  const latest = useRef(0)

  async function load() {
    const ticket = ++latest.current
    const current = () => alive.current && ticket === latest.current
    try {
      const found = (await fetchQrTables(storeId)).find(table => table.id === tableId) ?? null
      if (current()) { setState(found); setError('') }
    } catch (reason) { if (current()) setError(reason instanceof Error ? reason.message : 'Could not load QR settings.') }
    finally { if (current()) setLoading(false) }
  }
  useEffect(() => {
    alive.current = true
    setIssued(null); setLoading(true); setCopied(false)
    void load()
    return () => { alive.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, tableId])

  async function run(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action(); await load() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'That change did not go through.') }
    finally { setBusy(false) }
  }

  const link = issued ? orderUrl(issued) : ''
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true) } catch { setError('Copy is blocked in this browser. Select the link and copy it manually.') }
  }

  return <section className="qr-panel" aria-label={`QR ordering for table ${tableLabel}`}>
    <h3>Table QR ordering</h3>
    {loading && <p role="status">Loading QR settings…</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {!loading && state && <>
      <p className="qr-panel-state">
        <StatusBadge tone={state.qr_enabled ? 'success' : 'muted'}>{state.qr_enabled ? 'QR active' : 'No active QR'}</StatusBadge>
        {state.qr_rotated_at && <span>Last rotated {new Date(state.qr_rotated_at).toLocaleString()}</span>}
      </p>
      <SelectField label="Guest access" value={state.qr_mode} disabled={busy}
        onChange={event => void run(async () => { await updateQrSettings(storeId, tableId, { mode: event.target.value as QrMode }) })}>
        {(Object.keys(QR_MODE_LABELS) as QrMode[]).map(mode => <option key={mode} value={mode}>{QR_MODE_LABELS[mode]}</option>)}
      </SelectField>
      <label className="qr-panel-check">
        <input type="checkbox" checked={state.qr_require_confirmation} disabled={busy}
          onChange={event => void run(async () => { await updateQrSettings(storeId, tableId, { require_confirmation: event.target.checked }) })} />
        Staff confirm each guest order before it joins the check
      </label>
      <div className="qr-panel-actions">
        <button type="button" className="secondary-cta" disabled={busy} onClick={() => void run(async () => {
          if (state.qr_enabled && !window.confirm(`Rotate the QR for ${tableLabel}? The printed code and every guest session stop working.`)) return
          setIssued((await rotateQrCode(storeId, tableId)).code); setCopied(false)
        })}>{state.qr_enabled ? 'Rotate QR' : 'Generate QR'}</button>
        {state.qr_enabled && <button type="button" className="text-action" disabled={busy} onClick={() => void run(async () => {
          if (!window.confirm(`Turn off QR ordering for ${tableLabel}? Guest sessions end immediately.`)) return
          await revokeQrCode(storeId, tableId); setIssued(null)
        })}>Revoke</button>}
      </div>
      {issued && <div className="qr-panel-issued">
        <QrImage value={link} label={`QR code linking to the ordering page for table ${tableLabel}`} />
        <p className="qr-panel-note">Shown once. Print or save it now; a lost code must be rotated.</p>
        <input className="qr-panel-link" readOnly value={link} aria-label="Ordering link" onFocus={event => event.currentTarget.select()} />
        <button type="button" className="secondary-cta" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
      </div>}
    </>}
    {!loading && !state && !error && <p>This table is not available for QR ordering.</p>}
  </section>
}
