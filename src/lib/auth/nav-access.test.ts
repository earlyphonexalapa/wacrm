import { describe, expect, it } from 'vitest'
import { canOpenPath, minRoleForPath } from './nav-access'

const OPEN = ['/dashboard', '/inbox', '/inbox?c=1', '/notifications', '/contacts', '/settings']
const TECHNICAL = [
  '/automations',
  '/automations/new',
  '/automations/abc/edit',
  '/followups',
  '/flows',
  '/flows/abc/runs',
  '/agents',
  '/exports',
  '/broadcasts',
  '/broadcasts/new',
  '/pipelines',
]

describe('minRoleForPath', () => {
  it('leaves the everyday pages open to every role', () => {
    for (const p of OPEN) expect(minRoleForPath(p), p).toBe('viewer')
  })

  it('reserves the technical areas for admins', () => {
    for (const p of TECHNICAL) expect(minRoleForPath(p), p).toBe('admin')
  })

  it('does not catch look-alike paths', () => {
    expect(minRoleForPath('/automationsx')).toBe('viewer')
    expect(minRoleForPath('/contacts/flows')).toBe('viewer')
  })
})

describe('canOpenPath', () => {
  it('lets owners and admins open everything', () => {
    for (const role of ['owner', 'admin'] as const) {
      for (const p of [...OPEN, ...TECHNICAL]) expect(canOpenPath(role, p), `${role} ${p}`).toBe(true)
    }
  })

  it('keeps agents (closers) and viewers out of the technical areas only', () => {
    for (const role of ['agent', 'viewer'] as const) {
      for (const p of OPEN) expect(canOpenPath(role, p), `${role} ${p}`).toBe(true)
      for (const p of TECHNICAL) expect(canOpenPath(role, p), `${role} ${p}`).toBe(false)
    }
  })

  it('shows only the open pages while the role is unknown', () => {
    expect(canOpenPath(null, '/inbox')).toBe(true)
    expect(canOpenPath(null, '/automations')).toBe(false)
  })
})
