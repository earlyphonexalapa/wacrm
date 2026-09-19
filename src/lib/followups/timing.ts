// ============================================================
// Pure timing helpers for follow-ups. No I/O, no clock reads except
// where `now` is passed in — everything here is unit-tested.
// ============================================================

export const HOUR_MS = 60 * 60 * 1000
export const MINUTE_MS = 60 * 1000

/** WhatsApp's customer-service window: free-form messages are only
 *  accepted for 24h after the customer's last message. */
export const CUSTOMER_WINDOW_MS = 24 * HOUR_MS

/** Safety margin: a message due with less than this left in the window
 *  is treated as outside it, since Meta's clock and ours can differ and
 *  the send itself takes a moment. */
export const WINDOW_SAFETY_MARGIN_MS = 5 * MINUTE_MS

export interface CustomerWindow {
  /** True while a free-form (non-template) message can still be sent. */
  open: boolean
  /** Time left before the window closes; 0 when closed/unknown. */
  remainingMs: number
}

/**
 * The same "21h remaining" the inbox shows, computed from the
 * customer's last inbound message. `null` (the customer never wrote)
 * means the window is closed.
 */
export function customerWindow(
  lastCustomerAt: Date | null,
  now: Date,
  marginMs: number = WINDOW_SAFETY_MARGIN_MS,
): CustomerWindow {
  if (!lastCustomerAt) return { open: false, remainingMs: 0 }
  const remaining = lastCustomerAt.getTime() + CUSTOMER_WINDOW_MS - now.getTime()
  if (remaining - marginMs <= 0) return { open: false, remainingMs: Math.max(0, remaining) }
  return { open: true, remainingMs: remaining }
}

/** Minutes after local midnight in `timeZone` for the given instant. */
export function minutesOfDayInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

/** Is `timeZone` a zone this runtime understands? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Whether `now` falls inside the allowed sending hours
 * [startMin, endMin) in `timeZone`. A window that wraps midnight
 * (start > end) is supported.
 */
export function isWithinSendWindow(
  now: Date,
  timeZone: string,
  startMin: number,
  endMin: number,
): boolean {
  const cur = minutesOfDayInZone(now, timeZone)
  if (startMin === endMin) return true
  if (startMin < endMin) return cur >= startMin && cur < endMin
  return cur >= startMin || cur < endMin
}

/**
 * The next instant, strictly after `now`, at which the sending window
 * opens (local `startMin` in `timeZone`). Meant to be called when
 * `now` is outside the window. Corrects for DST shifts by re-checking
 * the local clock after the estimate.
 */
export function nextSendWindowStart(
  now: Date,
  timeZone: string,
  startMin: number,
): Date {
  const cur = minutesOfDayInZone(now, timeZone)
  let deltaMin = startMin - cur
  if (deltaMin <= 0) deltaMin += 24 * 60

  // Land on the minute boundary, then nudge if a DST change moved the
  // local clock by a different amount than the estimate assumed.
  let result = new Date(
    Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS + deltaMin * MINUTE_MS,
  )
  for (let i = 0; i < 3; i++) {
    const diff = startMin - minutesOfDayInZone(result, timeZone)
    if (diff === 0) break
    // Normalise to (-720, 720] so we always take the short way round.
    const adj = ((diff + 720 + 1440) % 1440) - 720
    result = new Date(result.getTime() + adj * MINUTE_MS)
  }
  return result
}

/** A random whole-minute delay in [minMinutes, maxMinutes], in ms. */
export function pickDelayMs(
  minMinutes: number,
  maxMinutes: number,
  random: () => number = Math.random,
): number {
  const lo = Math.min(minMinutes, maxMinutes)
  const hi = Math.max(minMinutes, maxMinutes)
  const minutes = lo + Math.floor(random() * (hi - lo + 1))
  return minutes * MINUTE_MS
}

// ------------------------------------------------------------
// {{nombre}} interpolation
// ------------------------------------------------------------

/**
 * A usable first name from a WhatsApp profile name: the first word that
 * contains a letter (so "🔥 antonio 🔥" → "Antonio", "5215618893400" →
 * fallback). ALL-CAPS words are normalised to Capitalised.
 */
export function firstName(
  name: string | null | undefined,
  fallback: string,
): string {
  if (name) {
    for (const rawToken of name.split(/\s+/)) {
      const token = rawToken.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')
      if (!token || !/\p{L}/u.test(token)) continue
      if (token.length > 1 && token === token.toUpperCase()) {
        return token.charAt(0) + token.slice(1).toLowerCase()
      }
      return token
    }
  }
  return fallback
}

export interface FollowupVars {
  nombre: string
  nombre_completo: string
}

/** Names the editor offers as insertable variables. */
export const FOLLOWUP_VARIABLES = ['nombre', 'nombre_completo'] as const

export function buildVars(
  contactName: string | null | undefined,
  fallback: string,
): FollowupVars {
  const first = firstName(contactName, fallback)
  const cleaned = (contactName ?? '').trim()
  const looksLikePhone = /^[+\d\s()-]+$/.test(cleaned)
  return {
    nombre: first,
    nombre_completo: cleaned && !looksLikePhone ? cleaned : first,
  }
}

/** Replace `{{nombre}}` / `{{nombre_completo}}` (any spacing). Unknown
 *  tokens are left untouched so a typo is visible, not silently blank. */
export function interpolate(text: string, vars: FollowupVars): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key: string) => {
    const k = key.toLowerCase() as keyof FollowupVars
    return k in vars ? vars[k] : match
  })
}

// ------------------------------------------------------------
// Presentation helpers (shared by the API + UI)
// ------------------------------------------------------------

/** "2h", "14h 30m", "3d" — for the timeline chips. */
export function formatMinutes(total: number): string {
  if (total < 60) return `${total}m`
  if (total < 24 * 60) {
    const h = Math.floor(total / 60)
    const m = total % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(total / (24 * 60))
  const h = Math.floor((total % (24 * 60)) / 60)
  return h ? `${d}d ${h}h` : `${d}d`
}

/** "2–3h" when the range collapses to different values, else "2h". */
export function formatDelayRange(minMinutes: number, maxMinutes: number): string {
  if (minMinutes === maxMinutes) return formatMinutes(minMinutes)
  return `${formatMinutes(minMinutes)}–${formatMinutes(maxMinutes)}`
}
