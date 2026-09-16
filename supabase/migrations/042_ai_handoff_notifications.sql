-- ============================================================
-- 042_ai_handoff_notifications
--
-- Today, when the AI bot hands a conversation off to its configured
-- agent, `notify_conversation_assigned()` (migration 027) fires and
-- creates a notification — but it's worded exactly like a teammate
-- manually reassigning a chat ("Someone assigned you a conversation
-- with ..."), giving the recipient no signal that the bot bailed and a
-- human reply is actually needed now.
--
-- This widens `notifications.type` to add 'ai_handoff', and teaches the
-- trigger to detect that case (the same UPDATE that changed
-- assigned_agent_id also just wrote a NEW ai_handoff_summary — see
-- src/lib/ai/auto-reply.ts) and use a distinct title/body carrying the
-- actual handoff summary (the customer's last message + reply count)
-- instead of the generic reassignment text.
--
-- Manual/flow/automation reassignments are untouched — they never touch
-- ai_handoff_summary in the same statement, so they keep the original
-- wording and type.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'ai_handoff'));

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
  v_is_ai_handoff BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
    -- The AI handoff path (src/lib/ai/auto-reply.ts) always writes a
    -- fresh ai_handoff_summary in the SAME update as assigned_agent_id.
    -- A manual/flow/automation reassignment never touches that column,
    -- so this can't misfire on those.
    v_is_ai_handoff := NEW.ai_handoff_summary IS NOT NULL
      AND NEW.ai_handoff_summary IS DISTINCT FROM OLD.ai_handoff_summary;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about. Doesn't
  -- apply to an AI handoff: that always runs under the service role,
  -- which has no auth.uid(), so this never engages for it anyway.
  IF NOT v_is_ai_handoff
     AND auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  IF v_is_ai_handoff THEN
    INSERT INTO notifications (
      account_id, user_id, type, conversation_id, contact_id,
      actor_user_id, title, body
    ) VALUES (
      NEW.account_id,
      NEW.assigned_agent_id,
      'ai_handoff',
      NEW.id,
      NEW.contact_id,
      NULL,
      '🤖 Needs human attention',
      COALESCE(NEW.ai_handoff_summary, 'The AI agent handed off this conversation.')
    );
  ELSE
    INSERT INTO notifications (
      account_id, user_id, type, conversation_id, contact_id,
      actor_user_id, title, body
    ) VALUES (
      NEW.account_id,
      NEW.assigned_agent_id,
      'conversation_assigned',
      NEW.id,
      NEW.contact_id,
      auth.uid(),
      'New conversation assigned',
      COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
        || COALESCE(v_contact_name, 'a contact')
    );
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
