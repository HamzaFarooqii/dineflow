# Ember POS design artifact

This directory is the visual source of truth for Dineflow. It distills the Ember restaurant POS
direction into tokens, component rules, responsive behavior, and representative production
surfaces. Product functionality, copy, data, and routes remain Dineflow's; presentation follows
this artifact.

## Non-negotiable identity

- Canvas: warm ivory \`#fffdf6\`; never beige-heavy or grey.
- Service chrome: warm near-black \`#1a1410\`.
- Primary action: ember orange \`#f97316\`.
- Attention: amber \`#fbbf24\`.
- Information and card payments: blue \`#0ea5e9\`.
- UI type: Inter. Order numbers, prices, timestamps, and operational codes: JetBrains Mono.
- The interface is flat, crisp, and operational. Use one-pixel borders and very restrained shadows.
- Headings are compact sans serif—not editorial serif.
- Orange is reserved for the current task, primary action, active navigation, and urgent focus.
- Controls use 8px corners; cards use 10–12px. Pills are only for statuses.
- Primary touch targets are at least 44px; POS actions are 52–64px.

## Layout

- Desktop shell: 224px dark rail, 64px top bar, ivory working canvas.
- Tablet POS: product workspace plus a fixed-width order rail.
- Mobile: one working column and a dark bottom navigation rail.
- Screen content stays dense enough for restaurant operations, with 16–24px page gutters and
  12–16px gaps.
- Avoid decorative hero treatments inside the application. The first viewport is always the
  working surface.

## Components

- Primary button: orange fill, white text, 8px corner, no gradient.
- Secondary button: ivory/white fill, graphite border, graphite text.
- Cards: white or ivory, subtle border, no decorative shapes.
- Tables: compact rows, uppercase 12px labels, mono numeric cells.
- Inputs: white background, graphite border, orange focus ring.
- Statuses: tinted semantic background with text and optional dot; never use color alone.
- Empty/error/loading states keep the same card frame and clearly explain the next action.
- Motion is limited to 120–180ms color/border transitions and a 1px interactive lift.

## Reference

The documented Ember POS reference uses \`#1a1410\`, \`#fffdf6\`, \`#f97316\`, \`#fbbf24\`,
\`#0ea5e9\`, Inter, and JetBrains Mono. The specimen in \`index.html\` demonstrates the required
silhouette and component hierarchy.
