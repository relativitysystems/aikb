-- Relativity Knowledge Base — Migration 009: Slack request dedup log
-- Architecture repo backlog M13 (revised): Slack-originated conversations
-- (both channel @mentions and 1:1 DMs) are no longer persisted at all —
-- services/runKnowledgeQuery.js is now called with persistConversation:
-- false for Slack, so no knowledge_chat_sessions/knowledge_chat_messages
-- row is ever created for them. That removed the mechanism POST /ask used
-- to detect a duplicate/retried enqueue (idempotency_key on
-- knowledge_chat_sessions, see migrations/005_slack_origin_tracking.sql):
-- there is no longer a session to look up.
--
-- This table replaces that mechanism with the minimal operational metadata
-- needed for idempotency and reliability ONLY — no question, answer,
-- citation, or chunk text is ever written here. routes/knowledge.js POST
-- /ask claims a row (INSERT, relying on the UNIQUE index below) before
-- enqueueing knowledge/slack.question.requested; a claim that hits the
-- unique constraint means Relativity's own in-flow retry
-- (services/slackEventsService.js's retryWithBackoff around the /ask HTTP
-- call) already enqueued this idempotency_key once, so a second Inngest
-- event — and therefore a second LLM call / second Slack reply — is never
-- created. The Inngest function (inngest/functions.js) marks the row
-- delivered or failed once it knows the outcome.
--
-- idempotency_key is "slack:<event_id>" (see services/slackEventLogService.js
-- on the Relativity side) — already globally unique per Slack event, so the
-- unique index is on that column alone, not composite with client_id,
-- mirroring idx_knowledge_chat_sessions_idempotency_key's precedent.
--
-- Safe to run multiple times (IF NOT EXISTS throughout). Additive only.

CREATE TABLE IF NOT EXISTS knowledge_slack_request_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL,
  idempotency_key TEXT        NOT NULL,
  origin          TEXT        NOT NULL CHECK (origin IN ('slack', 'slack_dm')),
  status          TEXT        NOT NULL DEFAULT 'processing'
                                CHECK (status IN ('processing', 'delivered', 'failed')),
  attempt_count   INTEGER     NOT NULL DEFAULT 1,
  error_category  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_slack_request_log_idempotency_key
  ON knowledge_slack_request_log (idempotency_key);

-- Per-client audit/debugging lookups only — never surfaced to the portal.
CREATE INDEX IF NOT EXISTS idx_knowledge_slack_request_log_client_id
  ON knowledge_slack_request_log (client_id, created_at DESC);
