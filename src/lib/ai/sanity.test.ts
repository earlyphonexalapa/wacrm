import { describe, expect, it } from 'vitest'
import { detectUnusableReply, MAX_REPLY_CHARS } from './sanity'

describe('detectUnusableReply', () => {
  it('lets a normal sales reply through', () => {
    const reply =
      'Desde cero te sirve perfecto 🙌\n\nEl curso normalmente vale *$2600*, pero hoy está en promo por *1197* con acceso de por vida e inmediato.\nIncluye también 8 herramientas gratis de entrada y la comunidad 24/7 para resolver dudas.\n\n¿Te gustaría que te comparta más detalles del temario?'
    expect(detectUnusableReply(reply)).toBeNull()
  })

  it('lets a bulleted reply with repeated words through', () => {
    const reply =
      '✅ acceso de por vida\n✅ 8 herramientas gratis de entrada\n✅ comunidad 24/7 para dudas\n✅ actualizaciones mensuales y asesoría 1 a 1\n\nSi quieres, te paso el precio y cómo sería el acceso completo al curso.'
    expect(detectUnusableReply(reply)).toBeNull()
  })

  it('catches the looping nonsense reply that reached a customer', () => {
    const loop =
      '1197 no olvides ir a una fiesta con una amiga es para ir en finde de mes y el otro lado de la casa de la empresa no me digas nada de eso pero me voy a dormir y te mando el correo del trabajo ' +
      'y no me digas nada de eso '.repeat(12)
    expect(detectUnusableReply(loop)).toBe('repetitive')
  })

  it('catches an absurdly long reply', () => {
    expect(detectUnusableReply('hola '.repeat(MAX_REPLY_CHARS))).not.toBeNull()
    expect(detectUnusableReply('x'.repeat(MAX_REPLY_CHARS + 1))).toBe('too_long')
  })

  it('ignores short replies even if they repeat a word', () => {
    expect(detectUnusableReply('ja ja ja ja ja ja')).toBeNull()
  })
})
