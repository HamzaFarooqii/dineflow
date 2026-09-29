// Isolated component/browser regression: actual PaymentScreen, Dexie checkout and receipt
// renderer, with synthetic catalog data. No live account, database, or payment provider.
import assert from 'node:assert/strict'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = root + 'apps/web/split-qa.html'
const screenshots = root + 'docs/qa/a2'
await mkdir(screenshots, { recursive: true })
await writeFile(fixture, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root"></main><script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PaymentScreen } from '/src/screens/PaymentScreen.tsx';
import { SaleReceipt } from '/src/receipts/SaleReceipt.tsx';
import { readReceipt } from '/src/receipts/data.ts';
import { posDb } from '/src/lib/db.ts';
import { usePosStore } from '/src/lib/pos-store.ts';
import '/src/styles.css'; import '/src/ember.css'; import '/src/receipts/receipts.css';
const storeId = '11111111-1111-4111-8111-111111111111';
await posDb.store_config.put({id:storeId,store_id:storeId,name:'Ember QA',timezone:'UTC',currency:'USD',catalog_version:1,service_charge_bps:0});
const items = [1500,1501].map((price,index)=>({lineId:crypto.randomUUID(),storeId,productId:crypto.randomUUID(),name:index?'Roasted vegetables':'Grilled chicken',sku:'QA-'+index,unitPriceCents:price,basePriceCents:price,modifiers:[],taxRateBps:0,catalogVersion:1,quantity:1,discount:null}));
usePosStore.setState({storeId,items,orderType:'takeaway',activeCheckId:null,activeCheckVersion:null});
window.qa={db:posDb,storeId,readReceipt};
function Saved(){const [receipt,setReceipt]=React.useState(null); React.useEffect(()=>{posDb.orders.toArray().then(async rows=>setReceipt(await readReceipt(storeId,rows.at(-1).id)))},[]); return receipt?React.createElement(SaleReceipt,{receipt,duplicate:false}):'Loading receipt';}
createRoot(document.getElementById('root')).render(React.createElement(MemoryRouter,{initialEntries:['/payment']},React.createElement(Routes,null,React.createElement(Route,{path:'/payment',element:React.createElement(PaymentScreen)}),React.createElement(Route,{path:'/orders/:id',element:React.createElement(Saved)}))));
</script></body></html>`)
const server = spawn(process.execPath, [root + 'apps/web/node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '3196', '--strictPort'], {
  cwd: root + 'apps/web', windowsHide: true, stdio: 'pipe',
  env: { ...process.env, VITE_SUPABASE_URL: 'http://127.0.0.1:3195', VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture', VITE_API_URL: '/api' },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Vite did not start')), 30000)
    server.stdout.on('data', data => { if (String(data).includes('3196')) { clearTimeout(timeout); resolve() } })
    server.on('error', reject)
    server.on('exit', code => { if (code) reject(new Error(`Vite exited ${code}`)) })
  })
  try { browser = await chromium.launch({ headless: true }) }
  catch { browser = await chromium.launch({ headless: true, channel: 'chrome' }) }
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => route.abort())
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }))
  await page.goto('http://127.0.0.1:3196/split-qa.html')
  await page.getByLabel('Split payment', { exact: true }).check()
  const first = page.getByRole('region', { name: 'Payment 1', exact: true })
  const second = page.getByRole('region', { name: 'Payment 2', exact: true })
  await expect(first.getByLabel('Sale amount')).toHaveValue('15.01')
  await expect(second.getByLabel('Sale amount')).toHaveValue('15.00')
  await first.getByLabel('Tip', { exact: true }).fill('1.00')
  await first.getByLabel('Cash received').fill('20.00')
  await second.getByLabel('Method').selectOption('card')
  await second.getByLabel('External reference').fill('QA-AUTH-123')
  await expect(page.getByRole('button', { name: 'Close check', exact: true })).toBeDisabled()
  await second.getByLabel('External card payment approved').check()
  await expect(page.getByRole('button', { name: 'Close check', exact: true })).toBeEnabled()
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`)
    await page.screenshot({ path: screenshots + `/payment-${width}.png`, fullPage: true })
  }
  await page.getByRole('button', { name: 'Close check', exact: true }).click()
  await expect(page.getByText('QA-AUTH-123', { exact: true })).toBeVisible()
  await expect(page.getByText('$3.99', { exact: true })).toBeVisible()
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.screenshot({ path: screenshots + `/receipt-${width}.png`, fullPage: true })
  }
  assert.deepEqual(errors, [])
  console.log('PASS: equal split, cash + external card, tip, exact change, approval gate, saved receipt; screenshots at 390/768/1440px.')
} finally {
  await browser?.close()
  server.kill()
  await unlink(fixture)
}
