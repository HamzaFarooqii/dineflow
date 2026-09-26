# DineFlow Design System — MISE (Ember palette)

This is not a new proposal for the token *framework* — MISE (the `--mise-*` custom-property family,
the component inventory below, the review checklist) is still the one visual language DineFlow
runs on. What changed, post-Day-5, is the palette and typography inside that same framework: a
full-app visual redesign replaced MISE's original bright neutral colors with **Ember**, a warmer,
darker/moodier hospitality identity, while every token *name*, every component contract, and every
review rule in this document stayed exactly what it was. **Do not propose a second visual
language, and do not invent new `--mise-*` names for this** — a palette refresh reuses the existing
tokens' names and just carries new values; that's what happened here, and it's the pattern any
future palette adjustment should follow too.

## Brand

DineFlow: "the dining room, in one rhythm." Warm, editorial, fine-dining-menu inspired — not a
generic SaaS dashboard, not a copy of Toast/Square/TouchBistro/Clover/Lightspeed. Ember pushes this
further: a deep oxblood-rust accent instead of a bright gold, near-black warm ink instead of soft
grey, and a distinctive serif (Fraunces) on headings/dish-names/numerals so the product reads as a
premium hospitality brand rather than an admin panel. Flat cards, hairline borders, no gradients,
no glassmorphism, hover never moves position (staff shouldn't have to re-aim a tap because
something drifted) — all still true; Ember added tasteful hover-lift + shadow on genuinely
interactive cards (menu tiles, table cards) as the one deliberate exception to "never moves
position," since a few px of lift on hover (not on tap/press) reads as responsiveness, not drift.

## Colors

Canonical source: `apps/web/src/styles.css`, `:root`. Reference the custom property by name — never
hex values in new code. Values below are the current Ember palette; the token *names* are unchanged
from MISE's original set, so nothing that already referenced `var(--mise-saffron)` etc. needed to
change to pick up the new look.

| Token | Value | Use |
|---|---|---|
| `--mise-canvas` | `#E8DECE` | App background — a deep warm linen, not bright white/grey |
| `--mise-surface` | `#FFFFFF` | Cards, elevated surfaces — kept pure white so it pops against the deeper canvas |
| `--mise-surface-sunken` | `#DED0BA` | Recessed panels, hover fill, sunken form controls |
| `--mise-border-hairline` / `--mise-border-strong` | `#D6C7AD` / `#BFA980` | Borders |
| `--mise-ink` / `--mise-ink-secondary` / `--mise-ink-muted` / `--mise-ink-disabled` | `#1A130E` / `#4E3F34` / `#7A6A5A` / `#9C948A` | Text, in decreasing emphasis — near-black warm brown, not soft grey |
| `--mise-ink-inverse` | `#F7EFE2` | Text on dark surfaces |
| `--mise-action` / `--mise-action-hover` | `#1D1510` / `#2E2119` | Primary dark-fill surfaces (terminal shell, high-contrast buttons) |
| `--mise-saffron` / `--mise-saffron-deep` / `--mise-saffron-fill` | `#A93A0C` / `#7A2A08` / `#F2DCC8` | Brand accent, primary CTA fill, focus rings, "in progress" states — **repurposed from a bright gold to a deep oxblood-rust; any rule pairing a saffron *background* with dark ink text needs light/inverse text instead, see the contrast note below** |
| `--mise-success` / `--mise-success-fill` | `#2F5E3D` / `#DCE8DA` | Available / synced / served / positive |
| `--mise-warning` / `--mise-warning-fill` | `#96530E` / `#F0DCC0` | Needs attention (bill requested, low stock) |
| `--mise-danger` / `--mise-danger-fill` | `#8E2B21` / `#F0DAD5` | Blocked / out of service / cancelled |
| `--mise-info` / `--mise-info-fill` | `#1A4A70` / `#DCE6EE` | Neutral in-progress (seated, reserved, preparing) |
| `--mise-service-*` | dark surface set (deepened further, e.g. base `#100D0A`) | Sidebar, auth art, cashier terminal chrome |

**Contrast note (learned the hard way this pass):** `--mise-saffron` going from a light gold to a
dark oxblood-rust broke every existing rule that had a saffron *background* paired with dark ink
text — that pairing was correct against the old bright gold and unreadable against the new dark
one. Six such rules were found and fixed across the app (brand marks, the terminal's login/unlock
buttons, an onboarding step indicator, the landing footer CTA) by flipping their text to
`--mise-ink-inverse`. **If you ever change a color token's lightness significantly, grep for every
rule that uses it as a `background` and check the paired text color — don't assume the rest of the
codebase adapts automatically just because the variable name didn't change.**

### Status color semantics (must stay consistent across kitchen/table/order/inventory)

| Meaning | Tone | Used by |
|---|---|---|
| Positive / available / done | `success` | `TABLE_STATUS_TONE.available`, `KITCHEN_TICKET_STATUS_TONE.served` |
| In progress, needs eyes soon | `saffron` | `ordering`, `preparing` |
| Neutral waiting state | `info` | `seated`, `reserved`, `ready` |
| Needs attention | `warning` | `bill_requested` |
| Blocked / stop | `danger` | `out_of_service`, `cancelled` |
| Inactive / low emphasis | `muted` | `dirty`, `queued` |

Extend this table, don't replace it, when Inventory (low-stock/expiring) and Loyalty
(tier colors) need statuses in Days 3–4 — reuse `success`/`saffron`/`info`/`warning`/`danger`/
`muted`, don't add a seventh tone without Lead approval.

## Typography

**Fraunces** (new, `--mise-font-display`) — page/section headings, dish names, dashboard numerals,
the brand wordmark: anywhere the product should read as hospitality rather than admin tooling.
**Archivo** — everything else: dense UI text, buttons, labels, form fields, body copy. **IBM Plex
Mono** — prices, quantities, receipt/order numbers, timestamps: anything numeric that benefits from
tabular figures, always, never Fraunces (a premium display serif on a number that needs to stay
visually stable as digits change is the wrong call — mono does that job, keep it there).

| Role | Spec |
|---|---|
| Display (landing hero) | `500 clamp(46px,5.2vw,80px)/1.02 var(--mise-font-display)` |
| Page heading (h1) | `500 clamp(26–42px,~3vw)/1.1 var(--mise-font-display)` |
| Section heading (h2) | `500 19–26px var(--mise-font-display)` |
| Body | `400 14–16px Archivo` |
| Label / kicker | `600 10–12px Archivo`, uppercase, `.2em` tracking |
| Supporting text | `400 12–13px Archivo`, `--mise-ink-secondary`/`muted` |
| Numeric / price | `500–600 13–28px IBM Plex Mono` |
| Status chip text | `600 10–11px Archivo` |

Sizes above now also exist as tokens (`styles.css` `:root`): `--mise-text-display/h1/h2/h3/body/
small/micro` and `--mise-text-numeric-lg/md/sm`. Screens redesigned from here on size text from
these instead of a one-off px value; screens not yet touched keep their existing inline sizes —
this is additive, not a forced rewrite of every screen at once. The Fraunces rollout follows the
same rule: it's live on every screen this pass reached (Register, Payment, Dashboard, Landing,
Auth, the app shell + terminal shell nav, Settings, Orders, and every screen `PageHeader`/`Dialog`/
`EmptyState` render on, since those are shared) — a screen that still shows a bold Archivo heading
just hasn't been reached yet, not a deliberate exception. Check `docs/day-plans/day5-*.md` for
what's still in progress before assuming a gap is intentional.

## Icons

**One library: `lucide-react`.** Before the product-wide redesign (`docs/day-plans` — Hamza's
Day 4 redesign branches), every icon in the app was a hand-picked Unicode glyph (⌂ ⌁ ▦ ♧ …) —
consistent as a mechanism, not as a visual system (inconsistent weight, a card-suit symbol
standing in for "Guests"). Import icons from `apps/web/src/components/icons.ts`, not straight
from `lucide-react` — that file re-exports the specific set actually in use, so "which icons does
this app have" stays answerable from one place instead of drifting. Add a new icon there, not
inline, the first time a screen needs one that isn't already re-exported.

`Monitor` (terminal/device) and `History` (activity log) were added during the Settings pass —
`CardIcon` in `SettingsOverview.tsx` and the `.list-icon` tiles in `ManagerSetup.tsx` render these
instead of the old "▣"/"♧"/"▤" glyphs. `Shield` and `Play` were added for the Landing pass. Landing's
feature-strip icons and `RegisterMini`'s fake sidebar/search icons now reuse the same lucide icons
as the real logged-in nav (`ShoppingCart`/`UtensilsCrossed`/`ClipboardList`/`Search`) instead of
their own separate glyphs, so the marketing mockup actually previews the real product's icon set.

**Intentionally not migrated**: `Mark()` (`App.tsx`) — the "⌁" brand mark rendered next to the
"Dineflow" wordmark everywhere (Landing header/footer, the auth pages, the logged-in sidebar). This
is the app's logo glyph, not a generic UI icon standing in for a concept — swapping it for a lucide
icon would replace the brand mark with an arbitrary generic one, not actually fix anything. Every
other Unicode glyph on Landing (feature icons, the "watch" play glyph, `RegisterMini`'s fake nav)
is migrated; `Mark()` is the one deliberate exception.

## Spacing, radius, elevation

- Spacing scale: `--mise-space-2/4/8/12/16/24/32` (px). Pick from this scale; don't invent a
  one-off pixel value.
- Radius scale: `--mise-r1..r4` = `3/8/14/22px` (more generous than MISE's original `2/4/8/12`, part
  of Ember's softer, more premium feel). Small controls → r1/r2, cards → r3, large surfaces
  (modals, hero art) → r4. Nothing bigger — no "huge rounded" cards.
- Elevation: `--mise-e1/e2/e3`, increasing shadow depth, now warmer-toned and a touch more
  pronounced than MISE's original (`rgba(20,14,8,…)` instead of a cooler grey). Flat-with-hairline-
  border is still the default; elevation is for genuinely floating UI (the Floor detail drawer,
  discount popover) plus, new in Ember, a subtle hover-lift shadow on interactive cards (menu
  tiles, table cards) — see the Brand section above.
- Touch targets: 44px minimum height on every interactive control (buttons, inputs, table
  cards) — already the convention throughout; keep it for every new component.

## Components (existing — standardize on these, don't create alternates)

| Component | Reference | Notes |
|---|---|---|
| Primary button | `.cta` | Dark fill, inverse text. **Not yet consolidated**: `.report-primary`/`.report-secondary` (reporting.css) are the same recipe under a different name, still used by OwnerDashboardScreen's header actions, ReportsScreen's Export CSV button and CashierDashboardScreen's "Open register" link — leave as-is until CashierDashboardScreen (not yet redesigned) gets its own pass, since the three call sites span screens at different stages of this effort |
| Secondary button | `.secondary-cta` | Outlined |
| Text/tertiary button | `.text-action` | No border, saffron-tinted hover |
| Icon-only button | `.quantity button`, `.cart-line>button` | 44px square minimum |
| Search input | `.search` | Icon + input, saffron focus ring |
| Select/dropdown | `<SelectField>` (`apps/web/src/components/SelectField.tsx`) | Styled wrapper around a real native `<select>` — e.g. keyboard/mobile-picker behavior is free, it's just no longer bare browser chrome. Takes an optional `label` for a visible label above the control (Floor's area/waiter/transfer pickers, Inventory's wastage reason/batch pickers, Settings' restaurant/role pickers) or bare with `aria-label` for a compact inline toolbar control (Menu's category filter, Inventory's sort picker). **Not migrated**: `UnitSelector.tsx`'s unit picker uses `<select size={...}>` as an always-open listbox, not a collapsed dropdown — deliberate, not an oversight. `StoreDetails.tsx`'s currency/timezone selects and `ProductCatalogScreen.tsx`'s add-dish category/tax-rate selects are also still plain `<select>` — both sit inside `product-catalog.css`'s shared `.pc-field` wrapper, which has no `appearance` override, so swapping either in isolation risks the same native-arrow-plus-custom-chevron double-arrow bug `.pc-cat-select` had before its fix. Do all of `.pc-field`'s remaining selects together in one pass, not one at a time |
| Tabs | `.categories`, `.floor-area-tabs` | Pill row, active = dark fill |
| Card | `.catalog-card`, `.table-card` | Hairline border, r3, flat |
| KPI/metric card | `<MetricCard>` (`apps/web/src/components/MetricCard.tsx`) | Fully migrated — `ReportCard`/`.report-card` (Dashboard, Cashier terminal dashboard), `.inventory-summary-card` and `.inventory-detail-stat` (Inventory), `.pc-stat` (ProductCatalogScreen, CashierProductsScreen) and `.status-amount` (the Pending/Rejected/Refunded tiles on the Dashboard and Reports) were the same recipe built independently six times; all are retired, everything KPI-shaped now renders through `MetricCard`. Takes an optional `className` for a modifier like `.metric-card.rejected` (danger-tinted left border, replacing `.status-amount.rejected`) alongside the existing `featured` |
| Status chip | `<StatusBadge>` (`apps/web/src/components/StatusBadge.tsx`), class family `.status-badge-*` | **The new canonical chip going forward.** Migrated so far: `.pc-stock-pill`/`.pc-pill-dot` and `.dish-availability-badge` (Menu); `.order-state` on OrderHistoryScreen and ReceiptScreen (Orders); the guest sync-status text in `CustomerFinder` (Guests); `.floor-status` everywhere it appeared (Floor, Inventory) and Kitchen's `.order-state.tone-*`; and now Settings' `.terminal-state` (`TerminalState`, `ManagerSetup`, `TerminalHardwareSettings`, `CashierHardwareSettings` — `CashierLogin.tsx`'s own `.terminal-state` spans are the one exception, left as-is since that screen is out of scope) and `.mise-log-tag` (`ActivityScreen`). **Still not migrated**: `SyncCenterScreen`'s own `.order-state` usage, and Settings' `.team-role`/`.team-active`/`.count-badge` (SettingsOverview, ManagerSetup) — these read as role/count labels rather than a true status/tone concept, so they weren't forced into StatusBadge; revisit if a real tone-based need shows up there. Don't start a new pattern; if a screen needs a chip today, this is the one to add |
| Page header | `<PageHeader>` (`apps/web/src/components/PageHeader.tsx`) | Kicker/h1/subtitle/actions row every screen was hand-building slightly differently (`.floor-page-head`, `.reporting-heading`, ...). Migrated: Dashboard, Menu, Orders (OrderHistoryScreen, ReceiptScreen), Guests (CustomerScreen), Reports (ReportsScreen), Floor (`FloorScreen`), Kitchen (`KitchenScreen`), Inventory (`InventoryScreen`), and in Settings: `SettingsOverview`, `ManagerSetup` (kept its own breadcrumb nav above `PageHeader`), `ActivityScreen`. Watch for the same descendant-selector trap each time: a screen's own `.foo-page h1`/`.foo-heading h1` rule can silently outrank `.page-header h1` for the nested heading since both are equally specific — delete the old rule, don't just stop using it. **Still not migrated**: CashierDashboardScreen still builds its own `.reporting-heading` header directly; `StoreDetails.tsx` keeps its breadcrumb-style `.pc-hero` header (shares `product-catalog.css` with Menu, and has no single all-caps kicker to migrate cleanly — needs a deliberate look, not a mechanical swap); `CashierHardwareSettings.tsx` has no page-level `h1` at all by design (several `h2` sub-sections instead), so it isn't a `PageHeader` candidate |
| Popover/inline editor | `.discount-popover` | Anchored, not a full modal |
| Modal/dialog shell | `<Dialog>` (`apps/web/src/components/Dialog.tsx`) | Extracted from `ManagerApprovalModal`'s original focus-trap logic. `CustomerSelector` (Sell/POS) is migrated onto it — that was the app's second, undocumented overlay pattern, now retired. Supports an optional `kicker` and a `className="wide"` modifier (`.dialog-panel.wide`, 940px) for content wider than a typical confirmation dialog. **Still not migrated**: `ManagerApprovalModal` itself stands alone — it has PIN-keypad UI, lockout timers and manager selection well beyond a plain dialog shell, and is used across five-plus screens, so it's deliberately not rushed. Any *new* dialog uses `Dialog`. |
| Drawer | `.floor-detail` (fixed-position side panel) | Reuse for any future detail-panel need before inventing a new drawer pattern |
| Notice/toast-equivalent | `.form-notice` (error/status variants) | No true stacking toast system exists yet — if a screen needs one, it's a new shared component, flag to the Lead before building a one-off |
| Empty state | `<EmptyState>` (`apps/web/src/components/EmptyState.tsx`) | Title + optional description + optional action. Screens not yet migrated keep their own plain `<p>` message for now. Text pattern stays: state the fact, not "no data" |
| Loading state | `role="status"` text ("Loading the floor…") | No skeleton components yet |
| Confirmation dialog | `window.confirm(...)` (e.g. "Void this check") | Acceptable for low-frequency destructive actions; don't build a custom confirm dialog for parity's sake alone |

**Gaps, honestly**: no dedicated Table/DataGrid, Tooltip, or Skeleton component exists. Don't
invent one speculatively — build it the first time a screen genuinely needs it, as a
shared component from that point on, not a one-off.

## Restaurant-specific components (existing — reuse, extend, don't duplicate)

| Component | File | Reused by |
|---|---|---|
| `MenuItemCard` | `screens/menu/MenuItemCard.tsx` | Register grid |
| `MenuCategoryTabs` | `screens/menu/MenuCategoryTabs.tsx` | Register |
| `MenuSearch` | `screens/menu/MenuSearch.tsx` | Register |
| `DishAvailability` | `screens/menu/DishAvailability.tsx` | Register, ProductCatalogScreen, CashierProductsScreen |
| `RestaurantOrderItem` | `screens/menu/RestaurantOrderItem.tsx` | Register cart |
| `TableCard` | `screens/floor/TableCard.tsx` | Floor screen |
| `KitchenTicketCard` | `screens/kitchen/KitchenTicketCard.tsx` | KDS |

Day 3–5 additions that need the same treatment (build once, reuse everywhere they apply):
recipe-ingredient-line row, ingredient stock row, loyalty-tier badge, customer profile card.
Before building one, check this table first — a near-duplicate is a design review rejection.

## Design review checklist (every UI PR)

- New colors? → must be an existing `--mise-*` token, or flagged to the Lead before merging.
- New radius/spacing value not on the scale? → reject.
- New button/card/chip visually different from the table above with no stated reason? → reject.
- Touch targets under 44px? → reject.
- A second modal/drawer/toast implementation? → reject, point at the existing one.
