import { beforeEach, describe, expect, it } from 'vitest'
import {
  claimMediaSend,
  isTrivialQuery,
  matchesTrigger,
  normalizeForMedia,
  resetMediaClaims,
  unsentOnly,
} from './media-rules'

describe('isTrivialQuery', () => {
  it.each(['Si', 'sí', 'Ok', 'Okey gracias', '..', '??', 'Claro que si', 'Por favor', 'dale 👍', '  ', 'va'])(
    'treats %j as trivial',
    (t) => expect(isTrivialQuery(t)).toBe(true),
  )

  it.each(['confiable?', 'es una estafa', 'cuanto cuesta', 'quiero ver reseñas', 'si es real'])(
    'does not treat %j as trivial',
    (t) => expect(isTrivialQuery(t)).toBe(false),
  )
})

describe('matchesTrigger', () => {
  const triggers = ['confiable', 'estafa', 'real', 'reseña', 'como les ha ido']

  it('matches whole words, ignoring case, accents and punctuation', () => {
    expect(matchesTrigger('¿Es CONFIABLE?', triggers)).toBe(true)
    expect(matchesTrigger('no será una estafa', triggers)).toBe(true)
    expect(matchesTrigger('tienen reseñas?', triggers)).toBe(true)
    expect(matchesTrigger('cómo les ha ido a otros', triggers)).toBe(true)
  })

  it('accepts a plural of the phrase', () => {
    expect(matchesTrigger('son confiables?', triggers)).toBe(true)
    expect(matchesTrigger('los resultados son reales', triggers)).toBe(true)
  })

  it('does not fire on a longer word that merely starts with the phrase', () => {
    expect(matchesTrigger('quiero realizar el pago', triggers)).toBe(false)
    expect(matchesTrigger('realmente me interesa', triggers)).toBe(false)
  })

  it('does not fire on confirmations or unrelated text', () => {
    expect(matchesTrigger('Si', triggers)).toBe(false)
    expect(matchesTrigger('cuanto cuesta', triggers)).toBe(false)
    expect(matchesTrigger('hola', [])).toBe(false)
  })

  it('normalizes text the same way for both sides', () => {
    expect(normalizeForMedia('¡Reseñas!  ')).toBe('resenas')
  })
})

describe('unsentOnly', () => {
  const items = [{ url: 'a' }, { url: 'b' }, { url: 'c' }]
  it('drops files already sent in the conversation', () => {
    expect(unsentOnly(items, new Set(['b']))).toEqual([{ url: 'a' }, { url: 'c' }])
  })
  it('returns everything when nothing was sent', () => {
    expect(unsentOnly(items, new Set())).toBe(items)
    expect(unsentOnly(items)).toBe(items)
  })
})

describe('claimMediaSend', () => {
  beforeEach(() => resetMediaClaims())

  it('lets only the first dispatch send a given file', () => {
    expect(claimMediaSend('conv', 'u1', 1000)).toBe(true)
    expect(claimMediaSend('conv', 'u1', 2000)).toBe(false)
  })

  it('is scoped per conversation and per file', () => {
    expect(claimMediaSend('conv', 'u1', 1000)).toBe(true)
    expect(claimMediaSend('other', 'u1', 1000)).toBe(true)
    expect(claimMediaSend('conv', 'u2', 1000)).toBe(true)
  })

  it('releases the claim after the TTL', () => {
    expect(claimMediaSend('conv', 'u1', 0)).toBe(true)
    expect(claimMediaSend('conv', 'u1', 11 * 60 * 1000)).toBe(true)
  })
})
