-- Relativity Knowledge Base — Migration 004: member-level chat ownership
-- Run this in the AIKB Supabase SQL editor after 003_chat_history.sql.
--
-- member_id references Relativity_Global.client_members.id but is stored here
-- as a plain UUID with no foreign-key constraint because cross-project (cross-database)
-- foreign keys are not supported in Supabase.

-- ---------------------------------------------------------------------------
-- Add member_id columns (nullable so existing rows are unaffected)
-- ---------------------------------------------------------------------------

ALTER TABLE knowledge_chat_sessions
  ADD COLUMN IF NOT EXISTS member_id UUID;

-- NOTE: client_id is already denormalised on messages for client-scoped queries.
-- member_id is denormalised here for the same reason: fast member-scoped queries
-- without joining knowledge_chat_sessions.
ALTER TABLE knowledge_chat_messages
  ADD COLUMN IF NOT EXISTS member_id UUID;

ALTER TABLE knowledge_gaps
  ADD COLUMN IF NOT EXISTS member_id UUID;

-- ---------------------------------------------------------------------------
-- Indexes for member-scoped queries
-- These complement (not replace) the existing client-level indexes.
-- ---------------------------------------------------------------------------

-- Session list filtered by client + member, with soft-delete and activity ordering
CREATE INDEX IF NOT EXISTS idx_chat_sessions_client_member
  ON knowledge_chat_sessions (client_id, member_id, deleted_at, updated_at DESC);

-- Message queries scoped to a specific client + member + session
CREATE INDEX IF NOT EXISTS idx_chat_messages_client_member
  ON knowledge_chat_messages (client_id, member_id, session_id, created_at ASC);

-- Knowledge gap admin/member view per client + member, newest first
CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_client_member
  ON knowledge_gaps (client_id, member_id, created_at DESC);
