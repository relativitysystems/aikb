-- Relativity Knowledge Base — Migration 010: Email ingestion EM1 schema foundation
-- Run this in the AIKB Supabase SQL editor after 009_slack_request_log.sql.
--
-- EM1 — Multi-member schema foundation (Architecture/architecture/
-- EMAIL_INGESTION.md §13.2, §31). Schema only: no application service writes
-- either table yet (that begins at EM6 for email_source_messages and a later
-- attachment milestone for email_attachments). This migration is scoped
-- strictly to AIKB's own database — it does not read from, write to, or
-- otherwise alter Relativity's Global project, and does not touch
-- services/aikbDatabaseProvider.js or the ADR-008 routing contract.
--
-- Two new tables:
--   - email_source_messages — structured, query-and-citation-time email
--     metadata, 1:1 with a knowledge_documents row.
--   - email_attachments — parent/child linkage for attachment documents,
--     a concept that doesn't exist anywhere in AIKB today. Schema
--     preparation only; no code path populates this table until a later
--     attachment milestone.
--
-- client_id, contributing_member_id, and ingestion_rule_id all reference
-- rows that live in Relativity's separate Global Supabase project.
-- Cross-project foreign keys are not supported by Supabase, so each is
-- stored as a plain UUID column with no FK constraint — the same pattern
-- already established by 004_member_id.sql's member_id/connection_id
-- columns.
--
-- Safe to run multiple times (IF NOT EXISTS throughout).

-- ---------------------------------------------------------------------------
-- 1. email_source_messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_source_messages (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id             UUID         NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  client_id               UUID         NOT NULL,
  provider                TEXT         NOT NULL CHECK (provider IN ('gmail', 'microsoft')),
  provider_account_id     TEXT         NOT NULL,   -- mailbox address, echoed from Relativity, not independently verified
  contributing_member_id  UUID,                    -- Relativity's client_members.id; no FK (cross-project)
  provider_message_id     TEXT         NOT NULL,
  provider_thread_id      TEXT,
  from_address            TEXT,
  from_name               TEXT,
  to_addresses            JSONB        NOT NULL DEFAULT '[]',
  cc_addresses            JSONB        NOT NULL DEFAULT '[]',
  subject                 TEXT,
  sent_at                 TIMESTAMPTZ,
  received_at             TIMESTAMPTZ,
  folder_or_labels        JSONB        NOT NULL DEFAULT '[]',
  has_attachments         BOOLEAN      NOT NULL DEFAULT false,
  deep_link_url           TEXT,
  ingestion_rule_id       UUID,        -- Relativity's email_ingestion_rules.id; no FK (cross-project)
  content_hash            TEXT,        -- of normalized body; same-message unchanged-content skip only, never cross-message dedup
  source_deleted_at       TIMESTAMPTZ, -- set when Relativity detects remote deletion; distinct from knowledge_documents.status='deleted'
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id)
);

CREATE INDEX IF NOT EXISTS email_source_messages_client_thread_idx
  ON email_source_messages (client_id, provider_thread_id);
CREATE INDEX IF NOT EXISTS email_source_messages_message_idx
  ON email_source_messages (client_id, provider, provider_message_id);
CREATE INDEX IF NOT EXISTS email_source_messages_contributor_idx
  ON email_source_messages (client_id, contributing_member_id);

-- ---------------------------------------------------------------------------
-- 2. email_attachments
-- Not part of the MVP (EMAIL_INGESTION.md §3) — schema proposed now so a
-- later migration doesn't need to redesign the relationship. scan_status
-- defaults reflect that no malware-scanning integration exists anywhere in
-- either repository today; the column exists so the ABSENCE of scanning is
-- visible in the data model, not because scanning is implemented.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_attachments (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_document_id      UUID         NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  attachment_document_id  UUID         REFERENCES knowledge_documents(id) ON DELETE CASCADE,  -- null until/unless successfully ingested
  client_id               UUID         NOT NULL,
  original_filename       TEXT         NOT NULL,
  content_type            TEXT,
  size_bytes               BIGINT,
  scan_status              TEXT        NOT NULL DEFAULT 'not_scanned'
                                        CHECK (scan_status IN ('not_scanned', 'clean', 'flagged', 'scan_unavailable')),
  extraction_status        TEXT        NOT NULL DEFAULT 'pending'
                                        CHECK (extraction_status IN ('pending', 'ingested', 'unsupported_format', 'too_large', 'password_protected', 'failed')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_attachments_parent_idx
  ON email_attachments (parent_document_id);
