import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { createLocalCustomer, searchLocalCustomers, searchServerCustomers } from '../lib/customers'
import type { LocalCustomer } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'
import { requireSupabase } from '../lib/supabase'
import { currentAccess } from '../terminal-auth/cache'
import { LoyaltyBalance } from './loyalty/LoyaltyBalance'
import { RewardRulesSection } from './loyalty/RewardRulesSection'
import './customer.css'

export function CustomerFinder({ storeId, terminal, onSelect }: { storeId: string; terminal: boolean; onSelect?: (customer: LocalCustomer) => void }) {
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
    void searchLocalCustomers(storeId, query).then(rows => { if (active) setLocal(rows) }).catch(reason => { if (active) { setLocal([]); setError(reason instanceof Error ? reason.message : 'Invalid phone search.') } })
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
      <p>Search by international phone number. Local matches appear immediately; online lookup adds saved restaurant matches.</p>
      <label>Phone with country code<input type="tel" inputMode="tel" autoComplete="off" placeholder="+923001234567" value={query} onChange={event => { setQuery(event.target.value); setMessage('') }} /></label>
      <button type="button" className="secondary-cta" disabled={!query.trim() || searching || !navigator.onLine} onClick={() => void onlineSearch()}>{searching ? 'Searching…' : 'Search online'}</button>
      {query.trim() && <div className="crm-results" role="region" aria-live="polite" aria-label="Guest matches">
        {matches.length ? <ul>{matches.map(customer => <li key={customer.id}><span><strong>{customer.name}</strong><small>{customer.phone_normalized ? `+${customer.phone_normalized}` : 'No phone'} · {customer.sync_status === 'synced' ? 'Saved' : customer.sync_status === 'failed' ? 'Needs review' : 'Pending sync'}</small>{customer.failure_reason && <small role="status">{customer.failure_reason}</small>}<LoyaltyBalance storeId={storeId} terminal={terminal} customer={customer} /></span>
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
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    closeButton.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]')]
        if (!focusable.length) return
        const first = focusable[0], last = focusable.at(-1)!
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  return <div className="crm-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialog} className="crm-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-dialog-title">
      <div className="crm-dialog-head"><div><p className="kicker">CURRENT CHECK</p><h2 id="crm-dialog-title">Add guest</h2></div><button ref={closeButton} type="button" className="text-action" onClick={onClose}>Close</button></div>
      <CustomerFinder storeId={storeId} terminal={terminal} onSelect={customer => { selectCustomer(customer); onClose() }} />
    </section></div>
}

export function CustomerScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const selectCustomer = usePosStore(state => state.selectCustomer)
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState('')
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
  return <section className="crm-page"><p className="kicker">{terminal ? 'SERVICE TERMINAL' : 'RESTAURANT MANAGEMENT'}</p><h1>Guests</h1>
    <p>Search or create guests for this restaurant. Duplicate phone numbers remain separate records.</p>
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {!storeId && !error && <p role="status">Checking guest access…</p>}
    {storeId && <CustomerFinder storeId={storeId} terminal={terminal} onSelect={terminal ? customer => { selectCustomer(customer); navigate('/pos/register') } : undefined} />}
    {storeId && !terminal && <RewardRulesSection storeId={storeId} />}
  </section>
}
