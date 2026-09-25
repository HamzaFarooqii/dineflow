/**
 * ProductCatalogScreen — Menu management for the owner / manager back of house.
 * Styled with the MISE design system (see :root in styles.css):
 * - Warm neutral canvas, white cards, hairline borders, flat by default
 * - Archivo for text, IBM Plex Mono for prices, SKUs and counts
 * - Saffron reserved for focus / action-needed, semantic fills for stock status
 * - Offline-first liveQuery via Dexie, integer cents
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { liveQuery } from 'dexie'
import { formatCents, parseCents } from '../../../../packages/domain/src/money'
import { foodCostBps, formatFoodCostPercent } from '../../../../packages/domain/src/recipe-cost'
import { posDb, type LocalCategory, type LocalProduct, type LocalTaxRate } from '../lib/db'
import { activeStoreId, accessToken, configuredApiUrl, loadCatalog } from '../lib/catalog'
import { requireSupabase } from '../lib/supabase'
import { MetricCard } from '../components/MetricCard'
import { StatusBadge } from '../components/StatusBadge'
import { SelectField } from '../components/SelectField'
import { Search, X } from '../components/icons'
import { DishAvailability } from './menu/DishAvailability'
import { RecipeEditor } from './menu/RecipeEditor'
import { createUnit, loadRecipeData, saveRecipe, type RecipeData } from './menu/recipe-api'
import {
  EMPTY_RECIPE_DRAFT,
  costSavedRecipe,
  draftFromRecipe,
  isDraftBlank,
  validateDraft,
  type RecipeDraft,
  type RecipeDraftErrors,
  type SavedRecipe,
  type UnitKind,
} from './menu/recipe-draft'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
import './product-catalog.css'

function priceCentsOrNull(display: string): number | null {
  try {
    return parseCents(display)
  } catch {
    return null // not a valid amount yet — the price field shows its own error on submit
  }
}

type StockMap = Record<string, number>

interface FormState {
  name: string
  sku: string
  barcode: string
  categoryId: string
  newCategoryName: string
  taxRateId: string
  newTaxRateName: string
  newTaxRatePercent: string
  priceDisplay: string
  initialStock: string
}

interface FieldErrors {
  name?: string
  sku?: string
  barcode?: string
  price?: string
  initialStock?: string
  newCategoryName?: string
  newTaxRateName?: string
  newTaxRatePercent?: string
}

const EMPTY: FormState = {
  name: '',
  sku: '',
  barcode: '',
  categoryId: '',
  newCategoryName: '',
  taxRateId: '',
  newTaxRateName: '',
  newTaxRatePercent: '',
  priceDisplay: '',
  initialStock: '0',
}

// A tax rate percentage input ("8.25") converted to bounded integer basis points (0-10000),
// mirroring parseCents' strictness so a malformed or out-of-range rate is rejected client-side
// before it ever reaches the server.
function parseRateBps(input: string): number {
  const normalized = input.trim()
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Enter a percentage between 0 and 100 with up to two decimal places.')
  }
  const bps = Math.round(Number(normalized) * 100)
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('Tax rate must be between 0% and 100%.')
  return bps
}

export function ProductCatalogScreen() {
  const [products, setProducts] = useState<LocalProduct[] | null>(null)
  const [categories, setCategories] = useState<LocalCategory[]>([])
  const [taxRates, setTaxRates] = useState<LocalTaxRate[]>([])
  const [stockMap, setStockMap] = useState<StockMap>({})
  const [storeId, setStoreId] = useState('')
  const [currency, setCurrency] = useState('USD')

  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('all')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [errs, setErrs] = useState<FieldErrors>({})
  const [busy, setBusy] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const [notice, setNotice] = useState('')
  const [loadErr, setLoadErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imageError, setImageError] = useState('')
  const firstRef = useRef<HTMLInputElement>(null)
  const barcodeRef = useRef<HTMLInputElement>(null)

  // Recipe section — shared by the add-dish drawer and the per-dish recipe drawer (never open
  // at the same time, so one draft serves both).
  const [recipeData, setRecipeData] = useState<RecipeData | null>(null)
  const [recipeDataErr, setRecipeDataErr] = useState('')
  const [recipeDraft, setRecipeDraft] = useState<RecipeDraft>(EMPTY_RECIPE_DRAFT)
  const [recipeErrs, setRecipeErrs] = useState<RecipeDraftErrors>({})
  const [recipeProduct, setRecipeProduct] = useState<LocalProduct | null>(null)
  const [recipeBusy, setRecipeBusy] = useState(false)
  const [recipeSubmitErr, setRecipeSubmitErr] = useState('')

  const handleImagePick = (file: File | null) => {
    setImageError('')
    if (!file) {
      setImageFile(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setImageError('Choose an image file.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('Image must be 5MB or smaller.')
      return
    }
    setImageFile(file)
  }

  // Bootstrap store context
  useEffect(() => {
    let live = true
    void activeStoreId()
      .then(async (id) => {
        if (!live) return
        setStoreId(id)
        const cfg = await posDb.store_config.get(id)
        if (cfg) setCurrency(cfg.currency)
      })
      .catch((e) => {
        if (live) setLoadErr(e instanceof Error ? e.message : 'Could not load this restaurant.')
      })
    return () => {
      live = false
    }
  }, [])

  // Live Dexie subscriptions
  useEffect(() => {
    if (!storeId) return
    const s1 = liveQuery(() => posDb.products.where('store_id').equals(storeId).toArray()).subscribe({
      next: (rows) => setProducts(rows.sort((a, b) => a.name.localeCompare(b.name))),
      error: () => setLoadErr('Failed to read the menu.'),
    })
    const s2 = liveQuery(() => posDb.categories.where('store_id').equals(storeId).toArray()).subscribe({
      next: setCategories,
    })
    const s3 = liveQuery(() => posDb.tax_rates.where('store_id').equals(storeId).toArray()).subscribe({
      next: (rates) => {
        setTaxRates(rates)
        // Pre-select the first active tax rate as default when drawer hasn't been touched
        setForm((f) => {
          if (f.taxRateId !== '') return f
          const active = rates.find((r) => r.active)
          return active ? { ...f, taxRateId: active.id } : f
        })
      },
    })
    const s4 = liveQuery(async () => {
      const rows = await posDb.server_stock.toArray()
      const adjs = await posDb.stock_adjustments.toArray()
      const adj: Record<string, number> = {}
      for (const a of adjs) {
        if (!a.accepted_checkpoint) adj[a.product_id] = (adj[a.product_id] ?? 0) + a.delta
      }
      const m: StockMap = {}
      for (const s of rows) m[s.product_id] = s.current_stock + (adj[s.product_id] ?? 0)
      return m
    }).subscribe({ next: setStockMap })

    return () => {
      s1.unsubscribe()
      s2.unsubscribe()
      s3.unsubscribe()
      s4.unsubscribe()
    }
  }, [storeId])

  // Auto-load if empty
  useEffect(() => {
    if (!storeId || products === null || products.length > 0) return
    if (!navigator.onLine) {
      setLoadErr('No menu saved on this device. Connect to load it.')
      return
    }
    setRefreshing(true)
    void loadCatalog(storeId)
      .then(() => setNotice('Menu loaded from server.'))
      .catch((e) => setLoadErr(e instanceof Error ? e.message : 'Menu load failed.'))
      .finally(() => setRefreshing(false))
  }, [storeId, products])

  // Recipe data is back-office only and fetched live (not cached in Dexie).
  const reloadRecipeData = async (id: string) => {
    setRecipeDataErr('')
    if (!navigator.onLine) {
      setRecipeDataErr('Connect to load recipes and ingredient costs.')
      return
    }
    try {
      setRecipeData(await loadRecipeData(id))
    } catch (e) {
      setRecipeDataErr(e instanceof Error ? e.message : 'Could not load recipes.')
    }
  }
  useEffect(() => {
    if (storeId) void reloadRecipeData(storeId)
  }, [storeId])

  const recipeByProduct = useMemo(() => {
    const m: Record<string, SavedRecipe> = {}
    for (const r of recipeData?.recipes ?? []) m[r.product_id] = r
    return m
  }, [recipeData])

  const storeSavedRecipe = (saved: SavedRecipe) =>
    setRecipeData((d) => d && { ...d, recipes: [...d.recipes.filter((r) => r.product_id !== saved.product_id), saved] })

  const handleCreateUnit = async (unit: { name: string; abbreviation: string; kind: UnitKind }) => {
    const created = await createUnit(storeId, unit)
    setRecipeData((d) => d && { ...d, units: [...d.units, created].sort((a, b) => a.name.localeCompare(b.name)) })
    return created
  }

  const updateRecipeDraft = (draft: RecipeDraft) => {
    setRecipeDraft(draft)
    setRecipeErrs({})
  }

  const openRecipe = (product: LocalProduct) => {
    setRecipeProduct(product)
    setRecipeDraft(draftFromRecipe(recipeByProduct[product.id]))
    setRecipeErrs({})
    setRecipeSubmitErr('')
  }
  const closeRecipe = () => {
    if (recipeBusy) return
    setRecipeProduct(null)
    setRecipeDraft(EMPTY_RECIPE_DRAFT)
    setRecipeErrs({})
  }

  const handleRecipeSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!recipeProduct || !recipeData) return
    const result = validateDraft(recipeDraft, recipeData.ingredients)
    if (!result.ok) {
      setRecipeErrs(result.errors)
      return
    }
    setRecipeBusy(true)
    setRecipeSubmitErr('')
    try {
      storeSavedRecipe(await saveRecipe(storeId, recipeProduct.id, result.payload))
      setNotice(`Recipe for "${recipeProduct.name}" saved.`)
      setRecipeProduct(null)
      setRecipeDraft(EMPTY_RECIPE_DRAFT)
    } catch (err) {
      setRecipeSubmitErr(err instanceof Error ? err.message : 'Could not save the recipe.')
    } finally {
      setRecipeBusy(false)
    }
  }

  // Auto-focus first input when drawer opens
  useEffect(() => {
    if (drawerOpen) {
      setTimeout(() => firstRef.current?.focus(), 50)
    }
  }, [drawerOpen])

  const catMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of categories) m[c.id] = c.name
    return m
  }, [categories])

  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!products) return []
    return products.filter((p) => {
      if (catFilter !== 'all' && p.category_id !== catFilter) return false
      if (!q) return true
      return (
        p.name.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q)
      )
    })
  }, [products, catFilter, q])

  const total = products?.length ?? 0
  const inStock = products?.filter((p) => (stockMap[p.id] ?? 0) > 5).length ?? 0
  const lowStock = products?.filter((p) => {
    const s = stockMap[p.id] ?? 0
    return s > 0 && s <= 5
  }).length ?? 0
  const outStock = products?.filter((p) => (stockMap[p.id] ?? 0) <= 0).length ?? 0

  const setField = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setErrs((e) => ({ ...e, [k === 'priceDisplay' ? 'price' : (k as string)]: undefined }))
  }

  function validate(): FieldErrors {
    const e: FieldErrors = {}
    if (!form.name.trim()) e.name = 'Dish name is required.'
    else if (form.name.trim().length > 160) e.name = 'Max 160 characters.'
    if (!form.sku.trim()) e.sku = 'SKU is required.'
    else if (form.sku.trim().length > 80) e.sku = 'Max 80 characters.'
    if (form.barcode.trim() && !/^[A-Za-z0-9]+$/.test(form.barcode.trim())) {
      e.barcode = 'Alphanumeric characters only.'
    }
    if (form.categoryId === '__new__' && !form.newCategoryName.trim()) {
      e.newCategoryName = 'Category name required.'
    }
    if (form.taxRateId === '__new__') {
      if (!form.newTaxRateName.trim()) e.newTaxRateName = 'Tax rate name required.'
      if (!form.newTaxRatePercent.trim()) {
        e.newTaxRatePercent = 'Tax rate percentage required.'
      } else {
        try {
          parseRateBps(form.newTaxRatePercent)
        } catch (err) {
          e.newTaxRatePercent = err instanceof Error ? err.message : 'Invalid tax rate.'
        }
      }
    }
    if (!form.priceDisplay.trim()) {
      e.price = 'Price is required.'
    } else {
      try {
        parseCents(form.priceDisplay)
      } catch (err) {
        e.price = err instanceof Error ? err.message : 'Invalid price.'
      }
    }
    const qty = Number(form.initialStock)
    if (!Number.isInteger(qty) || qty < 0) {
      e.initialStock = 'Enter a whole number, 0 or more.'
    }
    return e
  }

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fieldErrs = validate()
    // An untouched recipe section is simply skipped; a started one must be valid before the
    // dish is created, so a bad recipe can't leave a half-saved dish behind.
    const recipeResult = isDraftBlank(recipeDraft) || !recipeData ? null : validateDraft(recipeDraft, recipeData.ingredients)
    if (Object.keys(fieldErrs).length || (recipeResult && !recipeResult.ok)) {
      setErrs(fieldErrs)
      if (recipeResult && !recipeResult.ok) setRecipeErrs(recipeResult.errors)
      return
    }
    setBusy(true)
    setSubmitErr('')
    try {
      const priceCents = parseCents(form.priceDisplay)
      const initialStock = Math.round(Number(form.initialStock))
      const finalCategoryId = form.categoryId && form.categoryId !== '__new__' ? form.categoryId : null
      const newCatName =
        form.categoryId === '__new__' && form.newCategoryName.trim()
          ? form.newCategoryName.trim()
          : null
      const finalTaxRateId = form.taxRateId && form.taxRateId !== '__new__' ? form.taxRateId : null
      const newTaxRateName = form.taxRateId === '__new__' ? form.newTaxRateName.trim() : null
      const newTaxRateBps = newTaxRateName ? Math.round(Number(form.newTaxRatePercent) * 100) : null

      const token = await accessToken()

      // Product images upload straight to Supabase Storage from the browser (publishable key +
      // RLS, same pattern the rest of the app uses for anything Supabase-authenticated) rather
      // than through our API — the API never needs to see the file itself, only the resulting
      // public URL. Path is "{store_id}/{uuid}.{ext}" so the storage RLS policy can check
      // is_store_admin() against the folder's store_id.
      let imageUrl: string | null = null
      if (imageFile) {
        const extension = (imageFile.name.split('.').pop() ?? 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
        const path = `${storeId}/${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await requireSupabase().storage
          .from('product-images')
          .upload(path, imageFile, { cacheControl: '3600', upsert: false, contentType: imageFile.type })
        if (uploadError) throw new Error(uploadError.message || 'Could not upload the dish photo.')
        imageUrl = requireSupabase().storage.from('product-images').getPublicUrl(path).data.publicUrl
      }

      const resp = await fetch(`${configuredApiUrl()}/catalog/products`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          store_id: storeId,
          name: form.name.trim(),
          sku: form.sku.trim(),
          barcode: form.barcode.trim() || null,
          category_id: finalCategoryId,
          new_category_name: newCatName,
          tax_rate_id: finalTaxRateId,
          image_url: imageUrl,
          new_tax_rate_name: newTaxRateName,
          new_tax_rate_rate_bps: newTaxRateBps,
          unit_price_cents: priceCents,
          initial_stock: initialStock,
        }),
      })
      const data = (await resp.json()) as {
        product?: {
          id: string
          store_id: string
          sku: string
          barcode: string | null
          name: string
          category_id: string | null
          tax_rate_id: string | null
          unit_price_cents: number
          active: boolean
          revision: number
          image_url: string | null
        }
        stock?: { product_id: string; current_stock: number }
        category?: { id: string; store_id: string; name: string; active: boolean }
        taxRate?: { id: string; store_id: string; name: string; rate_bps: number; active: boolean }
        message?: string
      }
      if (!resp.ok) throw new Error(data.message ?? `Server error (${resp.status})`)
      if (!data.product) throw new Error('Server returned no dish.')

      await posDb.transaction('rw', [posDb.products, posDb.server_stock, posDb.categories, posDb.tax_rates], async () => {
        if (data.category) await posDb.categories.put({ ...data.category, parent_id: null })
        if (data.taxRate) await posDb.tax_rates.put(data.taxRate)
        await posDb.products.put({ ...data.product!, unit_price_cents: data.product!.unit_price_cents })
        if (data.stock) {
          await posDb.server_stock.put({
            product_id: data.stock.product_id,
            current_stock: data.stock.current_stock,
            updated_at: new Date().toISOString(),
          })
        }
      })

      // The dish itself is saved at this point; a recipe failure is reported, not rolled back.
      let recipeFailure = ''
      if (recipeResult?.ok) {
        try {
          storeSavedRecipe(await saveRecipe(storeId, data.product.id, recipeResult.payload))
        } catch (err) {
          recipeFailure = err instanceof Error ? err.message : 'Unknown error.'
        }
      }
      if (recipeFailure) {
        setLoadErr(`"${data.product.name}" was added, but its recipe was not saved: ${recipeFailure} Open its recipe from the menu list to try again.`)
      } else {
        setNotice(`"${data.product.name}" is on the menu and ready on the register.`)
      }
      setDrawerOpen(false)
      setForm(EMPTY)
      setErrs({})
      setImageFile(null)
      setImageError('')
      setRecipeDraft(EMPTY_RECIPE_DRAFT)
      setRecipeErrs({})
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : 'Could not add the dish.')
    } finally {
      setBusy(false)
    }
  }

  const handleRefresh = async () => {
    if (!storeId || refreshing) return
    setRefreshing(true)
    setLoadErr('')
    setNotice('')
    try {
      const r = await loadCatalog(storeId)
      setNotice(r === 'updated' ? 'Menu refreshed.' : 'Already up to date.')
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : 'Refresh failed.')
    } finally {
      setRefreshing(false)
    }
  }

  const hasFilters = q !== '' || catFilter !== 'all'
  const isLoading = products === null && !loadErr
  const closeDrawer = () => {
    if (!busy) {
      setDrawerOpen(false)
      setForm(EMPTY)
      setErrs({})
      setImageFile(null)
      setImageError('')
      setRecipeDraft(EMPTY_RECIPE_DRAFT)
      setRecipeErrs({})
    }
  }

  return (
    <div className="pc-page">
      {/* ── Header ── */}
      <div className="pc-hero">
        <div>
          <p className="pc-breadcrumb">
            Back of house <span>/</span> Menu
          </p>
          <h1 className="pc-title">The menu.</h1>
          <p className="pc-subtitle">Build, price and track every dish your kitchen sends out.</p>
        </div>
        <div className="pc-actions">
          <button
            type="button"
            className="secondary-cta"
            onClick={() => void handleRefresh()}
            disabled={refreshing || !storeId}
          >
            {refreshing ? 'Refreshing…' : 'Refresh menu'}
          </button>
          <button
            id="pc-add-btn"
            type="button"
            className="cta"
            onClick={() => {
              setDrawerOpen(true)
              setSubmitErr('')
              setErrs({})
            }}
            disabled={!storeId}
          >
            + Add dish
          </button>
        </div>
      </div>

      {/* ── Stat Strip ── */}
      {products !== null && (
        <div className="pc-stats-strip">
          <MetricCard label="Menu Items" value={total} detail="Across all categories" />
          <MetricCard label="In Stock" value={inStock} detail="Ready to serve" />
          <MetricCard label="Low Stock" value={lowStock} detail="5 portions or fewer" />
          <MetricCard label="Out of Stock" value={outStock} detail="Needs restocking" />
        </div>
      )}

      {/* ── Main Content Area ── */}
      <div className="pc-content">
        {/* Notices */}
        {loadErr && (
          <div className="pc-alert error" role="alert">
            <span>{loadErr}</span>
            <button type="button" className="pc-alert-close" onClick={() => setLoadErr('')} aria-label="Dismiss">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
        )}
        {notice && (
          <div className="pc-alert success" role="status">
            <span>{notice}</span>
            <button type="button" className="pc-alert-close" onClick={() => setNotice('')} aria-label="Dismiss">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="pc-toolbar">
          <div className="pc-search">
            <Search aria-hidden="true" size={15} />
            <input
              id="pc-search"
              className="pc-search-input"
              type="search"
              placeholder="Search dishes by name, SKU or barcode…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search the menu"
            />
            {query && (
              <button
                type="button"
                className="pc-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X aria-hidden="true" size={14} />
              </button>
            )}
          </div>

          <SelectField
            id="pc-cat-filter"
            className="pc-cat-select"
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            aria-label="Filter by category"
          >
            <option value="all">All categories</option>
            {categories
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </SelectField>

          {hasFilters && (
            <button
              type="button"
              className="pc-clear-btn"
              onClick={() => {
                setQuery('')
                setCatFilter('all')
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Results Meta */}
        {!isLoading && filtered.length > 0 && (
          <div className="pc-meta">
            Showing {filtered.length} dish{filtered.length !== 1 ? 'es' : ''}
            {hasFilters && ` (filtered from ${total})`}
          </div>
        )}

        {/* Loading Skeletons */}
        {isLoading && (
          <div className="pc-table-wrap" aria-busy="true">
            <div className="pc-thead">
              <span>Dish</span>
              <span>Barcode</span>
              <span>Category</span>
              <span>Price</span>
              <span>Stock</span>
            </div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="pc-skel-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div className="pc-bone" style={{ width: 36, height: 36, borderRadius: 6, flexShrink: 0 }} />
                  <div style={{ display: 'grid', gap: 6, flex: 1 }}>
                    <div className="pc-bone" style={{ height: 14, width: '60%' }} />
                    <div className="pc-bone" style={{ height: 10, width: '35%' }} />
                  </div>
                </div>
                <div className="pc-bone" style={{ height: 12, width: '70%', marginLeft: 'auto' }} />
                <div className="pc-bone" style={{ height: 20, width: 80, borderRadius: 10, marginLeft: 'auto' }} />
                <div className="pc-bone" style={{ height: 16, width: 60, marginLeft: 'auto' }} />
                <div className="pc-bone" style={{ height: 14, width: 75, marginLeft: 'auto' }} />
              </div>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && products !== null && filtered.length === 0 && (
          <div className="pc-state">
            <h2>{hasFilters ? 'No dishes found' : 'Nothing on the menu yet'}</h2>
            <p>
              {hasFilters
                ? 'Try adjusting your search terms or category filter to find the dish you are looking for.'
                : 'Add your first dish. It goes live on the register the moment you save it.'}
            </p>
            {!hasFilters && (
              <button
                type="button"
                className="cta"
                onClick={() => {
                  setDrawerOpen(true)
                  setSubmitErr('')
                  setErrs({})
                }}
              >
                + Add first dish
              </button>
            )}
          </div>
        )}

        {/* Product Table */}
        {!isLoading && filtered.length > 0 && (
          <div className="pc-table-wrap" role="table" aria-label="Menu items">
            <div className="pc-thead" role="row">
              <span>Dish</span>
              <span>Barcode</span>
              <span>Category</span>
              <span>Price</span>
              <span>Stock</span>
            </div>
            {filtered.map((product) => {
              const stock = stockMap[product.id] ?? 0
              const catName = product.category_id ? catMap[product.category_id] ?? '' : ''
              const initial = product.name.charAt(0).toUpperCase() || 'P'
              const stockTone = stock > 5 ? 'success' : stock > 0 ? 'warning' : 'danger'
              const stockLabel = stock > 5 ? `${stock} in stock` : stock > 0 ? `${stock} left` : 'Out of stock'
              const pillLabel = stock > 5 ? 'In Stock' : stock > 0 ? 'Low Stock' : 'Out of Stock'

              return (
                <div key={product.id} className="pc-row" role="row">
                  <div className="pc-cell-product" role="cell">
                    {product.image_url ? (
                      <img className="pc-avatar-img" src={product.image_url} alt="" aria-hidden="true" />
                    ) : (
                      <div className="pc-avatar" aria-hidden="true">{initial}</div>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span className="pc-prod-name" title={product.name}>{product.name}</span>
                        <DishAvailability isAvailable={product.is_available} unavailableUntil={product.unavailable_until} />
                      </div>
                      <div className="pc-prod-sku">{product.sku}</div>
                    </div>
                  </div>
                  <div className="pc-cell-code" role="cell">{product.barcode || '—'}</div>
                  <div className="pc-cell" role="cell">
                    <span className={`pc-badge ${catName ? '' : 'empty'}`}>
                      {catName || 'Unassigned'}
                    </span>
                  </div>
                  <div className="pc-cell-price" role="cell">
                    {formatCents(product.unit_price_cents, currency)}
                    {recipeData && (() => {
                      const recipe = recipeByProduct[product.id]
                      if (!recipe) {
                        return (
                          <button type="button" className="recipe-row-link" onClick={() => openRecipe(product)}>
                            + Add recipe
                          </button>
                        )
                      }
                      const cost = costSavedRecipe(recipe, recipeData.ingredients)
                      const pct = formatFoodCostPercent(foodCostBps(cost.portionCostCents, product.unit_price_cents))
                      return (
                        <button
                          type="button"
                          className="recipe-row-link"
                          onClick={() => openRecipe(product)}
                          aria-label={`Edit recipe for ${product.name}, food cost ${pct}`}
                        >
                          Food cost {pct}{cost.complete ? '' : ' (partial)'}
                        </button>
                      )
                    })()}
                  </div>
                  <div className="pc-cell-stock-wrap" role="cell">
                    <StatusBadge tone={stockTone}>{pillLabel}</StatusBadge>
                    <span className="pc-stock-qty">{stockLabel}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Add Dish Slide-over Drawer ── */}
      {drawerOpen && (
        <div
          className="pc-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Add dish"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeDrawer()
          }}
        >
          <div className="pc-drawer">
            {/* Header — flat surface, hairline separator */}
            <div className="pc-drawer-head">
              <div className="pc-drawer-head-copy">
                <p className="pc-drawer-eyebrow">Menu management</p>
                <h2 className="pc-drawer-title">Add a dish</h2>
              </div>
              <button
                type="button"
                className="pc-drawer-close"
                onClick={closeDrawer}
                aria-label="Close"
              >
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            {/* Body */}
            <form className="pc-drawer-form" onSubmit={(e) => void handleSubmit(e)}>
            <div className="pc-drawer-body">
              {submitErr && (
                <div className="pc-alert error" role="alert">
                  <span>{submitErr}</span>
                  <button
                    type="button"
                    className="pc-alert-close"
                    onClick={() => setSubmitErr('')}
                    aria-label="Dismiss"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                </div>
              )}

              {/* Group 1: Identity */}
              <div className="pc-group">
                <p className="pc-group-label">Dish Details</p>
                <div className="pc-field">
                  <label htmlFor="pf-name">Dish name</label>
                  <input
                    ref={firstRef}
                    id="pf-name"
                    type="text"
                    className={errs.name ? 'err' : ''}
                    value={form.name}
                    onChange={(e) => setField('name', e.target.value)}
                    maxLength={160}
                    placeholder="e.g. Seared Scallops, Beurre Blanc"
                    autoComplete="off"
                  />
                  {errs.name && <p className="pc-field-err">{errs.name}</p>}
                </div>

                <div className="pc-pair">
                  <div className="pc-field">
                    <label htmlFor="pf-sku">SKU</label>
                    <input
                      id="pf-sku"
                      type="text"
                      className={errs.sku ? 'err' : ''}
                      value={form.sku}
                      onChange={(e) => setField('sku', e.target.value.trim())}
                      maxLength={80}
                      placeholder="MAIN-SCAL-01"
                      autoComplete="off"
                    />
                    {errs.sku && <p className="pc-field-err">{errs.sku}</p>}
                  </div>
                  <div className="pc-field">
                    <label htmlFor="pf-barcode">
                      Barcode <span className="pc-opt">optional</span>
                    </label>
                    <div className="pc-barcode-input">
                      <input
                        ref={barcodeRef}
                        id="pf-barcode"
                        type="text"
                        className={errs.barcode ? 'err' : ''}
                        value={form.barcode}
                        onChange={(e) => setField('barcode', e.target.value.trim())}
                        maxLength={80}
                        placeholder="Scan or type"
                        autoComplete="off"
                      />
                      <button className="pc-scan-button" type="button" onClick={() => barcodeRef.current?.focus()} aria-label="Scan barcode with connected scanner">⌁ Scan</button>
                    </div>
                    <p className="pc-field-hint">Select Scan, then use a connected USB or Bluetooth barcode scanner. Scanners enter the code here automatically.</p>
                    {errs.barcode && <p className="pc-field-err">{errs.barcode}</p>}
                  </div>
                </div>
              </div>

              {/* Group 2: Categorization & Tax */}
              <div className="pc-group">
                <p className="pc-group-label">Menu Category & Tax</p>
                <div className="pc-field">
                  <label htmlFor="pf-cat">
                    Category <span className="pc-opt">optional</span>
                  </label>
                  <select
                    id="pf-cat"
                    value={form.categoryId}
                    onChange={(e) => setField('categoryId', e.target.value)}
                  >
                    <option value="">No category</option>
                    {categories
                      .filter((c) => c.active)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    <option value="__new__">+ Create new category…</option>
                  </select>
                  {form.categoryId === '__new__' && (
                    <input
                      className={`pc-newcat ${errs.newCategoryName ? 'err' : ''}`}
                      type="text"
                      placeholder="Category name (e.g. Starters)"
                      value={form.newCategoryName}
                      onChange={(e) => setField('newCategoryName', e.target.value)}
                      maxLength={120}
                      autoComplete="off"
                    />
                  )}
                  {errs.newCategoryName && <p className="pc-field-err">{errs.newCategoryName}</p>}
                </div>

                <div className="pc-field">
                  <label htmlFor="pf-tax">
                    Tax rate <span className="pc-opt">optional</span>
                  </label>
                  <select
                    id="pf-tax"
                    value={form.taxRateId}
                    onChange={(e) => setField('taxRateId', e.target.value)}
                  >
                    <option value="">Tax exempt (0%)</option>
                    {taxRates
                      .filter((t) => t.active)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} — {(t.rate_bps / 100).toFixed(2)}%
                        </option>
                      ))}
                    <option value="__new__">+ Create new tax rate…</option>
                  </select>
                  {form.taxRateId === '__new__' && (
                    <div className="pc-newtax">
                      <input
                        className={errs.newTaxRateName ? 'err' : ''}
                        type="text"
                        placeholder="Tax rate name (e.g. Sales tax)"
                        value={form.newTaxRateName}
                        onChange={(e) => setField('newTaxRateName', e.target.value)}
                        maxLength={80}
                        autoComplete="off"
                      />
                      <input
                        className={errs.newTaxRatePercent ? 'err' : ''}
                        type="text"
                        inputMode="decimal"
                        placeholder="Percent (e.g. 8.5)"
                        value={form.newTaxRatePercent}
                        onChange={(e) => setField('newTaxRatePercent', e.target.value)}
                      />
                    </div>
                  )}
                  {errs.newTaxRateName && <p className="pc-field-err">{errs.newTaxRateName}</p>}
                  {errs.newTaxRatePercent && <p className="pc-field-err">{errs.newTaxRatePercent}</p>}
                </div>
              </div>

              {/* Group 3: Pricing & Inventory */}
              <div className="pc-group">
                <p className="pc-group-label">Pricing & Stock</p>
                <div className="pc-pair">
                  <div className="pc-field">
                    <label htmlFor="pf-price">Menu price</label>
                    <div className="pc-price-wrap">
                      <span className="pc-price-prefix">$</span>
                      <input
                        id="pf-price"
                        type="text"
                        inputMode="decimal"
                        className={errs.price ? 'err' : ''}
                        value={form.priceDisplay}
                        onChange={(e) => setField('priceDisplay', e.target.value)}
                        placeholder="4.50"
                        autoComplete="off"
                      />
                    </div>
                    {errs.price ? (
                      <p className="pc-field-err">{errs.price}</p>
                    ) : (
                      <p className="pc-field-hint">Stored in integer cents</p>
                    )}
                  </div>
                  <div className="pc-field">
                    <label htmlFor="pf-stock">Initial stock</label>
                    <input
                      id="pf-stock"
                      type="number"
                      inputMode="numeric"
                      className={errs.initialStock ? 'err' : ''}
                      value={form.initialStock}
                      onChange={(e) => setField('initialStock', e.target.value)}
                      min={0}
                      step={1}
                      placeholder="0"
                    />
                    {errs.initialStock && <p className="pc-field-err">{errs.initialStock}</p>}
                  </div>
                </div>
              </div>

              {/* Group 3b: Recipe — optional; food-cost % sits next to where the price is set */}
              <div className="pc-group">
                <p className="pc-group-label">
                  Recipe <span className="pc-opt">optional</span>
                </p>
                <RecipeEditor
                  draft={recipeDraft}
                  onChange={updateRecipeDraft}
                  errors={recipeErrs}
                  data={recipeData}
                  dataError={recipeDataErr}
                  menuPriceCents={priceCentsOrNull(form.priceDisplay)}
                  currency={currency}
                  disabled={busy}
                  onCreateUnit={handleCreateUnit}
                />
              </div>

              {/* Group 4: Dish Photo */}
              <div className="pc-group">
                <p className="pc-group-label">Dish Photo</p>
                <div className="pc-field">
                  <label htmlFor="pf-image">
                    Photo <span className="pc-opt">optional</span>
                  </label>
                  <input
                    id="pf-image"
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleImagePick(e.target.files?.[0] ?? null)}
                  />
                  {imageError ? (
                    <p className="pc-field-err">{imageError}</p>
                  ) : imageFile ? (
                    <p className="pc-field-hint">{imageFile.name} selected. Shown on the register once saved.</p>
                  ) : (
                    <p className="pc-field-hint">Shown on the menu and on the register. Falls back to a placeholder when absent.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="pc-drawer-foot">
              <button type="submit" className="pc-submit" disabled={busy || !storeId}>
                {busy ? 'Saving dish…' : 'Save to menu'}
              </button>
              <button type="button" className="pc-cancel" onClick={closeDrawer} disabled={busy}>
                Cancel
              </button>
            </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Recipe drawer for an existing dish — same drawer pattern as "Add dish" ── */}
      {recipeProduct && (
        <div
          className="pc-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`Recipe for ${recipeProduct.name}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRecipe()
          }}
        >
          <div className="pc-drawer">
            <div className="pc-drawer-head">
              <div className="pc-drawer-head-copy">
                <p className="pc-drawer-eyebrow">Recipe &amp; costing</p>
                <h2 className="pc-drawer-title">{recipeProduct.name}</h2>
              </div>
              <button type="button" className="pc-drawer-close" onClick={closeRecipe} aria-label="Close">
                <X aria-hidden="true" size={18} />
              </button>
            </div>

            <form className="pc-drawer-form" onSubmit={(e) => void handleRecipeSubmit(e)}>
              <div className="pc-drawer-body">
                {recipeSubmitErr && (
                  <div className="pc-alert error" role="alert">
                    <span>{recipeSubmitErr}</span>
                    <button type="button" className="pc-alert-close" onClick={() => setRecipeSubmitErr('')} aria-label="Dismiss">
                      <X aria-hidden="true" size={14} />
                    </button>
                  </div>
                )}
                <div className="pc-group">
                  <p className="pc-group-label">Recipe</p>
                  <div className="pc-field">
                    <p className="recipe-lines-label">Menu price</p>
                    <span className="pc-cell-price" style={{ textAlign: 'left' }}>
                      {formatCents(recipeProduct.unit_price_cents, currency)}
                    </span>
                  </div>
                  <RecipeEditor
                    draft={recipeDraft}
                    onChange={updateRecipeDraft}
                    errors={recipeErrs}
                    data={recipeData}
                    dataError={recipeDataErr}
                    menuPriceCents={recipeProduct.unit_price_cents}
                    currency={currency}
                    disabled={recipeBusy}
                    onCreateUnit={handleCreateUnit}
                  />
                </div>
              </div>
              <div className="pc-drawer-foot">
                <button type="submit" className="pc-submit" disabled={recipeBusy || !recipeData}>
                  {recipeBusy ? 'Saving recipe…' : 'Save recipe'}
                </button>
                <button type="button" className="pc-cancel" onClick={closeRecipe} disabled={recipeBusy}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
