/**
 * StoreSwitcher — header dropdown showing the account's active store(s). Lives in .app-top
 * rather than the sidebar: .app-sidebar is set to display:none entirely below 700px, and
 * .register-meta (the only other place the store name showed) is also hidden on mobile with no
 * replacement, so a sidebar-only switcher was structurally unreachable on any narrow screen
 * regardless of whether its data logic was correct. .app-top is common to both layouts.
 * Always visible once loaded (even for a single-store account, so the mechanism is discoverable
 * and consistent) — it just has one option to pick from until the account has more. Persists the
 * choice through setActiveStoreId(), which activeStoreId() then respects everywhere else in the
 * app, and reloads so every screen's local Dexie cache and in-memory state re-bootstraps cleanly
 * for the newly selected store.
 */
import { useEffect, useState, type ChangeEvent } from 'react'
import { activeStoreId, listActiveStores, setActiveStoreId, type ActiveStoreOption } from '../lib/catalog'
import { SelectField } from './SelectField'
import { Store } from './icons'

export function StoreSwitcher() {
  const [stores, setStores] = useState<ActiveStoreOption[]>([])
  const [current, setCurrent] = useState('')
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([listActiveStores(), activeStoreId()])
      .then(([options, id]) => {
        if (!active) return
        setStores(options)
        setCurrent(id)
      })
      .catch(reason => {
        // An offline session or a single-store account just won't show a switcher, but log the
        // real reason to the console rather than swallowing it silently — this hid a genuine
        // layout bug (see the block comment above) with zero diagnostic trail.
        console.error('StoreSwitcher: could not load this account\'s stores.', reason)
      })
    return () => {
      active = false
    }
  }, [])

  // Nothing to show only while the initial fetch hasn't resolved yet (or failed, e.g. offline) —
  // once we have at least one store, always render, regardless of how many.
  if (stores.length === 0) return null

  const handleChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value
    if (!next || next === current) return
    setSwitching(true)
    try {
      await setActiveStoreId(next)
      window.location.reload()
    } catch (reason) {
      console.error('StoreSwitcher: could not switch store.', reason)
      setSwitching(false)
    }
  }

  return (
    <span className="store-switcher">
      <Store aria-hidden="true" size={16} className="store-switcher-icon" />
      <SelectField className="store-switcher-select" value={current} onChange={event => void handleChange(event)} disabled={switching} aria-label="Switch store">
        {stores.map(store => (
          <option key={store.store_id} value={store.store_id}>
            {store.store_name || 'Untitled store'}
          </option>
        ))}
      </SelectField>
    </span>
  )
}
