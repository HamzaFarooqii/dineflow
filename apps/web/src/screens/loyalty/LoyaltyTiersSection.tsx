import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { createLoyaltyTier, fetchLoyaltyTiers, updateLoyaltyTier, type LoyaltyTier } from '../../lib/loyalty'
import { draftFromTier, EMPTY_TIER_DRAFT, parseTierDraft, type TierDraft } from './tier-draft'

export function LoyaltyTiersSection({ storeId }: { storeId: string }) {
  const [tiers, setTiers] = useState<LoyaltyTier[] | null>(null)
  const [draft, setDraft] = useState<TierDraft>(EMPTY_TIER_DRAFT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setError('')
    try { setTiers(await fetchLoyaltyTiers(storeId)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Tiers could not be loaded.') }
  }, [storeId])
  useEffect(() => { void load() }, [load])

  const reset = () => { setDraft(EMPTY_TIER_DRAFT); setEditingId(null) }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage('')
    let input
    try { input = parseTierDraft(draft) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Check the tier details.'); return }
    setBusy(true)
    try {
      if (editingId) {
        const updated = await updateLoyaltyTier(storeId, editingId, input)
        setTiers(rows => rows?.map(row => row.id === updated.id ? updated : row) ?? [updated])
        setMessage('Tier updated.')
      } else {
        const created = await createLoyaltyTier(storeId, input)
        setTiers(rows => [...(rows ?? []), created])
        setMessage('Tier added.')
      }
      reset()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Tier could not be saved.') }
    finally { setBusy(false) }
  }

  const sorted = tiers ? [...tiers].sort((a, b) => a.min_lifetime_points - b.min_lifetime_points || a.name.localeCompare(b.name)) : []
  return <section className="crm-panel loyalty-rules loyalty-tiers" aria-labelledby="loyalty-tiers-title">
    <div className="loyalty-section-heading">
      <div><span className="loyalty-eyebrow">MEMBERSHIP LADDER</span><h2 id="loyalty-tiers-title">Loyalty tiers</h2></div>
      {tiers && <StatusBadge tone="info">{tiers.length} {tiers.length === 1 ? 'tier' : 'tiers'}</StatusBadge>}
    </div>
    <p>Reward returning guests with a points multiplier as their lifetime points grow.</p>
    {!tiers && !error && <p role="status">Loading tiers…</p>}
    {tiers && !tiers.length && <EmptyState title="No loyalty tiers" description="Create a starting tier or add Gold at 2,000 lifetime points with a 1.5× multiplier." />}
    {tiers && Boolean(tiers.length) && <ol className="loyalty-rules-list loyalty-tier-list">
      {sorted.map((tier, index) => <li key={tier.id}>
        <span className="loyalty-tier-rank">{String(index + 1).padStart(2, '0')}</span>
        <span><strong>{tier.name}</strong><small>From {tier.min_lifetime_points.toLocaleString('en-US')} lifetime points</small></span>
        <StatusBadge tone="warning">{(tier.point_multiplier_bps / 10_000).toFixed(2).replace(/\.00$/, '')}× points</StatusBadge>
        <button type="button" className="text-action" disabled={busy} onClick={() => { setEditingId(tier.id); setDraft(draftFromTier(tier)); setError(''); setMessage('') }}>Edit</button>
      </li>)}
    </ol>}
    <form className="loyalty-rule-form" onSubmit={event => void submit(event)}>
      <h3>{editingId ? 'Edit tier' : 'Add a tier'}</h3>
      <div className="loyalty-tier-form-row">
        <label>Tier name<input value={draft.name} maxLength={40} required onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Gold" /></label>
        <label>Lifetime points<input inputMode="numeric" value={draft.threshold} required onChange={event => setDraft({ ...draft, threshold: event.target.value })} placeholder="2000" /></label>
        <label>Points multiplier<input inputMode="decimal" value={draft.multiplier} required onChange={event => setDraft({ ...draft, multiplier: event.target.value })} placeholder="1.50" /><small>Enter 1.50 for 1.5× points.</small></label>
      </div>
      <div className="loyalty-rule-form-actions">
        <button type="submit" className="cta" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save tier' : 'Add tier'}</button>
        {editingId && <button type="button" className="secondary-cta" disabled={busy} onClick={reset}>Cancel</button>}
      </div>
    </form>
    {message && <p className="form-notice" role="status">{message}</p>}
    {error && <p className="form-notice error" role="alert">{error} {tiers === null && <button type="button" className="text-action" onClick={() => void load()}>Retry</button>}</p>}
  </section>
}
