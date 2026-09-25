import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createLocalCustomer, fetchCustomerSummary, searchLocalCustomers, searchServerCustomers, type CustomerSummary } from '../lib/customers'
import { formatCents } from '../../../../packages/domain/src/money'
import type { LocalCustomer } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { requireSupabase } from '../lib/supabase'
import { currentAccess } from '../terminal-auth/cache'
import { Dialog } from '../components/Dialog'
import { PageHeader } from '../components/PageHeader'
import { StatusBadge, type BadgeTone } from '../components/StatusBadge'
import './customer.css'

const CUSTOMER_SYNC_TONE: Record<LocalCustomer['sync_status'], BadgeTone> = { synced: 'success', pending: 'warning', failed: 'danger' }
const CUSTOMER_SYNC_LABEL: Record<LocalCustomer['sync_status'], string> = { synced: 'Saved', pending: 'Pending sync', failed: 'Needs review' }

// Loyalty tier badge (Day 4 task 4, Bisma's half — sequenced after Hamza's loyalty schema
// landed): reads loyalty_accounts/loyalty_tiers directly via Supabase RLS (member-read policies
// already grant this), the same way this screen already reads store_memberships directly, rather
// than through apps/api/src/routes/loyalty.ts, which is Ahmed's Day 4 task and not built yet.
// Only available in manager mode -- a cashier terminal has no Supabase session to query with.
const TIER_TONES: readonly BadgeTone[] = ['info', 'saffron', 'success', 'warning']
async function loadTierBadges(storeId: string, customerIds: string[]): Promise<Map<string, { name: string; tone: BadgeTone }>> {
  const badges = new Map<string, { name: string; tone: BadgeTone }>()
  if (!customerIds.length) return badges
  const client = requireSupabase()
  const [tiersResult, accountsResult] = await Promise.all([
    client.from('loyalty_tiers').select('id,name,min_lifetime_points').eq('store_id', storeId).order('min_lifetime_points', { ascending: true }),
    client.from('loyalty_accounts').select('customer_id,lifetime_points').eq('store_id', storeId).in('customer_id', customerIds),
  ])
  const tiers = tiersResult.data ?? []
  if (!tiers.length) return badges
  for (const account of accountsResult.data ?? []) {
    let match: { name: string } | null = null
    let toneIndex = -1
    tiers.forEach((tier, index) => {
      if (account.lifetime_points >= tier.min_lifetime_points) { match = tier; toneIndex = index }
    })
    if (match) badges.set(account.customer_id, { name: (match as { name: string }).name, tone: TIER_TONES[toneIndex % TIER_TONES.length] })
  }
  return badges
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
  const [tierBadges, setTierBadges] = useState<Map<string, { name: string; tone: BadgeTone }>>(new Map())
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
  // Keyed on the joined, sorted id set (not local/server's array identity, which changes on
  // every keystroke of the phone search) and debounced, so typing a phone number doesn't fire a
  // fresh pair of loyalty queries per character.
  const matchIdKey = [...new Set(matches.map(customer => customer.id))].sort().join(',')
  useEffect(() => {
    let active = true
    if (terminal || !navigator.onLine || !matchIdKey) { setTierBadges(new Map()); return }
    const ids = matchIdKey.split(',')
    const timeout = setTimeout(() => {
      void loadTierBadges(storeId, ids).then(badges => { if (active) setTierBadges(badges) }).catch(() => { if (active) setTierBadges(new Map()) })
    }, 250)
    return () => { active = false; clearTimeout(timeout) }
  }, [storeId, terminal, matchIdKey])
  return <div className="crm-finder">
    <section className="crm-panel" aria-labelledby="crm-search-title"><h2 id="crm-search-title">Find a guest</h2>
      <p>Search by phone number (with country code) or by name. Local matches appear immediately; online lookup adds saved restaurant matches.</p>
      <label>Phone or name<input type="text" autoComplete="off" placeholder="+923001234567 or Ayesha Khan" value={query} onChange={event => { setQuery(event.target.value); setMessage('') }} /></label>
      <button type="button" className="secondary-cta" disabled={!query.trim() || searching || !navigator.onLine} onClick={() => void onlineSearch()}>{searching ? 'Searching…' : 'Search online'}</button>
      {query.trim() && <div className="crm-results" role="region" aria-live="polite" aria-label="Guest matches">
        {matches.length ? <ul>{matches.map(customer => <li key={customer.id}><span><strong>{customer.name}</strong><small>{customer.phone_normalized ? `+${customer.phone_normalized}` : 'No phone'}</small>{customer.failure_reason && <small role="status">{customer.failure_reason}</small>}</span>
          {tierBadges.get(customer.id) && <StatusBadge tone={tierBadges.get(customer.id)!.tone}>{tierBadges.get(customer.id)!.name}</StatusBadge>}
          <StatusBadge tone={CUSTOMER_SYNC_TONE[customer.sync_status]}>{CUSTOMER_SYNC_LABEL[customer.sync_status]}</StatusBadge>
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

function CustomerProfile({ storeId, customer, terminal, onClose }: { storeId: string; customer: LocalCustomer; terminal: boolean; onClose: () => void }) {
  const [summary, setSummary] = useState<CustomerSummary | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void fetchCustomerSummary(storeId, customer.id, terminal)
      .then(result => { if (active) setSummary(result) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load this guest’s history.') })
    return () => { active = false }
  }, [storeId, customer.id, terminal])
  return <Dialog title={customer.name} kicker="GUEST PROFILE" onClose={onClose}>
    {error && <p className="form-notice error" role="alert">{error}</p>}
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
  </Dialog>
}

export function CustomerScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const selectCustomer = usePosStore(state => state.selectCustomer)
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState('')
  const [profileCustomer, setProfileCustomer] = useState<LocalCustomer | null>(null)
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
    {storeId && <CustomerFinder storeId={storeId} terminal={terminal}
      onSelect={terminal ? customer => { selectCustomer(customer); navigate('/pos/register') } : undefined}
      onViewProfile={terminal ? undefined : customer => setProfileCustomer(customer)} />}
    {profileCustomer && <CustomerProfile storeId={storeId} customer={profileCustomer} terminal={terminal} onClose={() => setProfileCustomer(null)} />}
  </section>
}
