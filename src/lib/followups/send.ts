import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { interpolate, type FollowupVars } from './timing'
import type { FollowupStep } from './types'

/**
 * Send one follow-up step through the same WhatsApp senders the
 * automations use (they persist the message to the inbox as a `bot`
 * message and bump the conversation). Throws on any failure so the
 * processor can retry / log it.
 */
export async function sendFollowupStep(args: {
  accountId: string
  /** Audit column only — the sender doesn't authorise on it. */
  userId: string
  conversationId: string
  contactId: string
  step: Pick<
    FollowupStep,
    'message_type' | 'message_text' | 'template_name' | 'template_language' | 'template_variables'
  >
  vars: FollowupVars
}): Promise<{ whatsapp_message_id: string }> {
  const { step, vars } = args
  const common = {
    accountId: args.accountId,
    userId: args.userId,
    conversationId: args.conversationId,
    contactId: args.contactId,
  }

  if (step.message_type === 'template') {
    if (!step.template_name) throw new Error('no template selected for this step')
    // Meta rejects an empty template parameter, so fail loudly instead
    // of sending "Hola , tu lugar…".
    const params = step.template_variables.map((v) => interpolate(v, vars).trim())
    if (params.some((p) => !p)) throw new Error('a template variable resolved to an empty value')
    return engineSendTemplate({
      ...common,
      templateName: step.template_name,
      language: step.template_language ?? undefined,
      params,
    })
  }

  const text = interpolate(step.message_text ?? '', vars).trim()
  if (!text) throw new Error('the message is empty')
  return engineSendText({ ...common, text })
}
