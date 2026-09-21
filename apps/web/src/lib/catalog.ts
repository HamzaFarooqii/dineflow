import { posDb, type LocalProduct } from './db'
import { requireSupabase } from './supabase'

const apiUrl = import.meta.env.VITE_API_URL as string | undefined
export function configuredApiUrl(): string {
  if (!apiUrl) throw new Error('Catalog API is not configured. Set VITE_API_URL in apps/web/.env.local.')
  return apiUrl.replace(/\/$/, '')
}
export async function accessToken(): Promise<string> {
  const { data, error } = await requireSupabase().auth.getSession()
  if (error || !data.session?.access_token) throw new Error('Sign in before syncing this store.')
  return data.session.access_token
}
export interface ActiveStoreOption { store_id: string; store_name: string; role: string }

/**
 * Every store this account currently has active membership in, oldest joined first.
 * Two plain queries rather than a PostgREST embedded join (`stores(name)`) — matches the proven
 * pattern ManagerSetup.tsx already uses for the same "list my stores" need, instead of relying on
 * embed syntax that was never actually verified against a real project.
 */
export async function listActiveStores(): Promise<ActiveStoreOption[]> {
  const client = requireSupabase()
  const { data: userResult, error: userError } = await client.auth.getUser()
  if (userError || !userResult.user) throw new Error('Sign in to load your stores.')
  const { data: memberships, error: membershipError } = await client
    .from('store_memberships')
    .select('store_id, role')
    .eq('user_id', userResult.user.id)
    .eq('active', true)
    .order('joined_at')
  if (membershipError) throw membershipError
  if (!memberships?.length) return []
  const { data: stores, error: storeError } = await client
    .from('stores')
    .select('id, name')
    .in('id', memberships.map(membership => membership.store_id))
  if (storeError) throw storeError
  const names = new Map((stores ?? []).map(store => [store.id as string, store.name as string]))
  return memberships.map(membership => ({
    store_id: membership.store_id as string,
    role: membership.role as string,
    store_name: names.get(membership.store_id as string) ?? '',
  }))
}

export async function activeStoreId(): Promise<string> {
  const client = requireSupabase()
  const { data: sessionResult } = await client.auth.getSession()
  const sessionUser = sessionResult.session?.user
  if (!sessionUser) throw new Error('Sign in to load a store.')
  const cacheKey = `active_store:${sessionUser.id}`
  if (!navigator.onLine) {
    const saved = await posDb.sync_metadata.get(cacheKey)
    if (saved?.value) return saved.value
    throw new Error('Connect once to confirm this account’s store membership.')
  }
  const { data: userResult, error: userError } = await client.auth.getUser()
  if (userError || !userResult.user) throw new Error('Sign in to load a store.')
  const { data, error } = await client.from('store_memberships').select('store_id').eq('user_id', userResult.user.id).eq('active', true).order('joined_at')
  if (error) throw error
  const memberships = (data ?? []).map(row => row.store_id as string)
  if (!memberships.length) throw new Error('No active store membership was found.')

  // Respect a previously chosen store instead of re-picking on every call — blindly re-querying
  // "any active membership, limit 1" on every call let a multi-store user's active store silently
  // flip between screens with no stable ordering guarantee. Only fall back to a deterministic
  // default (the membership joined earliest) when there is no saved choice yet, or the saved store
  // is no longer one this account belongs to (e.g. they were removed from it).
  const saved = await posDb.sync_metadata.get(cacheKey)
  const storeId = saved?.value && memberships.includes(saved.value) ? saved.value : memberships[0]
  await posDb.sync_metadata.put({ key: cacheKey, value: storeId })
  return storeId
}

/** Persists the user's chosen store so activeStoreId() stops re-picking on the next call. */
export async function setActiveStoreId(storeId: string): Promise<void> {
  const client = requireSupabase()
  const { data: sessionResult } = await client.auth.getSession()
  const sessionUser = sessionResult.session?.user
  if (!sessionUser) throw new Error('Sign in to switch stores.')
  const options = await listActiveStores()
  if (!options.some(option => option.store_id === storeId)) throw new Error('You do not have active access to that store.')
  await posDb.sync_metadata.put({ key: `active_store:${sessionUser.id}`, value: storeId })
}

type Snapshot = {
  store: { id: string; name: string; timezone: string; currency: string }
  catalog_version: number
  checkpoint: string
  categories: { id: string; store_id: string; name: string; active: boolean }[]
  tax_rates: { id: string; store_id: string; name: string; rate_bps: number; active: boolean }[]
  products: (Omit<LocalProduct, 'unit_price_cents' | 'revision'> & { unit_price_cents: string; revision: string })[]
  stock: { product_id: string; current_stock: number; updated_at: string }[]
}

export async function loadCatalog(storeId: string, terminal = false): Promise<'updated' | 'cached'> {
  if (!navigator.onLine) return 'cached'
  const response = await fetch(`${configuredApiUrl()}${terminal ? '/pos/catalog' : '/catalog'}/snapshot?store_id=${encodeURIComponent(storeId)}`, {
    credentials: terminal ? 'include' : 'same-origin',
    headers: terminal ? undefined : { Authorization: `Bearer ${await accessToken()}` },
  })
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { message?: string } | null
    throw new Error(`${failure?.message ?? 'Catalog could not be loaded.'} (${response.status})`)
  }
  const snapshot = await response.json() as Snapshot
  if (snapshot.store?.id !== storeId) throw new Error('Catalog response belongs to another store.')
  if (!/^\d+$/.test(snapshot.checkpoint)) throw new Error('Catalog checkpoint is invalid.')
  const products = snapshot.products.map(product => {
    const price = Number(product.unit_price_cents)
    const revision = Number(product.revision)
    if (!Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000 || !Number.isSafeInteger(revision)) {
      throw new Error('Catalog contains an invalid price or revision.')
    }
    return { ...product, unit_price_cents: price, revision }
  })
  await posDb.transaction('rw', [posDb.store_config, posDb.categories, posDb.tax_rates,
    posDb.products, posDb.server_stock, posDb.stock_adjustments, posDb.outbox], async () => {
      const unresolved = await posDb.outbox.where('store_id').equals(storeId).toArray()
      if (unresolved.some(entry => entry.status !== 'synced' && entry.failure_kind !== 'validation')) {
        throw new Error('Pending sync outcomes must be resolved before refreshing stock.')
      }
      await posDb.store_config.put({ id: storeId, store_id: storeId, name: snapshot.store.name,
        timezone: snapshot.store.timezone, currency: snapshot.store.currency, catalog_version: snapshot.catalog_version })
      await posDb.categories.where('store_id').equals(storeId).delete()
      await posDb.tax_rates.where('store_id').equals(storeId).delete()
      const oldProducts = await posDb.products.where('store_id').equals(storeId).primaryKeys()
      await posDb.products.where('store_id').equals(storeId).delete()
      await posDb.server_stock.bulkDelete(oldProducts)
      await posDb.categories.bulkPut(snapshot.categories.map(category => ({ ...category, parent_id: null })))
      await posDb.tax_rates.bulkPut(snapshot.tax_rates)
      await posDb.products.bulkPut(products)
      await posDb.server_stock.bulkPut(snapshot.stock)
      const adjustments = await posDb.stock_adjustments.toArray()
      for (const adjustment of adjustments) {
        if (adjustment.accepted_checkpoint && BigInt(adjustment.accepted_checkpoint) <= BigInt(snapshot.checkpoint)) {
          await posDb.stock_adjustments.delete([adjustment.operation_id, adjustment.product_id])
        }
      }
    })
  return 'updated'
}
