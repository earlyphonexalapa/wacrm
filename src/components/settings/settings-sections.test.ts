import { describe, expect, it } from 'vitest'
import {
  NON_ADMIN_SECTIONS,
  resolveSectionFor,
  SETTINGS_SECTIONS,
  sectionsForRole,
} from './settings-sections'

const TECHNICAL = ['overview', 'whatsapp', 'templates', 'fields', 'deals', 'members', 'routing', 'api'] as const

describe('sectionsForRole', () => {
  it('gives admins every section', () => {
    expect(sectionsForRole(true)).toEqual(SETTINGS_SECTIONS)
  })

  it('gives everyone else only the personal ones', () => {
    expect(sectionsForRole(false)).toEqual(['profile', 'security', 'appearance', 'quick-replies'])
    for (const s of TECHNICAL) expect(NON_ADMIN_SECTIONS, s).not.toContain(s)
  })
})

describe('resolveSectionFor', () => {
  it('keeps an admin on the section they asked for', () => {
    expect(resolveSectionFor('whatsapp', true)).toBe('whatsapp')
    expect(resolveSectionFor('api', true)).toBe('api')
  })

  it('sends a closer who asks for a technical section to their profile', () => {
    for (const s of TECHNICAL) expect(resolveSectionFor(s, false), s).toBe('profile')
  })

  it('lets a closer open the personal sections', () => {
    expect(resolveSectionFor('security', false)).toBe('security')
    expect(resolveSectionFor('quick-replies', false)).toBe('quick-replies')
  })

  it('falls back sensibly with no or an unknown tab', () => {
    expect(resolveSectionFor(null, true)).toBe('overview')
    expect(resolveSectionFor(null, false)).toBe('profile')
    expect(resolveSectionFor('nonsense', false)).toBe('profile')
  })

  it('still maps the legacy tabs onto Fields & tags for admins only', () => {
    expect(resolveSectionFor('tags', true)).toBe('fields')
    expect(resolveSectionFor('tags', false)).toBe('profile')
  })
})
