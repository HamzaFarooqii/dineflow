/**
 * CashierProductsScreen — /pos/products
 * Read-only catalog browse for the cashier terminal (FEAT-CAT-01).
 * Reuses ProductCatalogScreen's visual language (product-catalog.css) and
 * read-side data shape, but bootstraps from terminal auth instead of Supabase,
 * and has no add/edit affordance — catalog creation stays owner/manager only.
 */
import { useEffect, useMemo, useState } from 'react'
import { liveQuery } from 'dexie'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type LocalCategory, type LocalProduct } from '../lib/db'
import { currentAccess } from '../terminal-auth/cache'
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
      if (!access?.policy.valid) { setLoadErr('Unlock this terminal before browsing products.'); return }
      const id = access.cache.device.store_id
      setStoreId(id)
      const config = await posDb.store_config.get(id)
      if (config && active) setCurrency(config.currency)
    }).catch(reason => { if (active) setLoadErr(reason instanceof Error ? reason.message : 'Could not load this store.') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!storeId) return
    const productsSub = liveQuery(() => posDb.products.where('store_id').equals(storeId).toArray()).subscribe({
      next: rows => setProducts(rows.filter(product => product.active).sort((a, b) => a.name.localeCompare(b.name))),
      error: () => setLoadErr('Failed to read the saved product catalog.'),
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
      <p className="pc-breadcrumb">Cashier terminal <span>/</span> Products</p>
      <h1 className="pc-title">Product catalog.</h1>
      <p className="pc-subtitle">Browse this store's products, prices and stock. Ask a manager to add or edit items.</p>
    </div></div>

    {products !== null && <div className="pc-stats-strip">
      <div className="pc-stat"><span className="pc-stat-label">Total Products</span><span className="pc-stat-value">{total}</span><span className="pc-stat-sub">Across all categories</span></div>
      <div className="pc-stat"><span className="pc-stat-label">In Stock</span><span className="pc-stat-value">{inStock}</span><span className="pc-stat-sub">Ready to sell</span></div>
      <div className="pc-stat"><span className="pc-stat-label">Low Stock</span><span className="pc-stat-value">{lowStock}</span><span className="pc-stat-sub">5 units or less</span></div>
      <div className="pc-stat"><span className="pc-stat-label">Out of Stock</span><span className="pc-stat-value">{outStock}</span><span className="pc-stat-sub">Needs replenishment</span></div>
    </div>}

    <div className="pc-content">
      {loadErr && <div className="pc-alert error" role="alert"><span>{loadErr}</span>
        <button type="button" className="pc-alert-close" onClick={() => setLoadErr('')} aria-label="Dismiss">✕</button></div>}

      <div className="pc-toolbar">
        <div className="pc-search">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" /><path d="M10 10 13.5 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <input id="pc-search" className="pc-search-input" type="search" placeholder="Search by name, SKU or barcode…" value={query} onChange={event => setQuery(event.target.value)} aria-label="Search products" />
          {query && <button type="button" className="pc-search-clear" onClick={() => setQuery('')} aria-label="Clear search">✕</button>}
        </div>
        <select id="pc-cat-filter" className="pc-cat-select" value={catFilter} onChange={event => setCatFilter(event.target.value)} aria-label="Filter by category">
          <option value="all">All categories</option>
          {categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        {hasFilters && <button type="button" className="pc-clear-btn" onClick={() => { setQuery(''); setCatFilter('all') }}>Clear filters</button>}
      </div>

      {!isLoading && filtered.length > 0 && <div className="pc-meta">Showing {filtered.length} product{filtered.length !== 1 ? 's' : ''}{hasFilters && ` (filtered from ${total})`}</div>}

      {isLoading && <div className="pc-table-wrap" aria-busy="true">
        <div className="pc-thead"><span>Product</span><span>Barcode</span><span>Category</span><span>Price</span><span>Stock</span></div>
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
        <h2>{hasFilters ? 'No products found' : 'No products yet'}</h2>
        <p>{hasFilters ? 'Try adjusting your search terms or category filter to find what you are looking for.' : 'Connect this terminal to load the store catalog.'}</p>
      </div>}

      {!isLoading && filtered.length > 0 && <div className="pc-table-wrap" role="table" aria-label="Products">
        <div className="pc-thead" role="row"><span>Product</span><span>Barcode</span><span>Category</span><span>Price</span><span>Stock</span></div>
        {filtered.map(product => {
          const level = stock[product.id] ?? 0
          const catName = product.category_id ? catMap[product.category_id] ?? '' : ''
          const initial = product.name.charAt(0).toUpperCase() || 'P'
          const stockCls = level > 5 ? 'in' : level > 0 ? 'low' : 'out'
          const stockLabel = level > 5 ? `${level} in stock` : level > 0 ? `${level} left` : 'Out of stock'
          const pillLabel = level > 5 ? 'In Stock' : level > 0 ? 'Low Stock' : 'Out of Stock'
          return <div key={product.id} className="pc-row" role="row">
            <div className="pc-cell-product" role="cell">{product.image_url ? <img className="pc-avatar-img" src={product.image_url} alt="" aria-hidden="true" /> : <div className="pc-avatar" aria-hidden="true">{initial}</div>}
              <div style={{ minWidth: 0 }}><div className="pc-prod-name" title={product.name}>{product.name}</div><div className="pc-prod-sku">{product.sku}</div></div></div>
            <div className="pc-cell-code" role="cell">{product.barcode || '—'}</div>
            <div className="pc-cell" role="cell"><span className={`pc-badge ${catName ? '' : 'empty'}`}>{catName || 'Unassigned'}</span></div>
            <div className="pc-cell-price" role="cell">{formatCents(product.unit_price_cents, currency)}</div>
            <div className="pc-cell-stock-wrap" role="cell"><span className={`pc-stock-pill ${stockCls}`}><span className={`pc-pill-dot ${stockCls}`} aria-hidden="true" />{pillLabel}</span><span className="pc-stock-qty">{stockLabel}</span></div>
          </div>
        })}
      </div>}
    </div>
  </div>
}
