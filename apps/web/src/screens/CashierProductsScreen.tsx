/**
 * CashierProductsScreen — /pos/products
 * Read-only menu browse for the service terminal (FEAT-CAT-01).
 * Reuses ProductCatalogScreen's MISE visual language (product-catalog.css) and
 * read-side data shape, but bootstraps from terminal auth instead of Supabase,
 * and has no add/edit affordance — menu editing stays owner/manager only.
 */
import { useEffect, useMemo, useState } from 'react'
import { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type LocalCategory, type LocalProduct } from '../lib/db'
import { currentAccess } from '../terminal-auth/cache'
import { DishAvailability } from './menu/DishAvailability'
import { MetricCard } from '../components/MetricCard'
import { StatusBadge } from '../components/StatusBadge'
import { SelectField } from '../components/SelectField'
import { Search, X } from '../components/icons'
import './product-catalog.css'

export function CashierProductsScreen() {
  const [products, setProducts] = useState<LocalProduct[] | null>(null)
  const [categories, setCategories] = useState<LocalCategory[]>([])
  const [stock, setStock] = useState<Record<string, number>>({})
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [loadErr, setLoadErr] = useState('')

  useEffect(() => {
    let active = true
    void currentAccess().then(async access => {
      if (!active) return
      if (!access?.policy.valid) { setLoadErr('Unlock this terminal before browsing the menu.'); return }
      const id = access.cache.device.store_id
      setStoreId(id)
      const config = await posDb.store_config.get(id)
      if (config && active) setCurrency(config.currency)
    }).catch(reason => { if (active) setLoadErr(reason instanceof Error ? reason.message : 'Could not load this restaurant.') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId) return
    const productsSub = liveQuery(() => posDb.products.where('store_id').equals(storeId).toArray()).subscribe({
      next: rows => setProducts(rows.filter(product => product.active).sort((a, b) => a.name.localeCompare(b.name))),
      error: () => setLoadErr('Failed to read the saved menu.'),
    })
    const categoriesSub = liveQuery(() => posDb.categories.where('store_id').equals(storeId).toArray()).subscribe({
      next: rows => setCategories(rows.filter(category => category.active)),
    })
    const stockSub = liveQuery(async () => {
      const [rows, adjustments] = await Promise.all([posDb.server_stock.toArray(), posDb.stock_adjustments.toArray()])
      const base: Record<string, number> = Object.fromEntries(rows.map(row => [row.product_id, row.current_stock]))
      for (const adjustment of adjustments) base[adjustment.product_id] = (base[adjustment.product_id] ?? 0) + adjustment.delta
      return base
    }).subscribe({ next: setStock })
    return () => { productsSub.unsubscribe(); categoriesSub.unsubscribe(); stockSub.unsubscribe() }
  }, [storeId])

  const catMap = useMemo(() => Object.fromEntries(categories.map(category => [category.id, category.name])), [categories])
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!products) return []
    return products.filter(product => {
      if (catFilter !== 'all' && product.category_id !== catFilter) return false
      if (!q) return true
      return product.name.toLowerCase().includes(q) || product.sku.toLowerCase().includes(q) || (product.barcode ?? '').toLowerCase().includes(q)
    })
  }, [products, catFilter, q])

  const total = products?.length ?? 0
  const inStock = products?.filter(product => (stock[product.id] ?? 0) > 5).length ?? 0
  const lowStock = products?.filter(product => { const level = stock[product.id] ?? 0; return level > 0 && level <= 5 }).length ?? 0
  const outStock = products?.filter(product => (stock[product.id] ?? 0) <= 0).length ?? 0
  const hasFilters = q !== '' || catFilter !== 'all'
  const isLoading = products === null && !loadErr

  return <div className="pc-page">
    <div className="pc-hero"><div>
      <p className="pc-breadcrumb">Service terminal <span>/</span> Menu</p>
      <h1 className="pc-title">The menu.</h1>
      <p className="pc-subtitle">Browse tonight's dishes, prices and stock. Ask a manager to add or edit a dish.</p>
    </div></div>

    {products !== null && <div className="pc-stats-strip">
      <MetricCard label="Menu Items" value={total} detail="Across all categories" />
      <MetricCard label="In Stock" value={inStock} detail="Ready to serve" />
      <MetricCard label="Low Stock" value={lowStock} detail="5 portions or fewer" />
      <MetricCard label="Out of Stock" value={outStock} detail="Needs restocking" />
    </div>}

    <div className="pc-content">
      {loadErr && <div className="pc-alert error" role="alert"><span>{loadErr}</span>
        <button type="button" className="pc-alert-close" onClick={() => setLoadErr('')} aria-label="Dismiss"><X aria-hidden="true" size={14} /></button></div>}

      <div className="pc-toolbar">
        <div className="pc-search">
          <Search aria-hidden="true" size={15} />
          <input id="pc-search" className="pc-search-input" type="search" placeholder="Search dishes by name, SKU or barcode…" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search the menu" />
          {query && <button type="button" className="pc-search-clear" onClick={() => setQuery('')} aria-label="Clear search"><X aria-hidden="true" size={14} /></button>}
        </div>
        <SelectField id="pc-cat-filter" className="pc-cat-select" value={catFilter} onChange={event => setCatFilter(event.target.value)} aria-label="Filter by category">
          <option value="all">All categories</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </SelectField>
        {hasFilters && <button type="button" className="pc-clear-btn" onClick={() => { setQuery(''); setCatFilter('all') }}>Clear filters</button>}
      </div>

      {!isLoading && filtered.length > 0 && <div className="pc-meta">Showing {filtered.length} dish{filtered.length !== 1 ? 'es' : ''}{hasFilters && ` (filtered from ${total})`}</div>}

      {isLoading && <div className="pc-table-wrap" aria-busy="true">
        <div className="pc-thead"><span>Dish</span><span>Barcode</span><span>Category</span><span>Price</span><span>Stock</span></div>
        {Array.from({ length: 6 }).map((_, index) => <div key={index} className="pc-skel-row">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="pc-bone" style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0 }} />
            <div style={{ display: 'grid', gap: 6, flex: 1 }}><div className="pc-bone" style={{ height: 14, width: '60%' }} /><div className="pc-bone" style={{ height: 10, width: '35%' }} /></div>
          </div>
          <div className="pc-bone" style={{ height: 12, width: '70%', marginLeft: 'auto' }} />
          <div className="pc-bone" style={{ height: 20, width: 80, borderRadius: 10, marginLeft: 'auto' }} />
          <div className="pc-bone" style={{ height: 16, width: 60, marginLeft: 'auto' }} />
          <div className="pc-bone" style={{ height: 14, width: 75, marginLeft: 'auto' }} />
        </div>)}
      </div>}

      {!isLoading && !loadErr && products !== null && filtered.length === 0 && <div className="pc-state">
        <h2>{hasFilters ? 'No dishes found' : 'Nothing on the menu yet'}</h2>
        <p>{hasFilters ? 'Try adjusting your search terms or category filter to find the dish you are looking for.' : 'Connect this terminal to load the restaurant menu.'}</p>
      </div>}

      {!isLoading && filtered.length > 0 && <div className="pc-table-wrap" role="table" aria-label="Menu items">
        <div className="pc-thead" role="row"><span>Dish</span><span>Barcode</span><span>Category</span><span>Price</span><span>Stock</span></div>
        {filtered.map(product => {
          const level = stock[product.id] ?? 0
          const catName = product.category_id ? catMap[product.category_id] ?? '' : ''
          const initial = product.name.charAt(0).toUpperCase() || 'P'
          const stockTone = level > 5 ? 'success' : level > 0 ? 'warning' : 'danger'
          const stockLabel = level > 5 ? `${level} in stock` : level > 0 ? `${level} left` : 'Out of stock'
          const pillLabel = level > 5 ? 'In Stock' : level > 0 ? 'Low Stock' : 'Out of Stock'
          return <div key={product.id} className="pc-row" role="row">
            <div className="pc-cell-product" role="cell">{product.image_url ? <img className="pc-avatar-img" src={product.image_url} alt="" aria-hidden="true" /> : <div className="pc-avatar" aria-hidden="true">{initial}</div>}
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span className="pc-prod-name" title={product.name}>{product.name}</span>
                  <DishAvailability isAvailable={product.is_available} unavailableUntil={product.unavailable_until} />
                </div>
                <div className="pc-prod-sku">{product.sku}</div>
              </div></div>
            <div className="pc-cell-code" role="cell">{product.barcode || '—'}</div>
            <div className="pc-cell" role="cell"><span className={`pc-badge ${catName ? '' : 'empty'}`}>{catName || 'Unassigned'}</span></div>
            <div className="pc-cell-price" role="cell">{formatCents(product.unit_price_cents, currency)}</div>
            <div className="pc-cell-stock-wrap" role="cell"><StatusBadge tone={stockTone}>{pillLabel}</StatusBadge><span className="pc-stock-qty">{stockLabel}</span></div>
          </div>
        })}
      </div>}
    </div>
  </div>
}
