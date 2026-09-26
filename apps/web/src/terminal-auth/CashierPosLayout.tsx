import { useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { currentAccess, readTerminal, type TerminalCache } from './cache'
import { pushPendingOrders } from '../lib/order-sync'
import { ClockButton } from './ClockButton'
import { LayoutDashboard, ShoppingCart, UtensilsCrossed, ClipboardList, Users, Package, Settings as SettingsIcon, Store } from '../components/icons'
import './terminal-auth.css'
import '../receipts/receipts.css'

// Same icon choices as the owner/manager shell's sidebar (App.tsx) for the same concepts, so a
// manager who uses both the web app and a terminal sees one consistent icon language. Before the
// redesign this used Unicode glyphs, and three of the five items (Products, Orders, Settings)
// shared the exact same generic "○" placeholder glyph -- not just a different icon style from the
// owner shell, but no real distinction between its own nav items either.
const navigation = [
  { label: 'Dashboard', to: '/pos/dashboard', icon: LayoutDashboard },
  { label: 'Sell', to: '/pos/register', icon: ShoppingCart },
  { label: 'Products', to: '/pos/products', icon: UtensilsCrossed },
  { label: 'Orders', to: '/pos/orders', icon: ClipboardList },
  { label: 'Customers', to: '/pos/customers', icon: Users },
  { label: 'Inventory', to: '/pos/inventory', icon: Package },
  { label: 'Settings', to: '/pos/settings', icon: SettingsIcon },
]

export function CashierPosLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  const [terminal, setTerminal] = useState<TerminalCache>()
  useEffect(() => { void readTerminal().then(setTerminal) }, [])
  // Every /pos/* screen renders inside this shell, so this is the one place that guarantees a
  // reconnect triggers a sync no matter which screen a cashier is on — e.g. staying on Receipt
  // after completing a sale, which (like most cashier screens) has no sync trigger of its own.
  // RegisterScreen/OrderHistoryScreen skip their own equivalent effect when terminal=true, so this
  // is the only trigger running for cashier screens (owner-mode AppLayout still uses theirs).
  // Re-reads the device's store id fresh via currentAccess() on every tick rather than closing
  // over the one-time readTerminal() above, so a device reprovisioned to a different store while
  // this tab stays open can't push pending orders under a stale store id.
  useEffect(() => {
    let active = true
    const sync = async () => {
      if (!active || !navigator.onLine) return
      const access = await currentAccess().catch(() => undefined)
      if (!active || !access?.policy.valid) return
      await pushPendingOrders(access.cache.device.store_id, true).catch(() => undefined)
    }
    window.addEventListener('online', sync)
    const interval = window.setInterval(sync, 15_000)
    return () => { active = false; window.removeEventListener('online', sync); window.clearInterval(interval) }
  }, [])
  const cashier = terminal?.employees.find(employee => employee.id === terminal.session?.employee_id)
  return <div className="cashier-pos-shell">
    <aside className="cashier-pos-sidebar">
      <Link className="cashier-pos-brand" to="/pos/register"><span>D</span> Dineflow</Link>
      <nav aria-label="Cashier navigation">{navigation.map(item => {
        const active = item.label === 'Sell'
          ? ['/pos/register', '/pos/payment'].includes(pathname)
          : item.label === 'Orders'
            ? pathname.startsWith('/pos/orders')
            : pathname === item.to
        const Icon = item.icon
        return item.to
          ? <Link key={item.label} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} to={item.to}><Icon aria-hidden="true" size={18} />{item.label}</Link>
          : <span key={item.label} className="cashier-nav-muted"><Icon aria-hidden="true" size={18} />{item.label}</span>
      })}</nav>
      <footer><span className="cashier-online-dot" />Terminal ready<br /><small>{terminal?.device.name ?? 'Cashier terminal'}</small></footer>
    </aside>
    <main className="cashier-pos-main">
      <header className="cashier-pos-topbar"><span className="cashier-online"><i />{navigator.onLine ? 'Online' : 'Offline'}</span><span><Store aria-hidden="true" size={14} /> {terminal?.device.name ?? 'Terminal'}</span><span>{terminal?.device.receipt_prefix ?? 'Receipt prefix unavailable'}</span>{terminal?.device.store_id && <ClockButton storeId={terminal.device.store_id} />}<span className="cashier-profile">{cashier?.name ?? 'Cashier'}<small>{cashier?.role ?? 'Cashier'}</small></span></header>
      <nav className="cashier-pos-mobile-nav" aria-label="Cashier navigation"><Link className={pathname === '/pos/register' ? 'active' : ''} to="/pos/register">Sell</Link><Link className={pathname === '/pos/customers' ? 'active' : ''} to="/pos/customers">Customers</Link></nav>
      {children}
      <footer className="cashier-pos-status"><span><i /> {navigator.onLine ? 'Connected' : 'Offline'}</span><span>{terminal?.device.name ?? 'Terminal'}</span><span>Receipt prefix: {terminal?.device.receipt_prefix ?? '—'}</span></footer>
    </main>
    <nav className="cashier-mobile-nav" aria-label="Cashier navigation"><Link className={pathname === '/pos/dashboard' ? 'active' : ''} to="/pos/dashboard"><LayoutDashboard aria-hidden="true" size={18} />Dashboard</Link><Link className={pathname === '/pos/register' || pathname === '/pos/payment' ? 'active' : ''} to="/pos/register"><ShoppingCart aria-hidden="true" size={18} />Sell</Link></nav>
  </div>
}
