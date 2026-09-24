import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}

// Customer message types the bot cannot read: the context above only
// carries text, so a voice note / image / file is invisible to the model.
const UNREADABLE_TYPES = new Set(['audio', 'video', 'image', 'document', 'location'])

export type UnreadableKind = 'audio' | 'video' | 'image' | 'document' | 'location'

/**
 * If the customer has sent something the bot cannot read since the last
 * message from the business (a voice note, photo, video, file or
 * location), return what it was; otherwise null.
 *
 * Without this the bot answers as if the message never existed — replying
 * to a stale text turn, or making things up — while a person would have
 * listened to the voice note. The caller hands the chat to a human
 * instead of letting the model improvise. Best-effort: null on failure.
 */
export async function findUnreadableInbound(
  db: SupabaseClient,
  conversationId: string,
): Promise<UnreadableKind | null> {
  try {
    const { data, error } = await db
      .from('messages')
      .select('sender_type, content_type')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(12)
    if (error || !data) return null
    for (const m of data as { sender_type: string; content_type: string }[]) {
      if (m.sender_type !== 'customer') break // reached the business's last message
      if (UNREADABLE_TYPES.has(m.content_type)) return m.content_type as UnreadableKind
    }
    return null
  } catch {
    return null
  }
}
