import { describe, it, expect } from 'vitest'
import {
  customerWindow,
  minutesOfDayInZone,
  isWithinSendWindow,
  nextSendWindowStart,
  pickDelayMs,
  firstName,
  buildVars,
  interpolate,
  formatMinutes,
  formatDelayRange,
  isValidTimeZone,
  HOUR_MS,
  MINUTE_MS,
} from './timing'

const MX = 'America/Mexico_City' // UTC-6 year-round since 2022 (no DST)

describe('customerWindow', () => {
  const now = new Date('2026-09-18T12:00:00Z')

  it('is open with the remaining time when the customer wrote recently', () => {
    const last = new Date(now.getTime() - 3 * HOUR_MS)
    const w = customerWindow(last, now)
    expect(w.open).toBe(true)
    expect(w.remainingMs).toBe(21 * HOUR_MS) // the inbox's "21h remaining"
  })

  it('is closed after 24h', () => {
    const w = customerWindow(new Date(now.getTime() - 25 * HOUR_MS), now)
    expect(w.open).toBe(false)
    expect(w.remainingMs).toBe(0)
  })

  it('treats the last few minutes as closed (safety margin)', () => {
    const last = new Date(now.getTime() - (24 * HOUR_MS - 2 * MINUTE_MS))
    expect(customerWindow(last, now).open).toBe(false)
  })

  it('is closed when the customer never wrote', () => {
    expect(customerWindow(null, now)).toEqual({ open: false, remainingMs: 0 })
  })
})

describe('send-window helpers', () => {
  it('reads the local minute-of-day in a timezone', () => {
    // 15:30 UTC = 09:30 in Mexico City
    expect(minutesOfDayInZone(new Date('2026-09-18T15:30:00Z'), MX)).toBe(9 * 60 + 30)
  })

  it('knows whether an instant is inside 09:00–21:00 local', () => {
    const inside = new Date('2026-09-18T18:00:00Z') // 12:00 local
    const tooEarly = new Date('2026-09-18T12:00:00Z') // 06:00 local
    const tooLate = new Date('2026-09-19T04:00:00Z') // 22:00 local
    expect(isWithinSendWindow(inside, MX, 540, 1260)).toBe(true)
    expect(isWithinSendWindow(tooEarly, MX, 540, 1260)).toBe(false)
    expect(isWithinSendWindow(tooLate, MX, 540, 1260)).toBe(false)
  })

  it('supports a window that wraps midnight', () => {
    const at23 = new Date('2026-09-19T05:00:00Z') // 23:00 local
    const at12 = new Date('2026-09-18T18:00:00Z') // 12:00 local
    expect(isWithinSendWindow(at23, MX, 22 * 60, 6 * 60)).toBe(true)
    expect(isWithinSendWindow(at12, MX, 22 * 60, 6 * 60)).toBe(false)
  })

  it('finds the next opening later the same day when before it', () => {
    const early = new Date('2026-09-18T12:00:00Z') // 06:00 local
    const next = nextSendWindowStart(early, MX, 540)
    expect(next.toISOString()).toBe('2026-09-18T15:00:00.000Z') // 09:00 local
  })

  it('finds the next opening the following morning when after close', () => {
    const late = new Date('2026-09-19T04:00:00Z') // 22:00 local on the 18th
    const next = nextSendWindowStart(late, MX, 540)
    expect(next.toISOString()).toBe('2026-09-19T15:00:00.000Z') // 09:00 local on the 19th
  })

  it('handles a DST timezone across a spring-forward boundary', () => {
    // America/New_York springs forward 2026-03-08 02:00 → 03:00.
    const evening = new Date('2026-03-08T02:00:00Z') // 21:00 EST on the 7th
    const next = nextSendWindowStart(evening, 'America/New_York', 540)
    // 09:00 local on the 8th is EDT (UTC-4) → 13:00Z
    expect(next.toISOString()).toBe('2026-03-08T13:00:00.000Z')
  })

  it('validates timezone names', () => {
    expect(isValidTimeZone('America/Mexico_City')).toBe(true)
    expect(isValidTimeZone('Not/AZone')).toBe(false)
  })
})

describe('pickDelayMs', () => {
  it('stays within the range, inclusive', () => {
    expect(pickDelayMs(120, 180, () => 0)).toBe(120 * MINUTE_MS)
    expect(pickDelayMs(120, 180, () => 0.999999)).toBe(180 * MINUTE_MS)
    const mid = pickDelayMs(120, 180, () => 0.5) / MINUTE_MS
    expect(mid).toBeGreaterThanOrEqual(120)
    expect(mid).toBeLessThanOrEqual(180)
  })

  it('collapses to a fixed delay when min equals max', () => {
    expect(pickDelayMs(60, 60)).toBe(60 * MINUTE_MS)
  })
})

describe('firstName / buildVars / interpolate', () => {
  it('takes the first word with letters and strips emoji/punctuation', () => {
    expect(firstName('🔥 antonio 🔥', 'amigo')).toBe('antonio')
    expect(firstName('Antonio Pérez', 'amigo')).toBe('Antonio')
  })

  it('normalises ALL-CAPS names', () => {
    expect(firstName('ANTONIO', 'amigo')).toBe('Antonio')
  })

  it('falls back when the profile name is a phone number or empty', () => {
    expect(firstName('5215618893400', 'amigo')).toBe('amigo')
    expect(firstName('+52 1 561 889 3400', 'amigo')).toBe('amigo')
    expect(firstName('', 'amigo')).toBe('amigo')
    expect(firstName(null, 'amigo')).toBe('amigo')
    expect(firstName('🔥🔥', 'amigo')).toBe('amigo')
  })

  it('builds full-name vars, falling back to the first name for phone-like names', () => {
    expect(buildVars('Antonio Pérez', 'amigo')).toEqual({
      nombre: 'Antonio',
      nombre_completo: 'Antonio Pérez',
    })
    expect(buildVars('5215618893400', 'amigo')).toEqual({
      nombre: 'amigo',
      nombre_completo: 'amigo',
    })
  })

  it('interpolates known tokens (any spacing/case) and leaves unknown ones visible', () => {
    const vars = { nombre: 'Antonio', nombre_completo: 'Antonio Pérez' }
    expect(interpolate('Hola {{nombre}}, {{ Nombre_Completo }}!', vars)).toBe(
      'Hola Antonio, Antonio Pérez!',
    )
    expect(interpolate('Hola {{apodo}}', vars)).toBe('Hola {{apodo}}')
  })
})

describe('formatting', () => {
  it('formats minutes compactly', () => {
    expect(formatMinutes(45)).toBe('45m')
    expect(formatMinutes(120)).toBe('2h')
    expect(formatMinutes(150)).toBe('2h 30m')
    expect(formatMinutes(2880)).toBe('2d')
    expect(formatMinutes(3000)).toBe('2d 2h')
  })

  it('formats a delay range', () => {
    expect(formatDelayRange(120, 180)).toBe('2h–3h')
    expect(formatDelayRange(60, 60)).toBe('1h')
  })
})
