import { FormEvent, ReactNode, useEffect, useState, lazy, Suspense, createContext, useContext } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { PasswordField } from './components/PasswordField'
import { isSupabaseConfigured, requireSupabase, supabase } from './lib/supabase'
import { ReceiptScreen } from './receipts/ReceiptScreen'
import { OrderHistoryScreen } from './screens/OrderHistoryScreen'
import { PaymentScreen } from './screens/PaymentScreen'
import { RegisterScreen } from './screens/RegisterScreen'
import { CustomerScreen } from './screens/CustomerScreen'
import { usePosStore } from './lib/pos-store'
import { SettingsOverview } from './terminal-auth/SettingsOverview'
import { useTerminalStatus } from './terminal-auth/TerminalStatus'
import { CashierTerminalRoute } from './terminal-auth/CashierTerminalRoute'
import { CashierPosLayout } from './terminal-auth/CashierPosLayout'
import { CashierDashboardScreen, OwnerDashboardScreen, ReportsScreen } from './screens/ReportingScreens'
import { ActivityScreen } from './screens/ActivityScreen'
import { resolveFinancialAccess } from './lib/management-access'
import { posDb } from './lib/db'
import { ConnectionAndSync } from './components/ConnectionAndSync'
import { StoreSwitcher } from './components/StoreSwitcher'
import { ProductCatalogScreen } from './screens/ProductCatalogScreen'
import { FloorScreen } from './screens/floor/FloorScreen'
import { KitchenScreen } from './screens/kitchen/KitchenScreen'
import { InventoryScreen } from './screens/inventory/InventoryScreen'
import { SyncCenterScreen } from './screens/SyncCenterScreen'
import { CashierHardwareSettings } from './screens/CashierHardwareSettings'
import { CashierProductsScreen } from './screens/CashierProductsScreen'
import { OnboardingWizard } from './onboarding/OnboardingWizard'
import { activeStoreId, loadCatalog } from './lib/catalog'
import {
  LayoutDashboard, ShoppingCart, UtensilsCrossed, ClipboardList, Users, BarChart3,
  LayoutGrid, ChefHat, Package, Settings as SettingsIcon, LogOut, CircleUser,
} from './components/icons'
import type { LucideIcon } from 'lucide-react'

const CashierLogin = lazy(() => import('./terminal-auth/CashierLogin').then(module => ({ default: module.CashierLogin })))
const ManagerSetup = lazy(() => import('./terminal-auth/ManagerSetup').then(module => ({ default: module.ManagerSetup })))
const StoreDetails = lazy(() => import('./screens/StoreDetails').then(module => ({ default: module.StoreDetails })))

// Menu mock for the marketing hero's <RegisterMini /> only. The fourth field names a
// .product-art shape in styles.css; the third is the station the dish fires from.
const products = [['Hamachi Crudo', '$26.00', 'Raw bar', 'plate'], ['Burrata & Peach', '$19.00', 'Garde manger', 'bowl'], ['Charred Broccolini', '$14.00', 'Garde manger', 'leaf'], ['Sourdough & Cultured Butter', '$9.00', 'Bakery', 'slice'], ['Duck Breast, Cherry', '$42.00', 'Grill', 'board'], ['Bavette, Bone Marrow', '$46.00', 'Grill', 'board'], ['Riesling, Mosel', '$17.00', 'Cellar', 'glass'], ['Amaro Service', '$15.00', 'Bar', 'bottle']] as const
// Grouped by how a restaurant actually thinks about these screens, not an alphabetical or
// flat admin-sidebar list: a home item, then the moment-to-moment "Operate" screens, the
// less time-sensitive "Manage" screens, "Insights", and Settings on its own at the bottom
// (account/system-level, not a workflow). navGroups drives the sidebar; ALL_NAV_ITEMS is the
// flat lookup mobileNav and the Reports-visibility filter both need.
type NavItem = readonly [LucideIcon, string, string]
const navGroups: readonly { label: string | null; items: readonly NavItem[] }[] = [
  { label: null, items: [[LayoutDashboard, 'Dashboard', '/dashboard']] },
  { label: 'Operate', items: [[ShoppingCart, 'Sell', '/register'], [ClipboardList, 'Orders', '/orders'], [LayoutGrid, 'Floor & Tables', '/floor'], [ChefHat, 'Kitchen', '/kitchen']] },
  { label: 'Manage', items: [[UtensilsCrossed, 'Menu', '/products'], [Package, 'Inventory', '/inventory'], [Users, 'Guests', '/customers']] },
  { label: 'Insights', items: [[BarChart3, 'Reports', '/reports']] },
]
const settingsNavItem: NavItem = [SettingsIcon, 'Settings', '/settings']
const ALL_NAV_ITEMS: readonly NavItem[] = [...navGroups.flatMap(group => group.items), settingsNavItem]
function Mark() { return <span aria-hidden="true" className="leaf-mark">⌁</span> }
function Brand({ dark = false }: { dark?: boolean }) { return <Link className={`brand ${dark ? 'brand-dark' : ''}`} to="/"><Mark />Dineflow <small>RESTAURANT OPERATING SYSTEM</small></Link> }
function Button({ children, to, disabled = false, type = 'button', onClick }: { children: ReactNode, to?: string, disabled?: boolean, type?: 'button' | 'submit', onClick?: () => void }) { return to ? <Link className="cta" to={to}>{children}<b aria-hidden="true">→</b></Link> : <button className="cta" type={type} disabled={disabled} onClick={onClick}>{children}<b aria-hidden="true">→</b></button> }

// ── Session Context ──────────────────────────────────────────────────────────
// Resolved ONCE at the root so navigating between protected routes never
// triggers "Checking your session…" again.
const SessionCtx = createContext<{ loading: boolean; session: Session | null; needsOnboarding: boolean; onboardingLoading: boolean; markOnboardingComplete: () => void }>({ loading: true, session: null, needsOnboarding: false, onboardingLoading: false, markOnboardingComplete: () => {} })
function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(Boolean(supabase))
  const [session, setSession] = useState<Session | null>(null)
  const [needsOnboarding, setNeedsOnboarding] = useState(false)
  const [onboardingLoading, setOnboardingLoading] = useState(false)
  useEffect(() => {
    if (!supabase) { setLoading(false); return }
    let active = true
    void supabase.auth.getSession().then(({ data }) => { if (active) { setSession(data.session); setLoading(false) } })
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setLoading(false) })
    return () => { active = false; listener.subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (!session || !supabase) { setNeedsOnboarding(false); setOnboardingLoading(false); return }
    let active = true
    setOnboardingLoading(true)
    // Signup/finishStoreSetup races this check while the store is still being created; routes must
    // wait for onboardingLoading to clear instead of redirecting on the stale default of false.
    void supabase.from('store_memberships').select('store_id, role').eq('user_id', session.user.id).eq('active', true).eq('role', 'owner').limit(1)
      .then(async ({ data: memberships }) => {
        const storeId = memberships?.[0]?.store_id
        if (!storeId) return false
        const { data: store } = await requireSupabase().from('stores').select('onboarding_completed_at').eq('id', storeId).single()
        return !store?.onboarding_completed_at
      })
      // A failed check never blocks an existing session from reaching the app.
      .then(result => { if (active) setNeedsOnboarding(Boolean(result)) }, () => { if (active) setNeedsOnboarding(false) })
      .then(() => { if (active) setOnboardingLoading(false) })
    return () => { active = false }
    // Deliberately session?.user.id, not session itself: Supabase's client refreshes the access
    // token in the background on tab refocus, firing onAuthStateChange with a new session object
    // for the same user every time — depending on the whole object re-ran this whole check (and
    // ProtectedRoute shows "Loading…" while onboardingLoading is true) on every tab switch, not
    // just on an actual sign-in/sign-out/account change. The catalog-refresh effect below already
    // gets this right; this one didn't.
  }, [session?.user.id])
  useEffect(() => {
    if (!session || !navigator.onLine) return
    // Dexie persists across browser restarts for offline checkout. Rehydrate the account's
    // server-authorized active store whenever its owner/manager session changes so a second
    // account on the same browser cannot be shown a stale catalog from an earlier session.
    void activeStoreId().then(storeId => loadCatalog(storeId)).catch(() => undefined)
  }, [session?.user.id])
  // The wizard calls this right after the completion RPC succeeds, so ProtectedRoute
  // stops redirecting to /onboarding without waiting on a re-fetch of store state.
  const markOnboardingComplete = () => setNeedsOnboarding(false)
  return <SessionCtx.Provider value={{ loading, session, needsOnboarding, onboardingLoading, markOnboardingComplete }}>{children}</SessionCtx.Provider>
}
export function useSession() { return useContext(SessionCtx) }
function AuthPending() { return <main className="route-pending" role="status">Loading…</main> }
function ProtectedRoute({ children }: { children: ReactNode }) { const { loading, session, needsOnboarding, onboardingLoading } = useSession(); const location = useLocation(); if (loading) return <AuthPending />; if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />; if (location.pathname !== '/onboarding' && onboardingLoading) return <AuthPending />; if (needsOnboarding && location.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />; return <>{children}</> }
function PublicRoute({ children }: { children: ReactNode }) { const { loading, session, needsOnboarding, onboardingLoading } = useSession(); if (loading) return <AuthPending />; if (session && onboardingLoading) return <AuthPending />; return session ? <Navigate to={needsOnboarding ? '/onboarding' : '/dashboard'} replace /> : <>{children}</> }

function Landing() { return <div className="landing"><header className="site-header"><Brand /><nav aria-label="Marketing"><a href="#platform">Platform</a><a href="#features">Features</a><a href="#restaurants">Restaurants</a><a href="#pricing">Pricing</a><a href="#support">Support</a></nav><div className="header-actions"><Link to="/login">Sign in</Link><Button to="/signup">Open your restaurant</Button></div></header><section className="hero" id="platform"><div className="hero-copy"><p className="kicker">OFFLINE-FIRST OPERATING SYSTEM FOR FINE DINING</p><h1>The dining room,<br /><i>in one rhythm</i>.</h1><span className="brush" /><p className="hero-text">Dineflow gives restaurants a floor, kitchen and register that stay in sync — from the dining room to the pass.</p><div className="hero-actions"><Button to="/signup">Open your restaurant</Button><a className="watch" href="#features"><span aria-hidden="true">▷</span> See a service run</a></div></div><div className="hero-art" aria-hidden="true"><div className="monitor"><RegisterMini /></div></div></section><section id="features" className="feature-strip"><div className="strip-quote">Hospitality,<br />held to<br />a higher<br />standard.</div>{[['◷', 'Service never stops', 'Floor, bar and pass stay in step — online or off.'], ['♧', 'Calm for your team', 'Learned in one shift. Trusted every seating.'], ['⬡', 'Your covers, your data', 'Every cover, check and count stays yours.'], ['⌁', 'Ready for the next room', 'Open the second dining room without starting over.']].map(([icon, title, copy]) => <article key={title}><span aria-hidden="true">{icon}</span><strong>{title}</strong><small>{copy}</small></article>)}</section>{[['restaurants', 'Made for the dining room.', 'One calm service for the people who run the pass, the floor and the book — from a twelve-seat counter to a full à la carte room.'], ['pricing', 'Simple to open.', 'Set up your owner account, then seat the rest of your team.'], ['support', 'Hospitality for the hosts.', 'Account recovery and restaurant access guidance are built in.']].map(([id, title, text]) => <section id={id} className="landing-note" key={id}><h2>{title}</h2><p>{text}</p></section>)}<footer><Brand dark /><span>MORE THAN A POS. MISE EN PLACE FOR THE WHOLE HOUSE.</span><Button to="/signup">Start for free</Button></footer></div> }
function RegisterMini() { return <div className="mini-register"><aside><b>Dineflow</b><span>▣ &nbsp; Sell</span><span>▦ &nbsp; Menu</span><span>▤ &nbsp; Orders</span></aside><div className="mini-products"><div className="mini-search">⌕ &nbsp; Search the menu…</div><div className="mini-grid">{products.map(([name, , station, art]) => <div className="mini-card" key={name}><div className={`product-art ${art}`} /><b>{name}</b><small>{station}</small></div>)}</div></div><div className="mini-cart"><p>Open check</p><div>Hamachi Crudo <b>$26.00</b></div><hr /><strong>Total <b>$26.00</b></strong></div></div> }
export function AuthShell({ title, copy, kicker = 'SERVICE, UNINTERRUPTED', note, children }: { title: string, copy: string, kicker?: string, note?: ReactNode, children: ReactNode }) { return <main className="auth-page"><section className="auth-art"><Brand dark /><div><p className="kicker">{kicker}</p><h1>{title}</h1><p>{copy}</p></div><div className="auth-note">{note ?? <><Mark /><span>SET THE PASS.<br />OPEN THE DOORS.</span></>}</div></section><section className="auth-form"><div className="form-card">{children}</div></section></main> }
function AuthNotice({ error, message }: { error?: string, message?: string }) { return <>{error && <p className="form-notice error" role="alert">{error}</p>}{message && <p className="form-notice" role="status" aria-live="polite">{message}</p>}</> }
function ConfigNotice() { return !isSupabaseConfigured ? <p className="form-notice" role="status">Supabase is not configured. Add the project URL and publishable key to enable account actions.</p> : null }
async function finishStoreSetup(): Promise<boolean> { const client = requireSupabase(); const { data: { user }, error: userError } = await client.auth.getUser(); if (userError) throw userError; if (!user) throw new Error('Your session could not be restored. Please sign in again.'); const { error: inviteError } = await client.rpc('accept_store_invites'); if (inviteError) throw inviteError; const { data: memberships, error } = await client.from('store_memberships').select('store_id, role').eq('user_id', user.id).eq('active', true).limit(1); if (error) throw error; let storeId = memberships?.[0]?.store_id; const isOwner = memberships?.[0]?.role === 'owner'; if (!memberships?.length && typeof user.user_metadata.store_name === 'string') { const { data: newStoreId, error: createError } = await client.rpc('create_store', { p_name: user.user_metadata.store_name, p_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, p_currency: 'USD' }); if (createError) throw createError; storeId = newStoreId; return true } if (!storeId || !isOwner) return false; const { data: store, error: storeError } = await client.from('stores').select('onboarding_completed_at').eq('id', storeId).single(); if (storeError) throw storeError; return !store.onboarding_completed_at }

function Login() { const go = useNavigate(); const location = useLocation(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [message] = useState((location.state as { message?: string } | null)?.message ?? ''); const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(''); setBusy(true); try { const form = new FormData(event.currentTarget); const { error: signInError } = await requireSupabase().auth.signInWithPassword({ email: String(form.get('email')).trim(), password: String(form.get('password')) }); if (signInError) throw signInError; const needsOnboarding = await finishStoreSetup(); go(needsOnboarding ? '/onboarding' : ((location.state as { from?: string } | null)?.from ?? '/dashboard'), { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to sign in.') } finally { setBusy(false) } }; return <AuthShell title="Your dining room is waiting." copy="Sign in to manage your restaurant, your team, and your terminals."><p className="kicker">OWNER & MANAGER ACCESS</p><h2>Welcome back.</h2><p className="form-copy">Your session stays active on this browser until you sign out.</p><ConfigNotice /><AuthNotice error={error} message={message} /><form onSubmit={submit} noValidate><label>Email address<input name="email" type="email" autoComplete="email" placeholder="you@yourrestaurant.com" required /></label><PasswordField label="Password" name="password" autoComplete="current-password" placeholder="Enter your password" required /><div className="form-line"><Link to="/forgot-password">Forgot password?</Link><Link to="/invite">Accept an invite</Link></div><Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Open restaurant'}</Button></form><p className="form-footer">New to Dineflow? <Link to="/signup">Create your restaurant</Link></p></AuthShell> }
function Signup() { const go = useNavigate(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get('password')); if (password !== String(form.get('confirmPassword'))) { setError('Passwords do not match.'); return } setError(''); setBusy(true); try { const email = String(form.get('email')).trim(); const { data, error: signUpError } = await requireSupabase().auth.signUp({ email, password, options: { data: { full_name: String(form.get('fullName')).trim(), store_name: String(form.get('storeName')).trim() }, emailRedirectTo: `${window.location.origin}/login` } }); if (signUpError) throw signUpError; if (!data.session) { go('/check-email', { replace: true, state: { email } }); return } const needsOnboarding = await finishStoreSetup(); go(needsOnboarding ? '/onboarding' : '/dashboard', { replace: true }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to create your restaurant.') } finally { setBusy(false) } }; return <AuthShell title="A great room starts here." copy="Set up the owner account for your restaurant. You can invite your team after sign-in."><p className="kicker">OPEN YOUR RESTAURANT</p><h2>Make it yours.</h2><p className="form-copy">This creates an owner account and your first restaurant workspace.</p><ConfigNotice /><AuthNotice error={error} /><form onSubmit={submit} noValidate><label>Your name<input name="fullName" autoComplete="name" placeholder="Your full name" required /></label><label>Restaurant name<input name="storeName" autoComplete="organization" placeholder="The Copper Larder" required /></label><label>Work email<input name="email" type="email" autoComplete="email" placeholder="owner@yourrestaurant.com" required /></label><PasswordField label="Create password" name="password" autoComplete="new-password" placeholder="At least 12 characters" minLength={12} required showRequirements /><PasswordField label="Confirm password" name="confirmPassword" autoComplete="new-password" placeholder="Enter the same password" minLength={12} required /><Button type="submit" disabled={busy}>{busy ? 'Opening restaurant…' : 'Create restaurant'}</Button></form><p className="form-footer">Already have access? <Link to="/login">Sign in</Link></p></AuthShell> }
function CheckEmail() { const location = useLocation(); const email = (location.state as { email?: string } | null)?.email; const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const resend = async () => { if (!email) return; setBusy(true); setError(''); try { const { error: resendError } = await requireSupabase().auth.resend({ type: 'signup', email, options: { emailRedirectTo: `${window.location.origin}/login` } }); if (resendError) throw resendError; setMessage('A new confirmation email is on its way.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to resend the confirmation email.') } finally { setBusy(false) } }; return <AuthShell title="Check your inbox." copy="Confirm your email to finish setting up your restaurant."><p className="kicker">EMAIL CONFIRMATION</p><h2>One more step.</h2><p className="form-copy">{email ? <>We sent a confirmation link to <strong>{email}</strong>.</> : 'We sent a confirmation link to your email address.'}</p><AuthNotice error={error} message={message} />{email && <Button disabled={busy} onClick={resend}>{busy ? 'Sending…' : 'Resend email'}</Button>}<p className="form-footer"><Link to="/signup">Change email</Link> · <Link to="/login">Return to sign in</Link></p></AuthShell> }
function ForgotPassword() { const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setError(''); setMessage(''); setBusy(true); try { const email = String(new FormData(event.currentTarget).get('email')).trim(); const { error: resetError } = await requireSupabase().auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` }); if (resetError) throw resetError; setMessage('If that email has an account, a password-reset link is on its way.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to send a reset link.') } finally { setBusy(false) } }; return <AuthShell title="Get back to your restaurant." copy="We will send a secure link to reset your password."><p className="kicker">PASSWORD RESET</p><h2>Reset password.</h2><ConfigNotice /><AuthNotice error={error} message={message} /><form onSubmit={submit} noValidate><label>Work email<input name="email" type="email" autoComplete="email" placeholder="you@yourrestaurant.com" required /></label><Button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</Button></form><p className="form-footer"><Link to="/login">Back to sign in</Link></p></AuthShell> }
function ResetPassword() { const go = useNavigate(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); const password = String(form.get('password')); if (password !== String(form.get('confirmPassword'))) { setError('Passwords do not match.'); return } setError(''); setBusy(true); try { const { error: updateError } = await requireSupabase().auth.updateUser({ password }); if (updateError) throw updateError; go('/login', { replace: true, state: { message: 'Password updated. Sign in with your new password.' } }) } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to update your password. Open the latest reset link and try again.') } finally { setBusy(false) } }; return <AuthShell title="Choose a new password." copy="Use a unique password for your restaurant account."><p className="kicker">PASSWORD RESET</p><h2>New password.</h2><AuthNotice error={error} /><form onSubmit={submit}><PasswordField label="New password" name="password" autoComplete="new-password" minLength={12} required showRequirements /><PasswordField label="Confirm new password" name="confirmPassword" autoComplete="new-password" minLength={12} required /><Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save new password'}</Button></form></AuthShell> }
function Invite() { const go = useNavigate(); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const accept = async () => { setError(''); setMessage(''); setBusy(true); try { const client = requireSupabase(); const { data: { user }, error: userError } = await client.auth.getUser(); if (userError) throw userError; if (!user) { go('/login'); return } const { data, error: acceptError } = await client.rpc('accept_store_invites'); if (acceptError) throw acceptError; if (data) { go('/dashboard'); return } setMessage('No active invitation was found for this signed-in email.') } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to accept your invitation.') } finally { setBusy(false) } }; return <AuthShell title="The good stuff is ahead." copy="Sign in with the same email your manager invited to join the restaurant."><p className="kicker">JOIN YOUR TEAM</p><h2>Accept your invite.</h2><p className="form-copy">Invitations are matched to your verified account email. No invite code is needed.</p><ConfigNotice /><AuthNotice error={error} message={message} /><Button disabled={busy} onClick={accept}>{busy ? 'Checking…' : 'Check my invitation'}</Button><p className="form-footer"><Link to="/login">Back to sign in</Link></p></AuthShell> }

export function AppLayout({ children }: { children: ReactNode }) {
  // Mobile bottom bar is a fixed 5-column grid (styles.css); keep exactly 5 items here
  // (Dashboard, Sell, Menu, Orders, Settings) or the 6th wraps onto its own row. Customers
  // stays reachable from the sidebar on larger screens. Looked up by label rather than array
  // index so this doesn't silently break if navGroups gets reordered.
  const mobileLabels = ['Dashboard', 'Sell', 'Menu', 'Orders', 'Settings']
  const mobileNav = mobileLabels.map(label => ALL_NAV_ITEMS.find(([, itemLabel]) => itemLabel === label)!)
  const go = useNavigate()
  const [signingOut, setSigningOut] = useState(false)
  const [canReport, setCanReport] = useState<boolean>()
  const { session } = useSession()
  const terminal = useTerminalStatus()
  useEffect(() => {
    let active = true
    const userId = session?.user.id
    // management-access.ts's resolveFinancialAccess only ever writes this cache key after a
    // successful check, and deletes it on a failed one — so its mere presence is a reliable
    // "yes" from last time. Reading it first gives the sidebar an immediate, informed answer
    // instead of hiding Reports and popping it back in on every reload while the network round
    // trip below is in flight (canReport otherwise starts undefined, which reads as false here).
    void (userId ? posDb.sync_metadata.get(`financial_access:${userId}`) : Promise.resolve(undefined))
      .then(cached => { if (active && cached) setCanReport(true) })
      .catch(() => undefined)
    void resolveFinancialAccess().then(() => { if (active) setCanReport(true) }).catch(() => { if (active) setCanReport(false) })
    return () => { active = false }
  }, [session?.user.id])
  // canReport resolves quickly in background; sidebar simply hides Reports until ready. A group
  // that ends up with no visible items (only "Insights" can, today) is dropped entirely rather
  // than rendering an empty labeled section.
  const visibleGroups = navGroups
    .map(group => ({ ...group, items: group.items.filter(([, label]) => label !== 'Reports' || canReport) }))
    .filter(group => group.items.length > 0)
  const signOut = async () => {
    setSigningOut(true)
    try {
      if (supabase) { const { error } = await supabase.auth.signOut(); if (error) throw error }
      usePosStore.getState().clearCart(); usePosStore.getState().setStoreContext('', '')
      go('/login', { replace: true })
    } finally { setSigningOut(false) }
  }
  return <div className="pos-app">
    <aside className="app-sidebar">
      <Brand dark />
      <nav aria-label="Store navigation" className="sidebar-nav">
        {visibleGroups.map((group, index) => <div className="sidebar-nav-group" key={group.label ?? `top-${index}`}>
          {group.label && <p className="sidebar-nav-label">{group.label}</p>}
          {group.items.map(([Icon, label, to]) => <NavLink key={label} to={to}><Icon aria-hidden="true" size={18} />{label}</NavLink>)}
        </div>)}
        <div className="sidebar-nav-group sidebar-nav-settings">
          <NavLink to={settingsNavItem[2]}><SettingsIcon aria-hidden="true" size={18} />{settingsNavItem[1]}</NavLink>
        </div>
      </nav>
      <div className="sidebar-bottom"><span>{terminal?.device.name ?? 'Store workspace'}<br /><small>{terminal ? 'Terminal ready' : 'No terminal connected'}</small></span></div>
    </aside>
    <main className="app-main">
      <header className="app-top">
        <div className="mobile-store"><Brand dark /></div>
        <StoreSwitcher />
        <ConnectionAndSync />
        <span className="register-meta"><b>{terminal?.device.name ?? 'Store workspace'}</b><small>{terminal ? `Receipt prefix: ${terminal.device.receipt_prefix}` : 'No terminal connected'}</small></span>
        <div className="account-chip">
          <CircleUser aria-hidden="true" size={20} />
          <span className="account-chip-email">{session?.user.email ?? 'Account'}</span>
          <button className="account-chip-signout" type="button" onClick={() => void signOut()} disabled={signingOut} title="Sign out">
            <LogOut aria-hidden="true" size={16} />{signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>
      {children}
    </main>
    <nav className="mobile-nav mobile-nav-with-customers" aria-label="Store navigation">
      {mobileNav.map(([Icon, label, to]) => <NavLink key={label} to={to}><Icon aria-hidden="true" size={18} />{label}</NavLink>)}
    </nav>
  </div>
}
function Register() { return <AppLayout><RegisterScreen /></AppLayout> }
function Cart() { return <aside className="sale-cart"><div className="cart-title"><h2>Open check</h2><button type="button" className="text-action" disabled>Void check</button></div><p className="empty-cart">This check is ready for its first course.</p><button type="button" className="customer" disabled>Add customer <small>(available with POS setup)</small></button><div className="totals"><span>Subtotal <b>$0.00</b></span><span>Tax <b>$0.00</b></span><strong>Total <b>$0.00</b></strong></div><Button to="/payment">Proceed to payment</Button></aside> }
function Dashboard() {
  const { session } = useSession()
  const fullName = session?.user.user_metadata?.full_name
  const firstName = typeof fullName === 'string' && fullName.trim() ? fullName.trim().split(' ')[0] : undefined
  return <AppLayout><OwnerDashboardScreen greetingName={firstName} /></AppLayout>
}
function Reports() { return <AppLayout><ReportsScreen /></AppLayout> }
function Payment() { return <AppLayout><PaymentScreen /></AppLayout> }
function Orders() { return <AppLayout><OrderHistoryScreen /></AppLayout> }
function Settings() { return <AppLayout><SettingsOverview /></AppLayout> }
function Customers() { return <AppLayout><CustomerScreen /></AppLayout> }
function Placeholder() { return <AppLayout><section className="placeholder"><p className="kicker">POS FOUNDATION</p><h1>Coming next.</h1><p>This space will be built with local data, terminal permissions, and synchronized store records.</p></section></AppLayout> }
function Products() { return <AppLayout><ProductCatalogScreen /></AppLayout> }
function Floor() { return <AppLayout><FloorScreen /></AppLayout> }
function Kitchen() { return <AppLayout><KitchenScreen /></AppLayout> }
function Inventory() { return <AppLayout><InventoryScreen /></AppLayout> }
function App() { const protectedPaths = ['/dashboard', '/register', '/payment', '/products', '/orders', '/customers', '/reports', '/settings', '/floor', '/kitchen', '/inventory']; return <SessionProvider><Routes><Route path="/pos/login" element={<Suspense fallback={<AuthPending />}><CashierLogin /></Suspense>} /><Route path="/pos/dashboard" element={<CashierTerminalRoute><CashierPosLayout><CashierDashboardScreen /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/register" element={<CashierTerminalRoute><CashierPosLayout><RegisterScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/orders" element={<CashierTerminalRoute><CashierPosLayout><OrderHistoryScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/orders/:orderId" element={<CashierTerminalRoute><CashierPosLayout><ReceiptScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/orders/:orderId" element={<ProtectedRoute><AppLayout><ReceiptScreen /></AppLayout></ProtectedRoute>} /><Route path="/pos/payment" element={<CashierTerminalRoute><CashierPosLayout><PaymentScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/customers" element={<CashierTerminalRoute><CashierPosLayout><CustomerScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/inventory" element={<CashierTerminalRoute><CashierPosLayout><InventoryScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/products" element={<CashierTerminalRoute><CashierPosLayout><CashierProductsScreen /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/settings" element={<CashierTerminalRoute><CashierPosLayout><CashierHardwareSettings /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/sync" element={<CashierTerminalRoute><CashierPosLayout><SyncCenterScreen terminal /></CashierPosLayout></CashierTerminalRoute>} /><Route path="/pos/reports" element={<Navigate to="/pos/dashboard" replace />} /><Route path="/settings/terminals" element={<ProtectedRoute><Suspense fallback={<AuthPending />}><ManagerSetup screen="terminals" /></Suspense></ProtectedRoute>} /><Route path="/settings/employees" element={<ProtectedRoute><Suspense fallback={<AuthPending />}><ManagerSetup screen="employees" /></Suspense></ProtectedRoute>} /><Route path="/settings/activity" element={<ProtectedRoute><AppLayout><ActivityScreen /></AppLayout></ProtectedRoute>} /><Route path="/settings/store" element={<ProtectedRoute><Suspense fallback={<AuthPending />}><StoreDetails /></Suspense></ProtectedRoute>} /><Route path="/onboarding" element={<ProtectedRoute><OnboardingWizard /></ProtectedRoute>} /><Route path="/" element={<Landing />} /><Route path="/login" element={<PublicRoute><Login /></PublicRoute>} /><Route path="/signup" element={<PublicRoute><Signup /></PublicRoute>} /><Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} /><Route path="/reset-password" element={<PublicRoute><ResetPassword /></PublicRoute>} /><Route path="/check-email" element={<PublicRoute><CheckEmail /></PublicRoute>} /><Route path="/invite" element={<Invite />} />{protectedPaths.map((path) => <Route key={path} path={path} element={<ProtectedRoute>{path === '/dashboard' ? <Dashboard /> : path === '/reports' ? <Reports /> : path === '/register' ? <Register /> : path === '/payment' ? <Payment /> : path === '/orders' ? <Orders /> : path === '/customers' ? <Customers /> : path === '/products' ? <Products /> : path === '/settings' ? <Settings /> : path === '/floor' ? <Floor /> : path === '/kitchen' ? <Kitchen /> : path === '/inventory' ? <Inventory /> : <Placeholder />}</ProtectedRoute>} />)}<Route path="*" element={<Navigate to="/" replace />} /></Routes></SessionProvider> }
export default App
