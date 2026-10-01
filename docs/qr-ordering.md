# QR table ordering

Guests scan a per-table QR code, get a short-lived session bound to that table, browse a public-safe menu and submit orders. Staff confirm each order (default) and it joins the table's open check. Feature-flagged, off by default.

## Disabling / enabling

- `QR_ORDERING_ENABLED=true` on the API enables the **public** router (`/public/qr/*`). Anything else, or unset, returns `404 feature_disabled`. Read on every request, so it is a runtime kill switch.
- Manager/staff endpoints (`/qr/*`, `/pos/qr/*`) stay available so QR codes can be prepared and pending orders drained while public access is off.
- Per table: `PATCH /qr/tables/:id/settings` sets `mode` (`menu_only`, `menu_and_order`, `waiter_only`) and `require_confirmation`. `DELETE /qr/tables/:id/code` revokes the code and ends all sessions.

## Model

- QR code = 64-hex random token. Only its sha256 is stored; the raw code is returned once (Floor drawer shows it as a QR image and link).
- Session (120 min) is bound to store, table and QR generation. It is invalid when expired, revoked, the code is rotated/revoked, or the table is not in `seated`/`ordering`/`served`/`bill_requested`. A DB trigger revokes sessions when a table becomes available, dirty, reserved or out of service.
- The customer never sends `store_id`, `table_id`, prices, tax, discounts, approvals, employee ids or payment claims. Unknown body fields are `422 forbidden_field`.
- Prices, modifier deltas, tax and service charge are resolved server-side from the live catalog.
- Submissions are idempotent by `(store, session, operation_id)` with a payload hash: same content replays the original, different content is `409 operation_id_conflict`.
- Order submission locks the table row `FOR UPDATE`, so phones on one table serialize and there is one open check per table.
- Customer statuses: `awaiting_confirmation` -> `added_to_check` or `declined`. Nothing tells a guest food is being prepared.
- **No kitchen ticket is created by QR orders.** Kitchen tickets are created only when staff close the check (existing behaviour).

## Security integration points (`apps/api/src/routes/qr-security-hooks.ts`)

Hooks default to allow and are replaced with `setQrSecurityHooks`:

| Hook | Called | Intended use |
| --- | --- | --- |
| `sessionIssuance` | before `POST /public/qr/sessions` | per-IP / per-code rate limit, bot checks |
| `orderSubmission` | before `POST /public/qr/orders` | per-session / per-table rate limit |
| `statusPolling` | before `GET /public/qr/orders` and menu | polling limits |
| `staffConfirmation` | before staff confirm/reject | stronger staff authorization (PIN / approval) |

This branch does not include the security branch's implementation; wire it by calling `setQrSecurityHooks` at app start.

## Known limitations

- Close-vs-append race: a guest order can land between the check-close commit and the table becoming dirty; it is then rejected on the next request but a window exists.
- Staff full-replace edits of an open check drop `qr_submission_id` tags on items. Guest tracking reads the submission snapshot, so it is unaffected.
- `moveTableParty` does not move open checks (pre-existing).
- Stock levels are not enforced for QR orders. Combos are unavailable via QR (`combo_unavailable_via_qr`).
- No "call waiter" action. `served` tables do not accept new guest orders.
- Tests simulate concurrency by serializing whole transactions on one PGlite connection; ordering in real Postgres comes from the table row lock.
- Not release-ready until the security hooks are integrated and verified.

## Unresolved product decisions

- Should guest orders be allowed on `served` tables?
- Should prepayment/auto-confirmed orders fire the kitchen earlier (separate architecture decision)?
- Session TTL (120 min) and whether the QR should print table label plus store name.
- Whether stock-out should hide items automatically.
