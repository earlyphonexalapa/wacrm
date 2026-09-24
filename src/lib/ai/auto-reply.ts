import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext, findUnreadableInbound, type UnreadableKind } from './context'
import { retrieveKnowledge, findKnowledgeMedia, loadSentMediaUrls } from './knowledge'
import {
  loadTagRules,
  loadContactTagIds,
  extractTagSentinels,
  matchTagRules,
  matchReplyPhrases,
} from './tagging'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage, retrievalQuery } from './query'
import { detectUnusableReply } from './sanity'
import { claimMediaSend } from './media-rules'
import { engineSendText, engineSendMedia } from '@/lib/flows/meta-send'
import { basenameFromUrl } from '@/lib/media/filename'
import type { MediaKind } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { notifyHandoffNeedsHuman } from './handoff-notify'
import { isCloserPhone, notifyCloserOnWhatsApp } from './handoff-whatsapp'
import { showTypingIndicator } from './typing'
import { AiError, type GenerateResult } from './types'

/** A short natural line the model may write before its handoff marker
 *  ("Va, dame un momento"). Longer than this is treated as the model
 *  rambling and is dropped, as before. */
const MAX_HANDOFF_TEXT_CHARS = 300

const UNREADABLE_LABEL: Record<UnreadableKind, string> = {
  audio: 'a voice note / audio',
  video: 'a video',
  image: 'an image',
  document: 'a document',
  location: 'a location',
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * Disable auto-reply on this conversation and route it to a human —
 * shared by every failure path below (the model choosing to bail, the
 * provider call failing, the slot claim failing, the WhatsApp send
 * failing) so a customer is never left stranded with no human ever
 * finding out. See `notifyHandoffNeedsHuman` for why the "no handoff
 * agent configured" branch matters — without it, a technical failure on
 * an account using the shared queue would leave both the bot AND the
 * notification silent.
 */
async function performHandoff(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    handoffAgentId: string | null
    alreadyAssigned: boolean
    summary: string
  },
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: args.summary,
  }
  const willAssign = Boolean(args.handoffAgentId && !args.alreadyAssigned)
  if (willAssign) {
    update.assigned_agent_id = args.handoffAgentId
  }
  await db.from('conversations').update(update).eq('id', args.conversationId)

  if (!willAssign && !args.alreadyAssigned) {
    await notifyHandoffNeedsHuman(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      summary: args.summary,
    })
  }

  // Extra channel: alert the closer on WhatsApp too (no-op unless it's
  // switched on in the AI settings). Never throws.
  await notifyCloserOnWhatsApp(db, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    summary: args.summary,
  })
}

/** Provider errors that will fail identically on an immediate retry —
 *  not worth burning the one retry attempt on. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof AiError)) return true
  return err.code !== 'invalid_key' && err.code !== 'unsupported_provider'
}

/** Knowledge-base attachments are restricted to images and PDFs — see
 *  the upload validation in the /api/ai/knowledge routes. */
function mediaKindForMime(mimeType: string): MediaKind | null {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType === 'application/pdf') return 'document'
  return null
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    // The closer answering a handoff alert is a teammate, not a lead —
    // never let the bot reply to them.
    const { data: inboundContact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', contactId)
      .maybeSingle()
    if (await isCloserPhone(db, accountId, (inboundContact as { phone?: string } | null)?.phone)) return

    const messages = await buildConversationContext(db, conversationId)

    // A voice note / photo / file is invisible to the model (the context is
    // text only), so it would answer a stale turn or make something up. A
    // person can listen to it — hand the chat over instead.
    const unreadable = await findUnreadableInbound(db, conversationId)
    if (unreadable) {
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: Boolean(conv.assigned_agent_id),
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
          failureNote: `the customer sent ${UNREADABLE_LABEL[unreadable]} that the bot cannot read`,
        }),
      })
      return
    }

    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Show "typing…" to the customer while the slower work below (RAG
    // retrieval + the provider call) runs — purely cosmetic, so it's
    // fire-and-forget and never allowed to delay or block the reply.
    void showTypingIndicator(db, { accountId, conversationId }).catch(() => {})

    // Ground the reply in the account's knowledge base (best-effort).
    const lastCustomerText = latestUserMessage(messages)
    // For a bare "Si" / "Ok" search by what the business just said instead.
    const knowledge = await retrieveKnowledge(db, accountId, config, retrievalQuery(messages))

    // A knowledge-base document can carry an image (e.g. a price list or
    // course flyer) — find the best match now, alongside the text
    // grounding above, so it's ready to attach once the reply is sent.
    // Files already sent in this conversation are never sent again, and a
    // message with no topic ("Si") never picks one (see findKnowledgeMedia).
    const sentUrls = await loadSentMediaUrls(db, conversationId)
    const media = await findKnowledgeMedia(db, accountId, lastCustomerText, { sentUrls })

    // Lead-qualification tags the bot may apply this turn (e.g.
    // "Calificado" / "No calificado") — admin-authored via Setup.
    const tagRules = await loadTagRules(db, accountId)
    // Tags the lead already has — the bot is told which stages are done and
    // only considers the open ones (see buildTagRulesPrompt).
    const appliedTagIds = tagRules.length > 0 ? await loadContactTagIds(db, contactId) : []

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      tagRules,
      appliedTagIds,
    })

    let generation: GenerateResult
    try {
      generation = await generateReply({ config, systemPrompt, messages })
    } catch (firstErr) {
      if (!isRetryable(firstErr)) {
        console.error('[ai auto-reply] generateReply failed (non-retryable), handing off:', firstErr)
        await performHandoff(db, {
          accountId,
          conversationId,
          contactId,
          handoffAgentId: config.handoffAgentId,
          alreadyAssigned: Boolean(conv.assigned_agent_id),
          summary: buildHandoffSummary({
            messages,
            replyCount: conv.ai_reply_count ?? 0,
            failureNote: 'invalid AI provider key',
          }),
        })
        return
      }
      // One retry for a transient hiccup (timeout, momentary 429/5xx) —
      // better than permanently stranding the customer on a blip.
      console.warn('[ai auto-reply] generateReply failed, retrying once:', firstErr)
      try {
        generation = await generateReply({ config, systemPrompt, messages })
      } catch (secondErr) {
        console.error('[ai auto-reply] generateReply failed twice, handing off:', secondErr)
        await performHandoff(db, {
          accountId,
          conversationId,
          contactId,
          handoffAgentId: config.handoffAgentId,
          alreadyAssigned: Boolean(conv.assigned_agent_id),
          summary: buildHandoffSummary({
            messages,
            replyCount: conv.ai_reply_count ?? 0,
            failureNote: 'AI provider error',
          }),
        })
        return
      }
    }
    // A model that goes off the rails (a long looping nonsense reply was
    // once sent to a customer) gets one more try; if it is still unusable
    // the chat goes to a human instead of the customer seeing garbage.
    if (!generation.handoff && detectUnusableReply(extractTagSentinels(generation.text).text)) {
      console.warn('[ai auto-reply] unusable reply generated, regenerating once')
      void logAiUsage(db, {
        accountId,
        conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage: generation.usage,
      })
      try {
        generation = await generateReply({ config, systemPrompt, messages })
      } catch (retryErr) {
        console.error('[ai auto-reply] regeneration after an unusable reply failed:', retryErr)
      }
      if (!generation.handoff && detectUnusableReply(extractTagSentinels(generation.text).text)) {
        console.error('[ai auto-reply] reply still unusable, handing off')
        await performHandoff(db, {
          accountId,
          conversationId,
          contactId,
          handoffAgentId: config.handoffAgentId,
          alreadyAssigned: Boolean(conv.assigned_agent_id),
          summary: buildHandoffSummary({
            messages,
            replyCount: conv.ai_reply_count ?? 0,
            failureNote: 'the AI produced an unusable reply',
          }),
        })
        return
      }
    }
    const { text: rawReplyText, handoff, usage } = generation
    // Strip the tag marker before anything downstream sees `text` — the
    // customer must never receive it, and the handoff-empty check below
    // must not be confused by a reply that was ONLY a tag marker.
    const { text, rawTags } = extractTagSentinels(rawReplyText)

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // Apply any lead-qualification tag the model classified, regardless
    // of whether this turn also hands off — classifying the lead is
    // useful either way, and `addContactTagAndDispatch` is a safe no-op
    // when the contact already has it.
    const matchedTags = matchTagRules(tagRules, rawTags)
    const applyTag = async (tagId: string) => {
      try {
        await addContactTagAndDispatch({
          db,
          accountId,
          contactId,
          tagId,
          context: { conversation_id: conversationId },
        })
      } catch (err) {
        console.error('[ai auto-reply] tag assignment failed:', err)
      }
    }
    for (const rule of matchedTags) await applyTag(rule.tagId)
    // One line per reply so "why wasn't this lead tagged?" can be answered
    // from the logs: what it already had, what the model asked for.
    if (tagRules.length > 0) {
      const nameOf = (id: string) => tagRules.find((r) => r.tagId === id)?.tagName ?? id
      console.log(
        `[ai tagging] conv=${conversationId} had=[${appliedTagIds.map(nameOf).join(', ')}] model=[${rawTags.join(', ')}] applied=[${matchedTags.map((r) => r.tagName).join(', ')}]`,
      )
    }

    if (handoff || !text) {
      // The model may write one short natural line before its handoff
      // marker ("Va, dame un momento"). Send it so the customer isn't left
      // in silence while the chat goes to a person.
      if (handoff && text && text.length <= MAX_HANDOFF_TEXT_CHARS) {
        try {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text,
            aiGenerated: true,
          })
        } catch (err) {
          console.error('[ai auto-reply] handoff line failed to send:', err)
        }
      }
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human.
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: Boolean(conv.assigned_agent_id),
        summary: buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 }),
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Hand off instead of
      // silently dropping this turn — the customer already has a reply
      // ready, it just couldn't be recorded as sent.
      console.error('[ai auto-reply] claim_ai_reply_slot failed, handing off:', claimErr)
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: Boolean(conv.assigned_agent_id),
        summary: buildHandoffSummary({
          messages,
          replyCount: conv.ai_reply_count ?? 0,
          failureNote: 'internal error claiming a reply slot',
        }),
      })
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    try {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
      })
    } catch (err) {
      // The slot is already claimed (ai_reply_count incremented) but the
      // customer never actually got anything — hand off rather than
      // leaving the thread silently stuck until they happen to write
      // again. Matches the WhatsApp send failures seen in production
      // ("fetch failed", transient Meta 5xx/rate limits).
      console.error('[ai auto-reply] engineSendText failed, handing off:', err)
      await performHandoff(db, {
        accountId,
        conversationId,
        contactId,
        handoffAgentId: config.handoffAgentId,
        alreadyAssigned: Boolean(conv.assigned_agent_id),
        summary: buildHandoffSummary({
          messages,
          replyCount: (conv.ai_reply_count ?? 0) + 1,
          failureNote: 'failed to deliver the reply via WhatsApp',
        }),
      })
      return
    }

    // Deterministic tags: the reply is out, so anything it actually said
    // (e.g. the price) is now true regardless of whether the model
    // remembered to emit a marker. No-op for tags the lead already has.
    for (const rule of matchReplyPhrases(tagRules, text)) {
      if (!matchedTags.some((m) => m.tagId === rule.tagId)) await applyTag(rule.tagId)
    }

    // Attach the matched knowledge-base files (up to
    // MAX_KNOWLEDGE_MEDIA_ITEMS images/PDFs, in upload order) as
    // follow-up messages. Best-effort and isolated from the text send
    // above and from each other: one broken URL or Meta rejection must
    // not undo the reply the customer already received, nor stop the
    // rest of the batch from going out.
    for (const item of media) {
      const kind = mediaKindForMime(item.mimeType)
      if (!kind) continue
      // Two dispatches for the same conversation can both read "not sent
      // yet" from the database; the in-process claim makes only one send.
      if (!claimMediaSend(conversationId, item.url)) continue
      try {
        await engineSendMedia({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          kind,
          link: item.url,
          ...(kind === 'document' ? { filename: basenameFromUrl(item.url) } : {}),
          aiGenerated: true,
        })
      } catch (err) {
        console.error('[ai auto-reply] knowledge media send failed:', err)
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
