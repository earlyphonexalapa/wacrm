// Who gets a phone notification for a new inbound WhatsApp message.
//
// Mirrors who can open the chat (conversations_select in migration 056) but
// narrower, so a busy inbox doesn't buzz every phone in the team:
//   - A chat with a closer (owner) or an assigned agent notifies just them.
//   - An unclaimed chat notifies everyone who can see it: every member when
//     closer isolation is off, only admins and the owner when it's on.
// Viewers never get pushes — they can't reply.

export interface PushMember {
  user_id: string
  account_role: string
}

export interface PushConversation {
  owner_agent_id?: string | null
  assigned_agent_id?: string | null
}

export function pushRecipients(
  conversation: PushConversation,
  members: PushMember[],
  isolationOn: boolean,
): string[] {
  const memberIds = new Set(members.map((m) => m.user_id))
  const claimed = [conversation.owner_agent_id, conversation.assigned_agent_id]
    .filter((id): id is string => !!id && memberIds.has(id))
  if (claimed.length > 0) return [...new Set(claimed)]

  return members
    .filter((m) =>
      isolationOn
        ? m.account_role === 'owner' || m.account_role === 'admin'
        : m.account_role !== 'viewer',
    )
    .map((m) => m.user_id)
}
