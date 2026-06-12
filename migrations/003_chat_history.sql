-- Relativity Knowledge Base — chat history, question logging, and knowledge gap tracking
-- Run this in the AIKB Supabase SQL editor after 002_add_storage_path.sql.

-- ---------------------------------------------------------------------------
-- knowledge_chat_sessions
-- One row per conversation session per client.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chat_sessions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID        NOT NULL,
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- knowledge_chat_messages
-- Individual messages (user / assistant / system) within a session.
-- Soft-deleted rows are hidden from queries but preserved for audit.
-- NOTE: client_id is intentionally denormalised here to allow simple
-- client-scoped queries without joining knowledge_chat_sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_chat_messages (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID        NOT NULL,
  session_id UUID        NOT NULL REFERENCES knowledge_chat_sessions(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT        NOT NULL,
  sources    JSONB,
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- knowledge_gaps
-- Logged when the RAG pipeline finds no relevant chunks for a question.
-- Provides admins with a view of what the knowledge base is missing.
-- message_id references the user's question message (not the assistant reply).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID        NOT NULL,
  session_id UUID        REFERENCES knowledge_chat_sessions(id) ON DELETE SET NULL,
  message_id UUID        REFERENCES knowledge_chat_messages(id) ON DELETE SET NULL,
  question   TEXT        NOT NULL,
  reason     TEXT,
  status     TEXT        NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'reviewed', 'resolved', 'ignored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Session list per client (portal chat history page — newest first)
CREATE INDEX IF NOT EXISTS knowledge_chat_sessions_client_idx
  ON knowledge_chat_sessions (client_id, created_at DESC);

-- Message list within a session (ordered chronologically)
CREATE INDEX IF NOT EXISTS knowledge_chat_messages_session_idx
  ON knowledge_chat_messages (client_id, session_id, created_at ASC);

-- Knowledge gap admin view per client (filter by status, newest first)
CREATE INDEX IF NOT EXISTS knowledge_gaps_client_idx
  ON knowledge_gaps (client_id, status, created_at DESC);
