import { isWithinSendWindow } from '@/lib/followups/timing'
import type { AiConfig } from './types'

// ============================================================
// Daily on/off schedule for the auto-reply bot. Pure — checked live
// against the clock on every inbound message (see auto-reply.ts), no
// scheduler needed. Reuses the same minutes-of-day-in-a-timezone window
// logic the follow-ups module already uses for its sending hours.
// ============================================================

/**
 * True when the bot may reply right now. Always true when the schedule
 * is off; otherwise true only inside [scheduleStartMin, scheduleEndMin)
 * local time in scheduleTimezone (a window that wraps midnight, e.g.
 * 22:00–06:00, is supported — same convention as follow-ups' sending
 * hours).
 */
export function isWithinAiSchedule(
  config: Pick<AiConfig, 'scheduleEnabled' | 'scheduleStartMin' | 'scheduleEndMin' | 'scheduleTimezone'>,
  now: Date,
): boolean {
  if (!config.scheduleEnabled) return true
  try {
    return isWithinSendWindow(now, config.scheduleTimezone, config.scheduleStartMin, config.scheduleEndMin)
  } catch {
    // An invalid saved timezone should never silently strand every
    // customer outside working hours — fail open (bot stays available)
    // rather than fail closed.
    console.error(`[ai schedule] invalid schedule_timezone "${config.scheduleTimezone}" — ignoring the schedule for this reply`)
    return true
  }
}
