import { readTerminal } from '../cache'

export interface TerminalIdentity {
  id: string
  storeId: string
  name: string
  receiptPrefix: string
  validatedAt: string
  lastSeen: number
  cashierName?: string
}
export type Persistence = 'granted' | 'not-granted' | 'unsupported' | 'unavailable'
export interface StorageStatus {
  persistence: Persistence
  canRequest: boolean
  usage?: number
  quota?: number
  estimateUnavailable: boolean
}
export interface ShellStatus {
  state: 'ready' | 'not-ready' | 'unsupported' | 'unavailable'
}
export interface BrowserCapabilities {
  now(): number
  online(): boolean
  subscribe(listener: () => void): () => void
  readIdentity(): Promise<TerminalIdentity | undefined>
  storage(): Promise<StorageStatus>
  requestPersistence(): Promise<boolean>
  shell(): Promise<ShellStatus>
  canPrint(): boolean
  print(): void
  printHost(): HTMLElement
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Browser capability check timed out.')), 8000)
    operation.then(value => { window.clearTimeout(timer); resolve(value) }, error => { window.clearTimeout(timer); reject(error) })
  })
}

async function inspectStorage(): Promise<StorageStatus> {
  const manager = navigator.storage
  const result: StorageStatus = { persistence: 'unsupported', canRequest: Boolean(manager?.persist), estimateUnavailable: true }
  if (manager?.persisted) {
    try { result.persistence = await manager.persisted() ? 'granted' : 'not-granted' }
    catch { result.persistence = 'unavailable' }
  }
  if (manager?.estimate) {
    try {
      const estimate = await manager.estimate()
      result.usage = Number.isFinite(estimate.usage) && estimate.usage! >= 0 ? estimate.usage : undefined
      result.quota = Number.isFinite(estimate.quota) && estimate.quota! > 0 ? estimate.quota : undefined
      result.estimateUnavailable = result.usage === undefined || result.quota === undefined
    } catch { /* The persistence result is still useful when quota is unavailable. */ }
  }
  return result
}

async function inspectShell(): Promise<ShellStatus> {
  if (!('serviceWorker' in navigator) || !('caches' in window)) return { state: 'unsupported' }
  try {
    const registration = await navigator.serviceWorker.getRegistration('/pos/login')
    if (!registration?.active || new URL(registration.active.scriptURL).pathname !== '/sw.js') return { state: 'not-ready' }
    // Registration alone does not prove the app shell was saved. Check this app's
    // precache and the entry resources without fetching anything from the network.
    for (const name of await caches.keys()) {
      if (!name.startsWith('workbox-precache')) continue
      const cache = await caches.open(name)
      const entries = await cache.keys()
      const index = entries.find(entry => new URL(entry.url).origin === location.origin && new URL(entry.url).pathname === '/index.html')
      if (!index) continue
      const response = await cache.match(index)
      if (!response?.ok) continue
      const html = new DOMParser().parseFromString(await response.text(), 'text/html')
      const resources = [...html.querySelectorAll('script[src],link[rel="stylesheet"][href],link[rel="modulepreload"][href]')]
        .map(element => new URL(element.getAttribute('src') ?? element.getAttribute('href')!, location.origin).pathname)
      const paths = new Set(entries.map(entry => new URL(entry.url).pathname))
      if (resources.length && resources.every(path => paths.has(path)) && [...paths].some(path => /\/assets\/CashierLogin-[^/]+\.js$/.test(path))) return { state: 'ready' }
    }
    return { state: 'not-ready' }
  } catch { return { state: 'unavailable' } }
}

export const browserCapabilities: BrowserCapabilities = {
  now: () => Date.now(),
  online: () => navigator.onLine,
  subscribe(listener) {
    window.addEventListener('online', listener)
    window.addEventListener('offline', listener)
    window.addEventListener('focus', listener)
    const interval = window.setInterval(listener, 15_000)
    return () => {
      window.removeEventListener('online', listener)
      window.removeEventListener('offline', listener)
      window.removeEventListener('focus', listener)
      window.clearInterval(interval)
    }
  },
  async readIdentity() {
    const cache = await bounded(readTerminal())
    if (!cache) return undefined
    return { id: cache.device.id, storeId: cache.device.store_id, name: cache.device.name, receiptPrefix: cache.device.receipt_prefix, validatedAt: cache.validated_at, lastSeen: cache.lastSeen, cashierName: cache.employees.find(employee => employee.id === cache.session?.employee_id)?.name }
  },
  storage: () => bounded(inspectStorage()),
  async requestPersistence() {
    if (!navigator.storage?.persist) throw new Error('Persistent storage is not supported by this browser.')
    return bounded(navigator.storage.persist())
  },
  shell: () => bounded(inspectShell()),
  canPrint: () => typeof window.print === 'function',
  print: () => window.print(),
  printHost: () => document.body,
}
