'use strict';

// EM10.5 Scenario 3 follow-up bug fix (Architecture/architecture/EM10_5_STAGING_CHECKLIST.md).
//
// upsertKnowledgeDocument only ever writes collection_id into its upsert
// payload when it's truthy (services/supabaseService.js) — omitting the key
// entirely otherwise, on the assumption that Postgres's
// `INSERT ... ON CONFLICT DO UPDATE` simply leaves an existing row's column
// alone when it's absent from the payload. That's true for the UPDATE that
// actually runs, but Postgres still constructs and validates a full
// candidate row for the INSERT branch (NOT NULL constraints included)
// *before* it resolves the conflict — so omitting collection_id from the
// payload fails with a NOT NULL violation even when the existing row
// already has a valid one. inngest/functions.js previously only resolved a
// collection_id `if (!existing)`, so any re-ingest of an existing row
// (soft-deleted OR indexed-with-changed-content), on any sourceProvider,
// hit this whenever the caller didn't pass an explicit collectionId.
//
// Resolution priority, matching Architecture's desired behavior:
//   1. an explicitly supplied, valid collectionId always wins;
//   2. otherwise, an existing document row's own collection_id is preserved;
//   3. otherwise (no existing row — a true first insert), the caller falls
//      back to the client's default collection — this is the pre-existing,
//      documented "General" behavior (see supabaseService.js#getDefaultCollection)
//      and is intentionally NOT decided here, since it requires an async DB
//      call; the 'default' source signals the caller to make that call;
//   4. an existing row with neither an explicit collectionId nor its own
//      valid collection_id can't be resolved — the caller must fail clearly
//      instead of sending an incomplete upsert payload.
//
// Pure/side-effect-free by design (same convention as
// services/ingestDedup.js#canSkipUnchangedHash) so the decision table is
// covered directly with plain inputs, no DB required.
function resolveDocumentCollectionId({ existing, collectionId }) {
  if (collectionId) {
    return { source: 'explicit', collectionId };
  }
  if (existing) {
    if (existing.collection_id) {
      return { source: 'existing', collectionId: existing.collection_id };
    }
    return { source: 'error', collectionId: null };
  }
  return { source: 'default', collectionId: null };
}

module.exports = { resolveDocumentCollectionId };
