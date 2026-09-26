/**
 * StoreDetails — Owner/Manager settings screen at /settings/store.
 * Lets an owner or manager edit currency, timezone, address and country after the store
 * has already been created (Signup only collects currency/timezone up front). Built on
 * product-catalog.css's MISE back-of-house shell (hero, groups, fields) for visual parity
 * with the rest of the owner/manager back office, rather than the plain generic form styling
 * this screen originally reused from the invite form.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { accessToken, activeStoreId, configuredApiUrl } from '../lib/catalog'
import { posDb } from '../lib/db'
import { CURRENCY_OPTIONS, timezoneOptions } from '../lib/locale-options'
import { X } from '../components/icons'
import './product-catalog.css'

interface StoreRecord {
  id: string
  name: string
  timezone: string
  currency: string
  address: string | null
  country: string | null
  service_charge_bps: number
}

export function StoreDetails() {
  const [storeId, setStoreId] = useState('')
  const [store, setStore] = useState<StoreRecord>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const load = async () => {
    setLoading(true)
    setLoadError('')
    try {
      const id = await activeStoreId()
      setStoreId(id)
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/stores/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = (await response.json()) as StoreRecord & { message?: string }
      if (!response.ok) throw new Error(data.message ?? `Server error (${response.status})`)
      setStore(data)
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load restaurant details.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!store) return
    const form = new FormData(event.currentTarget)
    const currency = String(form.get('currency')).trim().toUpperCase()
    // The server only allows currency changes before any products or sales exist.
    if (currency !== store.currency) {
      const proceed = window.confirm(
        `Change currency from ${store.currency} to ${currency}? This is allowed only before any dishes or sales have been created.`,
      )
      if (!proceed) return
    }
    setError('')
    setMessage('')
    setSaving(true)
    try {
      const serviceChargePercent = String(form.get('service_charge_percent') ?? '').trim()
      const serviceChargeBps = serviceChargePercent === '' ? 0 : Math.round(Number(serviceChargePercent) * 100)
      if (!Number.isFinite(serviceChargeBps) || serviceChargeBps < 0 || serviceChargeBps > 10_000) {
        setError('Service charge must be a percentage between 0 and 100.')
        setSaving(false)
        return
      }
      const body = {
        currency,
        timezone: String(form.get('timezone')).trim(),
        address: String(form.get('address')).trim() || null,
        country: String(form.get('country')).trim().toUpperCase() || null,
        service_charge_bps: serviceChargeBps,
      }
      const token = await accessToken()
      const response = await fetch(`${configuredApiUrl()}/stores/${storeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      })
      const data = (await response.json()) as StoreRecord & { message?: string }
      if (!response.ok) throw new Error(data.message ?? `Server error (${response.status})`)
      setStore(data)
      // Currency and timezone feed every money/clock display cached locally (Register, receipts,
      // reports) via posDb.store_config — patch it directly rather than calling loadCatalog(),
      // which refuses to run at all while this store has any pending/unresolved outbox entry
      // (by design, to protect stock refresh) and would silently no-op here, leaving the local
      // cache stale even though the server save succeeded.
      const cachedConfig = await posDb.store_config.get(storeId)
      if (cachedConfig) {
        await posDb.store_config.put({ ...cachedConfig, currency: data.currency, timezone: data.timezone, service_charge_bps: data.service_charge_bps })
      }
      setMessage('Restaurant details saved.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save restaurant details.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pc-page">
      <div className="pc-hero">
        <div>
          <p className="pc-breadcrumb">
            Back of house <span>/</span> Settings <span>/</span> Restaurant
          </p>
          <h1 className="pc-title">Restaurant details.</h1>
          <p className="pc-subtitle">House information used across receipts, reporting and the floor.</p>
        </div>
        <div className="pc-actions">
          <Link className="secondary-cta" to="/settings">
            ← Back to settings
          </Link>
        </div>
      </div>

      <div className="pc-content" style={{ maxWidth: 640 }}>
        {loadError && (
          <div className="pc-alert error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="pc-alert-close" onClick={() => setLoadError('')} aria-label="Dismiss">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
        )}
        {message && (
          <div className="pc-alert success" role="status">
            <span>{message}</span>
            <button type="button" className="pc-alert-close" onClick={() => setMessage('')} aria-label="Dismiss">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
        )}

        {loading ? (
          <div className="pc-state" aria-busy="true">
            <h2>Loading…</h2>
            <p>Fetching this restaurant's details.</p>
          </div>
        ) : store ? (
          <form onSubmit={submit}>
            <div className="pc-group">
              <p className="pc-group-label">Restaurant</p>
              <div className="pc-field">
                <label htmlFor="sf-name">Restaurant name</label>
                <input id="sf-name" value={store.name} disabled />
                <p className="pc-field-hint">Set when the restaurant was created — not editable here.</p>
              </div>
            </div>

            <div className="pc-group">
              <p className="pc-group-label">Currency &amp; Timezone</p>
              <div className="pc-pair">
                <div className="pc-field">
                  <label htmlFor="sf-currency">Currency</label>
                  <select id="sf-currency" name="currency" defaultValue={store.currency}>
                    {CURRENCY_OPTIONS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {code} — {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pc-field">
                  <label htmlFor="sf-timezone">Timezone</label>
                  <select id="sf-timezone" name="timezone" defaultValue={store.timezone}>
                    {timezoneOptions().map(zone => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="pc-field-hint">Currency can only be changed before any dishes or sales exist. Timezone changes apply immediately.</p>
            </div>

            <div className="pc-group">
              <p className="pc-group-label">Service Charge</p>
              <div className="pc-field">
                <label htmlFor="sf-service-charge">
                  Service charge <span className="pc-opt">optional, % of the post-discount subtotal</span>
                </label>
                <input id="sf-service-charge" name="service_charge_percent" type="number" min={0} max={100} step="0.01"
                  defaultValue={store.service_charge_bps ? (store.service_charge_bps / 100).toFixed(2) : ''} placeholder="0" style={{ maxWidth: 160 }} />
              </div>
              <p className="pc-field-hint">Added to every sale on top of tax, e.g. 10 for a 10% service charge. Leave blank or 0 for none.</p>
            </div>

            <div className="pc-group">
              <p className="pc-group-label">Address</p>
              <div className="pc-field">
                <label htmlFor="sf-address">
                  Address <span className="pc-opt">optional</span>
                </label>
                <input id="sf-address" name="address" defaultValue={store.address ?? ''} maxLength={240} placeholder="123 Main St, Suite 4" autoComplete="off" />
              </div>
              <div className="pc-field">
                <label htmlFor="sf-country">
                  Country <span className="pc-opt">optional, 2-letter code</span>
                </label>
                <input
                  id="sf-country"
                  name="country"
                  defaultValue={store.country ?? ''}
                  maxLength={2}
                  placeholder="US"
                  autoComplete="off"
                  style={{ textTransform: 'uppercase', maxWidth: 120 }}
                />
              </div>
            </div>

            {error && (
              <div className="pc-alert error" role="alert" style={{ marginTop: 0 }}>
                <span>{error}</span>
                <button type="button" className="pc-alert-close" onClick={() => setError('')} aria-label="Dismiss">
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            )}

            <button className="pc-submit" type="submit" disabled={saving} style={{ width: '100%' }}>
              {saving ? 'Saving…' : 'Save restaurant details'}
            </button>
          </form>
        ) : null}
      </div>
    </div>
  )
}
