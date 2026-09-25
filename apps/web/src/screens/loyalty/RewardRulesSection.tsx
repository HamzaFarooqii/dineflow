import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { formatCents } from '../../../../../packages/domain/src/money'
import { EmptyState } from '../../components/EmptyState'
import { StatusBadge } from '../../components/StatusBadge'
import { posDb } from '../../lib/db'
import { createRewardRule, deactivateRewardRule, fetchRewardRules, updateRewardRule, type RewardRule } from '../../lib/loyalty'
import { draftFromRule, EMPTY_REWARD_RULE_DRAFT, parseRewardRuleDraft, type RewardRuleDraft } from './reward-rule-draft'
import './loyalty.css'

// Owner/manager-only reward catalog ("spend N points, get $X off"), shown as a section of the
// management Guests screen rather than its own page. Only rendered on the web path, where
// CustomerScreen has already confirmed an owner/manager membership; the API enforces the same.
export function RewardRulesSection({ storeId }: { storeId: string }) {
  const [rules, setRules] = useState<RewardRule[] | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [draft, setDraft] = useState<RewardRuleDraft>(EMPTY_REWARD_RULE_DRAFT)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    setLoadError('')
    try { setRules(await fetchRewardRules(storeId, false, true)) }
    catch (reason) { setLoadError(reason instanceof Error ? reason.message : 'Rewards could not be loaded.') }
  }, [storeId])

  useEffect(() => {
    void load()
    posDb.store_config.get(storeId).then(config => { if (config?.currency) setCurrency(config.currency) })
      .catch(() => undefined) // Currency only affects formatting; USD stays the fallback.
  }, [storeId, load])

  const replace = (rule: RewardRule) => setRules(previous => previous?.map(row => row.id === rule.id ? rule : row) ?? [rule])
  const resetForm = () => { setDraft(EMPTY_REWARD_RULE_DRAFT); setEditingId(null) }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setMessage('')
    let input
    try { input = parseRewardRuleDraft(draft) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Check the reward details.'); return }
    setBusy(true)
    try {
      if (editingId) { replace(await updateRewardRule(storeId, editingId, input)); setMessage('Reward updated.') }
      else { const created = await createRewardRule(storeId, input); setRules(previous => [...(previous ?? []), created]); setMessage('Reward added.') }
      resetForm()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Reward could not be saved.') }
    finally { setBusy(false) }
  }

  const setActive = async (rule: RewardRule, active: boolean) => {
    if (!active && !window.confirm(`Stop offering "${rule.name}"? Guests' points are not affected.`)) return
    setBusy(true); setError(''); setMessage('')
    try {
      replace(active ? await updateRewardRule(storeId, rule.id, { active: true }) : await deactivateRewardRule(storeId, rule.id))
      setMessage(active ? 'Reward is offered again.' : 'Reward deactivated.')
      if (editingId === rule.id) resetForm()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Reward could not be updated.') }
    finally { setBusy(false) }
  }

  const sorted = rules ? [...rules].sort((a, b) => Number(b.active) - Number(a.active) || a.points_cost - b.points_cost || a.name.localeCompare(b.name)) : []

  return <section className="crm-panel loyalty-rules" aria-labelledby="loyalty-rules-title">
    <h2 id="loyalty-rules-title">Loyalty rewards</h2>
    <p>What guests can redeem points for. Deactivating a reward stops offering it; it never changes anyone's balance.</p>
    {loadError && <><p className="form-notice error" role="alert">{loadError}</p><button type="button" className="text-action" onClick={() => void load()}>Retry</button></>}
    {!rules && !loadError && <p role="status">Loading rewards…</p>}
    {rules && !rules.length && <EmptyState title="No rewards yet" description="Add the first reward below, for example 500 points for a free dessert." />}
    {rules && Boolean(rules.length) && <ul className="loyalty-rules-list">
      {sorted.map(rule => <li key={rule.id} className={rule.active ? '' : 'loyalty-rule-inactive'}>
        <span><strong>{rule.name}</strong><small>{rule.points_cost.toLocaleString('en-US')} pts → {formatCents(rule.discount_cents, currency)} off</small></span>
        <StatusBadge tone={rule.active ? 'success' : 'muted'}>{rule.active ? 'Offered' : 'Inactive'}</StatusBadge>
        <span className="loyalty-rule-actions">
          {rule.active && <button type="button" className="text-action" disabled={busy} onClick={() => { setEditingId(rule.id); setDraft(draftFromRule(rule)); setError(''); setMessage('') }}>Edit</button>}
          <button type="button" className="text-action" disabled={busy} onClick={() => void setActive(rule, !rule.active)}>{rule.active ? 'Deactivate' : 'Reactivate'}</button>
        </span>
      </li>)}
    </ul>}
    <form className="loyalty-rule-form" onSubmit={event => void submit(event)}>
      <h3>{editingId ? 'Edit reward' : 'Add a reward'}</h3>
      <label>Reward name<input value={draft.name} maxLength={60} required onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="Free dessert" /></label>
      <div className="loyalty-rule-form-row">
        <label>Points cost<input inputMode="numeric" value={draft.points} required onChange={event => setDraft({ ...draft, points: event.target.value })} placeholder="500" /></label>
        <label>Discount ({currency})<input inputMode="decimal" value={draft.amount} required onChange={event => setDraft({ ...draft, amount: event.target.value })} placeholder="5.00" /></label>
      </div>
      <div className="loyalty-rule-form-actions">
        <button type="submit" className="cta" disabled={busy}>{busy ? 'Saving…' : editingId ? 'Save reward' : 'Add reward'}</button>
        {editingId && <button type="button" className="secondary-cta" disabled={busy} onClick={resetForm}>Cancel</button>}
      </div>
    </form>
    {message && <p className="form-notice" role="status">{message}</p>}
    {error && <p className="form-notice error" role="alert">{error}</p>}
  </section>
}
