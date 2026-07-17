-- Relativity Knowledge Base — Migration 006: Knowledge Collections
-- Run this in the AIKB Supabase SQL editor after 005_slack_origin_tracking.sql.
--
-- Milestone 5 (Slack Knowledge Collections). Adds an org-scoped (client_id-
-- scoped) grouping for knowledge_documents so retrieval can be restricted to
-- an admin-chosen subset of documents — starting with limiting what Slack is
-- allowed to search. Every organization gets two seeded collections,
-- "General" (the default target for new uploads) and "Slack" (an ordinary
-- starter collection, no special behavior beyond being pre-created).
--
-- Unlike member_id/connection_id (004_member_id.sql/005_slack_origin_
-- tracking.sql), collection_id is NOT a cross-project reference —
-- knowledge_collections lives in this same AIKB database as
-- knowledge_documents, so a real foreign key is used here.
--
-- Safe to run multiple times (IF NOT EXISTS / ON CONFLICT DO NOTHING /
-- CREATE OR REPLACE), except the ALTER COLUMN SET NOT NULL below, which is
-- idempotent by nature — re-running it after it has already succeeded is a
-- no-op.

-- ---------------------------------------------------------------------------
-- 1. knowledge_collections
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS knowledge_collections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID        NOT NULL,
  name        TEXT        NOT NULL,
  is_default  BOOLEAN     NOT NULL DEFAULT false,  -- true only for the seeded "General" row
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, name)
);

CREATE INDEX IF NOT EXISTS knowledge_collections_client_idx
  ON knowledge_collections (client_id);

-- At most one default ("General") collection per client — this is the
-- fallback target new documents get assigned to, so its uniqueness (and
-- therefore existence) must be guaranteed at the DB level, not just in app code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_collections_default_per_client
  ON knowledge_collections (client_id)
  WHERE is_default = true;

-- ---------------------------------------------------------------------------
-- 2. Backfill seed collections for every client that already has documents.
-- Clients with zero documents today (or created after this migration runs)
-- are seeded lazily instead, by ensureDefaultCollections() in
-- services/supabaseService.js — this migration can't enumerate "all clients"
-- since that list lives in the separate Global Supabase project, not here.
-- ---------------------------------------------------------------------------
INSERT INTO knowledge_collections (client_id, name, is_default)
SELECT DISTINCT client_id, 'General', true
FROM knowledge_documents
ON CONFLICT (client_id, name) DO NOTHING;

INSERT INTO knowledge_collections (client_id, name, is_default)
SELECT DISTINCT client_id, 'Slack', false
FROM knowledge_documents
ON CONFLICT (client_id, name) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. knowledge_documents.collection_id
-- ---------------------------------------------------------------------------
ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS collection_id UUID;

-- Backfill BEFORE the NOT NULL constraint below — every existing document
-- goes to its client's General (is_default) collection.
UPDATE knowledge_documents kd
SET collection_id = kc.id
FROM knowledge_collections kc
WHERE kc.client_id = kd.client_id
  AND kc.is_default = true
  AND kd.collection_id IS NULL;

-- Safe now: every existing knowledge_documents row was just backfilled above.
ALTER TABLE knowledge_documents
  ALTER COLUMN collection_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_knowledge_documents_collection'
  ) THEN
    ALTER TABLE knowledge_documents
      ADD CONSTRAINT fk_knowledge_documents_collection
      FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS knowledge_docs_collection_idx
  ON knowledge_documents (collection_id);

-- ---------------------------------------------------------------------------
-- 4. match_knowledge_chunks — add optional collection filtering.
--
-- match_collection_ids DEFAULT NULL preserves today's portal behavior
-- exactly for every existing caller that doesn't pass it (no filter —
-- searches every collection). Passing an EMPTY array ('{}') matches ZERO
-- rows (`kd.collection_id = ANY('{}')` is always false) — this is the
-- mechanism that makes "Slack allowed 0 collections" mean "search nothing",
-- never "search everything". The filter runs inside this function's own
-- WHERE clause — i.e. inside the single SQL statement that performs the
-- vector search — so a restricted chunk is never fetched into the
-- application at all, and therefore can never reach the LLM prompt.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_knowledge_chunks (
  query_embedding      VECTOR(1536),
  match_client_id      UUID,
  match_threshold      FLOAT   DEFAULT 0.7,
  match_count          INT     DEFAULT 5,
  match_collection_ids UUID[]  DEFAULT NULL
)
RETURNS TABLE (
  id          UUID,
  document_id UUID,
  content     TEXT,
  metadata    JSONB,
  similarity  FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.document_id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) AS similarity
  FROM knowledge_chunks kc
  JOIN knowledge_documents kd ON kd.id = kc.document_id
  WHERE kc.client_id = match_client_id
    AND 1 - (kc.embedding <=> query_embedding) > match_threshold
    AND (
      match_collection_ids IS NULL
      OR kd.collection_id = ANY (match_collection_ids)
    )
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
