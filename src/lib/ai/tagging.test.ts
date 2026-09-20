import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadTagRules,
  extractTagSentinel,
  extractTagSentinels,
  matchTagRule,
  matchTagRules,
  matchReplyPhrases,
  normalizePhrases,
  loadContactTagIds,
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
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy', replyContains: [] },
      { tagId: 't2', tagName: 'No calificado', description: 'Just browsing', replyContains: [] },
    ])
  })

  it('handles the tags relation coming back as an array', async () => {
    const db = makeDb([
      { tag_id: 't1', description: 'Ready to buy', tags: [{ name: 'Calificado' }] },
    ])
    expect(await loadTagRules(db, 'acct')).toEqual([
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy', replyContains: [] },
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
    { tagId: 't1', tagName: 'Calificado', description: 'd1', replyContains: [] },
    { tagId: 't2', tagName: 'No calificado', description: 'd2', replyContains: [] },
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
      { tagId: 't1', tagName: 'Calificado', description: 'Ready to buy', replyContains: [] },
    ])
    expect(prompt).toContain('- Calificado: Ready to buy')
    expect(prompt).toContain('[[TAG: Calificado]]')
  })
})

const rule = (tagId: string, tagName: string, replyContains: string[] = []): TagRule => ({
  tagId,
  tagName,
  description: tagName + ' condition',
  replyContains,
})

describe('extractTagSentinels', () => {
  it('returns every marker in the trailing group', () => {
    expect(extractTagSentinels('Listo 🙌 [[TAG: Calificado]] [[TAG: Precio Dado]]')).toEqual({
      text: 'Listo 🙌',
      rawTags: ['Calificado', 'Precio Dado'],
    })
  })

  it('accepts markers on their own line', () => {
    expect(extractTagSentinels('Hola\n[[TAG: Calificando]]')).toEqual({ text: 'Hola', rawTags: ['Calificando'] })
  })

  it('returns no tags and the text unchanged when there is none', () => {
    expect(extractTagSentinels('Solo texto')).toEqual({ text: 'Solo texto', rawTags: [] })
  })

  it('never lets a stray marker reach the customer, and does not treat it as a request', () => {
    const r = extractTagSentinels('Hola [[TAG: Calificado]] qué tal')
    expect(r.rawTags).toEqual([])
    expect(r.text).not.toContain('[[TAG')
    expect(r.text).toContain('Hola')
    expect(r.text).toContain('qué tal')
  })
})

describe('matchTagRules', () => {
  const rules = [rule('t1', 'Calificado'), rule('t2', 'Precio Dado')]
  it('matches several, in order, without duplicates or invented names', () => {
    expect(matchTagRules(rules, ['precio dado', 'CALIFICADO', 'Precio Dado', 'Inventada']).map((r) => r.tagId)).toEqual(['t2', 't1'])
  })
})

describe('matchReplyPhrases', () => {
  const rules = [rule('p', 'Precio Dado', ['1197', '1,197']), rule('c', 'Calificado')]
  it('matches when the sent reply contains a phrase, ignoring case and spacing', () => {
    expect(matchReplyPhrases(rules, 'hoy está en promo por *1197* MXN').map((r) => r.tagId)).toEqual(['p'])
    expect(matchReplyPhrases(rules, 'promo por $1,197 MXN').map((r) => r.tagId)).toEqual(['p'])
  })
  it('does not match when the price is not in the reply, and skips rules without phrases', () => {
    expect(matchReplyPhrases(rules, 'Si quieres te paso el costo').map((r) => r.tagId)).toEqual([])
  })
})

describe('normalizePhrases', () => {
  it('trims, drops empties and case-insensitive duplicates, and caps the list', () => {
    expect(normalizePhrases([' 1197 ', '', '1197', '1,197', 5])).toEqual(['1197', '1,197'])
    expect(normalizePhrases(Array.from({ length: 30 }, (_, i) => 'p' + i))).toHaveLength(10)
    expect(normalizePhrases('nope')).toEqual([])
  })
})

describe('buildTagRulesPrompt — lead state', () => {
  const rules = [rule('t1', 'Calificando'), rule('t2', 'Calificado'), rule('t3', 'Precio Dado')]

  it('tells the model what the lead already has and only lists the open tags', () => {
    const p = buildTagRulesPrompt(rules, ['t1'])
    expect(p).toContain('already has: Calificando.')
    expect(p).toContain('- Calificado: Calificado condition')
    expect(p).toContain('- Precio Dado: Precio Dado condition')
    expect(p).not.toContain('- Calificando:')
  })

  it('says none when the lead has no tags, and asks for it on every reply', () => {
    const p = buildTagRulesPrompt(rules, [])
    expect(p).toContain('already has: none.')
    expect(p).toContain('EVERY reply')
    expect(p).toContain('one marker per tag')
  })

  it('says so when there is nothing left to apply', () => {
    const p = buildTagRulesPrompt(rules, ['t1', 't2', 't3'])
    expect(p).toContain('already has every tag')
    expect(p).not.toContain('Open tags')
  })
})

describe('loadContactTagIds', () => {
  it('returns the ids, and [] on error', async () => {
    const ok = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ tag_id: 'a' }, { tag_id: 'b' }], error: null }) }) }) } as unknown as SupabaseClient
    const bad = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: new Error('x') }) }) }) } as unknown as SupabaseClient
    expect(await loadContactTagIds(ok, 'c')).toEqual(['a', 'b'])
    expect(await loadContactTagIds(bad, 'c')).toEqual([])
  })
})
