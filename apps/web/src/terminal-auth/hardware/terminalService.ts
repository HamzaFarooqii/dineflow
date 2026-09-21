export async function checkTerminalService(): Promise<boolean> {
  const response = await fetch('/api/health', {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(5_000),
  })
  return response.ok
}
