export type FollowupMessageType = 'text' | 'template'

export type EnrollmentStatus = 'active' | 'completed' | 'cancelled'

export type CancelReason =
  | 'replied'
  | 'stop_tag'
  | 'tag_removed'
  | 'human_took_over'
  | 'sequence_disabled'
  | 'manual'

export type SendStatus = 'sent' | 'skipped' | 'failed'

export interface FollowupSettings {
  timezone: string
  send_window_enabled: boolean
  window_start_min: number
  window_end_min: number
  stop_tag_ids: string[]
  name_fallback: string
}

export const DEFAULT_FOLLOWUP_SETTINGS: FollowupSettings = {
  timezone: 'America/Mexico_City',
  send_window_enabled: true,
  window_start_min: 540,
  window_end_min: 1260,
  stop_tag_ids: [],
  name_fallback: 'amigo',
}

export interface FollowupStep {
  id?: string
  position: number
  delay_min_minutes: number
  delay_max_minutes: number
  message_type: FollowupMessageType
  message_text: string | null
  template_name: string | null
  template_language: string | null
  template_variables: string[]
}

export interface FollowupSequence {
  id: string
  account_id: string
  name: string
  description: string | null
  trigger_tag_id: string
  stop_tag_ids: string[]
  is_active: boolean
  position: number
  created_by: string | null
  steps: FollowupStep[]
}

/** Limits shared by the API validation and the editor UI. */
export const FOLLOWUP_LIMITS = {
  maxStepsPerSequence: 8,
  maxTextLength: 1024,
  maxDelayMinutes: 30 * 24 * 60,
} as const

/** Per-sequence counters shown on the sequence cards. */
export interface SequenceStats {
  active: number
  completed: number
  replied: number
  cancelled: number
  sent: number
}
