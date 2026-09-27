# Counterline / Dineflow design system — Ember POS

The visual source of truth is `docs/ember-artifact/`. Its files are reference-only: application
work must implement that direction without editing the artifact itself.

The live visual layer is `apps/web/src/ember.css`. It is loaded last so existing feature behavior,
data flow, permissions, routes, and workflows stay intact while the product presents as one Ember
system.

## Visual thesis

Ember is a compact, premium restaurant operations interface. It combines warm ivory workspaces,
near-black service chrome, white content cards, and one strong orange action color. It is crisp,
fast, and operational—not decorative, editorial, or generic SaaS.

## Foundations

### Color

| Role | Token | Value |
|---|---|---|
| Working canvas | `--mise-canvas` | `#F8F4E9` |
| Ivory chrome | `--mise-surface-ivory` | `#FFFDF6` |
| Content surface | `--mise-surface` | `#FFFFFF` |
| Sunken surface | `--mise-surface-sunken` | `#F2EDE2` |
| Service chrome | `--mise-service-base` | `#1A1410` |
| Raised service chrome | `--mise-service-surface` | `#251D18` |
| Primary action | `--mise-saffron` | `#F97316` |
| Primary hover | `--mise-saffron-deep` | `#D95C08` |
| Action tint | `--mise-saffron-fill` | `#FFF0E5` |
| Success | `--mise-success` | `#16835B` on `#E7F6EF` |
| Warning | `--mise-warning` | `#8B6200` on `#FFF7D6` |
| Information | `--mise-info` | `#0879AD` on `#E7F6FD` |
| Danger | `--mise-danger` | `#C43D2F` on `#FDECEA` |
| Primary ink | `--mise-ink` | `#241B16` |
| Secondary ink | `--mise-ink-secondary` | `#4D433D` |
| Muted ink | `--mise-ink-muted` | `#766A62` |
| Hairline | `--mise-border-hairline` | `#E3DDD3` |
| Strong border | `--mise-border-strong` | `#C9BFB3` |

Orange is reserved for the primary task, active navigation, focus, and urgent attention. Semantic
colors communicate status and always include a readable label.

### Typography

- Inter 400–800 is the only interface and heading family.
- JetBrains Mono 500–700 is used for prices, totals, quantities, order references, timestamps,
  percentages, terminal codes, and other operational data.
- Page titles are compact, bold sans serif with tight tracking.
- Default working text is 14px. Labels and secondary metadata use 11–13px.
- Avoid text below 10px and keep essential state at 12px or larger.

### Shape, spacing, and depth

- Compact radius: 4px for tiny tags and internal accents.
- Control radius: 8px for buttons, fields, tabs, navigation, and icon containers.
- Card radius: 12px for panels, product cards, tables, and status groups.
- Overlay radius: 16px for dialogs and drawers.
- Pills are reserved for compact statuses and taxonomy labels.
- One-pixel borders define structure. Shadows stay subtle and are used only for cards, floating
  overlays, or a small interactive lift.
- Desktop page gutters are 20–44px; mobile gutters are 12–16px.
- Card and panel gaps are 12–16px.
- Controls are at least 44px high; frequent POS actions may be 52–64px.

## Application shell

- Desktop uses a 224px near-black navigation rail and a 64px ivory top bar.
- Navigation groups follow restaurant operations: Dashboard, Operate, Manage, Insights, Settings.
- Active navigation is solid Ember orange with white icon and text.
- Desktop content stays within a 1500px working width without oversized cards.
- Tablet register layouts keep products and the current check visible together.
- Mobile uses one working column and a fixed, horizontally scrollable dark bottom navigation.

## Shared primitives

| Primitive | Ember treatment |
|---|---|
| `PageHeader` | Bold compact title, mono uppercase eyebrow, concise support text, optional actions |
| `.cta` | Orange fill, white text, 8px radius |
| `.secondary-cta` | White fill, warm graphite border and text |
| `MetricCard` | White 12px card, subtle border, mono value, restrained featured accent |
| `StatusBadge` | Small semantic pill with readable text |
| `SelectField` | Native accessible select inside the shared 44px control frame |
| `Dialog` | White 16px overlay, focus trap, solid dimmed backdrop, restrained shadow |
| Tables and lists | Compact rows, subtle separators, uppercase labels, mono numeric cells |
| Empty states | Bordered card with a clear fact, explanation, and optional next action |
| Loading states | Stable working surface with explicit status or skeleton |
| Error states | Semantic tint, readable message, and recovery action where possible |

## Page patterns

- Dashboard: four compact metrics followed by two-column operational panels.
- Register: dense searchable product workspace plus a persistent current-check rail.
- Orders and receipts: filter tools, scannable rows, mono references and totals.
- Kitchen: clear station tabs, elapsed-time emphasis, and large ready/bump actions.
- Floor: compact table cards with unambiguous occupancy/status labels.
- Products and inventory: search/filter tools first, then dense cards or master-detail lists.
- Customers and staff: readable identity rows, small statuses, and predictable actions.
- Settings: grouped setup cards followed by focused forms and terminal/team summaries.
- Authentication and setup: dark service panel plus an ivory/white focused form surface.

## Interaction and accessibility

- Use shared Lucide icons from `apps/web/src/components/icons.ts`.
- Hover and focus transitions last 120–180ms.
- Interactive cards may lift by 1px; passive cards do not move.
- Keyboard focus uses the Ember orange halo.
- Touch targets remain at least 44px.
- Respect `prefers-reduced-motion`.
- Status never relies on color alone.
- Responsive layouts must remain usable at 200% text enlargement without horizontal clipping.

## Implementation boundary

Presentation work may reorganize markup and shared components when necessary for clarity, but it
must not change authentication, permissions, routes, API calls, database behavior, calculations,
offline behavior, or the meaning and order of operational workflows.
