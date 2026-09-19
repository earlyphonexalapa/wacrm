import {
  customerWindow,
  isWithinSendWindow,
  nextSendWindowStart,
  WINDOW_SAFETY_MARGIN_MS,
} from './timing'
import type { CancelReason, FollowupMessageType, FollowupSettings } from './types'

// ============================================================
// The decision a follow-up makes at the moment it comes due. Pure: the
// processor gathers the facts (tags, last inbound message, ownership)
// and this decides — so every rule from the spec is testable without a
// database. Checked at SEND time, not schedule time, so a lead who
// replied / got a later tag / was picked up by a human is never
// messaged on stale information.
// ============================================================

export interface EvaluateInput {
  now: Date
  sequenceActive: boolean
  /** Does the contact still carry the sequence's trigger tag? */
  hasTriggerTag: boolean
  /** Sequence + global stop tags the contact currently has (may be empty). */
  presentStopTagIds: string[]
  /** Customer's last inbound message, or null if none. */
  lastCustomerAt: Date | null
  /** When the contact entered the sequence. */
  enrolledAt: Date
  /** A human agent is assigned, or AI auto-reply was handed off. */
  humanOwned: boolean
  stepType: FollowupMessageType
  settings: Pick<
    FollowupSettings,
    'send_window_enabled' | 'timezone' | 'window_start_min' | 'window_end_min'
  >
}

export type Decision =
  | { action: 'cancel'; reason: CancelReason }
  | { action: 'defer'; until: Date }
  | { action: 'skip'; reason: 'outside_24h' }
  | { action: 'send' }

export function evaluateFollowup(input: EvaluateInput): Decision {
  const { now, settings } = input

  if (!input.sequenceActive) return { action: 'cancel', reason: 'sequence_disabled' }
  if (!input.hasTriggerTag) return { action: 'cancel', reason: 'tag_removed' }
  if (input.presentStopTagIds.length > 0) return { action: 'cancel', reason: 'stop_tag' }

  // "If the lead replies, the rest of the sequence is cancelled."
  if (input.lastCustomerAt && input.lastCustomerAt.getTime() > input.enrolledAt.getTime()) {
    return { action: 'cancel', reason: 'replied' }
  }
  if (input.humanOwned) return { action: 'cancel', reason: 'human_took_over' }

  // Respect the allowed sending hours by pushing to the next opening —
  // unless that would land past the 24h window for a free-form message,
  // in which case there's nothing to wait for.
  if (
    settings.send_window_enabled &&
    !isWithinSendWindow(now, settings.timezone, settings.window_start_min, settings.window_end_min)
  ) {
    const until = nextSendWindowStart(now, settings.timezone, settings.window_start_min)
    if (input.stepType === 'text') {
      const win = customerWindow(input.lastCustomerAt, until, WINDOW_SAFETY_MARGIN_MS)
      if (!win.open) return { action: 'skip', reason: 'outside_24h' }
    }
    return { action: 'defer', until }
  }

  if (input.stepType === 'text' && !customerWindow(input.lastCustomerAt, now).open) {
    return { action: 'skip', reason: 'outside_24h' }
  }

  return { action: 'send' }
}
