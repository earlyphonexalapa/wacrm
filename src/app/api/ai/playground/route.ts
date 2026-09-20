import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { retrieveKnowledge, findKnowledgeMedia } from '@/lib/ai/knowledge'
import { loadTagRules, extractTagSentinels, matchTagRules, matchReplyPhrases } from '@/lib/ai/tagging'
import { generateReply } from '@/lib/ai/generate'
import { buildSystemPrompt } from '@/lib/ai/defaults'
import { latestUserMessage } from '@/lib/ai/query'
import { AiError, type ChatMessage } from '@/lib/ai/types'

// Keep the tested transcript bounded, mirroring the live context window.
const MAX_TURNS = 20

/**
 * POST /api/ai/playground  (agent+)
 *
 * Test-chat with the account's agent WITHOUT touching WhatsApp. Runs the
 * exact same path the auto-reply bot uses — knowledge-base retrieval +
 * `auto_reply` system prompt + the configured provider — so what you see
 * here is what a real customer would get. Reads the config even when the
 * master switch is off (requireActive:false) so you can try it before
 * going live. Stateless: the client sends the running transcript each turn.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`ai-playground:${userId}`, RATE_LIMITS.aiDraft)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawMessages = Array.isArray(body?.messages) ? body.messages : null
    if (!rawMessages) {
      return NextResponse.json({ error: 'messages is required' }, { status: 400 })
    }

    const messages: ChatMessage[] = rawMessages
      .filter(
        (m: unknown): m is ChatMessage =>
          !!m &&
          typeof m === 'object' &&
          ((m as ChatMessage).role === 'user' ||
            (m as ChatMessage).role === 'assistant') &&
          typeof (m as ChatMessage).content === 'string' &&
          (m as ChatMessage).content.trim().length > 0,
      )
      .slice(-MAX_TURNS)

    if (messages.length === 0) {
      return NextResponse.json(
        { error: 'Send a message to test the agent.' },
        { status: 400 },
      )
    }

    const config = await loadAiConfig(supabase, accountId, {
      requireActive: false,
    }).catch((err) => {
      console.error('[ai/playground] loadAiConfig error:', err)
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      })
    })
    if (!config) {
      return NextResponse.json(
        {
          error: 'No agent configured yet. Add your provider key in Setup.',
          code: 'ai_not_configured',
        },
        { status: 400 },
      )
    }

    const lastCustomerText = latestUserMessage(messages)
    const knowledge = await retrieveKnowledge(supabase, accountId, config, lastCustomerText)
    // Mirrors the real bot's behavior (see dispatchInboundToAiReply) so the
    // Playground shows what a customer would actually receive, including
    // any image the knowledge base would attach.
    const media = await findKnowledgeMedia(supabase, accountId, lastCustomerText)
    const tagRules = await loadTagRules(supabase, accountId)
    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      tagRules,
    })

    const { text: rawReplyText, handoff } = await generateReply({
      config,
      systemPrompt,
      messages,
    })
    const { text, rawTags } = extractTagSentinels(rawReplyText)
    const matchedTags = matchTagRules(tagRules, rawTags)
    const phraseTags = matchReplyPhrases(tagRules, text).filter((r) => !matchedTags.some((m) => m.tagId === r.tagId))
    const wouldApply = [...matchedTags, ...phraseTags]
    const attachedMedia =
      !handoff && text
        ? media.map((m) => ({ url: m.url, mimeType: m.mimeType }))
        : []
    return NextResponse.json({
      reply: text,
      handoff,
      media: attachedMedia,
      // Playground never writes to a real contact — this just shows
      // what tag the bot WOULD apply on a live conversation.
      tag: wouldApply[0]?.tagName ?? null,
      tags: wouldApply.map((r) => r.tagName),
    })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status },
      )
    }
    return toErrorResponse(err)
  }
}
