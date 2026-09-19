import type { SupabaseClient } from '@supabase/supabase-js'
import { createSequence, loadFollowupSettings, loadSequences, saveFollowupSettings } from './store'
import type { SequenceInput } from './validate'
import type { FollowupStep } from './types'

// ============================================================
// Starter pack: the EarlyAcademy follow-up plan (phases NI / I / IP)
// pre-loaded so the owner only edits wording and timings. Everything is
// created INACTIVE — nothing sends until they review and switch it on.
// ============================================================

export const STARTER_TAGS: { name: string; color: string }[] = [
  { name: 'Calificando', color: '#f59e0b' },
  { name: 'Calificado', color: '#3b82f6' },
  { name: 'Precio Dado', color: '#8b5cf6' },
  { name: 'Requiere Humano', color: '#ef4444' },
  { name: 'No Viable', color: '#6b7280' },
  { name: 'Pagado', color: '#10b981' },
  { name: 'Abono', color: '#06b6d4' },
  { name: 'Seguimiento', color: '#ec4899' },
]

/** Tags that mean "a human has this lead / it's over" — no automated
 *  follow-up should ever go to a contact carrying one. */
export const STARTER_GLOBAL_STOP_TAGS = [
  'Requiere Humano',
  'Pagado',
  'Abono',
  'No Viable',
  'Seguimiento',
]

const H = 60

function textStep(position: number, minMin: number, maxMin: number, text: string): FollowupStep {
  return {
    position,
    delay_min_minutes: minMin,
    delay_max_minutes: maxMin,
    message_type: 'text',
    message_text: text,
    template_name: null,
    template_language: null,
    template_variables: [],
  }
}

interface StarterSequence {
  name: string
  description: string
  trigger: string
  stop: string[]
  steps: FollowupStep[]
}

export const STARTER_SEQUENCES: StarterSequence[] = [
  {
    name: 'NI · Calificando sin respuesta',
    description: 'El bot mandó la pregunta de calificación y el lead no contestó.',
    trigger: 'Calificando',
    stop: ['Calificado'],
    steps: [
      textStep(
        0,
        2 * H,
        3 * H,
        '¿Sigues por ahí? 😊 nomás para saber si arrancarías desde cero o ya tienes experiencia reparando, y te cuento cómo te conviene más',
      ),
    ],
  },
  {
    name: 'I · Calificado sin precio',
    description: 'El lead ya recibió temario y bonos pero no ha pasado a ver el precio.',
    trigger: 'Calificado',
    stop: ['Precio Dado'],
    steps: [
      textStep(
        0,
        3 * H,
        4 * H,
        '¿Cómo la ves con lo que te compartí? Lo que más nos diferencia es que no es solo teoría suelta, está ordenado paso a paso y tienes a quien preguntarle si te trabas',
      ),
      textStep(
        1,
        14 * H,
        16 * H,
        'la mayoría de nuestros alumnos ya reparaban hardware pero no software, y ese solo cambio les abrió otra fuente de ingreso con los mismos clientes. ¿Es un poco tu caso?',
      ),
    ],
  },
  {
    name: 'IP · Precio dado sin respuesta',
    description: 'El bot ya dio el precio ($1197) y el lead se quedó callado.',
    trigger: 'Precio Dado',
    stop: [],
    steps: [
      textStep(0, 1 * H, 1 * H + 10, '¿Alguna duda con lo que te pasé? Con gusto te la resuelvo'),
      textStep(
        1,
        20 * H,
        22 * H,
        'Actualmente somos +1,800 estudiando, y si algo llega a fallar con la plataforma tienes 31 días de garantía. ¿Seguimos?',
      ),
      {
        position: 2,
        delay_min_minutes: 48 * H,
        delay_max_minutes: 72 * H,
        // Past the 24h customer window only an approved template can go out.
        message_type: 'template',
        message_text:
          'Hola {{1}}, tu lugar en EarlyAcademy sigue disponible. Si el pago completo no te acomoda, puedes apartarlo con $200 MXN y liquidas el resto en una semana. ¿Te interesa retomarlo?',
        template_name: null,
        template_language: null,
        template_variables: ['{{nombre}}'],
      },
    ],
  },
]

export interface SeedResult {
  tagsCreated: string[]
  sequencesCreated: string[]
  sequencesSkipped: string[]
}

/**
 * Create any missing starter tags, the starter sequences (inactive), and
 * — only if none are configured yet — the global stop tags. Idempotent:
 * re-running never duplicates tags or sequences.
 */
export async function seedStarterFollowups(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<SeedResult> {
  const result: SeedResult = { tagsCreated: [], sequencesCreated: [], sequencesSkipped: [] }

  const { data: existingTags, error: tagsErr } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', accountId)
  if (tagsErr) throw tagsErr

  const idByName = new Map<string, string>()
  for (const t of (existingTags ?? []) as { id: string; name: string }[]) {
    idByName.set(t.name.trim().toLowerCase(), t.id)
  }

  for (const tag of STARTER_TAGS) {
    if (idByName.has(tag.name.toLowerCase())) continue
    const { data, error } = await db
      .from('tags')
      .insert({ account_id: accountId, user_id: userId, name: tag.name, color: tag.color })
      .select('id')
      .single()
    if (error || !data) throw error ?? new Error(`could not create tag ${tag.name}`)
    idByName.set(tag.name.toLowerCase(), data.id)
    result.tagsCreated.push(tag.name)
  }

  const tagId = (name: string): string => {
    const id = idByName.get(name.toLowerCase())
    if (!id) throw new Error(`missing tag ${name}`)
    return id
  }

  const existingSeq = await loadSequences(db, accountId)
  const existingNames = new Set(existingSeq.map((s) => s.name.trim().toLowerCase()))

  for (const def of STARTER_SEQUENCES) {
    if (existingNames.has(def.name.toLowerCase())) {
      result.sequencesSkipped.push(def.name)
      continue
    }
    const input: SequenceInput = {
      name: def.name,
      description: def.description,
      trigger_tag_id: tagId(def.trigger),
      stop_tag_ids: def.stop.map(tagId),
      is_active: false,
      steps: def.steps,
    }
    await createSequence(db, accountId, userId, input)
    result.sequencesCreated.push(def.name)
  }

  const settings = await loadFollowupSettings(db, accountId)
  if (settings.stop_tag_ids.length === 0) {
    await saveFollowupSettings(db, accountId, {
      ...settings,
      stop_tag_ids: STARTER_GLOBAL_STOP_TAGS.map(tagId),
    })
  }

  return result
}
