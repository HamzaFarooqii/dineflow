# DineFlow Design System — MISE

This is not a new proposal — MISE is the visual identity DineFlow already shipped with (Day 1,
commits `751d798`/`80f7608`), applied across every screen. This document formalizes it as the
binding contract so Days 3–5 extend it instead of drifting. **Do not propose a second visual
language.** If something looks outdated, restyle it with these tokens; don't invent new ones.

## Brand

DineFlow: "the dining room, in one rhythm." Warm, editorial, fine-dining-menu inspired — not a
generic SaaS dashboard, not a copy of Toast/Square/TouchBistro/Clover/Lightspeed. Flat cards,
hairline borders, no gradients, no glassmorphism, hover never moves position (staff shouldn't
have to re-aim a tap because something drifted).

## Colors

Canonical source: `apps/web/src/styles.css`, Section E, `:root`. Reference the custom property
by name — never hex values in new code.

| Token | Value | Use |
|---|---|---|
| `--mise-canvas` | `#F2F0EC` | App background |
| `--mise-surface` | `#FFFFFF` | Cards, elevated surfaces |
| `--mise-surface-sunken` | `#E9E6E0` | Recessed panels, hover fill, sunken form controls |
| `--mise-border-hairline` / `--mise-border-strong` | `#E0DCD5` / `#C9C3BA` | Borders |
| `--mise-ink` / `--mise-ink-secondary` / `--mise-ink-muted` / `--mise-ink-disabled` | `#1B1917` / `#55504A` / `#6F6860` / `#9C948A` | Text, in decreasing emphasis |
| `--mise-ink-inverse` | `#FAF8F5` | Text on dark surfaces |
| `--mise-action` / `--mise-action-hover` | `#1F1B17` / `#36302A` | Primary buttons |
| `--mise-saffron` / `--mise-saffron-deep` / `--mise-saffron-fill` | `#E5A73C` / `#9A6A12` / `#FBEFD8` | Brand accent, active nav rail, "in progress" states |
| `--mise-success` / `--mise-success-fill` | `#1F7A4D` / `#E3F2E9` | Available / synced / served / positive |
| `--mise-warning` / `--mise-warning-fill` | `#C2600D` / `#FCEBD8` | Needs attention (bill requested, low stock) |
| `--mise-danger` / `--mise-danger-fill` | `#B3271F` / `#FBE6E3` | Blocked / out of service / cancelled |
| `--mise-info` / `--mise-info-fill` | `#1F5C8C` / `#E4EEF6` | Neutral in-progress (seated, reserved, preparing) |
| `--mise-service-*` | dark surface set | Sidebar, auth art, cashier terminal chrome |

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

**Archivo** — headings, UI text, buttons, labels. **IBM Plex Mono** — prices, quantities,
receipt/order numbers, timestamps: anything numeric that benefits from tabular figures.

| Role | Spec |
|---|---|
| Display (landing hero) | `600 clamp(46px,5.2vw,76px)/1.02 Archivo` |
| Page heading (h1) | `600 clamp(26–36px,~3vw)/1.12–1.15 Archivo` |
| Section heading (h2) | `600 20–24px Archivo` |
| Body | `400 14–16px Archivo` |
| Label / kicker | `600 10–12px Archivo`, uppercase, `.2em` tracking |
| Supporting text | `400 12–13px Archivo`, `--mise-ink-secondary`/`muted` |
| Numeric / price | `500–600 13–20px IBM Plex Mono` |
| Status chip text | `600 10–11px Archivo` |

Sizes above now also exist as tokens (`styles.css` `:root`): `--mise-text-display/h1/h2/h3/body/
small/micro` and `--mise-text-numeric-lg/md/sm`. Screens redesigned from here on size text from
these instead of a one-off px value; screens not yet touched keep their existing inline sizes —
this is additive, not a forced rewrite of every screen at once.

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
instead of the old "▣"/"♧"/"▤" glyphs. The Landing page (`App.tsx`'s `Landing()`/`RegisterMini()`)
is the one screen still on hand-picked Unicode glyphs (⌁ ◷ ♧ ⬡ ▷ ▣ ▦ ▤ ⌕) — its own redesign pass.

## Spacing, radius, elevation

- Spacing scale: `--mise-space-2/4/8/12/16/24/32` (px). Pick from this scale; don't invent a
  one-off pixel value.
- Radius scale: `--mise-r1..r4` = `2/4/8/12px`. Small controls → r1/r2, cards → r3, large
  surfaces (modals, hero art) → r4. Nothing bigger — no "huge rounded" cards.
- Elevation: `--mise-e1/e2/e3`, increasing shadow depth. Use sparingly — flat-with-hairline-
  border is the default; elevation is for genuinely floating UI (the Floor detail drawer,
  discount popover).
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
