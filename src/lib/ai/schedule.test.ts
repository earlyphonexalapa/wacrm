import { describe, expect, it } from 'vitest'
import { isWithinAiSchedule } from './schedule'

const base = {
  scheduleEnabled: true,
  scheduleStartMin: 9 * 60, // 09:00
  scheduleEndMin: 21 * 60, // 21:00
  scheduleTimezone: 'America/Mexico_City',
}

// America/Mexico_City has been fixed at UTC-6 (no DST) since 2022, so
// these UTC instants map to a stable local hour: local = UTC - 6.
const utcAt = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 28, h, m))

describe('isWithinAiSchedule', () => {
  it('is always true when the schedule is off, whatever the hour', () => {
    expect(isWithinAiSchedule({ ...base, scheduleEnabled: false }, utcAt(2))).toBe(true)
    expect(isWithinAiSchedule({ ...base, scheduleEnabled: false }, utcAt(12))).toBe(true)
  })

  it('is true inside the window and false outside it, in the local timezone', () => {
    expect(isWithinAiSchedule(base, utcAt(15))).toBe(true) // 09:00 local — window opens
    expect(isWithinAiSchedule(base, utcAt(18))).toBe(true) // 12:00 local
    expect(isWithinAiSchedule(base, utcAt(8))).toBe(false) // 02:00 local — before opening
  })

  it('the boundary minutes are correct: on at start, off at end', () => {
    expect(isWithinAiSchedule(base, utcAt(15, 0))).toBe(true) // exactly 09:00 local
    expect(isWithinAiSchedule(base, utcAt(3, 0))).toBe(false) // exactly 21:00 local (03:00 UTC next day)
    expect(isWithinAiSchedule(base, utcAt(2, 59))).toBe(true) // 20:59 local, still inside
  })

  it('supports a window that wraps midnight', () => {
    const overnight = { ...base, scheduleStartMin: 22 * 60, scheduleEndMin: 6 * 60 }
    expect(isWithinAiSchedule(overnight, utcAt(5))).toBe(true) // 23:00 local
    expect(isWithinAiSchedule(overnight, utcAt(15))).toBe(false) // 09:00 local, outside
  })

  it('fails open on a broken saved timezone rather than going silent', () => {
    expect(isWithinAiSchedule({ ...base, scheduleTimezone: 'Not/AZone' }, utcAt(2))).toBe(true)
  })
})
