# Saved sale receipts and local history

## Scope and integration

Branch: `feat/cashier-sale-receipts`, based on `develop` at `92745bd`.

- Checkout opens `/pos/orders/:orderId` (cashier) or `/orders/:orderId` (owner), using `completeLocalSale()`'s committed `operationId`.
- Cashier Orders navigation opens `/pos/orders`. Owner Orders remains `/orders`.
- Cashier pages retain `CashierTerminalRoute` and `CashierPosLayout`; owner pages retain `AppLayout`.
- Both contexts use the same snapshot receipt and isolated print output. History and detail reads are local, store-scoped Dexie reads; cashier access never resolves an owner active store or owner token.
- History retains background/manual sync and retry through the existing helpers, with the terminal flag for cashier requests. Printing has no write or upload path.
- Offline app-shell navigation now covers cashier register, payment, history, and saved receipt URLs as well as login. Authorization checks still run after an offline reload.
- The existing sidebar becomes a compact Sell/Orders navigation at mobile widths. No second sidebar or header is introduced.
- No endpoints, migrations, business schemas, authentication policies, customer persistence, or receipt sequence logic changed.

PR #6 is not in this base, so this implementation does not import or copy its unmerged test-receipt components. Sale receipts remain separate from hardware test receipts. The available checkout schema has no recorded discount or customer fields; neither is invented. Customer and discount details can be displayed when their persistence contracts are merged.

The frontend lockfile on the base omitted the already-declared `vite-plugin-pwa` dependency. The lockfile is repaired so clean installation and the required offline build work; no new runtime dependency was added.

## Exact manual reviewer steps

Use a test store and test terminal. These steps intentionally create real local sales.

1. Install dependencies with `npm ci` in `apps/web` and `apps/api`. Start the API using its configured environment. Run `npm run build`, then `npm run preview -- --host 127.0.0.1` in `apps/web`. Use a configured API URL reachable from preview. Offline reload testing requires the production build, not the development server.
2. Through Settings → POS setup, provision the browser and create/enable a cashier PIN if needed. Open cashier login and unlock it. Wait for offline readiness, then open the register while online to download the store catalog.
3. Add a product, proceed to payment, select Cash, enter sufficient tender, and complete the sale. Confirm that a saved receipt opens automatically, with the store snapshot, receipt number, recorded timezone, item name/SKU/quantity/price, tax, total, tender and change.
4. Select **Print receipt**. Choose an 80 mm printer or PDF, 100% scale, and disable browser headers/footers. Cancel the dialog. The sale must remain visible. Try again; the output now says **DUPLICATE RECEIPT**. A dialog opening is not confirmation that paper printed.
5. Select **New sale**, add another product, choose external Card, enter a recognizable reference, explicitly confirm approval, and complete. Verify card method, reference, tender equal to total, and zero change.
6. In browser developer tools, go offline. Use **New sale** for a cash transaction. Confirm checkout, receipt, and Orders still work. Refresh the saved receipt URL while offline: the stored receipt must load. Existing seven-day authorization limits apply.
7. Open **Orders** from cashier navigation at both desktop and mobile widths. Search by receipt number, try the recorded sale date, try a nonmatching value, and clear the filters. Open an older receipt and print it: it must say **DUPLICATE RECEIPT**. Orders is active in navigation; Sell is active only on register/payment.
8. Compare IndexedDB `counterline-pos` before/after repeated printing: `orders`, `order_items`, `payments`, `outbox`, `stock_adjustments`, and `sync_metadata` must be unchanged. Run this comparison offline to exclude independent background sync.
9. Change the catalog product name/price using the normal catalog management process, refresh the catalog, and reopen the older receipt. Its saved item name and price must remain unchanged.
10. Reconnect. History's sync/retry must use `/pos/orders/push` for cashier sessions, without an owner bearer token. Pending, synced, and rejected orders remain visible. Rejected paid sales are kept for review.
11. Sign in as the owner and open Orders through the owner navigation. View/print the same store's local saved sales. Owner sync uses `/orders/push`. No remote history restoration is implied.
12. Refresh a nonexistent receipt URL: verify **Receipt not found** and navigation back to Orders. An empty browser/store shows the no-orders state. A failed database read provides an error and retry, never fabricated receipt data.
13. Check 375, 390, 768 and 1440 px, keyboard Tab focus, status feedback, long product/receipt names, and a basket large enough for multiple print pages.

## Automated verification

From repository root:

```powershell
cd apps/web
npm test
npm run build
cd ../api
npm test
npm run test:orders
npm run test:integration
npm run test:browser
cd ../..
node --import ./apps/web/node_modules/tsx/dist/loader.mjs docs/receipts/browser-check.mts
```

The receipt browser runner uses an isolated Chromium profile and synthetic identity/catalog inputs. It completes sales using the real checkout UI and atomic Dexie transaction; it does not inject mock receipts. Upload outcomes are simulated. No live shop data or credentials are used. It builds with test configuration; run the normal web production build afterward to restore local build configuration.

Results:

- Web production build: passed (existing large-chunk warning).
- Web tests: 7 passed, including store isolation, immutable snapshots, incomplete-receipt failure, recorded-timezone date boundary, card reference and read-only behavior.
- Terminal security: 3 passed.
- Order API validation: 5 passed.
- Terminal API integration: 10 passed.
- Receipt browser checks: cash/card checkout, offline navigation and receipt URL refresh, history/reprint, print cancellation return and thrown failure, whole-business-database equality across print attempts, catalog changes, owner/terminal upload context, empty/not-found/no-results states, date search, keyboard navigation, responsive layouts and 80 mm printing.
- Existing terminal browser suite: failed at its pre-existing `Cashier access.` heading assertion. The current merged heading is `Cashier employees`; receipt work does not change that screen or its test.

## Evidence and device limitations

See [screenshots](screenshots/) for cashier receipt/history at all four widths and owner receipt at mobile/desktop widths.

- [80 mm receipt PDF](screenshots/receipt-80mm.pdf): one page.
- [Long basket PDF](screenshots/receipt-long-80mm.pdf): 32 committed item snapshots across nine pages, including a long receipt prefix.
- [Print view](screenshots/receipt-print.png).

Test environment: Windows, Node 24.18.1, Playwright Chromium 153.0.8010.12. PDF page dimensions are approximately 80 × 200 mm, with 4 mm margins and 72 mm content width. The print driver must also be configured for the actual 80 mm paper. Long baskets paginate without hiding overflow or cutting item rows.

Browser print calls were intercepted to simulate cancellation and failure. PDF export and rendered-page inspection are separate from native-dialog and physical shop-printer testing. No physical printer was attached; driver settings, paper feed/cutting, actual print cancellation, and audible screen-reader output still need device verification. No UI message claims physical printing succeeded.

Unsynced history exists only in this browser. This feature neither restores lost local data nor changes existing authorization/recovery behavior.
