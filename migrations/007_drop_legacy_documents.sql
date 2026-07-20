-- Relativity Knowledge Base — Migration 007: Drop legacy documents table
-- Run this in the AIKB Supabase SQL editor after 006_knowledge_collections.sql.
--
-- Backlog L6. `documents` (bigint id, content/metadata/embedding — the
-- standard pgvector-quickstart shape) and its `match_documents()` RPC predate
-- this repo's tracked migration history (pre-001) and were superseded by
-- knowledge_documents/knowledge_chunks. Confirmed via pg_stat_user_tables:
-- 954 historical inserts / 146 deletes (real prior use) but 0 rows and no
-- write activity as of this migration. No foreign keys reference `documents`,
-- and `match_documents()` is never called from application code in either
-- repo (git log -S confirms zero references). The application-side
-- best-effort cleanup shim, deleteLegacyDocumentsForClient(), has been
-- removed from services/supabaseService.js in the same change that adds
-- this migration — dropping only one of the two would leave the other as
-- dead code/a dangling reference.
--
-- Not safe to re-run blindly if a future migration recreates `documents`;
-- IF EXISTS makes this migration itself idempotent.

DROP FUNCTION IF EXISTS public.match_documents(extensions.vector, integer, jsonb);

DROP TABLE IF EXISTS public.documents;
