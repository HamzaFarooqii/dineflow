import { useEffect, useState, type ReactNode } from 'react'
import { liveQuery } from 'dexie'
import { Link } from 'react-router-dom'
import { formatCents } from '../../../../packages/domain/src/money'
import { posDb, type StoreConfig } from '../lib/db'
import { resolveFinancialAccess } from '../lib/management-access'
import {
  calculateLocalSalesReport,
  todayInTimezone,
  calculateTopProducts,
  calculateLowStockItems,
  getRecentOrders,
  calculateCashierShift,
  type LocalSalesReport,
  type TopProduct,
  type LowStockItem,
  type RecentOrderSummary,
  type CashierShiftSummary,
} from '../lib/reporting'
import { currentAccess } from '../terminal-auth/cache'
import { configuredApiUrl, loadCatalog } from '../lib/catalog'
import { classifySyncState, type SyncState } from '../lib/order-sync-core'
import { fetchDailySummary, fetchOrdersPage, fetchOversold, type ServerOversoldProduct } from '../lib/server-reports'
import { buildCsv, downloadCsv } from '../lib/csv'
import { PageHeader } from '../components/PageHeader'
import { MetricCard } from '../components/MetricCard'
import { Wallet, RefreshCw, Award, AlertTriangle, CircleAlert, Receipt } from '../components/icons'
import './reporting.css'

// Health-check the API the same way ConnectionAndSync/CashierDashboardScreen do: navigator.onLine
// alone doesn't tell us the API is actually up, so probe /health with a short timeout.
async function isApiReachable(): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    const response = await fetch(`${configuredApiUrl()}/health`, { signal: AbortSignal.timeout(3_000) })
    return response.ok
  } catch {
    return false
  }
}

interface ReportState {
  storeId: string
  day: string
  config: StoreConfig
  report: LocalSalesReport
  topProducts: TopProduct[]
  lowStock: LowStockItem[]
  recentOrders: RecentOrderSummary[]
}

function useFinancialReport(day?: string) {
  const [localState, setLocalState] = useState<ReportState>()
  const [state, setState] = useState<ReportState>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let subscription: { unsubscribe(): void } | undefined
    setLocalState(undefined)
    setError('')
    void resolveFinancialAccess()
      .then(async access => {
        let config = await posDb.store_config.get(access.storeId)
        // A browser that has never opened the register/products screens has no local catalog
        // snapshot yet — the app is online-and-offline, so bootstrap it from the server the same
        // way opening Register would, instead of hard-failing reporting on a brand-new device.
        if (!config && navigator.onLine) {
          try {
            await loadCatalog(access.storeId)
            config = await posDb.store_config.get(access.storeId)
          } catch {
            // Fall through to the "no store configuration" error below — e.g. offline, the
            // request failed, or there are unresolved outbox entries loadCatalog refuses to
            // overwrite. Reporting still needs a config either way.
          }
        }
        if (!config) throw new Error('No store configuration is saved in this browser. Connect once with this browser online to load it.')
        const reportDay = day || todayInTimezone(config.timezone)

        subscription = liveQuery(async () => {
          const [orders, items, payments, outbox, products, stock, adjustments] = await Promise.all([
            posDb.orders.where('store_id').equals(access.storeId).toArray(),
            posDb.order_items.toArray(),
            posDb.payments.toArray(),
            posDb.outbox.where('store_id').equals(access.storeId).toArray(),
            posDb.products.where('store_id').equals(access.storeId).toArray(),
            posDb.server_stock.toArray(),
            posDb.stock_adjustments.toArray(),
          ])

          const report = calculateLocalSalesReport(access.storeId, reportDay, config.timezone, {
            orders,
            items,
            payments,
            outbox,
          })
          const topProducts = calculateTopProducts(items, orders, access.storeId, reportDay, config.timezone, 4)
          const lowStock = calculateLowStockItems(products, stock, adjustments, 5, 5)
          const recentOrders = getRecentOrders(orders, items, payments, access.storeId, 5)

          return { storeId: access.storeId, day: reportDay, config, report, topProducts, lowStock, recentOrders }
        }).subscribe({
          next: data => {
            if (active) setLocalState(data)
          },
          error: reason => {
            if (active) setError(reason instanceof Error ? reason.message : 'Unable to calculate reporting totals.')
          },
        })
      })
      .catch(reason => {
        if (active) setError(reason instanceof Error ? reason.message : 'Reporting access could not be verified.')
      })

    return () => {
      active = false
      subscription?.unsubscribe()
      setLocalState(undefined)
    }
  }, [day])

  // Precedence: when the API is reachable, prefer the server's cross-device daily summary for the
  // financial totals so a second device sees every sale for the store, not just this browser's own.
  // pendingCount/rejectedAmountCents etc. stay sourced from the local outbox either way, since those
  // describe this browser's own queued/rejected sync state and have no server-side equivalent (a
  // rejected sale never reaches pos_orders at all). Falls back to the local Dexie calculation as-is
  // whenever offline or the request fails, so offline use is unaffected.
  useEffect(() => {
    let active = true
    if (!localState) {
      setState(undefined)
      return
    }
    void (async () => {
      let report = localState.report
      if (await isApiReachable()) {
        try {
          const summary = await fetchDailySummary(localState.storeId, localState.day)
          report = {
            ...summary,
            pendingCount: localState.report.pendingCount,
            pendingAmountCents: localState.report.pendingAmountCents,
            rejectedCount: localState.report.rejectedCount,
            rejectedAmountCents: localState.report.rejectedAmountCents,
          }
        } catch {
          // Server summary unavailable — fall through to the local calculation.
        }
      }
      // Only commit once resolved, so a table change elsewhere in the store (e.g. a stock
      // adjustment) that re-triggers this effect doesn't flash the totals down to the local-only
      // figure while the server summary re-fetches; the previously merged state stays on screen.
      if (active) setState({ ...localState, report })
    })()
    return () => {
      active = false
    }
  }, [localState])

  return { state, error }
}

// Oversold panel data: pulled straight from /reports/oversold (server truth across every device),
// unlike calculateLowStockItems which only reflects this browser's synced stock projection. Only
// meaningful when the API is reachable — there is no offline/local equivalent to fall back to, so
// the panel simply stays empty rather than showing stale or misleading data.
function useOversoldProducts(storeId: string | undefined) {
  const [products, setProducts] = useState<ServerOversoldProduct[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setProducts(undefined)
    setError('')
    if (!storeId) return
    void (async () => {
      if (!(await isApiReachable())) {
        if (active) setError('Connect to the internet to load restaurant-wide oversold items.')
        return
      }
      try {
        const result = await fetchOversold(storeId)
        if (active) setProducts(result)
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load oversold items.')
      }
    })()
    return () => {
      active = false
    }
  }, [storeId])
  return { products, error }
}

// Shifts a YYYY-MM-DD calendar-day string by a number of whole days. Pure date-string arithmetic
// (no timezone lookup) — good enough for a "vs yesterday" comparison per the visual-redesign scope,
// which is explicitly meant to stay simple rather than reproduce calendarDay()'s timezone precision.
function shiftDay(day: string, deltaDays: number): string {
  const [year, month, date] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1, date))
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays)
  return shifted.toISOString().slice(0, 10)
}

// Simple day-over-day comparison: fetches the prior calendar day's server-side recorded total so the
// dashboard can show a "vs yesterday" delta next to the headline KPI. Server-only (like the oversold
// panel and cashier breakdown) — there's no meaningful offline equivalent, so the badge just stays
// hidden when the API is unreachable rather than showing a stale or misleading number.
function usePreviousDayTotal(storeId: string | undefined, day: string | undefined) {
  const [previousCents, setPreviousCents] = useState<number>()
  useEffect(() => {
    let active = true
    setPreviousCents(undefined)
    if (!storeId || !day) return
    void (async () => {
      if (!(await isApiReachable())) return
      try {
        const summary = await fetchDailySummary(storeId, shiftDay(day, -1))
        if (active) setPreviousCents(summary.recordedTotalCents)
      } catch {
        // No comparison available for the prior day — badge stays hidden.
      }
    })()
    return () => {
      active = false
    }
  }, [storeId, day])
  return previousCents
}

export interface CashierBreakdownRow { employeeId: string | null; name: string; orderCount: number; totalCents: number; refundedCount: number; refundedCents: number }

// Sales by staff: pages through the same cross-device /reports/orders drill-down used for remote
// history restoration, grouping by cashierName/employeeId (the API field names are unchanged; only
// the user-facing label reads "staff" now). Server-only (like the oversold panel) —
// employee attribution across every device isn't available from a single browser's local Dexie data.
function useCashierBreakdown(storeId: string | undefined, day: string | undefined) {
  const [rows, setRows] = useState<CashierBreakdownRow[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setRows(undefined)
    setError('')
    if (!storeId || !day) return
    void (async () => {
      if (!(await isApiReachable())) {
        if (active) setError('Connect to the internet to load the staff breakdown.')
        return
      }
      try {
        const totals = new Map<string, CashierBreakdownRow>()
        let cursor: string | null | undefined
        do {
          const page = await fetchOrdersPage(storeId, day, cursor, 200)
          for (const order of page.orders) {
            const key = order.employeeId ?? 'unassigned'
            const existing = totals.get(key)
            if (existing) {
              existing.orderCount += 1
              existing.totalCents += order.totalCents
              if (order.refunded) { existing.refundedCount += 1; existing.refundedCents += order.totalCents }
            } else {
              totals.set(key, {
                employeeId: order.employeeId,
                name: order.cashierName ?? 'Unassigned',
                orderCount: 1,
                totalCents: order.totalCents,
                refundedCount: order.refunded ? 1 : 0,
                refundedCents: order.refunded ? order.totalCents : 0,
              })
            }
          }
          cursor = page.next_cursor
        } while (cursor && active)
        if (active) setRows(Array.from(totals.values()).sort((a, b) => b.totalCents - a.totalCents))
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load the staff breakdown.')
      }
    })()
    return () => {
      active = false
    }
  }, [storeId, day])
  return { rows, error }
}

const Money = ({ cents, currency }: { cents: number; currency: string }) => <>{formatCents(cents, currency)}</>

// Builds the same rows regardless of whether `report` came from the local Dexie calculation or the
// server daily-summary — both are normalized to the LocalSalesReport shape by useFinancialReport,
// so this export needs no branching on data source.
function exportDailyReportCsv(state: ReportState) {
  const { report, config, day } = state
  const rows: (string | number)[][] = [
    ['Dineflow — daily sales report'],
    ['Store', config.name],
    ['Report date', day],
    ['Timezone', config.timezone],
    ['Currency', config.currency],
    [],
    ['Metric', 'Value'],
    ['Gross sales', formatCents(report.grossSalesCents, config.currency)],
    ['Discounts', formatCents(report.discountCents, config.currency)],
    ['Net sales', formatCents(report.netSalesCents, config.currency)],
    ['Tax collected', formatCents(report.taxCents, config.currency)],
    ['Cash takings', formatCents(report.cashTakingsCents, config.currency)],
    ['Card takings', formatCents(report.cardTakingsCents, config.currency)],
    ['Recorded total', formatCents(report.recordedTotalCents, config.currency)],
    ['Completed orders', report.completedOrderCount],
    ['Average ticket', formatCents(report.averageSaleCents, config.currency)],
    ['Items sold', report.itemsSold],
    ['Pending sync — count', report.pendingCount],
    ['Pending sync — amount', formatCents(report.pendingAmountCents, config.currency)],
    ['Rejected — count', report.rejectedCount],
    ['Rejected — amount', formatCents(report.rejectedAmountCents, config.currency)],
  ]
  downloadCsv(`dineflow-daily-report-${day}.csv`, buildCsv(rows))
}

// Time-of-day greeting -- a small, low-risk touch toward "immediately communicate restaurant
// performance and status" rather than a flat "Today at a glance" for everyone at every hour.
function timeGreeting(now = new Date()): string {
  const hour = now.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

// Replaces the old DeltaBadge component with a pure function feeding MetricCard's structured
// delta prop -- null when there's nothing meaningful to compare (both days at zero).
function computeDelta(current: number, previous: number): { direction: 'up' | 'down' | 'flat'; label: string } | null {
  if (current === 0 && previous === 0) return null
  const diff = current - previous
  const pct = previous > 0 ? Math.round((diff / previous) * 100) : diff > 0 ? 100 : 0
  return { direction: pct === 0 ? 'flat' : diff > 0 ? 'up' : 'down', label: `${Math.abs(pct)}% vs yesterday` }
}

export function OwnerDashboardScreen({ greetingName }: { greetingName?: string } = {}) {
  const { state, error } = useFinancialReport()
  const { products: oversoldProducts, error: oversoldError } = useOversoldProducts(state?.storeId)
  const previousDayTotal = usePreviousDayTotal(state?.storeId, state?.day)
  if (error) return <AccessMessage message={error} />
  if (!state) return <DashboardSkeleton />
  const { report, config, topProducts, lowStock, recentOrders } = state

  const totalTakings = report.cashTakingsCents + report.cardTakingsCents
  const cashPct = totalTakings > 0 ? Math.round((report.cashTakingsCents / totalTakings) * 100) : 0
  const cardPct = totalTakings > 0 ? 100 - cashPct : 0
  const delta = previousDayTotal === undefined ? undefined : computeDelta(report.recordedTotalCents, previousDayTotal) ?? undefined

  return (
    <section className="reporting-page owner-dashboard">
      <PageHeader
        kicker={`RESTAURANT OVERVIEW · ${config.name}`}
        title={`${timeGreeting()}${greetingName ? `, ${greetingName}` : ''}.`}
        subtitle={`Recorded sales for today in ${config.timezone}. Offline and pending sales remain included.`}
        actions={<>
          <Link className="report-secondary" to="/reports">Daily report <span aria-hidden="true">→</span></Link>
          <Link className="report-primary" to="/register">Open register <span aria-hidden="true">→</span></Link>
        </>}
      />

      {/* KPI Stats — the headline metric is visually emphasized, the rest stay lighter-weight */}
      <div className="metric-grid">
        <MetricCard
          label="Today’s recorded sales"
          value={<Money cents={report.recordedTotalCents} currency={config.currency} />}
          detail="Total revenue completed locally"
          featured
          delta={delta}
        />
        <MetricCard label="Completed orders" value={report.completedOrderCount} detail="Recorded in this browser" />
        <MetricCard label="Average ticket" value={<Money cents={report.averageSaleCents} currency={config.currency} />} detail="Original sale total ÷ orders" />
        <MetricCard label="Items sold" value={report.itemsSold} detail="Total items rung in today" />
      </div>

      {/* Tender Breakdown & Sync Status */}
      <div className="dashboard-subgrid">
        <section className="dashboard-panel tender-panel">
          <div className="panel-header">
            <h2><Wallet aria-hidden="true" size={16} className="panel-icon" />Payment breakdown</h2>
            <small>Cash vs. Card distribution</small>
          </div>
          {totalTakings > 0 ? (
            <div className="tender-distribution">
              <TenderDonut cashPct={cashPct} cardPct={cardPct} />
              <div className="tender-legend">
                <div className="legend-item">
                  <span className="dot dot-cash" />
                  <span>Cash takings</span>
                  <strong><Money cents={report.cashTakingsCents} currency={config.currency} /></strong>
                  <small>({cashPct}%)</small>
                </div>
                <div className="legend-item">
                  <span className="dot dot-card" />
                  <span>Card payments</span>
                  <strong><Money cents={report.cardTakingsCents} currency={config.currency} /></strong>
                  <small>({cardPct}%)</small>
                </div>
              </div>
            </div>
          ) : (
            <p className="empty-panel-copy">No sales completed yet today.</p>
          )}
        </section>

        <section className="unresolved-panel">
          <div>
            <h2><RefreshCw aria-hidden="true" size={16} className="panel-icon" />Sync queue status</h2>
            <p>Sales are recorded immediately in browser storage and uploaded when connected.</p>
          </div>
          <MetricCard label="Pending sync" value={report.pendingCount} detail={<Money cents={report.pendingAmountCents} currency={config.currency} />} />
          <MetricCard label="Rejected" value={report.rejectedCount} detail={<Money cents={report.rejectedAmountCents} currency={config.currency} />} className="rejected" />
        </section>
      </div>

      {/* Two-Column Analytics: Top Products & Inventory Health */}
      <div className="dashboard-columns">
        <section className="dashboard-panel">
          <div className="panel-header">
            <h2><Award aria-hidden="true" size={16} className="panel-icon" />Top menu items</h2>
            <small>Best sellers today by quantity</small>
          </div>
          {topProducts.length ? (
            <ol className="ranked-list">
              {topProducts.map((p, idx) => (
                <li key={p.productId} className="ranked-row">
                  <span className="rank-badge">{idx + 1}</span>
                  <div className="ranked-details">
                    <strong>{p.name}</strong>
                    <small>{p.quantity} {p.quantity === 1 ? 'item' : 'items'} sold</small>
                  </div>
                  <b><Money cents={p.totalCents} currency={config.currency} /></b>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-panel-copy">No menu item sales recorded yet today.</p>
          )}
        </section>

        <section className="dashboard-panel">
          <div className="panel-header">
            <h2><AlertTriangle aria-hidden="true" size={16} className="panel-icon" />Stock alerts</h2>
            <small>Low inventory and out of stock</small>
          </div>
          {lowStock.length ? (
            <ul className="alert-list">
              {lowStock.map(item => (
                <li key={item.productId} className="alert-row">
                  <div>
                    <strong>{item.name}</strong>
                    <small>SKU: {item.sku}</small>
                  </div>
                  <span className={`stock-pill ${item.currentStock <= 0 ? 'out' : 'low'}`}>
                    {item.currentStock <= 0 ? 'Out of stock' : `${item.currentStock} left`}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-panel-copy healthy">✓ All inventory levels are healthy.</p>
          )}
        </section>

        <section className="dashboard-panel">
          <div className="panel-header">
            <h2><CircleAlert aria-hidden="true" size={16} className="panel-icon" />Oversold items</h2>
            <small>Restaurant-wide stock gone negative, across every device</small>
          </div>
          {oversoldError ? (
            <p className="empty-panel-copy">{oversoldError}</p>
          ) : oversoldProducts === undefined ? (
            <p className="empty-panel-copy" role="status">Loading server oversold data…</p>
          ) : oversoldProducts.length ? (
            <ul className="alert-list">
              {oversoldProducts.map(item => (
                <li key={item.id} className="alert-row">
                  <div>
                    <strong>{item.name}</strong>
                    <small>SKU: {item.sku}</small>
                  </div>
                  <span className="stock-pill out">{item.current_stock} oversold</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-panel-copy healthy">✓ No items are oversold across the restaurant.</p>
          )}
        </section>
      </div>

      {/* Recent Store Orders */}
      <section className="dashboard-panel recent-orders-panel">
        <div className="panel-header">
          <div>
            <h2><Receipt aria-hidden="true" size={16} className="panel-icon" />Recent orders</h2>
            <small>Latest checks across the restaurant</small>
          </div>
          <Link className="panel-link" to="/orders">View all orders <span aria-hidden="true">→</span></Link>
        </div>
        {recentOrders.length ? (
          <div className="table-wrapper">
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>Receipt #</th>
                  <th>Time</th>
                  <th>Items</th>
                  <th>Tender</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map(o => (
                  <tr key={o.id}>
                    <td><Link className="receipt-link" to={`/orders/${encodeURIComponent(o.id)}`}>{o.receiptNumber}</Link></td>
                    <td>{new Date(o.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}</td>
                    <td><span className={`method-badge ${o.paymentMethod}`}>{o.paymentMethod.toUpperCase()}</span></td>
                    <td><span className={`sync-pill ${o.refunded ? 'refunded' : o.syncStatus}`}>{o.refunded ? 'refunded' : o.syncStatus}</span></td>
                    <td className="num"><strong><Money cents={o.totalCents} currency={config.currency} /></strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-panel-copy">No orders have been recorded yet.</p>
        )}
      </section>
    </section>
  )
}

export function ReportsScreen() {
  const [day, setDay] = useState('')
  const { state, error } = useFinancialReport(day || undefined)
  const { rows: cashierRows, error: cashierError } = useCashierBreakdown(state?.storeId, state?.day)
  useEffect(() => {
    if (state && !day) setDay(todayInTimezone(state.config.timezone))
  }, [state, day])
  return (
    <section className="reporting-page reports-detail">
      <PageHeader
        kicker="THIS BROWSER / REGISTER-LOCAL"
        title="Daily sales report."
        subtitle="Calendar days use the saved store timezone and the recorded sale time."
        actions={state && (
          <div className="reports-heading-controls">
            <label className="day-picker">
              Report date
              <input type="date" value={day} onChange={event => setDay(event.target.value)} />
            </label>
            <button type="button" className="report-secondary export-csv-btn" onClick={() => exportDailyReportCsv(state)}>
              Export CSV <span aria-hidden="true">↓</span>
            </button>
          </div>
        )}
      />
      {error && <AccessMessage message={error} embedded />}
      {!error && !state && <ReportLinesSkeleton />}
      {state && (
        <>
          <div className="report-metrics">
            <ReportLine label="Gross sales" hint="Subtotal before discounts and tax" cents={state.report.grossSalesCents} currency={state.config.currency} />
            <ReportLine label="Discounts" hint="Older records count as zero" cents={state.report.discountCents} currency={state.config.currency} />
            <ReportLine label="Net sales" hint="Gross sales minus discounts and refunded merchandise" cents={state.report.netSalesCents} currency={state.config.currency} />
            <ReportLine label="Tax collected" hint="Tax after refunds" cents={state.report.taxCents} currency={state.config.currency} />
            <ReportLine label="Cash takings" hint="Cash received less cash refunds; change excluded" cents={state.report.cashTakingsCents} currency={state.config.currency} />
            <ReportLine label="Card takings" hint="Card payments less card refunds" cents={state.report.cardTakingsCents} currency={state.config.currency} />
            <ReportLine label="Recorded total" hint={`${state.report.completedOrderCount} completed order${state.report.completedOrderCount === 1 ? '' : 's'}; refunds deducted`} cents={state.report.recordedTotalCents} currency={state.config.currency} emphasized />
          </div>
          <section className="unresolved-panel">
            <div>
              <h2>Unresolved sales</h2>
              <p>Included in recorded totals and shown separately here.</p>
            </div>
            <MetricCard label="Pending" value={state.report.pendingCount} detail={<Money cents={state.report.pendingAmountCents} currency={state.config.currency} />} />
            <MetricCard label="Rejected" value={state.report.rejectedCount} detail={<Money cents={state.report.rejectedAmountCents} currency={state.config.currency} />} className="rejected" />
          </section>
          <section className="unresolved-panel">
            <div>
              <h2>Refunds</h2>
              <p>Original sales remain in gross figures; refunds reduce net sales and takings.</p>
            </div>
            <MetricCard label="Refunded" value={state.report.refundedCount} detail={<Money cents={state.report.refundedAmountCents} currency={state.config.currency} />} className="rejected" />
          </section>

          <section className="dashboard-panel">
            <div className="panel-header">
              <h2>Sales by staff</h2>
              <small>Gross sales and refunds across devices for {day}</small>
            </div>
            {cashierError ? (
              <p className="empty-panel-copy">{cashierError}</p>
            ) : cashierRows === undefined ? (
              <p className="empty-panel-copy" role="status">Loading staff breakdown…</p>
            ) : cashierRows.length ? (
              <ul className="ranked-list">
                {cashierRows.map(row => (
                  <li key={row.employeeId ?? 'unassigned'} className="ranked-row">
                    <div className="ranked-details">
                      <strong>{row.name}</strong>
                      <small>{row.orderCount} {row.orderCount === 1 ? 'sale' : 'sales'}{row.refundedCount ? ` · ${row.refundedCount} refunded (${formatCents(row.refundedCents, state.config.currency)})` : ''}</small>
                    </div>
                    <b><Money cents={row.totalCents} currency={state.config.currency} /> gross</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-panel-copy">No sales recorded for this day yet.</p>
            )}
          </section>
        </>
      )}
    </section>
  )
}

interface CashierDashboardState {
  cashier: string
  terminal: string
  receiptPrefix: string
  storeId: string
  currency: string
  online: boolean
  syncCounts: Record<SyncState, number>
  shift: CashierShiftSummary
  recentOrders: RecentOrderSummary[]
  managerApproval: boolean
}

export function CashierDashboardScreen() {
  const [state, setState] = useState<CashierDashboardState>()
  const [apiReachable, setApiReachable] = useState<boolean | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let subscription: { unsubscribe(): void } | undefined
    const load = async () => {
      const access = await currentAccess()
      if (!access?.cache || !access.employee || !access.policy.valid) throw new Error('Cashier access is no longer valid.')
      const { cache, employee, policy } = access
      const config = await posDb.store_config.get(cache.device.store_id)
      const timezone = config?.timezone || 'UTC'
      const currency = config?.currency || 'USD'
      const today = todayInTimezone(timezone)

      subscription = liveQuery(async () => {
        const [allStoreOrders, items, payments, outbox] = await Promise.all([
          posDb.orders.where('store_id').equals(cache.device.store_id).toArray(),
          posDb.order_items.toArray(),
          posDb.payments.toArray(),
          posDb.outbox.where('store_id').equals(cache.device.store_id).toArray(),
        ])

        const terminalOrders = allStoreOrders.filter(o => o.receipt_number.startsWith(cache.device.receipt_prefix))
        const shift = calculateCashierShift(terminalOrders, payments, cache.device.store_id, today, timezone)
        const recentOrders = getRecentOrders(terminalOrders, items, payments, cache.device.store_id, 5)

        return {
          cashier: employee.name,
          terminal: cache.device.name,
          receiptPrefix: cache.device.receipt_prefix,
          storeId: cache.device.store_id,
          currency,
          online: navigator.onLine,
          syncCounts: outbox.filter(entry => entry.entity_type === 'order').reduce((counts, entry) => {
            counts[classifySyncState(entry)]++
            return counts
          }, { pending: 0, in_flight: 0, blocked: 0, rejected: 0, synced: 0 } as Record<SyncState, number>),
          shift,
          recentOrders,
          managerApproval: policy.managerApproval,
        }
      }).subscribe(value => {
        if (active) setState(value)
      })
    }
    void load().catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Unable to load terminal status.')
    })
    const connection = () => setState(previous => (previous ? { ...previous, online: navigator.onLine } : previous))
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    return () => {
      active = false
      subscription?.unsubscribe()
      window.removeEventListener('online', connection)
      window.removeEventListener('offline', connection)
      setState(undefined)
    }
  }, [])

  useEffect(() => {
    let active = true
    const checkApi = async () => {
      const reachable = await isApiReachable()
      if (active) setApiReachable(reachable)
    }
    void checkApi()
    const timer = window.setInterval(() => void checkApi(), 15_000)
    window.addEventListener('online', checkApi)
    window.addEventListener('offline', checkApi)
    return () => {
      active = false
      window.clearInterval(timer)
      window.removeEventListener('online', checkApi)
      window.removeEventListener('offline', checkApi)
    }
  }, [])

  if (error) return <AccessMessage message={error} />
  if (!state) return <section className="reporting-page" role="status">Loading terminal workspace…</section>

  const cashInDrawer = state.shift.cashCents - state.shift.changeCents

  return (
    <section className="reporting-page cashier-dashboard">
      <header className="reporting-heading">
        <div>
          <p className="kicker">SERVICE TERMINAL · {state.terminal}</p>
          <h1>Hello, {state.cashier}.</h1>
          <p>Terminal ready for service. Shift sales and recent checks are saved locally.</p>
        </div>
        <Link className="report-primary" to="/pos/register">Open register <span aria-hidden="true">→</span></Link>
      </header>

      {/* Shift Register Metrics */}
      <div className="metric-grid">
        <MetricCard label="Today’s shift sales" value={<Money cents={state.shift.salesCents} currency={state.currency} />} detail="Total recorded on this terminal" />
        <MetricCard label="Checks closed" value={state.shift.orderCount} detail="Completed checkouts today" />
        <MetricCard label="Cash in drawer" value={<Money cents={cashInDrawer} currency={state.currency} />} detail="Net cash collected (less change)" />
        <MetricCard label="Card takings" value={<Money cents={state.shift.cardCents} currency={state.currency} />} detail="External card approvals" />
      </div>

      {/* Quick Register Actions */}
      <div className="cashier-actions-bar">
        <Link className="cashier-action-btn primary" to="/pos/register">
          <span aria-hidden="true">⌁</span>
          <div>
            <strong>New check</strong>
            <small>Open the register</small>
          </div>
        </Link>
        <Link className="cashier-action-btn" to="/pos/orders">
          <span aria-hidden="true">▤</span>
          <div>
            <strong>Receipt history</strong>
            <small>Look up & reprint</small>
          </div>
        </Link>
        <Link className="cashier-action-btn" to="/pos/customers">
          <span aria-hidden="true">♧</span>
          <div>
            <strong>Guests</strong>
            <small>Directory & lookup</small>
          </div>
        </Link>
      </div>

      {/* Two Column Grid: Recent Receipts & Terminal Security Status */}
      <div className="dashboard-columns">
        <section className="dashboard-panel">
          <div className="panel-header">
            <div>
              <h2>Recent receipts</h2>
              <small>Last sales on this terminal</small>
            </div>
            <Link className="panel-link" to="/pos/orders">All orders →</Link>
          </div>
          {state.recentOrders.length ? (
            <ul className="cashier-recent-list">
              {state.recentOrders.map(o => (
                <li key={o.id} className="cashier-recent-row">
                  <div className="receipt-meta">
                    <strong>{o.receiptNumber}</strong>
                    <small>{new Date(o.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {o.itemCount} items{o.refunded && <span className="sync-pill refunded" style={{ marginLeft: 6 }}>refunded</span>}</small>
                  </div>
                  <div className="receipt-end">
                    <b><Money cents={o.totalCents} currency={state.currency} /></b>
                    <Link className="reprint-btn" to={`/pos/orders/${encodeURIComponent(o.id)}`}>View receipt</Link>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-panel-copy">No checks closed on this terminal yet.</p>
          )}
        </section>

        <section className="dashboard-panel">
          <div className="panel-header">
            <h2>Terminal status</h2>
            <small>Provisioning & offline security</small>
          </div>
          <dl className="terminal-status-list">
            <div>
              <dt>Hardware Terminal</dt>
              <dd>{state.terminal}</dd>
            </div>
            <div>
              <dt>Receipt Prefix</dt>
              <dd><code>{state.receiptPrefix}</code></dd>
            </div>
            <div>
              <dt>Network Connection</dt>
              <dd>
                <span className={`status-badge ${state.online ? 'active' : 'offline'}`}>
                  {state.online ? 'Online' : 'Offline'}
                </span>
              </dd>
            </div>
            <div>
              <dt>API Connectivity</dt>
              <dd>
                <span className={`status-badge ${apiReachable ? 'active' : 'offline'}`}>
                  {!state.online ? 'Offline (sales queued)' : apiReachable === null ? 'Checking…' : apiReachable ? 'API reachable' : 'API unreachable'}
                </span>
              </dd>
            </div>
            <div>
              <dt>Sync Outbox</dt>
              <dd>
                {Object.values(state.syncCounts).every(count => !count) ? 'No sales queued yet' :
                  state.syncCounts.pending + state.syncCounts.in_flight + state.syncCounts.blocked + state.syncCounts.rejected === 0 ? 'All sales synced ✓' :
                  <span className="sync-breakdown">
                    {state.syncCounts.pending > 0 && <span className="sync-chip pending">{state.syncCounts.pending} pending</span>}
                    {state.syncCounts.in_flight > 0 && <span className="sync-chip in_flight">{state.syncCounts.in_flight} syncing</span>}
                    {state.syncCounts.blocked > 0 && <span className="sync-chip blocked">{state.syncCounts.blocked} blocked</span>}
                    {state.syncCounts.rejected > 0 && <span className="sync-chip rejected">{state.syncCounts.rejected} rejected</span>}
                  </span>}
              </dd>
            </div>
            <div>
              <dt>Manager Approval</dt>
              <dd>{state.managerApproval ? 'Active on terminal' : 'Requires online validation'}</dd>
            </div>
          </dl>
          {state.syncCounts.rejected > 0 && (
            <p className="operation-warning" role="status">
              ⚠ {state.syncCounts.rejected} sync operation{state.syncCounts.rejected === 1 ? '' : 's'} {state.syncCounts.rejected === 1 ? 'needs' : 'need'} review. Ask a manager for assistance.
            </p>
          )}
          <Link className="reprint-btn sync-center-link" to="/pos/sync">Open Sync Center →</Link>
        </section>
      </div>
    </section>
  )
}

function AccessMessage({ message, embedded = false }: { message: string; embedded?: boolean }) {
  return (
    <section className={embedded ? 'report-access embedded' : 'reporting-page report-access'} role="alert">
      <h2>Reporting unavailable</h2>
      <p>{message}</p>
    </section>
  )
}

// Cash vs. card split as an SVG donut — still pure CSS/SVG, no charting library. Strokes are set
// from MISE tokens in reporting.css (track = sunken surface, cash = info blue, card = saffron),
// following the design system's fixed categorical series order rather than hard-coded hexes.
function TenderDonut({ cashPct, cardPct }: { cashPct: number; cardPct: number }) {
  const radius = 40
  const circumference = 2 * Math.PI * radius
  const cashLength = (cashPct / 100) * circumference
  return (
    <svg viewBox="0 0 100 100" className="tender-donut" role="img" aria-label={`Cash ${cashPct} percent, card ${cardPct} percent`}>
      <circle className="donut-track" cx="50" cy="50" r={radius} fill="none" strokeWidth="14" />
      {cashPct > 0 && (
        <circle
          className="donut-cash" cx="50" cy="50" r={radius} fill="none" strokeWidth="14"
          strokeDasharray={`${cashLength} ${circumference - cashLength}`}
          transform="rotate(-90 50 50)"
        />
      )}
      {cardPct > 0 && (
        <circle
          className="donut-card" cx="50" cy="50" r={radius} fill="none" strokeWidth="14"
          strokeDasharray={`${circumference - cashLength} ${cashLength}`}
          strokeDashoffset={-cashLength}
          transform="rotate(-90 50 50)"
        />
      )}
      <text x="50" y="47" textAnchor="middle" className="donut-pct">{cashPct}%</text>
      <text x="50" y="61" textAnchor="middle" className="donut-label">cash</text>
    </svg>
  )
}

// Skeleton loading placeholders — replace bare "Checking…" text with a shimmering outline of the
// layout that's about to render, CSS-only (no new dependency).
function DashboardSkeleton() {
  return (
    <section className="reporting-page owner-dashboard" role="status" aria-label="Loading dashboard">
      <div className="skeleton skeleton-heading" />
      <div className="report-card-grid">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton skeleton-card" />)}
      </div>
      <div className="dashboard-subgrid">
        <div className="skeleton skeleton-panel" />
        <div className="skeleton skeleton-panel" />
      </div>
      <div className="dashboard-columns">
        <div className="skeleton skeleton-panel tall" />
        <div className="skeleton skeleton-panel tall" />
      </div>
    </section>
  )
}

function ReportLinesSkeleton() {
  return (
    <div className="report-metrics" role="status" aria-label="Loading report">
      {Array.from({ length: 7 }).map((_, i) => <div key={i} className="skeleton skeleton-line-row" />)}
    </div>
  )
}


function ReportLine({ label, hint, cents, currency, emphasized = false }: { label: string; hint: string; cents: number; currency: string; emphasized?: boolean }) {
  return (
    <article className={emphasized ? 'report-line emphasized' : 'report-line'}>
      <div>
        <strong>{label}</strong>
        <small>{hint}</small>
      </div>
      <b><Money cents={cents} currency={currency} /></b>
    </article>
  )
}
