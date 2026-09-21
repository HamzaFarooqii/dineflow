import { useCallback, useEffect, useState } from 'react'
import { activeStoreId, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { usePosStore } from '../lib/pos-store'

export function ConnectionAndSync() {
  const catalogStatus = usePosStore(state => state.catalogStatus)
  const storeId = usePosStore(state => state.storeId)
  const setStoreContext = usePosStore(state => state.setStoreContext)
  const [resolvedStoreId, setResolvedStoreId] = useState(storeId)
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [offline, setOffline] = useState(!navigator.onLine)
  const [unresolved, setUnresolved] = useState<number | null>(null)
  const [eligible, setEligible] = useState(0)
  const [busy, setBusy] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const effectiveStoreId = storeId || resolvedStoreId

  const update = useCallback(async () => {
    setOffline(!navigator.onLine)
    try {
      const entries = effectiveStoreId ? await posDb.outbox.where('store_id').equals(effectiveStoreId).toArray() : []
      const unresolvedEntries = entries.filter(entry => entry.status !== 'synced')
      setUnresolved(unresolvedEntries.length)
      setEligible(unresolvedEntries.filter(entry => entry.status === 'pending' || entry.failure_kind === 'connectivity').length)
    } catch { setUnresolved(null); setEligible(0) }
    if (!navigator.onLine) { setApiReachable(false); return }
    try {
      const response = await fetch(`${configuredApiUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
      setApiReachable(response.ok)
    } catch { setApiReachable(false) }
  }, [effectiveStoreId])

  useEffect(() => {
    if (!storeId) void activeStoreId().then(async id => {
      setResolvedStoreId(id)
      const config = await posDb.store_config.get(id)
      setStoreContext(id, config?.name ?? '')
    }).catch(() => undefined)
  }, [setStoreContext, storeId])

  useEffect(() => {
    void update()
    const timer = window.setInterval(() => void update(), 15_000)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.clearInterval(timer); window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [update])

  const sync = async () => {
    if (!effectiveStoreId) return
    setBusy(true)
    setSyncMessage('')
    try {
      const pushed = await pushPendingOrders(effectiveStoreId)
      setSyncMessage(pushed ? `${pushed} order${pushed === 1 ? '' : 's'} synchronized.` : 'No queued orders were ready to sync.')
    } catch (reason) { setSyncMessage(reason instanceof Error ? reason.message : 'Sync could not reach the API. Queued orders were preserved.') }
    finally { setBusy(false); await update() }
  }
  const label = offline ? 'Browser offline' : apiReachable === null ? 'Checking API…' :
    !apiReachable ? 'API unreachable' : catalogStatus === 'unavailable' ? 'Catalog unavailable' : 'API reachable'
  const detail = unresolved === null ? label : `${label}${unresolved ? ` · ${unresolved} unresolved` : ''}`
  return <><div className={`connection ${offline || apiReachable === false || catalogStatus === 'unavailable' ? 'connection-error' : ''}`}
    role="status" title={syncMessage || detail}>{busy ? 'Synchronizing…' : syncMessage || detail}</div>
    <button className="sync" type="button" aria-label={busy ? 'Syncing orders' : `Sync pending orders${eligible ? `, ${eligible} eligible` : ''}`}
      title={eligible ? `Sync ${eligible} eligible order${eligible === 1 ? '' : 's'}` : 'No orders ready to sync'}
      onClick={() => void sync()} disabled={busy || !apiReachable || !effectiveStoreId || eligible === 0}>↻</button></>
}
