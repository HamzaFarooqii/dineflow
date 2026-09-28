import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createLocalCustomer, fetchCustomerSummary, searchLocalCustomers, searchServerCustomers, type CustomerSummary } from '../lib/customers'
import { addPreference, fetchCustomerProfile, fetchPreferences, mergeCustomers, removePreference, setCustomerActive, updateCustomerProfile,
  type PreferenceEvent, type PreferenceState } from '../lib/customer-profile'
import { formatCents } from '../../../../packages/domain/src/money'
import type { LocalCustomer } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { requireSupabase } from '../lib/supabase'
import { currentAccess } from '../terminal-auth/cache'
import { LoyaltyBalance } from './loyalty/LoyaltyBalance'
import { RewardRulesSection } from './loyalty/RewardRulesSection'
import { LoyaltyTiersSection } from './loyalty/LoyaltyTiersSection'
import { Dialog } from '../components/Dialog'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge, type BadgeTone } from '../components/StatusBadge'
import './customer.css'

const CUSTOMER_SYNC_TONE: Record<LocalCustomer['sync_status'], BadgeTone> = { synced: 'success', pending: 'warning', failed: 'danger' }
const CUSTOMER_SYNC_LABEL: Record<LocalCustomer['sync_status'], string> = { synced: 'Saved', pending: 'Pending sync', failed: 'Needs review' }

// Compact favorites/preferences summary shown wherever the guest picker already shows a guest
// row (search results, guest directory) -- same lazy-per-row fetch pattern as LoyaltyBalance,
// read-only even for the owner/manager surface (editing happens in the guest profile dialog).
function GuestPreferenceSummary({ storeId, terminal, customer }: { storeId: string; terminal: boolean; customer: LocalCustomer }) {
  const synced = customer.sync_status === 'synced'
  const [state, setState] = useState<PreferenceState | null>(null)
  useEffect(() => {
    if (!synced) return
    let active = true
    fetchPreferences(storeId, customer.id, terminal).then(result => { if (active) setState(result) }).catch(() => { if (active) setState(null) })
    return () => { active = false }
  }, [storeId, customer.id, terminal, synced])
  if (!synced || !state || !state.current.length) return null
  const favorites = state.current.filter(entry => entry.kind === 'favorite')
  const preferences = state.current.filter(entry => entry.kind === 'preference')
  return <small className="crm-preference-summary" aria-label={`${customer.name} favorites and preferences`}>
    {favorites.length > 0 && <span>★ {favorites.map(entry => entry.label).join(', ')}</span>}
    {preferences.length > 0 && <span>{preferences.map(entry => entry.label).join(', ')}</span>}
  </small>
}

export function CustomerFinder({ storeId, terminal, onSelect, onViewProfile }: { storeId: string; terminal: boolean; onSelect?: (customer: LocalCustomer) => void; onViewProfile?: (customer: LocalCustomer) => void }) {
  const [query, setQuery] = useState('')
  const [local, setLocal] = useState<LocalCustomer[]>([])
  const [server, setServer] = useState<LocalCustomer[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const normalizedName = name.trim().replace(/\s+/g, ' ')
  const nameError = normalizedName.length > 30 ? 'Guest name must be 30 characters or fewer.' : ''
  useEffect(() => {
    let active = true
    setServer([]); setNextCursor(null); setError('')
    void searchLocalCustomers(storeId, query).then(rows => { if (active) setLocal(rows) }).catch(reason => { if (active) { setLocal([]); setError(reason instanceof Error ? reason.message : 'Invalid search.') } })
    return () => { active = false }
  }, [storeId, query])
  const onlineSearch = async (cursor: string | null = null) => {
    setSearching(true); setError('')
    try {
      const result = await searchServerCustomers(storeId, query, terminal, cursor)
      const mapped: LocalCustomer[] = result.customers.map(row => ({ ...row, client_generated_at: '', creating_operation_id: null, sync_status: 'synced', failure_reason: null }))
      setServer(previous => cursor ? [...previous, ...mapped] : mapped)
      setNextCursor(result.next_cursor)
      setLocal(await searchLocalCustomers(storeId, query))
      setMessage(result.customers.length ? 'Online matches loaded.' : 'No online matches found.')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Guest lookup is unavailable.') }
    finally { setSearching(false) }
  }
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const customer = await createLocalCustomer(storeId, name, phone)
      setName(''); setPhone('')
      setMessage('Guest saved on this browser. It will sync when connected.')
      if (onSelect) onSelect(customer)
      setLocal(await searchLocalCustomers(storeId, query))
      void pushPendingOrders(storeId, terminal).catch(() => undefined)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Guest could not be saved.') }
    finally { setBusy(false) }
  }
  const matches = [...local, ...server.filter(remote => !local.some(customer => customer.id === remote.id))]
  return <div className="crm-finder">
    <section className="crm-panel" aria-labelledby="crm-search-title"><h2 id="crm-search-title">Find a guest</h2>
      <p>Search by phone number (with country code) or by name. Local matches appear immediately; online lookup adds saved restaurant matches.</p>
      <label>Phone or name<input type="text" autoComplete="off" placeholder="+923001234567 or Ayesha Khan" value={query} onChange={event => { setQuery(event.target.value); setMessage('') }} /></label>
      <button type="button" className="secondary-cta" disabled={!query.trim() || searching || !navigator.onLine} onClick={() => void onlineSearch()}>{searching ? 'Searching…' : 'Search online'}</button>
      {query.trim() && <div className="crm-results" role="region" aria-live="polite" aria-label="Guest matches">
        {matches.length ? <ul>{matches.map(customer => <li key={customer.id}><span><strong>{customer.name}</strong><small>{customer.phone_normalized ? `+${customer.phone_normalized}` : 'No phone'}</small>{customer.failure_reason && <small role="status">{customer.failure_reason}</small>}</span>
          <StatusBadge tone={CUSTOMER_SYNC_TONE[customer.sync_status]}>{CUSTOMER_SYNC_LABEL[customer.sync_status]}</StatusBadge>
          <LoyaltyBalance storeId={storeId} terminal={terminal} customer={customer} />
          <GuestPreferenceSummary storeId={storeId} terminal={terminal} customer={customer} />
          {onViewProfile && <button type="button" className="text-action" onClick={() => onViewProfile(customer)}>View profile</button>}
          {onSelect && <button type="button" className="secondary-cta" onClick={() => onSelect(customer)}>Select {customer.name}</button>}</li>)}</ul> : <p className="crm-empty">No local matches. Search online or create a new guest.</p>}
      </div>}
      {nextCursor && <button type="button" className="text-action" disabled={searching} onClick={() => void onlineSearch(nextCursor)}>Load more matches</button>}
    </section>
    <section className="crm-panel" aria-labelledby="crm-create-title"><h2 id="crm-create-title">Create guest</h2>
      <p>A name is required. Phone is optional; when supplied, include an explicit country code.</p>
      <form onSubmit={event => void create(event)}><label>Guest name<input value={name} onChange={event => setName(event.target.value)} required aria-invalid={Boolean(nameError)} aria-describedby="customer-name-limit" autoComplete="name" /></label>
        <p id="customer-name-limit" className={nameError ? 'form-notice error' : 'customer-name-count'} role={nameError ? 'alert' : undefined}>{nameError || `${normalizedName.length} / 30 characters`}</p>
        <label>Phone with country code (optional)<input type="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+923001234567" autoComplete="tel" /></label>
        <button type="submit" className="cta" disabled={busy || !normalizedName || Boolean(nameError)}>{busy ? 'Saving…' : 'Save guest'}</button></form>
      {message && <p className="form-notice" role="status">{message}</p>}
      {error && <p className="form-notice error" role="alert">{error}</p>}
    </section>
  </div>
}

export function CustomerSelector({ storeId, terminal, onClose }: { storeId: string; terminal: boolean; onClose: () => void }) {
  const selectCustomer = usePosStore(state => state.selectCustomer)
  return <Dialog title="Add guest" kicker="CURRENT CHECK" onClose={onClose} className="wide">
    <CustomerFinder storeId={storeId} terminal={terminal} onSelect={customer => { selectCustomer(customer); onClose() }} />
  </Dialog>
}

// Favorites/preferences editor with full author-attributed history. Every add/remove is its own
// immutable event (apps/api/src/routes/customer-profile.ts's customer_preference_events), so this
// never edits a row in place -- it only ever appends a new one and re-fetches.
function PreferenceEditor({ storeId, customerId, disabled }: { storeId: string; customerId: string; disabled: boolean }) {
  const [state, setState] = useState<PreferenceState | null>(null)
  const [kind, setKind] = useState<'favorite' | 'preference'>('favorite')
  const [label, setLabel] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showHistory, setShowHistory] = useState(false)

  const reload = () => { void fetchPreferences(storeId, customerId, false).then(setState).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load favorites and preferences.')) }
  useEffect(reload, [storeId, customerId])

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await addPreference(storeId, customerId, { kind, label: label.trim(), note: note.trim() || undefined }); setLabel(''); setNote(''); reload() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this entry.') }
    finally { setBusy(false) }
  }
  const remove = async (entry: PreferenceEvent) => {
    setBusy(true); setError('')
    try { await removePreference(storeId, customerId, { kind: entry.kind, label: entry.label }); reload() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove this entry.') }
    finally { setBusy(false) }
  }

  return <section className="crm-preferences" aria-labelledby="crm-preferences-title">
    <h3 id="crm-preferences-title">Favorites &amp; preferences</h3>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {state && state.current.length > 0 && <ul className="crm-preference-list">
      {state.current.map(entry => <li key={entry.id}>
        <span><strong>{entry.kind === 'favorite' ? '★' : '—'} {entry.label}</strong>{entry.note && <small>{entry.note}</small>}</span>
        {!disabled && <button type="button" className="text-action" disabled={busy} onClick={() => void remove(entry)}>Remove</button>}
      </li>)}
    </ul>}
    {state && !state.current.length && <p className="crm-empty">No favorites or preferences recorded yet.</p>}
    {!disabled && <form onSubmit={event => void add(event)} className="crm-preference-form">
      <label>Type
        <select value={kind} onChange={event => setKind(event.target.value === 'preference' ? 'preference' : 'favorite')}>
          <option value="favorite">Favorite</option>
          <option value="preference">Preference (allergy, seating, etc.)</option>
        </select>
      </label>
      <label>Label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={120} required /></label>
      <label>Note (optional)<input value={note} onChange={event => setNote(event.target.value)} maxLength={500} /></label>
      <button type="submit" className="secondary-cta" disabled={busy || !label.trim()}>{busy ? 'Saving…' : 'Add'}</button>
    </form>}
    {state && state.history.length > 0 && <>
      <button type="button" className="text-action" onClick={() => setShowHistory(value => !value)}>{showHistory ? 'Hide history' : 'Show full history'}</button>
      {showHistory && <ul className="crm-preference-history">
        {state.history.map(entry => <li key={entry.id}>
          <span>{entry.action === 'add' ? 'Added' : 'Removed'} <strong>{entry.label}</strong> ({entry.kind})</span>
          <small>{new Date(entry.created_at).toLocaleString()}</small>
        </li>)}
      </ul>}
    </>}
  </section>
}

// Explicit, manager-gated merge: the source guest is always the profile being viewed, and the
// target is chosen by an explicit search -- never inferred from a phone-number match. A reason is
// required, matching the immutable customer_merges audit row this produces server-side.
function MergeDialog({ storeId, source, onClose, onMerged }: { storeId: string; source: LocalCustomer; onClose: () => void; onMerged: () => void }) {
  const [target, setTarget] = useState<LocalCustomer | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    if (!target) return
    setBusy(true); setError('')
    try { await mergeCustomers(storeId, source.id, target.id, reason.trim()); onMerged(); onClose() }
    catch (reason_) { setError(reason_ instanceof Error ? reason_.message : 'Merge failed.') }
    finally { setBusy(false) }
  }
  return <Dialog title={`Merge "${source.name}"`} kicker="MANAGER ACTION" onClose={onClose} className="wide">
    <p>Search for the guest profile to keep. <strong>{source.name}</strong>’s order history and loyalty balance will move to that profile, and this profile will be deactivated. This cannot be undone and is never done automatically by phone number.</p>
    {!target && <CustomerFinder storeId={storeId} terminal={false} onSelect={candidate => { if (candidate.id !== source.id) setTarget(candidate) }} />}
    {target && <div className="crm-merge-confirm">
      <p>Merge <strong>{source.name}</strong> into <strong>{target.name}</strong>.</p>
      <label>Reason (required)<input value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required placeholder="e.g. Confirmed duplicate guest by phone call" /></label>
      {error && <p className="form-notice error" role="alert">{error}</p>}
      <div className="crm-merge-actions">
        <button type="button" className="secondary-cta" disabled={busy} onClick={() => setTarget(null)}>Choose a different guest</button>
        <button type="button" className="cta" disabled={busy || !reason.trim()} onClick={() => void confirm()}>{busy ? 'Merging…' : 'Confirm merge'}</button>
      </div>
    </div>}
  </Dialog>
}

function CustomerProfile({ storeId, customer, terminal, onClose, onChanged }: { storeId: string; customer: LocalCustomer; terminal: boolean; onClose: () => void; onChanged: () => void }) {
  const [summary, setSummary] = useState<CustomerSummary | null>(null)
  const [error, setError] = useState('')
  const [editName, setEditName] = useState(customer.name)
  const [editPhone, setEditPhone] = useState(customer.phone_normalized ? `+${customer.phone_normalized}` : '')
  const [active, setActiveFlag] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  useEffect(() => {
    let active_ = true
    void fetchCustomerSummary(storeId, customer.id, terminal)
      .then(result => { if (active_) setSummary(result) })
      .catch(reason => { if (active_) setError(reason instanceof Error ? reason.message : 'Could not load this guest’s history.') })
    void fetchCustomerProfile(storeId, customer.id)
      .then(record => { if (active_) setActiveFlag(record.active) })
      .catch(() => { if (active_) setActiveFlag(true) })
    return () => { active_ = false }
  }, [storeId, customer.id, terminal])

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true); setError('')
    try {
      await updateCustomerProfile(storeId, customer.id, { name: editName.trim(), phone_normalized: editPhone.trim() || null })
      onChanged()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save changes.') }
    finally { setSaving(false) }
  }
  const toggleActive = async () => {
    if (active === null) return
    setSaving(true); setError('')
    try { const updated = await setCustomerActive(storeId, customer.id, !active); setActiveFlag(updated.active); onChanged() }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update guest status.') }
    finally { setSaving(false) }
  }

  return <Dialog title={customer.name} kicker="GUEST PROFILE" onClose={onClose} className="wide">
    {error && <p className="form-notice error" role="alert">{error}</p>}
    <section className="crm-edit" aria-labelledby="crm-edit-title">
      <h3 id="crm-edit-title">Edit guest</h3>
      <form onSubmit={event => void saveEdit(event)}>
        <label>Guest name<input value={editName} onChange={event => setEditName(event.target.value)} maxLength={30} required /></label>
        <label>Phone with country code<input type="tel" value={editPhone} onChange={event => setEditPhone(event.target.value)} placeholder="+923001234567" /></label>
        <div className="crm-edit-actions">
          <button type="submit" className="secondary-cta" disabled={saving || !editName.trim()}>{saving ? 'Saving…' : 'Save changes'}</button>
          <button type="button" className="secondary-cta" disabled={saving || active === null} onClick={() => void toggleActive()}>{active === null ? 'Checking status…' : active ? 'Deactivate guest' : 'Reactivate guest'}</button>
          <button type="button" className="secondary-cta" disabled={saving} onClick={() => setShowMerge(true)}>Merge into another guest…</button>
        </div>
      </form>
      <p>Duplicate phone numbers remain separate records until a manager explicitly merges these two profiles by name.</p>
    </section>
    {!summary && !error && <p role="status">Loading guest history…</p>}
    {summary && <dl className="crm-profile">
      <div><dt>Lifetime spend</dt><dd>{formatCents(summary.lifetime_spend_cents)}</dd></div>
      <div><dt>Visits</dt><dd>{summary.visit_count}</dd></div>
    </dl>}
    {summary && <>
      <h3>Recent visits</h3>
      {summary.recent_visits.length
        ? <ul className="crm-profile-visits">{summary.recent_visits.map(visit => <li key={visit.order_id}>
            <span>{new Date(visit.visited_at).toLocaleDateString()}</span><b>{formatCents(visit.total_cents)}</b>
          </li>)}</ul>
        : <p className="crm-empty">No completed visits yet.</p>}
    </>}
    <PreferenceEditor storeId={storeId} customerId={customer.id} disabled={active !== true} />
    {showMerge && <MergeDialog storeId={storeId} source={customer} onClose={() => setShowMerge(false)} onMerged={onChanged} />}
  </Dialog>
}

export function CustomerScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const selectCustomer = usePosStore(state => state.selectCustomer)
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState('')
  const [profileCustomer, setProfileCustomer] = useState<LocalCustomer | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        let id: string | undefined
        if (terminal) {
          const access = await currentAccess()
          if (!access?.policy.valid) throw new Error('Unlock this terminal before opening the guest directory.')
          id = access.cache.device.store_id
        } else {
          if (!navigator.onLine) throw new Error('Connect to validate management guest access.')
          const client = requireSupabase()
          const { data: { user }, error: userError } = await client.auth.getUser()
          if (userError || !user) throw new Error('Sign in to manage guests.')
          const { data, error: membershipError } = await client.from('store_memberships').select('store_id,role')
            .eq('user_id', user.id).eq('active', true).in('role', ['owner', 'manager']).limit(1)
          if (membershipError) throw membershipError
          id = data?.[0]?.store_id
        }
        if (!id) throw new Error('Store access is unavailable.')
        if (active) setStoreId(id)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Could not load guest access.') }
    }
    void load(); return () => { active = false }
  }, [terminal])
  return <section className="crm-page">
    <PageHeader
      kicker={terminal ? 'SERVICE TERMINAL' : 'RESTAURANT MANAGEMENT'}
      title="Guests"
      subtitle="Search or create guests for this restaurant. Duplicate phone numbers remain separate records."
    />
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {!storeId && !error && <p role="status">Checking guest access…</p>}
    {storeId && <CustomerFinder key={refreshKey} storeId={storeId} terminal={terminal}
      onSelect={terminal ? customer => { selectCustomer(customer); navigate('/pos/register') } : undefined}
      onViewProfile={terminal ? undefined : customer => setProfileCustomer(customer)} />}
    {profileCustomer && <CustomerProfile storeId={storeId} customer={profileCustomer} terminal={terminal}
      onClose={() => setProfileCustomer(null)} onChanged={() => setRefreshKey(value => value + 1)} />}
    {storeId && !terminal && <div className="loyalty-management-grid">
      <LoyaltyTiersSection storeId={storeId} />
      <RewardRulesSection storeId={storeId} />
    </div>}
  </section>
}
