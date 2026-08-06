'use strict';

// EM10.5 Scenario 3 bug fix (Architecture/architecture/EM10_5_STAGING_CHECKLIST.md).
//
// A matching content_hash alone is not proof that a document is still
// searchable: knowledge-document-delete soft-deletes (status='deleted') and
// hard-deletes chunks, but historically left content_hash on the row
// untouched. Re-submitting the same message afterward (e.g. a Gmail full
// scan re-syncing an email whose label was removed and re-added) then
// compared hashes, saw a match, and skipped re-indexing entirely — the job
// reported "imported"/COMPLETED with chunkCount: 0, and the document was
// never searchable again.
//
// A hash match may only short-circuit indexing when the existing document is
// still a real, complete, indexed row: status 'indexed' AND at least one
// chunk actually exists for it. Pure/side-effect-free by design (matches
// this codebase's extractCitedIndices/buildContextText convention) — the
// caller is responsible for fetching chunkCount (a DB round trip) only when
// the cheap synchronous checks already pass.
function canSkipUnchangedHash({ existing, contentHash, forceReindex, chunkCount }) {
  if (forceReindex) return false;
  if (!existing) return false;
  if (existing.content_hash !== contentHash) return false;
  if (existing.status !== 'indexed') return false;
  if (!(chunkCount > 0)) return false;
  return true;
}

module.exports = { canSkipUnchangedHash };
