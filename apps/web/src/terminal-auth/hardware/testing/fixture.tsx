// Test-only entry point served by the hardware browser runner, never a production route.
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { TerminalHardwareSettings } from '../TerminalHardwareSettings'
import type { BrowserCapabilities, Persistence } from '../browserCapabilities'
import '../../terminal-auth.css'
import '../../../styles.css'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'denied'
let persistence: Persistence = scenario === 'unsupported' ? 'unsupported' : 'not-granted'
let notify = () => {}
const at = Date.parse('2026-09-17T12:00:00Z')
const adapter: BrowserCapabilities = {
  now: () => at,
  online: () => scenario !== 'offline',
  subscribe(listener) { notify = listener; return () => {} },
  async readIdentity() {
    if (scenario === 'identity-error') throw new Error('Test read failure')
    if (scenario === 'empty') return undefined
    return { id: 'test-device', storeId: scenario === 'other-store' ? 'other-store' : 'test-store', name: 'Fixture counter', receiptPrefix: 'TEST-', validatedAt: new Date(at - (scenario === 'expired' ? 8 * 86400000 : 3600000)).toISOString(), lastSeen: scenario === 'rollback' ? at + 1000 : at - 1000 }
  },
  async storage() {
    if (scenario === 'storage-error') throw new Error('Test storage failure')
    return { persistence, canRequest: scenario !== 'unsupported', usage: scenario === 'unsupported' ? undefined : 2048, quota: scenario === 'unsupported' ? undefined : 4096, estimateUnavailable: scenario === 'unsupported' }
  },
  async requestPersistence() {
    if (scenario === 'request-error') throw new Error('Test permission failure')
    persistence = scenario === 'granted' ? 'granted' : 'not-granted'
    notify()
    return persistence === 'granted'
  },
  async shell() { return { state: scenario === 'unsupported' ? 'unsupported' : scenario === 'shell-error' ? 'unavailable' : 'not-ready' } },
  canPrint: () => scenario !== 'unsupported',
  print() { if (scenario === 'print-error') throw new Error('Test printer failure') },
  printHost: () => document.body,
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><main className="terminal-admin-page"><TerminalHardwareSettings storeId="test-store" storeName="Test store" devices={[{ id: 'test-device', name: 'Fixture counter', receipt_prefix: 'TEST-', created_at: new Date(at).toISOString(), revoked_at: scenario === 'revoked' ? new Date(at).toISOString() : null }]} adapter={adapter} /></main></BrowserRouter>)
