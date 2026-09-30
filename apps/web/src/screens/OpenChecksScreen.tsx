import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { ORDER_TYPE_LABELS } from '../../../../packages/domain/src/order-type'
import { fetchOpenCheck, fetchOpenChecks, voidOpenCheck, type OpenCheckHeader } from '../lib/open-checks'
import { usePosStore, type CartItem } from '../lib/pos-store'
import { posDb } from '../lib/db'
import { currentAccess } from '../terminal-auth/cache'
import { activeStoreId } from '../lib/catalog'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/EmptyState'
import { StatusBadge } from '../components/StatusBadge'
import { QrSubmissionsPanel } from './QrSubmissionsPanel'
import './open-checks.css'

export function OpenChecksScreen({ terminal = false }: { terminal?: boolean }) {
  const navigate = useNavigate()
  const [storeId, setStoreId] = useState('')
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [checks, setChecks] = useState<OpenCheckHeader[]>()
  const [currency, setCurrency] = useState('USD')
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const loadCheckIntoCart = usePosStore(state => state.loadCheckIntoCart)
  const setStoreContext = usePosStore(state => state.setStoreContext)

  const load = async (id: string) => {
    try { setChecks(await fetchOpenChecks(id, terminal)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load open checks.') }
  }

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const id = terminal ? (await currentAccess())?.cache.device.store_id : await activeStoreId()
        if (!id) throw new Error('Unlock this terminal before viewing open checks.')
        if (!active) return
        setStoreId(id)
        if (terminal) setEmployeeId((await currentAccess())?.employee?.id ?? null)
        const config = await posDb.store_config.get(id)
        if (config) setCurrency(config.currency)
        await load(id)
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load open checks.') }
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal])

  async function resume(header: OpenCheckHeader) {
    setBusyId(header.id); setError('')
    try {
      const detail = await fetchOpenCheck(storeId, header.id, terminal)
      const customer = detail.check.customer_id ? (await posDb.customers.get(detail.check.customer_id)) ?? null : null
      const items: CartItem[] = detail.items.map(item => ({
        lineId: item.id, storeId, productId: item.product_id, name: item.snapshot_name, sku: item.snapshot_sku,
        unitPriceCents: item.snapshot_price_cents,
        basePriceCents: item.snapshot_price_cents - item.modifiers.reduce((sum, modifier) => sum + modifier.price_delta_cents, 0),
        modifiers: item.modifiers.map(modifier => ({ groupId: '', optionId: '', groupName: modifier.group_name, optionName: modifier.option_name, priceDeltaCents: modifier.price_delta_cents })),
        taxRateBps: item.snapshot_tax_bps, catalogVersion: item.catalog_version, quantity: item.quantity,
        discount: item.discount_kind === 'percent' ? { kind: 'percent', bps: item.discount_value ?? 0 }
          : item.discount_kind === 'fixed' ? { kind: 'fixed', cents: item.discount_value ?? 0 } : null,
      }))
      setStoreContext(storeId, '')
      loadCheckIntoCart({ checkId: detail.check.id, version: detail.check.version, orderType: detail.check.order_type, tableId: detail.check.table_id, customer, items })
      navigate(terminal ? '/pos/register' : '/register')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not resume this check.') }
    finally { setBusyId(null) }
  }

  async function abandon(header: OpenCheckHeader) {
    if (!window.confirm(`Void this check for ${header.table_label ?? ORDER_TYPE_LABELS[header.order_type]}? This cannot be undone.`)) return
    setBusyId(header.id); setError('')
    try {
      await voidOpenCheck(storeId, header.id, header.version, employeeId, terminal)
      await load(storeId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not void this check.') }
    finally { setBusyId(null) }
  }

  return <section className="open-checks-page">
    <PageHeader kicker="HELD ON THE FLOOR" title="Open checks." subtitle="Checks held for later — resume one to keep adding items or take payment, from any authorized terminal." />
    {storeId && <QrSubmissionsPanel storeId={storeId} terminal={terminal} currency={currency} onChanged={() => void load(storeId)} />}
    {error && <p className="form-notice error" role="alert">{error}</p>}
    {checks === undefined && !error && <p role="status">Loading open checks…</p>}
    {checks?.length === 0 && <EmptyState title="No open checks right now." description="A check held from the register appears here until it's resumed, closed or voided." />}
    <div className="open-checks-list">{checks?.map(check => (
      <article key={check.id} className="open-check-card">
        <div className="open-check-card-head">
          <strong>{check.table_label ?? ORDER_TYPE_LABELS[check.order_type]}</strong>
          <StatusBadge tone="saffron">{ORDER_TYPE_LABELS[check.order_type]}</StatusBadge>
        </div>
        <span className="open-check-card-meta">{check.item_count ?? 0} item{check.item_count === 1 ? '' : 's'} · opened {new Date(check.opened_at).toLocaleTimeString()}</span>
        <b>{formatCents(check.total_cents, currency)}</b>
        <div className="open-check-card-actions">
          <button type="button" className="cta" disabled={busyId === check.id} onClick={() => void resume(check)}>{busyId === check.id ? 'Loading…' : 'Resume'}</button>
          <button type="button" className="text-action" disabled={busyId === check.id} onClick={() => void abandon(check)}>Void</button>
        </div>
      </article>
    ))}</div>
  </section>
}
