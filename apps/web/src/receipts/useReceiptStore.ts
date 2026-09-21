import { useEffect, useState } from 'react'
import { activeStoreId } from '../lib/catalog'
import { currentAccess } from '../terminal-auth/cache'

export async function receiptStore(terminal: boolean): Promise<string> {
  if (!terminal) return activeStoreId()
  const access = await currentAccess()
  if (!access?.policy.valid || !access.employee) throw new Error('Terminal authorization expired. Reconnect and unlock the terminal to view receipts.')
  return access.cache.device.store_id
}

export function useReceiptStore(terminal: boolean) {
  const [storeId, setStoreId] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    setStoreId(''); setError('')
    void receiptStore(terminal).then(id => { if (active) setStoreId(id) }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to confirm store access.') })
    return () => { active = false }
  }, [terminal, attempt])
  return { storeId, error, retry: () => setAttempt(value => value + 1) }
}
