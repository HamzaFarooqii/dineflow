# Terminal hardware and storage settings

## Entry point and scope

Open **Settings → POS setup → Manage terminals**. The existing `/settings/terminals` page now includes hardware and storage panels in the shared Counterline layout. A provisioning link scrolls to the existing form; employee setup and cashier sign-in links connect the next steps.

Production frontend changes are confined to `apps/web/src/terminal-auth/`: a small insertion in `ManagerSetup.tsx` plus the `hardware/` modules. No API endpoint, OpenAPI definition, migration, authentication implementation, business database, register or checkout module changed.

The capability adapter reads a projection of local terminal metadata, storage estimates/persistence, connectivity and the existing service-worker precache. Status inspection does not rotate credentials or mutate the terminal cache. A service-worker registration alone is not reported as offline-ready: cached entry resources and the cashier chunk must also be present. Browser API checks time out after eight seconds with a visible recovery message.

## Manual test guide

1. Start the existing API with its configured environment. From `apps/web`, run `npm run build`, then `npm run preview -- --host 127.0.0.1 --port 5173`. Use `http://127.0.0.1:5173` so it matches the API's configured `WEB_ORIGIN`. The preview server inherits the existing `/api` proxy. Use a production build for offline-shell testing; the dev server does not prepare offline launch.
2. Sign in with an owner/manager account. Use the sidebar **Settings**, then **Manage terminals** under **POS setup**. Select the terminal's store.
3. Confirm the current terminal name, device/store IDs, store name, receipt prefix, last authorization validation and seven-day expiry. A browser without a terminal should show a setup message. Use **Go to terminal provisioning** to reach the existing form.
4. Check **Browser storage**. Compare the reported usage/quota with browser developer tools. Select **Request persistent storage**; check the grant/denial feedback. The browser decides whether to grant it and may not show a prompt. A grant reduces eviction risk; it is not a backup or recovery guarantee.
5. If offline launch is not ready, use **Open cashier sign in** while online to let the existing app save its shell. Return through Settings and select **Check device status**. Expect **Ready for offline cashier launch** after the service worker and cache are available.
6. While Settings remains open, disconnect/reconnect the network and check **Browser offline / Browser online** announcements. This indication does not claim that the API is reachable or sales are synchronized.
7. Focus **Scan test value**. With an HID keyboard scanner configured for an Enter suffix, scan a non-sensitive test barcode. Check the exact value, character count and timestamp. A normal keyboard plus Enter exercises the same input path. **Clear scanner test** removes the result and returns focus to the field. Navigate away and return; the result must not remain.
8. Select **Preview test receipt**, then **Print test receipt**. Choose an installed 80 mm printer, 100% scale, and disable browser headers/footers. Check that only the test receipt prints: no sidebar, navigation, form or button. Sample totals are subtotal USD 31.00, tax 1.55, total 32.55, cash tender 40.00, change 7.45. The receipt prominently says **TEST RECEIPT — NOT A SALE** and includes the terminal identity.
9. Cancel the dialog and repeat. The UI must never claim physical printing succeeded. Confirm that neither attempt creates a sale, payment, receipt number/sequence, stock movement or outbox operation.
10. Use Tab/Shift+Tab and Enter through the new controls. Check visible focus, the scanner's Enter behavior, Clear returning focus, and status/error announcements. Check 375, 390, 768 and 1440 px without horizontal scrolling.
11. Review recovery guidance for expired authorization, changed clocks, unavailable cache, unsupported/denied/full storage and reprovisioning. Do not clear site data or reset the local database to test these cases on a working shop terminal. Reprovisioning does not restore unsynced sales.

## Automated verification

Run existing regression checks from `apps/api`:

```powershell
npm test
npm run test:integration
npm run test:browser
```

Run the hardware-specific check from the repository root:

```powershell
node --import ./apps/api/node_modules/tsx/dist/loader.mjs docs/terminal-hardware/browser-check.mts
```

The runner uses the already-installed API Playwright dependency and web Vite dependency. It builds with local test-only Supabase settings and uses a fresh browser context. Owner identity and terminal-list HTTP responses are fixtures; no live Supabase connection is used. The actual production Settings page and browser capability adapter are tested. A separate, test-only Vite entry injects the typed adapter for unsupported, denied, granted, read-error, print-error, expired, revoked and changed-clock scenarios. Neither fixture is a production route.

After any browser suite, run the normal `npm run build` from `apps/web` to restore the normal environment's production assets.

### Results (2026-09-15)

- Web production build: passed; Vite reports a main-bundle size warning (approximately 627 kB).
- Existing terminal PIN/security tests: 3 passed.
- Existing OpenAPI/SQL/API integration tests: 10 passed.
- Existing browser suite: **failed at its first legacy selector**, `heading: Cashier access.`. The merged UI calls this page `Cashier employees`; both the old assertion and the new heading already exist on base `6637b92`. This task leaves that suite and employee UI unchanged. The old suite is not reported as passed.
- Hardware browser suite: passed. Checks the existing Settings entry point, read-only identity display, real browser cache readiness, connectivity transitions, Enter-terminated scanner capture, character count, clearing/focus, print isolation, persistent-storage outcomes and capability/recovery states.
- Before/after IndexedDB, localStorage and sessionStorage snapshots match across hardware tests; intercepted API mutations remain zero. No business table or test sale is created.
- All four requested widths have overflow assertions and screenshots. Live regions/status semantics and keyboard focus are checked; audible screen-reader speech has not been tested.
- Browser print-media output contains only the receipt; the generated PDF is one approximately 80 × 200 mm page, with 4 mm page margins and a 72 mm content area.

### Evidence

- [375 px](screenshots/terminals-375.png), [390 px](screenshots/terminals-390.png), [768 px](screenshots/terminals-768.png), [1440 px](screenshots/terminals-1440.png)
- [Receipt print view](screenshots/test-receipt-print.png), [80 mm test PDF](screenshots/test-receipt-80mm.pdf)

## Real-device limitations

Tested on Windows with Node 24.18.1 and Playwright Chromium 153.0.8010.12. Scanner keystrokes were simulated; no physical scanner model was attached. The print action was intercepted in the automated test and Chromium generated the PDF separately; no physical printer, driver or native print dialog was validated. Record the shop's actual OS, browser, scanner, printer and driver versions before pilot acceptance. Paper sizing and margins may need adjustment in the driver.

Persistent storage does not protect against deliberate data clearing or device loss. Browser connectivity is a network hint. Offline app readiness does not imply catalog bootstrap, checkout readiness or synchronized sales. Hardware tests remain separate from future checkout receipt printing.

Browser behavior references: [StorageManager](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager), [printing styles](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing), [page size](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40page/size).
