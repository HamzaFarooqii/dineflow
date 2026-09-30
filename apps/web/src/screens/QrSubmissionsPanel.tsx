import { useCallback, useEffect, useState } from 'react'
import { formatCents } from '../../../../packages/domain/src/money'
import { confirmQrSubmission, fetchQrSubmissions, rejectQrSubmission, type QrStaffSubmission } from '../lib/qr-ordering'
import { StatusBadge } from '../components/StatusBadge'

const POLL_MS = 10_000

// Guest orders from table QR codes waiting for staff. Confirming appends them to the table's open check;
// nothing here reaches the kitchen -- that still happens only when the check is closed.
export function QrSubmissionsPanel({ storeId, terminal, currency, onChanged }: { storeId: string; terminal: boolean; currency: string; onChanged: () => void }) {
  const [items, setItems] = useState<QrStaffSubmission[]>([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setItems(await fetchQrSubmissions(storeId, terminal)); setError('') }
    catch (reason) {
      // The public feature can be off or the role unauthorized; that is not an error worth alarming staff about.
      setItems([]); setError(reason instanceof Error && /feature|forbidden|permission/i.test(reason.message) ? '' : (reason instanceof Error ? reason.message : 'Could not load guest orders.'))
    }
  }, [storeId, terminal])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [load])

  async function decide(item: QrStaffSubmission, action: 'confirm' | 'reject') {
    setBusyId(item.id); setError('')
    try {
      if (action === 'confirm') await confirmQrSubmission(storeId, item.id, terminal); else await rejectQrSubmission(storeId, item.id, terminal)
      await load(); onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'That did not go through.') }
    finally { setBusyId(null) }
  }

  if (!items.length && !error) return null
  return <section className="qr-submissions" aria-label="Guest QR orders awaiting confirmation">
    <h2>Guest orders to confirm</h2>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    <div className="open-checks-list">{items.map(item => (
      <article key={item.id} className="open-check-card">
        <div className="open-check-card-head"><strong>{item.table_label}</strong><StatusBadge tone="warning">Awaiting staff</StatusBadge></div>
        <ul className="qr-submission-lines">{item.items.map((line, index) => <li key={index}>{line.quantity} × {line.name ?? line.snapshot_name}</li>)}</ul>
        {item.note && <span className="open-check-card-meta">Note: {item.note}</span>}
        <b>{formatCents(item.subtotal_cents + item.tax_cents, currency)}</b>
        <div className="open-check-card-actions">
          <button type="button" className="cta" disabled={busyId === item.id} onClick={() => void decide(item, 'confirm')}>Add to check</button>
          <button type="button" className="text-action" disabled={busyId === item.id} onClick={() => void decide(item, 'reject')}>Decline</button>
        </div>
      </article>
    ))}</div>
  </section>
}
