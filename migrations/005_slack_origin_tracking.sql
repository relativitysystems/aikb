-- Relativity Knowledge Base — Migration 005: Slack origin tracking
-- Architecture Review Phase 4, Milestone 4 (§4.19, §2.6). Run this in the
-- AIKB Supabase SQL editor after 004_member_id.sql.
--
-- Adds the minimal slice of origin/idempotency tracking POST /api/knowledge/ask
-- (routes/knowledge.js) needs to exist safely, per §2.6: "Milestone 4's
-- Slack event handler needs SOME idempotent-gap-creation support to exist
-- before it can safely go live... the minimal slice — the origin/
-- originMetadata/idempotencyKey columns and the unique constraint on
-- knowledge_gaps... and on knowledge_chat_sessions — ships as part of
-- Milestone 4's AIKB branch."
--
-- idempotency_key lets services/runKnowledgeQuery.js independently guard
-- against reprocessing the same Slack event even if Relativity's own
-- slack_event_log dedup were ever bypassed (e.g. a retried Inngest step, or
-- the Vercel Cron sweep re-calling POST /ask for a stuck event) — a second
-- runKnowledgeQuery call with the same idempotencyKey finds the existing
-- session via idx_knowledge_chat_sessions_idempotency_key and returns its
-- already-persisted answer instead of re-running retrieval/generation.
--
-- knowledge_gaps gets the same three columns for symmetry/future-readiness,
-- as specified, even though nothing in this milestone writes to
-- knowledge_gaps automatically — /query (and therefore the Slack /ask path
-- that shares its pipeline) has never auto-persisted a gap row; gap
-- persistence today is an explicit user action via POST /api/knowledge/gaps
-- (portal-only). Relativity does not create a second gap record for Slack
-- traffic, consistent with "AIKB remains responsible for knowledge-gap
-- determination and persistence."
--
-- member_id/cross-project references remain plain UUID columns with no FK
-- constraint (Supabase does not support cross-database foreign keys — see
-- 004_member_id.sql's comment). connection_id here is Relativity's
-- oauth_connections.id, for the same reason.

ALTER TABLE knowledge_chat_sessions
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS origin_metadata JSONB,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE knowledge_gaps
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS origin_metadata JSONB,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Nullable + UNIQUE is safe: every existing row has idempotency_key = NULL,
-- and Postgres treats NULL values as distinct for uniqueness purposes, so
-- any number of existing NULL rows co-exist without conflict. Only
-- Slack-originated sessions (and, if ever populated, gaps) ever set this
-- column going forward.
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_chat_sessions_idempotency_key
  ON knowledge_chat_sessions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_gaps_idempotency_key
  ON knowledge_gaps (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
