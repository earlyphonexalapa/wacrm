-- ============================================================
-- 045_followups
--
-- Built-in follow-up sequences: "when a contact gets tag X and stops
-- replying, send message A after ~2h, message B after ~14h, ...".
--
-- Why not the generic Automations engine (migration 006)? It can't
-- cancel a pending run when the customer replies, can't say "skip if
-- the contact has ANY of these tags", has no re-entry guard (two runs
-- for one contact), no 24h-window handling, and only advances when an
-- external pinger hits its cron endpoint. This module owns those rules.
--
-- Tables
--   followup_settings     one row per account: send window, timezone,
--                         global stop tags, name fallback
--   followup_sequences    "tag X -> steps", with per-sequence stop tags
--   followup_steps        ordered timed messages (text or template)
--   followup_enrollments  a contact currently moving through a sequence
--   followup_sends        append-only log of every attempt (sent /
--                         skipped / failed) for the activity view
--
-- Enrollment / send / cancel all run through the service role from
-- src/lib/followups. Members read everything for their account; admins
-- edit configuration; agents may cancel an enrollment by hand.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS followup_settings (
  account_id          uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  timezone            text NOT NULL DEFAULT 'America/Mexico_City',
  send_window_enabled boolean NOT NULL DEFAULT true,
  -- Minutes after local midnight. Defaults: 09:00 -> 21:00.
  window_start_min    integer NOT NULL DEFAULT 540 CHECK (window_start_min BETWEEN 0 AND 1439),
  window_end_min      integer NOT NULL DEFAULT 1260 CHECK (window_end_min BETWEEN 1 AND 1440),
  -- Contacts with ANY of these tags are never followed up (e.g.
  -- Requiere Humano, Pagado, Abono, No Viable, Seguimiento).
  stop_tag_ids        uuid[] NOT NULL DEFAULT '{}',
  -- Used for {{nombre}} when the contact has no usable first name.
  name_fallback       text NOT NULL DEFAULT 'amigo',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followup_sequences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  name           text NOT NULL,
  description    text,
  -- Enrolls when this tag is newly added to a contact.
  trigger_tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  -- Cancels / skips when the contact has ANY of these (typically the
  -- next phase's tag). Global stop tags live in followup_settings.
  stop_tag_ids   uuid[] NOT NULL DEFAULT '{}',
  is_active      boolean NOT NULL DEFAULT false,
  position       integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_sequences_account_idx
  ON followup_sequences (account_id);
CREATE INDEX IF NOT EXISTS followup_sequences_trigger_idx
  ON followup_sequences (account_id, trigger_tag_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS followup_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id        uuid NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  position           integer NOT NULL,
  -- Wait, counted from when the contact was enrolled (tag applied). The
  -- actual moment is a random point in [min, max] so sends don't all
  -- land on the same minute.
  delay_min_minutes  integer NOT NULL CHECK (delay_min_minutes >= 1),
  delay_max_minutes  integer NOT NULL CHECK (delay_max_minutes >= delay_min_minutes),
  message_type       text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'template')),
  -- For 'text': the message. For 'template': a draft/reference of what
  -- the template body should say (shown in the editor as a hint).
  message_text       text,
  template_name      text,
  template_language  text,
  -- Positional template body variables ({{1}}, {{2}}, ...). Each entry
  -- may itself contain {{nombre}}-style tokens.
  template_variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, position)
);

CREATE INDEX IF NOT EXISTS followup_steps_sequence_idx
  ON followup_steps (sequence_id, position);

CREATE TABLE IF NOT EXISTS followup_enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id       uuid NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'completed', 'cancelled')),
  -- replied | stop_tag | tag_removed | human_took_over |
  -- sequence_disabled | manual
  cancel_reason     text,
  enrolled_at       timestamptz NOT NULL DEFAULT now(),
  next_step_position integer NOT NULL DEFAULT 0,
  next_run_at       timestamptz NOT NULL,
  attempts          integer NOT NULL DEFAULT 0,
  -- Lease: a worker claims a due row by pushing this into the future.
  -- A crashed worker's claim simply expires, so nothing gets stuck.
  locked_until      timestamptz,
  last_sent_at      timestamptz,
  ended_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- One live run per (sequence, contact): re-tagging can never start a
-- parallel run and double-message the lead.
CREATE UNIQUE INDEX IF NOT EXISTS followup_enrollments_one_active_idx
  ON followup_enrollments (sequence_id, contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS followup_enrollments_due_idx
  ON followup_enrollments (next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS followup_enrollments_contact_idx
  ON followup_enrollments (contact_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS followup_enrollments_account_idx
  ON followup_enrollments (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS followup_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enrollment_id       uuid NOT NULL REFERENCES followup_enrollments(id) ON DELETE CASCADE,
  sequence_id         uuid NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_position       integer NOT NULL,
  status              text NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
  detail              text,
  whatsapp_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_sends_account_idx
  ON followup_sends (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS followup_sends_enrollment_idx
  ON followup_sends (enrollment_id);

-- ------------------------------------------------------------
-- updated_at triggers
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.followups_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS followup_settings_updated_at ON followup_settings;
CREATE TRIGGER followup_settings_updated_at
  BEFORE UPDATE ON followup_settings
  FOR EACH ROW EXECUTE FUNCTION public.followups_touch_updated_at();

DROP TRIGGER IF EXISTS followup_sequences_updated_at ON followup_sequences;
CREATE TRIGGER followup_sequences_updated_at
  BEFORE UPDATE ON followup_sequences
  FOR EACH ROW EXECUTE FUNCTION public.followups_touch_updated_at();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE followup_settings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_sequences   ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_steps       ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_sends       ENABLE ROW LEVEL SECURITY;

-- Configuration: any member reads, admin+ writes.
DROP POLICY IF EXISTS followup_settings_select ON followup_settings;
CREATE POLICY followup_settings_select ON followup_settings FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_settings_insert ON followup_settings;
CREATE POLICY followup_settings_insert ON followup_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS followup_settings_update ON followup_settings;
CREATE POLICY followup_settings_update ON followup_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS followup_sequences_select ON followup_sequences;
CREATE POLICY followup_sequences_select ON followup_sequences FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_sequences_insert ON followup_sequences;
CREATE POLICY followup_sequences_insert ON followup_sequences FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS followup_sequences_update ON followup_sequences;
CREATE POLICY followup_sequences_update ON followup_sequences FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS followup_sequences_delete ON followup_sequences;
CREATE POLICY followup_sequences_delete ON followup_sequences FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS followup_steps_select ON followup_steps;
CREATE POLICY followup_steps_select ON followup_steps FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_steps_insert ON followup_steps;
CREATE POLICY followup_steps_insert ON followup_steps FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS followup_steps_update ON followup_steps;
CREATE POLICY followup_steps_update ON followup_steps FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS followup_steps_delete ON followup_steps;
CREATE POLICY followup_steps_delete ON followup_steps FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Runtime state: members read; agents may cancel a run by hand.
-- Creation / advancement happens only via the service role.
DROP POLICY IF EXISTS followup_enrollments_select ON followup_enrollments;
CREATE POLICY followup_enrollments_select ON followup_enrollments FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS followup_enrollments_update ON followup_enrollments;
CREATE POLICY followup_enrollments_update ON followup_enrollments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS followup_sends_select ON followup_sends;
CREATE POLICY followup_sends_select ON followup_sends FOR SELECT
  USING (is_account_member(account_id));
