import { Link } from 'react-router-dom'
import { Brand, Button } from '../components/Brand'
import {
  ShoppingCart, UtensilsCrossed, ClipboardList, LayoutGrid, ChefHat, Package, Users, BarChart3,
  Clock, TrendingUp, Shield, Play, Search, RefreshCw, WifiOff, History,
} from '../components/icons'

// Real menu items for the marketing hero's <RegisterMini /> mockup only -- not live catalog data.
// The fourth field names a .product-art shape in styles.css; the third is the station it fires from.
const MINI_PRODUCTS = [
  ['Hamachi Crudo', 'Raw bar', 'plate'],
  ['Burrata & Peach', 'Garde manger', 'bowl'],
  ['Charred Broccolini', 'Garde manger', 'leaf'],
  ['Sourdough & Cultured Butter', 'Bakery', 'slice'],
  ['Duck Breast, Cherry', 'Grill', 'board'],
  ['Bavette, Bone Marrow', 'Grill', 'board'],
] as const

// One entry per real module in the app's own sidebar nav (App.tsx's navGroups) -- the copy
// describes what each screen actually does, not an aspirational feature list.
const MODULES = [
  [ShoppingCart, 'Sell', 'Ring in orders offline or on, split payments across cash and card, apply manager-approved discounts, and reprint any receipt in seconds. Every terminal has its own receipt prefix, so checks from the bar and the host stand never collide.'],
  [LayoutGrid, 'Floor & Tables', "See every table's status at a glance — seated, ordering, served, billed, cleaned — group tables into areas like patio or bar, and transfer or merge a party without leaving the floor."],
  [ChefHat, 'Kitchen Display', 'Tickets fire straight from the register, grouped by station, with one tap to move each item from fired to ready to served — no printers, no re-keying an order by hand.'],
  [UtensilsCrossed, 'Menu & Recipes', "Build your menu with categories, tax rates and photos, then cost every dish against its recipe so you see a food-cost percentage per dish, not just per ingredient."],
  [Package, 'Inventory', "Track ingredients by batch with expiry dates, log wastage with a reason, and trace any drop in stock back to the exact delivery it came from."],
  [Users, 'Guests', 'Look guests up by phone in seconds and attach them to a check. Two guests can share a number or a name without merging into one record by mistake.'],
  [BarChart3, 'Reports', "A daily sales report broken down by staff, tender and item, refund tracking, and low-stock alerts your manager sees the moment they open the dashboard."],
  [Shield, 'Staff & Security', "Every cashier signs in with their own PIN on a provisioned terminal — never a shared login. Sensitive actions need a manager's approval, and every change lands in a restaurant-wide activity log."],
] as const

const OFFLINE_POINTS = [
  'Orders, payments and stock updates save to the device the instant they happen — not after a round trip to a server.',
  'A sync status badge shows pending, in-flight, blocked or rejected checks on every screen, so nothing goes missing silently.',
  'A provisioned terminal keeps working — sign-in, orders, payments — for up to seven days without a connection.',
  'Run as many terminals as your service needs; every one reads and writes the same floor, menu and stock, and reconciles automatically the moment it reconnects.',
]

const STEPS = [
  ['1', 'Create your account', "Sign up and set your restaurant's name, currency and timezone."],
  ['2', 'Set up your floor and menu', 'Add your dining areas and tables, then build your menu, categories and recipes.'],
  ['3', 'Add your team', 'Provision terminals and issue staff PINs, with roles for owners, managers and cashiers.'],
  ['4', 'Open for service', 'Start ringing in checks and firing tickets — online or off.'],
] as const

export function Landing() {
  return (
    <div className="landing">
      <header className="site-header">
        <Brand />
        <nav aria-label="Marketing">
          <a href="#platform">Platform</a>
          <a href="#features">Features</a>
          <a href="#offline">Offline-first</a>
          <a href="#pricing">Pricing</a>
          <a href="#support">Support</a>
        </nav>
        <div className="header-actions">
          <Link to="/login">Sign in</Link>
          <Button to="/signup">Open your restaurant</Button>
        </div>
      </header>

      <section className="hero" id="platform">
        <div className="hero-copy">
          <p className="kicker">OFFLINE-FIRST OPERATING SYSTEM FOR FINE DINING</p>
          <h1>
            The dining room,<br /><i>in one rhythm</i>.
          </h1>
          <span className="brush" />
          <p className="hero-text">
            Dineflow gives restaurants a floor, kitchen and register that stay in sync — from the
            dining room to the pass.
          </p>
          <div className="hero-actions">
            <Button to="/signup">Open your restaurant</Button>
            <a className="watch" href="#modules">
              <span aria-hidden="true"><Play size={11} /></span> See what's inside
            </a>
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="monitor">
            <RegisterMini />
          </div>
        </div>
      </section>

      <section id="features" className="feature-strip">
        <div className="strip-quote">
          Hospitality,<br />held to<br />a higher<br />standard.
        </div>
        {([
          [Clock, 'Service never stops', 'Floor, bar and pass stay in step — online or off.'],
          [Users, 'Calm for your team', 'Learned in one shift. Trusted every seating.'],
          [Shield, 'Your covers, your data', 'Every cover, check and count stays yours.'],
          [TrendingUp, 'Ready for the next room', 'Open the second dining room without starting over.'],
        ] as const).map(([Icon, title, copy]) => (
          <article key={title}>
            <span aria-hidden="true"><Icon size={18} /></span>
            <strong>{title}</strong>
            <small>{copy}</small>
          </article>
        ))}
      </section>

      <section id="modules" className="modules-section">
        <div className="section-head">
          <p className="kicker">EVERY STATION, ONE SYSTEM</p>
          <h2>One app for the whole house.</h2>
          <p>
            The floor, the pass and the register all read from the same order — no separate
            systems to reconcile at the end of the night.
          </p>
        </div>
        <div className="modules-grid">
          {MODULES.map(([Icon, title, copy]) => (
            <article key={title} className="module-card">
              <span className="module-card-icon" aria-hidden="true"><Icon size={20} /></span>
              <h3>{title}</h3>
              <p>{copy}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="offline" className="offline-section">
        <div className="offline-copy">
          <p className="kicker">BUILT FOR REAL RESTAURANT WI-FI</p>
          <h2>The Wi-Fi will drop. Service shouldn't.</h2>
          <p>
            Dineflow is built local-first: every terminal keeps its own copy of the menu, stock
            and open checks, and works from it directly. When the connection comes back, it syncs
            in the background — no "please wait, reconnecting" screen between a guest and their bill.
          </p>
          <ul className="offline-list">
            {OFFLINE_POINTS.map(point => (
              <li key={point}>
                <RefreshCw aria-hidden="true" size={16} />
                <span>{point}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="offline-art" aria-hidden="true">
          <div className="offline-card">
            <WifiOff size={22} />
            <strong>Connection lost</strong>
            <small>Checks keep saving to this terminal.</small>
          </div>
          <div className="offline-card offline-card-accent">
            <RefreshCw size={22} />
            <strong>Back online</strong>
            <small>3 checks synced automatically.</small>
          </div>
          <div className="offline-card">
            <History size={22} />
            <strong>Nothing lost</strong>
            <small>Every change is on the activity log.</small>
          </div>
        </div>
      </section>

      <section id="restaurants" className="landing-note">
        <h2>Made for the dining room.</h2>
        <p>
          One calm service for the people who run the pass, the floor and the book — from a
          twelve-seat counter to a full à la carte room. Owners see the whole restaurant from one
          dashboard; cashiers see exactly what they need on the terminal in front of them.
        </p>
      </section>

      <section id="pricing" className="landing-note">
        <h2>Simple to open.</h2>
        <p>
          One plan, everything above included — the floor, the kitchen display, the register,
          inventory and reporting all come with every restaurant from day one. Set up your owner
          account, then seat the rest of your team.
        </p>
      </section>

      <section id="support" className="landing-note">
        <h2>Hospitality for the hosts.</h2>
        <p>
          Account recovery and restaurant access guidance are built in, every sensitive change is
          recorded in a restaurant-wide activity log, and a revoked or lost terminal can be
          re-provisioned by a manager in minutes without losing unsynced sales.
        </p>
      </section>

      <section className="steps-section">
        <div className="section-head">
          <p className="kicker">GETTING STARTED</p>
          <h2>Open in an afternoon.</h2>
        </div>
        <div className="steps-grid">
          {STEPS.map(([number, title, copy]) => (
            <div key={title} className="step-card">
              <span className="step-number" aria-hidden="true">{number}</span>
              <strong>{title}</strong>
              <p>{copy}</p>
            </div>
          ))}
        </div>
        <Button to="/signup">Open your restaurant</Button>
      </section>

      <footer>
        <Brand dark />
        <nav aria-label="Footer">
          <a href="#platform">Platform</a>
          <a href="#modules">Features</a>
          <a href="#offline">Offline-first</a>
          <a href="#pricing">Pricing</a>
          <a href="#support">Support</a>
        </nav>
        <span>MORE THAN A POS. MISE EN PLACE FOR THE WHOLE HOUSE.</span>
        <Button to="/signup">Start for free</Button>
      </footer>
    </div>
  )
}

function RegisterMini() {
  return (
    <div className="mini-register">
      <aside>
        <b>Dineflow</b>
        <span><ShoppingCart size={11} /> Sell</span>
        <span><UtensilsCrossed size={11} /> Menu</span>
        <span><ClipboardList size={11} /> Orders</span>
      </aside>
      <div className="mini-products">
        <div className="mini-search"><Search size={11} /> Search the menu…</div>
        <div className="mini-grid">
          {MINI_PRODUCTS.map(([name, station, art]) => (
            <div className="mini-card" key={name}>
              <div className={`product-art ${art}`} />
              <b>{name}</b>
              <small>{station}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="mini-cart">
        <p>Open check</p>
        <div>Hamachi Crudo <b>$26.00</b></div>
        <hr />
        <strong>Total <b>$26.00</b></strong>
      </div>
    </div>
  )
}
