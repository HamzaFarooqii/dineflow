import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { calculateDiscountedLine, calculateServiceCharge, discountNeedsManagerApproval, formatCents, parseCents } from '../../../../packages/domain/src/money'
import { ORDER_TYPES, ORDER_TYPE_LABELS } from '../../../../packages/domain/src/order-type'
import { redemptionValue } from '../../../../packages/domain/src/loyalty'
import { promotionToLineDiscount } from '../../../../packages/domain/src/promotions'
import { activeStoreId, loadCatalog } from '../lib/catalog'
import { posDb, type LocalCategory, type LocalProduct, type LocalStock } from '../lib/db'
import { pushPendingOrders } from '../lib/order-sync'
import { approvalIsCurrent, cartSignature, productsRequiringApproval, usePosStore, type CartItem, type LineDiscount, type SelectedModifier } from '../lib/pos-store'
import { fetchLoyaltyAccount, fetchRewardRules, type LoyaltyAccount, type RewardRule } from '../lib/loyalty'
import { fetchActivePromotions, type Promotion } from '../lib/promotions'
import { createOpenCheck, saveOpenCheck, OpenCheckConflictError, type SaveCheckItem } from '../lib/open-checks'
import { currentAccess, type TerminalCache } from '../terminal-auth/cache'
import { ManagerApprovalModal } from '../terminal-auth/ManagerApprovalModal'
import { requireSupabase } from '../lib/supabase'
import { CustomerSelector } from './CustomerScreen'
import { MenuCategoryTabs } from './menu/MenuCategoryTabs'
import { MenuItemCard } from './menu/MenuItemCard'
import { MenuSearch } from './menu/MenuSearch'
import { RestaurantOrderItem, type DiscountEditorKind } from './menu/RestaurantOrderItem'
import { ModifierPicker, modifierLineId } from './menu/ModifierPicker'
import { ComboPicker } from './menu/ComboPicker'
import { liveQuery } from 'dexie'

export function RegisterScreen({ terminal = false }: { terminal?: boolean }) {
  const [products, setProducts] = useState<LocalProduct[]>([])
  const [categories, setCategories] = useState<LocalCategory[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [taxRates, setTaxRates] = useState<Record<string, number>>({})
  const [currency, setCurrency] = useState('USD')
  const [serviceChargeBps, setServiceChargeBps] = useState(0)
  const [catalogVersion, setCatalogVersion] = useState(1)
  const [storeId, setStoreId] = useState('')
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scanNotice, setScanNotice] = useState('')
  const [scanChoices, setScanChoices] = useState<LocalProduct[] | null>(null)
  const [customerOpen, setCustomerOpen] = useState(false)
  const [customerSyncWarning, setCustomerSyncWarning] = useState('')
  const [customerAuthorized, setCustomerAuthorized] = useState(terminal)
  const [terminalCache, setTerminalCache] = useState<TerminalCache | undefined>()
  const [permissionVersion, setPermissionVersion] = useState(0)
  const [discountEditorFor, setDiscountEditorFor] = useState<string | null>(null)
  const [discountKind, setDiscountKind] = useState<DiscountEditorKind>('percent')
  const [discountInput, setDiscountInput] = useState('')
  const [discountError, setDiscountError] = useState('')
  const [rewardRules, setRewardRules] = useState<RewardRule[]>([])
  const [promotions, setPromotions] = useState<Promotion[]>([])
  const [loyaltyAccount, setLoyaltyAccount] = useState<LoyaltyAccount | null>(null)
  const [approvalOpen, setApprovalOpen] = useState(false)
  const [approvalReason, setApprovalReason] = useState('')
  const [oversoldAcknowledged, setOversoldAcknowledged] = useState(false)
  const [modifierPicker, setModifierPicker] = useState<{ product: LocalProduct; lineId?: string; initial: SelectedModifier[] } | null>(null)
  const [comboPicker, setComboPicker] = useState<LocalProduct | null>(null)
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [holdBusy, setHoldBusy] = useState(false)
  const [holdError, setHoldError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const cart = usePosStore(state => state.items)
  const addItem = usePosStore(state => state.addItem)
  const increment = usePosStore(state => state.incrementItem)
  const decrement = usePosStore(state => state.decrementItem)
  const remove = usePosStore(state => state.removeItem)
  const clear = usePosStore(state => state.clearCart)
  const setLineDiscount = usePosStore(state => state.setLineDiscount)
  const applyRewardDiscount = usePosStore(state => state.applyRewardDiscount)
  const applyPromotionDiscount = usePosStore(state => state.applyPromotionDiscount)
  const setItemNote = usePosStore(state => state.setItemNote)
  const setItemModifiers = usePosStore(state => state.setItemModifiers)
  const managerApproval = usePosStore(state => state.managerApproval)
  const setManagerApproval = usePosStore(state => state.setManagerApproval)
  const selectedCustomer = usePosStore(state => state.selectedCustomer)
  const selectCustomer = usePosStore(state => state.selectCustomer)
  const orderType = usePosStore(state => state.orderType)
  const setOrderType = usePosStore(state => state.setOrderType)
  const setStoreContext = usePosStore(state => state.setStoreContext)
  const setCatalogStatus = usePosStore(state => state.setCatalogStatus)
  const totals = usePosStore(state => state.totals)
  const activeTableId = usePosStore(state => state.activeTableId)
  const activeCheckId = usePosStore(state => state.activeCheckId)
  const activeCheckVersion = usePosStore(state => state.activeCheckVersion)
  const setActiveCheck = usePosStore(state => state.setActiveCheck)
  const deliveryDetails = usePosStore(state => state.deliveryDetails)
  const setDeliveryDetails = usePosStore(state => state.setDeliveryDetails)
  useEffect(() => {
    if (!storeId) return
    const subscription = liveQuery(() => posDb.outbox.where('store_id').equals(storeId).toArray()).subscribe(entries => {
      const waiting = entries.filter(entry => entry.entity_type === 'order' && (entry.depends_on?.length ?? 0) > 0 && entry.status !== 'synced')
      const blocked = waiting.find(entry => entry.failure_kind === 'dependency')
      setCustomerSyncWarning(waiting.length ? `${waiting.length} completed sale${waiting.length === 1 ? '' : 's'} waiting for customer sync. ${blocked?.failure_reason ?? 'Customer upload will run before linked sales.'}` : '')
    })
    return () => subscription.unsubscribe()
  }, [storeId])
  useEffect(() => {
    const id = selectedCustomer?.id
    if (!id) return
    const subscription = liveQuery(() => posDb.customers.get(id)).subscribe(customer => {
      if (customer && usePosStore.getState().selectedCustomer?.id === id && usePosStore.getState().selectedCustomer?.sync_status !== customer.sync_status) selectCustomer(customer)
    })
    return () => subscription.unsubscribe()
  }, [selectedCustomer?.id, selectCustomer])
  useEffect(() => {
    // CashierPosLayout runs its own reconnect-sync trigger for every /pos/* screen, this one
    // included — skip this copy in terminal mode so the two don't fire concurrently.
    if (!storeId || terminal) return
    let active = true
    const sync = () => { if (active && navigator.onLine) void pushPendingOrders(storeId, terminal).catch(() => undefined) }
    window.addEventListener('online', sync)
    const interval = window.setInterval(sync, 15_000)
    return () => { active = false; window.removeEventListener('online', sync); window.clearInterval(interval) }
  }, [storeId, terminal])
  // Day 4 checkout wiring: reward rules and active promotions are store-level, so they load once
  // storeId is ready; the loyalty account is per-guest, so it reloads whenever the attached guest
  // changes. All three are online-only reads (no local Dexie cache exists for them yet) — offline,
  // the Reward/Promo tabs just show their empty state rather than failing the register.
  useEffect(() => {
    if (!storeId || !navigator.onLine) return
    let active = true
    void fetchRewardRules(storeId, terminal).then(rules => { if (active) setRewardRules(rules) }).catch(() => { if (active) setRewardRules([]) })
    void fetchActivePromotions(storeId, terminal).then(list => { if (active) setPromotions(list) }).catch(() => { if (active) setPromotions([]) })
    return () => { active = false }
  }, [storeId, terminal])
  useEffect(() => {
    if (!selectedCustomer || !storeId || !navigator.onLine) { setLoyaltyAccount(null); return }
    let active = true
    void fetchLoyaltyAccount(storeId, selectedCustomer.id, terminal).then(account => { if (active) setLoyaltyAccount(account) }).catch(() => { if (active) setLoyaltyAccount(null) })
    return () => { active = false }
  }, [storeId, terminal, selectedCustomer?.id])
  useEffect(() => {
    if (!scanNotice) return
    const timer = window.setTimeout(() => setScanNotice(''), 2_500)
    return () => window.clearTimeout(timer)
  }, [scanNotice])

  useEffect(() => {
    let active = true
    async function boot() {
      try {
        const terminalAccess = terminal ? await currentAccess() : undefined
        const id = terminal ? terminalAccess?.cache.device.store_id : await activeStoreId()
        if (!id || (terminal && !terminalAccess?.policy.valid)) throw new Error('Unlock this terminal before opening the register.')
        if (!active) return
        setStoreId(id)
        setStoreContext(id, '')
        if (terminal && terminalAccess) { setTerminalCache(terminalAccess.cache); setPermissionVersion(terminalAccess.employee?.permission_version ?? 0); setEmployeeId(terminalAccess.employee?.id ?? null) }
        if (!terminal && navigator.onLine) {
          try {
            const client = requireSupabase()
            const { data: { user } } = await client.auth.getUser()
            if (user) {
              const { data: memberships } = await client.from('store_memberships').select('role').eq('user_id', user.id).eq('store_id', id).eq('active', true).limit(1)
              const allowed = memberships?.[0]?.role === 'owner' || memberships?.[0]?.role === 'manager'
              if (active) { setCustomerAuthorized(allowed); if (!allowed) selectCustomer(null) }
            }
          } catch { if (active) setCustomerAuthorized(false) }
        }
        if (terminal) await posDb.sync_metadata.put({ key: `receipt_prefix:${id}`, value: terminalAccess!.cache.device.receipt_prefix })
        const cached = await posDb.store_config.get(id)
        if (cached) setStoreContext(id, cached.name)
        const refresh = async () => {
          const [config, available, cats, rates, stocks, adjustments] = await Promise.all([
            posDb.store_config.get(id), posDb.products.where('store_id').equals(id).toArray(),
            posDb.categories.where('store_id').equals(id).toArray(), posDb.tax_rates.where('store_id').equals(id).toArray(),
            posDb.server_stock.toArray(), posDb.stock_adjustments.toArray(),
          ])
          if (!active) return
          if (config) { setCurrency(config.currency); setCatalogVersion(config.catalog_version); setStoreContext(id, config.name); setServiceChargeBps(config.service_charge_bps ?? 0) }
          setProducts(available.filter(product => product.active))
          setCategories(cats.filter(category => category.active))
          setTaxRates(Object.fromEntries(rates.filter(rate => rate.active).map(rate => [rate.id, rate.rate_bps])))
          const base = Object.fromEntries(stocks.map((row: LocalStock) => [row.product_id, row.current_stock]))
          for (const adjustment of adjustments) base[adjustment.product_id] = (base[adjustment.product_id] ?? 0) + adjustment.delta
          setStock(base)
        }
        await refresh()
        try {
          await pushPendingOrders(id, terminal)
          const result = await loadCatalog(id, terminal)
          if (result === 'updated') await refresh()
          if (!await posDb.products.where('store_id').equals(id).count()) throw new Error('Connect to load this store’s products.')
          setCatalogStatus('ready')
        }
        catch (reason) {
          setCatalogStatus('unavailable')
          const message = reason instanceof Error ? reason.message : 'Catalog service is unavailable.'
          if (await posDb.products.where('store_id').equals(id).count()) setNotice(`Using saved catalog. ${message}`)
          else setError(`No catalog saved for this store. ${message}`)
        }
      } catch (reason) { if (active) { setCatalogStatus('unavailable'); setError(reason instanceof Error ? reason.message : 'Unable to open the register.') } }
      finally { if (active) setLoading(false) }
    }
    void boot()
    return () => { active = false }
  }, [setStoreContext, setCatalogStatus, terminal])

  const visible = useMemo(() => products.filter(product => {
    const term = query.trim().toLowerCase()
    const matches = !term || product.name.toLowerCase().includes(term) || product.sku.toLowerCase().includes(term) ||
      product.barcode?.toLowerCase().includes(term)
    return matches && (categoryId === 'all' || product.category_id === categoryId)
  }), [products, query, categoryId])
  let total = { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 }
  let cartError = ''
  try { total = totals() } catch (reason) { cartError = reason instanceof Error ? reason.message : 'Cart amount is invalid.' }

  const approvalNeededIds = useMemo(() => productsRequiringApproval(cart), [cart])
  const approvalValid = terminal ? approvalIsCurrent(managerApproval, cart, permissionVersion) : true
  const needsApproval = terminal && approvalNeededIds.length > 0 && !approvalValid

  const rewardOptions = useMemo(() => rewardRules.map(rule => ({
    id: rule.id, label: `${rule.name} — ${formatCents(rule.discount_cents, currency)} for ${rule.points_cost} pts`,
    affordable: (loyaltyAccount?.points_balance ?? 0) >= rule.points_cost,
  })), [rewardRules, loyaltyAccount, currency])
  const promoOptions = useMemo(() => promotions.map(promo => ({
    id: promo.id, label: `${promo.name} — ${promo.discount_kind === 'percent' ? `${(promo.discount_value / 100).toFixed(2)}%` : formatCents(promo.discount_value, currency)} off`,
  })), [promotions, currency])

  // A cashier can still complete this sale even if it oversells — pos_stock is allowed to go
  // negative by design (loadOversold reports it for reconciliation) because the local stock
  // count can be stale, especially offline, and blocking a paying guest is worse than a rare
  // oversell. This is a confirmation gate, not a hard block: the cashier must see and
  // acknowledge it, but isn't stuck if the count turns out to be wrong.
  const oversoldLines = useMemo(() => cart.filter(item => item.quantity > (stock[item.productId] ?? Infinity)), [cart, stock])
  const oversoldKey = oversoldLines.map(item => `${item.lineId}:${item.quantity}`).join('|')
  useEffect(() => { setOversoldAcknowledged(false) }, [oversoldKey])
  const needsOversoldAcknowledgement = oversoldLines.length > 0 && !oversoldAcknowledged

  function addProductToCart(product: LocalProduct): boolean {
    if (product.tax_rate_id && taxRates[product.tax_rate_id] === undefined) { setError(`${product.name} needs a tax rate that has not synced to this browser yet.`); return false }
    setError('')
    if (product.combo) { setComboPicker(product); return false }
    if (product.modifier_groups?.length) { setModifierPicker({ product, initial: [] }); return false }
    addItem({ lineId: modifierLineId(product.id, []), storeId, productId: product.id, name: product.name, sku: product.sku,
      unitPriceCents: product.unit_price_cents, basePriceCents: product.unit_price_cents, modifiers: [],
      taxRateBps: taxRates[product.tax_rate_id ?? ''] ?? 0, catalogVersion })
    return true
  }

  function handleScan() {
    const code = query.trim()
    if (!code) return
    setScanChoices(null)
    const skuMatch = products.find(product => product.sku.toLowerCase() === code.toLowerCase())
    if (skuMatch) { if (addProductToCart(skuMatch)) setScanNotice(`Added ${skuMatch.name} from scan.`); setQuery(''); searchRef.current?.focus(); return }
    const barcodeMatches = products.filter(product => product.barcode && product.barcode.toLowerCase() === code.toLowerCase())
    if (barcodeMatches.length === 1) { if (addProductToCart(barcodeMatches[0])) setScanNotice(`Added ${barcodeMatches[0].name} from scan.`); setQuery(''); searchRef.current?.focus(); return }
    if (barcodeMatches.length > 1) { setScanChoices(barcodeMatches); return }
    setError(`No menu item found for barcode: ${code}`)
  }

  function pickScanChoice(product: LocalProduct) {
    if (addProductToCart(product)) setScanNotice(`Added ${product.name} from scan.`); setScanChoices(null); setQuery(''); searchRef.current?.focus()
  }

  function openDiscountEditor(item: CartItem) {
    setDiscountEditorFor(item.lineId)
    setDiscountError('')
    if (item.discountSource?.kind === 'reward') { setDiscountKind('reward'); setDiscountInput(item.discountSource.ruleId) }
    else if (item.discountSource?.kind === 'promotion') { setDiscountKind('promo'); setDiscountInput(item.discountSource.promotionId) }
    else if (item.discount) { setDiscountKind(item.discount.kind); setDiscountInput(item.discount.kind === 'percent' ? String(item.discount.bps / 100) : (item.discount.cents / 100).toFixed(2)) }
    else { setDiscountKind('percent'); setDiscountInput('') }
  }

  // Reward/promotion redemption produce a plain LineDiscount exactly like a manual one (Day 4
  // checkout wiring) — they go through the same lineSubtotal bound and the same manager-approval
  // check below; only *how* the discount amount was decided, and which pos-store action records
  // it, differs per kind.
  function applyDiscount(item: CartItem) {
    try {
      const lineSubtotal = item.unitPriceCents * item.quantity
      let discount: LineDiscount
      let commit: () => void
      if (discountKind === 'percent') {
        const value = Number(discountInput)
        if (!Number.isFinite(value) || value <= 0 || value > 100) throw new Error('Enter a percent between 0 and 100.')
        discount = { kind: 'percent', bps: Math.round(value * 100) }
        commit = () => setLineDiscount(item.lineId, discount)
      } else if (discountKind === 'fixed') {
        const cents = parseCents(discountInput || '0')
        if (cents <= 0 || cents > lineSubtotal) throw new Error('Enter an amount up to the line subtotal.')
        discount = { kind: 'fixed', cents }
        commit = () => setLineDiscount(item.lineId, discount)
      } else if (discountKind === 'reward') {
        const rule = rewardRules.find(candidate => candidate.id === discountInput)
        if (!rule) throw new Error('Choose a reward.')
        const value = redemptionValue(rule.points_cost, rule.discount_cents, loyaltyAccount?.points_balance ?? 0)
        if (!value) throw new Error(`${selectedCustomer?.name ?? 'This guest'} doesn't have enough points for that reward.`)
        if (value.cents > lineSubtotal) throw new Error(`This reward (${formatCents(value.cents, currency)}) is worth more than this line — apply it to a larger item.`)
        discount = value
        commit = () => applyRewardDiscount(item.lineId, { kind: 'reward', ruleId: rule.id, ruleName: rule.name, pointsCost: rule.points_cost }, value)
      } else {
        const promo = promotions.find(candidate => candidate.id === discountInput)
        if (!promo) throw new Error('Choose a promotion.')
        const value = promotionToLineDiscount({ id: promo.id, storeId: promo.store_id, name: promo.name, discountKind: promo.discount_kind,
          discountValue: promo.discount_value, startsAt: promo.starts_at ? new Date(promo.starts_at) : null, endsAt: promo.ends_at ? new Date(promo.ends_at) : null, active: promo.active })
        if (!value) throw new Error('This promotion could not be applied.')
        if (value.kind === 'fixed' && value.cents > lineSubtotal) throw new Error(`This promotion (${formatCents(value.cents, currency)}) is worth more than this line — apply it to a larger item.`)
        discount = value
        commit = () => applyPromotionDiscount(item.lineId, { kind: 'promotion', promotionId: promo.id, name: promo.name }, value)
      }
      commit()
      setDiscountEditorFor(null); setDiscountError('')
      const line = calculateDiscountedLine(item.unitPriceCents, item.quantity, item.taxRateBps, discount)
      if (terminal && discountNeedsManagerApproval(line.subtotalCents, line.discountAppliedCents)) {
        setApprovalReason(`${item.name}: a discount of ${formatCents(line.discountAppliedCents, currency)} on a ${formatCents(line.subtotalCents, currency)} line needs a manager's sign-off.`)
        setApprovalOpen(true)
      }
    } catch (reason) { setDiscountError(reason instanceof Error ? reason.message : 'Invalid discount.') }
  }

  function openApprovalModal() {
    const names = cart.filter(item => approvalNeededIds.includes(item.lineId)).map(item => item.name)
    setApprovalReason(names.length ? `${names.join(', ')} — discount above 20% needs manager sign-off.` : 'A discount above 20% needs manager sign-off.')
    setApprovalOpen(true)
  }

  // A guest must be attached to every check — created or picked from the directory — so a bill
  // always has a name and phone number on it. Gated on customerAuthorized, not just "no
  // customer yet": on the main (non-terminal) register, customer access requires being online
  // (it checks store_memberships live), so requiring one unconditionally would strand an
  // offline checkout with no way to satisfy it — that would break this app's core offline-first
  // guarantee. A cashier terminal is always customerAuthorized, so this is unconditional there.
  const needsCustomer = customerAuthorized && !selectedCustomer
  // A Delivery order needs a recipient, a normalized phone, and an address before checkout.ts can
  // build the order.delivery snapshot the API requires -- checked here so "Proceed to payment" is
  // disabled with a clear reason, the same pattern needsCustomer already uses, instead of letting
  // the cashier reach Payment and fail there.
  const needsDeliveryDetails = orderType === 'delivery' && (!deliveryDetails.recipientName.trim() ||
    !/^[1-9][0-9]{3,14}$/.test(deliveryDetails.contactPhone.replace(/\D/g, '')) || !deliveryDetails.address.trim())
  const proceedBlocked = !cart.length || Boolean(cartError) || !storeId || needsApproval || needsOversoldAcknowledgement || needsCustomer || needsDeliveryDetails

  // Hold: saves the current cart to the server as a durable, resumable open check (lib/open-checks.ts)
  // instead of completing a sale -- an online-only call (see that file's header comment), since a
  // held check exists specifically to be resumable from a *different* terminal. A dine-in check
  // needs a table (set by Floor's "Add order"); takeaway can be held without one. Delivery can't be
  // held at all yet: an open check has no column for recipient/address, so a held delivery check
  // would fail at close time with nowhere to recover -- same known gap as combos, not a new one.
  const holdBlocked = !cart.length || Boolean(cartError) || !storeId || needsApproval || needsOversoldAcknowledgement || needsCustomer ||
    (orderType === 'dine_in' && !activeTableId) || orderType === 'delivery' || holdBusy
  async function handleHold() {
    if (holdBlocked) return
    setHoldBusy(true); setHoldError('')
    try {
      const items: SaveCheckItem[] = cart.map(item => ({
        // item.lineId is a local cart merge key (see modifierLineId), not a server item id -- the
        // server fully replaces a check's items on every save (editOpenCheckCore), so there is no
        // continuity to preserve; omitting id lets it assign a fresh one, as SaveCheckItem.id allows.
        productId: item.productId, snapshotName: item.name, snapshotSku: item.sku,
        snapshotPriceCents: item.unitPriceCents, snapshotTaxBps: item.taxRateBps, catalogVersion: item.catalogVersion,
        quantity: item.quantity, discount: item.discount,
        modifiers: item.modifiers.map(modifier => ({ optionId: modifier.optionId, groupName: modifier.groupName, optionName: modifier.optionName, priceDeltaCents: modifier.priceDeltaCents })),
      }))
      const tableId = orderType === 'dine_in' ? activeTableId : null
      const checkId = activeCheckId ?? (await createOpenCheck(storeId, { orderType, tableId, customerId: selectedCustomer?.id ?? null, employeeId }, terminal)).check.id
      const startVersion = activeCheckId ? activeCheckVersion! : 1
      const saved = await saveOpenCheck(storeId, checkId, startVersion, items, serviceChargeBps, { customerId: selectedCustomer?.id ?? null }, terminal)
      setActiveCheck(saved.check.id, saved.check.version)
      clear()
      setNotice(`Check held for table service. Resume it from Open Checks when the guest is ready to pay.`)
    } catch (reason) {
      setHoldError(reason instanceof OpenCheckConflictError
        ? 'This check was changed elsewhere since it was last loaded. Reload it from Open Checks and try again.'
        : reason instanceof Error ? reason.message : 'Could not hold this check.')
    } finally { setHoldBusy(false) }
  }

  return <section className="register-page" aria-label="Register">
    <div className="catalog">
      <div className="catalog-tools"><MenuSearch value={query} onChange={setQuery} onSubmit={handleScan} inputRef={searchRef} />
      </div><div className="catalog-filter-bar" aria-label="Menu categories"><strong>Menu</strong><MenuCategoryTabs categories={categories} selectedId={categoryId} onSelect={setCategoryId} /></div>
      {loading && <p className="screen-note" role="status">Loading saved menu…</p>}
      {error && <p className="form-notice error" role="alert">{error}</p>}
      {notice && <p className="screen-note" role="status">{notice}</p>}
      {scanNotice && <p className="screen-note scan-toast" role="status">{scanNotice}</p>}
      {scanChoices && <div className="scan-picker" role="dialog" aria-label="Choose a product for this barcode">
        <div className="scan-picker-head"><strong>Multiple menu items share this barcode</strong><button type="button" className="text-action" onClick={() => setScanChoices(null)}>Cancel</button></div>
        <ul>{scanChoices.map(product => <li key={product.id}><span>{product.name} <small>{product.sku}</small></span>
          <button type="button" className="secondary-cta" onClick={() => pickScanChoice(product)}>Add</button></li>)}</ul>
      </div>}
      {!loading && !error && !visible.length && <p className="screen-note">{products.length ? 'No menu items match your search.' : 'No menu saved. Connect to load this restaurant’s menu.'}</p>}
      <div className="catalog-grid">{visible.map(product => <MenuItemCard key={product.id} product={product} stock={stock[product.id] ?? 0} currency={currency}
        disabled={Boolean(product.tax_rate_id && taxRates[product.tax_rate_id] === undefined)}
        onSelect={() => addProductToCart(product)} />)}</div>
    </div>
    <aside className="sale-cart"><div className="cart-title"><h2>{activeCheckId ? 'Resuming held check' : 'Open check'}</h2>
        <Link className="text-action" to={terminal ? '/pos/open-checks' : '/open-checks'}>Open Checks ↗</Link></div>
      <div className="cart-actions-row">
        <button className="secondary-cta cart-hold-button" type="button" onClick={() => void handleHold()} disabled={holdBlocked}
          title={orderType === 'dine_in' && !activeTableId ? 'Select a table from Floor before holding a dine-in check.' : orderType === 'delivery' ? 'Delivery orders can’t be held yet — complete checkout directly.' : undefined}>
          {holdBusy ? 'Holding…' : activeCheckId ? 'Save changes to held check' : 'Hold this check'}
        </button>
        <button className="text-action" type="button" onClick={() => { if (window.confirm('Void this check and clear it? This cannot be undone.')) clear() }} disabled={!cart.length}>Void check</button>
      </div>
      {Boolean(cart.length) && !activeCheckId && <p className="cart-hold-hint">Items only live in this browser until you tap <b>Hold this check</b> — that's what makes a check resumable later, from Open Checks or a different terminal. Proceeding straight to payment works too and needs no hold.</p>}
      {activeCheckId && <p className="cart-hold-hint cart-hold-hint-active">You're resuming a check held earlier. Keep editing freely — tap <b>Save changes to held check</b> to store your edits, or Proceed to payment to close it out now.</p>}
      {holdError && <p className="form-notice error" role="alert">{holdError}</p>}
      <div className="order-type-selector" role="radiogroup" aria-label="Order type">
        {ORDER_TYPES.map(type => <button key={type} type="button" role="radio" aria-checked={orderType === type}
          className={orderType === type ? 'active' : ''} onClick={() => setOrderType(type)}>{ORDER_TYPE_LABELS[type]}</button>)}
      </div>
      {orderType === 'delivery' && <div className="delivery-details-field" aria-label="Delivery details">
        <label>Recipient name<input value={deliveryDetails.recipientName} maxLength={120} placeholder="Who's this for?"
          onChange={event => setDeliveryDetails({ ...deliveryDetails, recipientName: event.target.value })} /></label>
        <label>Phone<input inputMode="tel" value={deliveryDetails.contactPhone} placeholder="+1 234 567 8900"
          onChange={event => setDeliveryDetails({ ...deliveryDetails, contactPhone: event.target.value })} /></label>
        <label>Delivery address<textarea value={deliveryDetails.address} maxLength={400} rows={2} placeholder="Street, unit, city"
          onChange={event => setDeliveryDetails({ ...deliveryDetails, address: event.target.value })} /></label>
        <label>Note for the rider (optional)<input value={deliveryDetails.instructions} maxLength={500} placeholder="Gate code, landmark, etc."
          onChange={event => setDeliveryDetails({ ...deliveryDetails, instructions: event.target.value })} /></label>
      </div>}
      <div className={`crm-cart-customer ${needsCustomer ? 'crm-cart-customer-required' : ''}`}>{selectedCustomer && customerAuthorized ? <><strong>{selectedCustomer.name}</strong><small>{selectedCustomer.phone_normalized ? `+${selectedCustomer.phone_normalized}` : 'No phone'} · {selectedCustomer.sync_status === 'synced' ? 'Saved' : 'Pending sync'}</small><div className="crm-cart-customer-actions"><button type="button" className="text-action" onClick={() => setCustomerOpen(true)}>Change customer</button><button type="button" className="text-action" onClick={() => selectCustomer(null)}>Remove</button></div></> : <><button type="button" className={customerAuthorized ? 'secondary-cta' : 'text-action'} disabled={!storeId || !customerAuthorized} onClick={() => setCustomerOpen(true)}>{customerAuthorized ? 'Select or add a guest (required)' : 'Add customer'}</button>{storeId && !customerAuthorized && <small>Customer access requires validated management membership.</small>}</>}</div>
      {customerSyncWarning && <p className="crm-sync-note" role="status">{customerSyncWarning}</p>}
      {!cart.length && <p className="empty-cart">Add a dish to start this check.</p>}
      {cart.map(item => <RestaurantOrderItem key={item.lineId} item={item} currency={currency} availableStock={stock[item.productId]}
        flagged={approvalNeededIds.includes(item.lineId)} approvalValid={approvalValid}
        discountEditorOpen={discountEditorFor === item.lineId} discountKind={discountKind} discountInput={discountInput} discountError={discountError}
        rewardOptions={rewardOptions} promoOptions={promoOptions} hasCustomer={Boolean(selectedCustomer)}
        onIncrement={() => increment(item.lineId)} onDecrement={() => decrement(item.lineId)} onRemove={() => remove(item.lineId)}
        onEditModifiers={products.find(product => product.id === item.productId)?.modifier_groups?.length ? () => {
          const product = products.find(candidate => candidate.id === item.productId)
          if (product) setModifierPicker({ product, lineId: item.lineId, initial: item.modifiers })
        } : undefined}
        onOpenDiscountEditor={() => openDiscountEditor(item)}
        onSetDiscountKind={kind => { setDiscountKind(kind); setDiscountInput(''); setDiscountError('') }}
        onSetDiscountInput={setDiscountInput}
        onRemoveDiscount={() => { setLineDiscount(item.lineId, null); setDiscountEditorFor(null) }}
        onCancelDiscountEditor={() => setDiscountEditorFor(null)}
        onApplyDiscount={() => applyDiscount(item)}
        onSetNote={note => setItemNote(item.lineId, note)} />)}
      {needsApproval && <div className="manager-approval-banner" role="alert">
        <span>A discount above 20% needs manager approval before checkout.</span>
        <button type="button" className="secondary-cta" onClick={openApprovalModal}>Get manager approval</button>
      </div>}
      {oversoldLines.length > 0 && <div className="manager-approval-banner" role="alert">
        <span>{oversoldLines.length === 1 ? `${oversoldLines[0].name} orders more than the ${stock[oversoldLines[0].productId] ?? 0} in stock.` : `${oversoldLines.length} items order more than what's in stock.`}{' '}This can still be sold — stock may be out of date — but confirm before continuing.</span>
        {!oversoldAcknowledged && <button type="button" className="secondary-cta" onClick={() => setOversoldAcknowledged(true)}>Proceed anyway</button>}
      </div>}
      <div className="totals"><span>Subtotal <b>{formatCents(total.subtotalCents, currency)}</b></span>
        {total.discountCents > 0 && <span className="totals-discount">Discount <b>−{formatCents(total.discountCents, currency)}</b></span>}
        <span>Tax <b>{formatCents(total.taxCents, currency)}</b></span>
        {serviceChargeBps > 0 && <span>Service charge <b>{formatCents(calculateServiceCharge(total.subtotalCents - total.discountCents, serviceChargeBps), currency)}</b></span>}
        <strong>Total <b>{formatCents(total.totalCents + calculateServiceCharge(total.subtotalCents - total.discountCents, serviceChargeBps), currency)}</b></strong></div>
      {cartError && <p className="form-notice error" role="alert">{cartError}</p>}
      {!cartError && Boolean(cart.length) && needsCustomer && <p className="form-notice error" role="alert">Select or add a guest before proceeding to payment.</p>}
      <Link className={`cta ${proceedBlocked ? 'cta-disabled' : ''}`} to={!proceedBlocked ? terminal ? '/pos/payment' : '/payment' : terminal ? '/pos/register' : '/register'}
        aria-disabled={proceedBlocked}>Proceed to payment <b aria-hidden="true">→</b></Link>
    </aside>
    {customerOpen && storeId && customerAuthorized && <CustomerSelector storeId={storeId} terminal={terminal} onClose={() => setCustomerOpen(false)} />}
    {approvalOpen && terminalCache && <ManagerApprovalModal cache={terminalCache} reason={approvalReason}
      onClose={() => setApprovalOpen(false)}
      onApprove={evidence => { setManagerApproval({ ...evidence, permissionVersion, cartSignature: cartSignature(cart) }); setApprovalOpen(false) }} />}
    {modifierPicker && <ModifierPicker product={modifierPicker.product} currency={currency} initial={modifierPicker.initial}
      onClose={() => setModifierPicker(null)} onApply={(modifiers, unitPriceCents) => {
        const nextLineId = modifierLineId(modifierPicker.product.id, modifiers)
        if (modifierPicker.lineId) setItemModifiers(modifierPicker.lineId, nextLineId, modifiers, unitPriceCents)
        else addItem({ lineId: nextLineId, storeId, productId: modifierPicker.product.id, name: modifierPicker.product.name,
          sku: modifierPicker.product.sku, unitPriceCents, basePriceCents: modifierPicker.product.unit_price_cents, modifiers,
          taxRateBps: taxRates[modifierPicker.product.tax_rate_id ?? ''] ?? 0, catalogVersion })
        setModifierPicker(null)
      }} />}
    {comboPicker && <ComboPicker product={comboPicker} currency={currency} productsById={new Map(products.map(candidate => [candidate.id, candidate]))}
      onClose={() => setComboPicker(null)} onApply={(selection, unitPriceCents) => {
        addItem({
          lineId: `${comboPicker.id}:combo:${selection.map(entry => entry.componentProductId).sort().join(',')}`,
          storeId, productId: comboPicker.id, name: comboPicker.name, sku: comboPicker.sku,
          unitPriceCents, basePriceCents: unitPriceCents, modifiers: [],
          taxRateBps: taxRates[comboPicker.tax_rate_id ?? ''] ?? 0, catalogVersion,
          comboSelection: selection.map(entry => ({ groupId: entry.groupId, componentProductId: entry.componentProductId, priceDeltaCents: entry.priceDeltaCents })),
        })
        setComboPicker(null)
      }} />}
  </section>
}
