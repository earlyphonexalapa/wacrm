import type { ChatMessage } from './types'
import { isTrivialQuery } from './media-rules'

/**
 * The text to retrieve knowledge against: the most recent customer
 * (`user`) turn in the conversation context. Falls back to the last
 * message of any role, then empty string. Shared by the draft route and
 * the auto-reply bot so both query the knowledge base the same way.
 */
export function latestUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content
  }
  return messages.length > 0 ? messages[messages.length - 1].content : ''
}

/**
 * The text to retrieve knowledge-base excerpts against. Normally the
 * customer's last message — but a bare "Si" / "Ok" says nothing on its
 * own, and searching for it pulled random documents (the ones that
 * happen to contain those words) into the model's context. For those we
 * use what the business just said instead, which is the topic the
 * customer is agreeing to.
 */
export function retrievalQuery(messages: ChatMessage[]): string {
  const last = latestUserMessage(messages)
  if (!isTrivialQuery(last)) return last
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].content.trim()) {
      return messages[i].content.slice(0, 400)
    }
  }
  return last
}
