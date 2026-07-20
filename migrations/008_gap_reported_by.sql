-- Relativity Knowledge Base — Migration 008: Knowledge-gap reported-by
-- attribution. Run after 007_drop_legacy_documents.sql.
--
-- Backlog M12, shipped alongside M4's auto-persist (runKnowledgeQuery now
-- calls createKnowledgeGap itself on every detected gap, origin: 'portal'
-- or 'slack', reported_by: 'system') and M5's admin review workflow.
-- Distinguishes gaps the pipeline detected automatically from gaps a human
-- explicitly flagged via POST /api/knowledge/gaps (reported_by: 'user'),
-- per Architecture/product/KNOWLEDGE_GAP_DETECTION.md's recommendation to
-- persist both into the same table with a reportedBy distinction rather
-- than a second table.
--
-- Nullable, no default: the ~280 existing rows (all created via the old
-- manual-only /gaps POST route, before this distinction existed) get NULL,
-- not a guessed 'user' or 'system' value — guessing would misattribute
-- rows this migration has no way to actually know the origin of.
-- Application code renders NULL as "legacy/unknown"; it is never
-- backfilled.
--
-- NOT YET APPLIED to either Supabase project as of this commit — see
-- Architecture/roadmap/FEATURE_BACKLOG.md's M4/M12 entries. Must be applied
-- before this migration's corresponding code (services/supabaseService.js's
-- createKnowledgeGap, which now writes reported_by on every insert) is
-- deployed, or inserts will fail with "column reported_by does not exist."

ALTER TABLE knowledge_gaps
  ADD COLUMN IF NOT EXISTS reported_by TEXT
    CHECK (reported_by IN ('system', 'user'));

CREATE INDEX IF NOT EXISTS idx_knowledge_gaps_reported_by
  ON knowledge_gaps (client_id, reported_by, created_at DESC);
