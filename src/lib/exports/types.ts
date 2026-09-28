// ============================================================
// Shared shapes for the chat-export feature.
// ============================================================

export interface ExportMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  media_url: string | null
  template_name: string | null
  status: string
  created_at: string
}

export interface ExportConversation {
  id: string
  status: string
  contact: {
    name: string | null
    phone: string
    company: string | null
  }
  /** Tag names, resolved server-side so the file is self-contained. */
  tags: string[]
  messages: ExportMessage[]
}
