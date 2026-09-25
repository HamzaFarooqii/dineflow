import { useEffect, useState } from 'react'
import { readTerminal, type TerminalCache } from './cache'
import { StatusBadge } from '../components/StatusBadge'

export function useTerminalStatus() {
  const [terminal, setTerminal] = useState<TerminalCache>()

  useEffect(() => {
    let active = true
    const load = async () => {
      const next = await readTerminal()
      if (active) setTerminal(next)
    }
    void load()
    const refresh = window.setInterval(() => { void load() }, 5_000)
    return () => { active = false; clearInterval(refresh) }
  }, [])

  return terminal
}

export function TerminalState({ terminal }: { terminal?: TerminalCache }) {
  if (!terminal) return <StatusBadge tone="muted">No terminal</StatusBadge>
  const age = Date.now() - Date.parse(terminal.validated_at)
  const online = navigator.onLine && age < 60 * 60 * 1000
  return <StatusBadge tone={online ? 'success' : 'warning'}>{navigator.onLine ? 'Active' : 'Offline'}</StatusBadge>
}
