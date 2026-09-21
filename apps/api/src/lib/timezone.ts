// Mirrors the calendar-day boundary logic in apps/web/src/lib/reporting.ts's calendarDay/
// todayInTimezone (same Intl.DateTimeFormat-based approach), so the server and client never
// disagree about where a day boundary falls in a given store's timezone.

function offsetMillis(instantMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(instantMs))
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0)
  const asIfUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
  return asIfUtc - instantMs
}

// The instant whose wall-clock reading in `timezone` is local midnight on `date` (YYYY-MM-DD).
// Converges to a fixed point rather than assuming a fixed number of passes suffices, since a DST
// transition can shift the offset used to refine the guess; the cap is a safety bound, not a
// expected iteration count — every real IANA zone converges within 2 passes in practice.
function localMidnightUtc(date: string, timezone: string): number {
  const naiveUtc = Date.parse(`${date}T00:00:00.000Z`)
  let guess = naiveUtc
  for (let i = 0; i < 5; i++) {
    const next = naiveUtc - offsetMillis(guess, timezone)
    if (next === guess) break
    guess = next
  }
  return guess
}

export function calendarDayBoundsUtc(date: string, timezone: string): { startUtc: string; endUtc: string } {
  const start = localMidnightUtc(date, timezone)
  const [year, month, day] = date.split('-').map(Number)
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
  const end = localMidnightUtc(nextDate, timezone)
  return { startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() }
}
