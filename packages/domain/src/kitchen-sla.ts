// Kitchen SLA states (Ahmad's A3 work): calm/warning/late, derived purely from when an item
// actually started prepping (fired_at) and its own snapshotted preparation target -- never from
// the live product record, so an owner editing a recipe's prep time later never rewrites the SLA
// on a ticket already in flight (same snapshot principle checkout.ts's receipts already use).
export type SlaState = 'calm' | 'warning' | 'late'

// Used when a product has no prep_time_seconds configured at all -- every ticket item needs a
// concrete target to measure against, so an unconfigured product still gets a reasonable default
// (snapshotted the same as a real one) rather than never being able to reach 'warning'/'late'.
export const DEFAULT_PREP_TARGET_SECONDS = 600

// An item that hasn't fired yet has no running clock -- it's 'calm' by definition, not late,
// no matter how long it's sat queued waiting for its course to be fired (that's what the
// held/fired distinction in the API is for, not the SLA clock).
export function deriveSlaState(firedAt: Date | null, targetSeconds: number, now: Date): SlaState {
  if (!firedAt) return 'calm'
  const elapsedSeconds = (now.getTime() - firedAt.getTime()) / 1000
  if (elapsedSeconds >= targetSeconds) return 'late'
  if (elapsedSeconds >= targetSeconds * 0.8) return 'warning'
  return 'calm'
}
