import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadTagRules,
  extractTagSentinel,
  matchTagRule,
  buildTagRulesPrompt,
  type TagRule,
} from './tagging'

function makeDb(rows: unknown[] | null, error: unknown = null) {
  const db = {
    from: () => ({
      select: () => ({
        eq: () => Promise.resolve({ data: rows, error }),
      }),
    }),
  }
  return db as unknown as SupabaseClient
}

describe('loadTagRules', () => {
  it('maps joined rows into TagRule[]', async () => {
    const db = makeDb([
      { tag_id: 't1', description: 'Ready to buy', tags: { name: 'Calificado' } },
      { tag_id: 't2', description: 'Just browsing', tags: { name: 'No calificado' } },
    ])
    expect(await loadTagRules(db, 'acct')).toEqual([
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy' },
      { tagId: 't2', tagName: 'No calificado', description: 'Just browsing' },
    ])
  })

  it('handles the tags relation coming back as an array', async () => {
    const db = makeDb([
      { tag_id: 't1', description: 'Ready to buy', tags: [{ name: 'Calificado' }] },
    ])
    expect(await loadTagRules(db, 'acct')).toEqual([
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy' },
    ])
  })

  it('returns [] on a query error rather than throwing', async () => {
    const db = makeDb(null, new Error('boom'))
    expect(await loadTagRules(db, 'acct')).toEqual([])
  })

  it('returns [] when there are no rules configured', async () => {
    const db = makeDb([])
    expect(await loadTagRules(db, 'acct')).toEqual([])
  })
})

describe('extractTagSentinel', () => {
  it('strips a trailing tag marker and returns the tag name', () => {
    expect(extractTagSentinel('Gracias por tu interés! [[TAG: Calificado]]')).toEqual({
      text: 'Gracias por tu interés!',
      rawTag: 'Calificado',
    })
  })

  it('returns the text unchanged when there is no marker', () => {
    expect(extractTagSentinel('Just a normal reply')).toEqual({
      text: 'Just a normal reply',
      rawTag: null,
    })
  })

  it('ignores a marker that is not at the very end', () => {
    const raw = '[[TAG: Calificado]] but then more text after it'
    expect(extractTagSentinel(raw)).toEqual({ text: raw, rawTag: null })
  })

  it('is case-insensitive on the TAG keyword', () => {
    expect(extractTagSentinel('Reply [[tag: Urgente]]')).toEqual({
      text: 'Reply',
      rawTag: 'Urgente',
    })
  })
})

describe('matchTagRule', () => {
  const rules: TagRule[] = [
    { tagId: 't1', tagName: 'Calificado', description: 'd1' },
    { tagId: 't2', tagName: 'No calificado', description: 'd2' },
  ]

  it('matches case- and whitespace-insensitively', () => {
    expect(matchTagRule(rules, '  calificado  ')).toEqual(rules[0])
    expect(matchTagRule(rules, 'NO CALIFICADO')).toEqual(rules[1])
  })

  it('returns null for an unknown tag name (never invented)', () => {
    expect(matchTagRule(rules, 'Something Else')).toBeNull()
  })

  it('returns null for a null rawTag', () => {
    expect(matchTagRule(rules, null)).toBeNull()
  })
})

describe('buildTagRulesPrompt', () => {
  it('returns empty string when there are no rules', () => {
    expect(buildTagRulesPrompt([])).toBe('')
  })

  it('lists every rule and shows the format example', () => {
    const prompt = buildTagRulesPrompt([
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy' },
    ])
    expect(prompt).toContain('- Calificado: Ready to buy')
    expect(prompt).toContain('[[TAG: Calificado]]')
  })
})
