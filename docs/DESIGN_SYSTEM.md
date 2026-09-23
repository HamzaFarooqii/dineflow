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

| Component | Reference class(es) | Notes |
|---|---|---|
| Primary button | `.cta` | Dark fill, inverse text |
| Secondary button | `.secondary-cta` | Outlined |
| Text/tertiary button | `.text-action` | No border, saffron-tinted hover |
| Icon-only button | `.quantity button`, `.cart-line>button` | 44px square minimum |
| Search input | `.search` | Icon + input, saffron focus ring |
| Select/dropdown | native `<select>` styled inline (see `.floor-waiter-select`) | No custom dropdown component yet — don't build one for a single use site |
| Tabs | `.categories`, `.floor-area-tabs` | Pill row, active = dark fill |
| Card | `.catalog-card`, `.table-card` | Hairline border, r3, flat |
| Status chip | `.floor-status`, `.order-state`, kitchen ticket status badge | Fill/ink pair per tone (see Colors) — **one pattern, reused across floor/kitchen/orders**, not reinvented per screen |
| Popover/inline editor | `.discount-popover` | Anchored, not a full modal |
| Modal | `ManagerApprovalModal` | The one true modal pattern so far — reuse its structure (backdrop, focus trap) for any new modal rather than writing a second one |
| Drawer | `.floor-detail` (fixed-position side panel) | Reuse for any future detail-panel need before inventing a new drawer pattern |
| Notice/toast-equivalent | `.form-notice` (error/status variants) | No true stacking toast system exists yet — if Day 3–5 needs one, it's a new shared component, flag to the Lead before building a one-off |
| Empty state | Plain `<p>` with a specific message (e.g. Floor's "No floor areas or tables are set up...") | No dedicated `<EmptyState>` component yet — text pattern is: state the fact, not "no data" |
| Loading state | `role="status"` text ("Loading the floor…") | No skeleton components yet |
| Confirmation dialog | `window.confirm(...)` (e.g. "Void this check") | Acceptable for low-frequency destructive actions; don't build a custom confirm dialog for parity's sake alone |

**Gaps, honestly**: no dedicated Table/DataGrid, Tooltip, or Skeleton component exists. Don't
invent one speculatively — build it the first time a Day 3–5 screen genuinely needs it, as a
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
