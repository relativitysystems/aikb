'use strict';

// EM10.5 Scenario 3 bug fix (Architecture/architecture/EM10_5_STAGING_CHECKLIST.md).
//
// Two layers here:
//   1. canSkipUnchangedHash is pure/side-effect-free (same convention as
//      extractCitedIndices/buildContextText — see test/runKnowledgeQuery.test.js's
//      header comment), so its decision table is covered directly with plain inputs.
//   2. A small in-memory fake mirroring the exact subset of supabaseService.js the
//      ingest/delete paths touch (documents + chunks maps) drives a full
//      index -> delete -> re-ingest-unchanged -> re-index -> re-ingest-unchanged
//      lifecycle, proving the fix end-to-end at the dedup decision boundary without
//      a live Supabase/OpenAI/Inngest environment — this repo has no test-database
//      pattern (see runKnowledgeQuery.test.js's createFakeSupabaseService), and the
//      parse/chunk/embed steps themselves were never implicated in this bug (the
//      production traces showed those steps work correctly whenever they actually
//      run — the bug was entirely in whether they ran at all).

const test = require('node:test');
const assert = require('node:assert/strict');
const { canSkipUnchangedHash } = require('../services/ingestDedup');

// ─────────────────────────────────────────────
// canSkipUnchangedHash — decision table
// ─────────────────────────────────────────────

test('active (indexed) document + same hash + valid chunks: may skip as unchanged', () => {
  const existing = { id: 'doc-1', status: 'indexed', content_hash: 'abc' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'abc', forceReindex: false, chunkCount: 3 }), true);
});

test('deleted document + same hash: must re-index, never skip', () => {
  const existing = { id: 'doc-1', status: 'deleted', content_hash: 'abc' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'abc', forceReindex: false, chunkCount: 0 }), false);
});

test('indexed document + same hash + zero chunks: must re-index, never skip', () => {
  const existing = { id: 'doc-1', status: 'indexed', content_hash: 'abc' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'abc', forceReindex: false, chunkCount: 0 }), false);
});

for (const status of ['pending', 'indexing', 'error']) {
  test(`tombstoned/inactive document (status=${status}) + same hash: must re-index, never skip`, () => {
    const existing = { id: 'doc-1', status, content_hash: 'abc' };
    assert.equal(canSkipUnchangedHash({ existing, contentHash: 'abc', forceReindex: false, chunkCount: 5 }), false);
  });
}

test('no existing document: never skip', () => {
  assert.equal(canSkipUnchangedHash({ existing: null, contentHash: 'abc', forceReindex: false, chunkCount: 5 }), false);
});

test('different content hash: never skip, regardless of status/chunks', () => {
  const existing = { id: 'doc-1', status: 'indexed', content_hash: 'old-hash' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'new-hash', forceReindex: false, chunkCount: 5 }), false);
});

test('forceReindex always wins, even for an otherwise-skippable healthy document', () => {
  const existing = { id: 'doc-1', status: 'indexed', content_hash: 'abc' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'abc', forceReindex: true, chunkCount: 5 }), false);
});

test('existing unchanged-content dedup behavior for healthy documents remains intact (a real re-upload of the same file still skips)', () => {
  const existing = { id: 'doc-1', status: 'indexed', content_hash: 'stable-hash' };
  assert.equal(canSkipUnchangedHash({ existing, contentHash: 'stable-hash', forceReindex: false, chunkCount: 1 }), true);
});

// ─────────────────────────────────────────────
// Full lifecycle, against a fake mirroring the real supabaseService surface
// ─────────────────────────────────────────────

function createFakeDocumentStore() {
  const documents = new Map(); // key: `${clientId}:${sourceProvider}:${sourceFileId}`
  const chunksByDocumentId = new Map(); // documentId -> array

  function key(clientId, sourceProvider, sourceFileId) {
    return `${clientId}:${sourceProvider}:${sourceFileId}`;
  }

  let nextId = 1;

  return {
    documents,
    chunksByDocumentId,

    // Mirrors upsertKnowledgeDocument's onConflict(client_id,source_provider,source_file_id)
    // upsert semantics, and its "status always reset to indexing" behavior.
    async upsertKnowledgeDocument(clientId, sourceProvider, sourceFileId, fileName, mimeType, contentHash) {
      const k = key(clientId, sourceProvider, sourceFileId);
      const existing = documents.get(k);
      const doc = {
        id: existing ? existing.id : `doc-${nextId++}`,
        client_id: clientId, source_provider: sourceProvider, source_file_id: sourceFileId,
        content_hash: contentHash, status: 'indexing',
      };
      documents.set(k, doc);
      return doc;
    },

    async getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId) {
      return documents.get(key(clientId, sourceProvider, sourceFileId)) || null;
    },

    async markDocumentIndexed(clientId, documentId) {
      for (const doc of documents.values()) {
        if (doc.id === documentId) doc.status = 'indexed';
      }
    },

    // Mirrors the real markDocumentDeleted fix: status flips to 'deleted' AND
    // content_hash is cleared (defense in depth).
    async markDocumentDeleted(clientId, documentId) {
      for (const doc of documents.values()) {
        if (doc.id === documentId) {
          doc.status = 'deleted';
          doc.content_hash = null;
        }
      }
    },

    async deleteChunksForDocument(clientId, documentId) {
      chunksByDocumentId.set(documentId, []);
    },

    async insertKnowledgeChunks(clientId, rows) {
      for (const row of rows) {
        const arr = chunksByDocumentId.get(row.document_id) || [];
        arr.push(row);
        chunksByDocumentId.set(row.document_id, arr);
      }
    },

    async getChunkCountForDocument(clientId, documentId) {
      return (chunksByDocumentId.get(documentId) || []).length;
    },
  };
}

// Drives the same decision + orchestration sequence inngest/functions.js's
// index-document-core step performs, against the fake store.
async function ingestOnce(store, { clientId, sourceProvider, sourceFileId, contentHash, forceReindex = false }) {
  const existing = await store.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);

  const hashAndStatusMatch = !forceReindex && existing && existing.content_hash === contentHash && existing.status === 'indexed';
  const existingChunkCount = hashAndStatusMatch ? await store.getChunkCountForDocument(clientId, existing.id) : 0;

  if (canSkipUnchangedHash({ existing, contentHash, forceReindex, chunkCount: existingChunkCount })) {
    return { skipped: true, documentId: existing.id };
  }

  const doc = await store.upsertKnowledgeDocument(clientId, sourceProvider, sourceFileId, 'email.txt', 'text/plain', contentHash);
  await store.deleteChunksForDocument(clientId, doc.id);
  await store.insertKnowledgeChunks(clientId, [
    { document_id: doc.id, chunk_index: 0, content: 'chunk one' },
    { document_id: doc.id, chunk_index: 1, content: 'chunk two' },
  ]);
  await store.markDocumentIndexed(clientId, doc.id);
  return { skipped: false, documentId: doc.id };
}

test('delete then re-ingest an unchanged Gmail email: produces chunks and restores searchable state (was previously skipped with 0 chunks)', async () => {
  const store = createFakeDocumentStore();
  const clientId = 'client-1';
  const target = { clientId, sourceProvider: 'gmail', sourceFileId: 'msg-1', contentHash: 'body-hash-abc' };

  // Original ingest — indexes normally.
  const first = await ingestOnce(store, target);
  assert.equal(first.skipped, false);
  assert.equal(await store.getChunkCountForDocument(clientId, first.documentId), 2);
  assert.equal((await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-1')).status, 'indexed');

  // Delete — matches knowledge-document-delete's real step order (delete-chunks,
  // then mark-deleted): chunks removed, then document soft-deleted.
  await store.deleteChunksForDocument(clientId, first.documentId);
  await store.markDocumentDeleted(clientId, first.documentId);
  assert.equal(await store.getChunkCountForDocument(clientId, first.documentId), 0);
  assert.equal((await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-1')).status, 'deleted');

  // Re-ingest with byte-identical content (same contentHash) — the exact
  // production scenario. Pre-fix this returned {skipped:true, chunkCount:0}.
  const second = await ingestOnce(store, target);
  assert.equal(second.skipped, false, 'a deleted document must never be treated as an unchanged-hash skip');
  assert.equal(second.documentId, first.documentId, 'the same document row is reused (upsert on client/provider/sourceFileId)');
  assert.equal(await store.getChunkCountForDocument(clientId, second.documentId), 2, 'chunks are rebuilt');
  assert.equal((await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-1')).status, 'indexed', 'status is restored to indexed');
});

test('a healthy re-sync after the restore above still dedups correctly (no regression to normal unchanged-content behavior)', async () => {
  const store = createFakeDocumentStore();
  const clientId = 'client-1';
  const target = { clientId, sourceProvider: 'gmail', sourceFileId: 'msg-2', contentHash: 'body-hash-xyz' };

  await ingestOnce(store, target); // first index
  const third = await ingestOnce(store, target); // immediate re-sync, unchanged, still indexed

  assert.equal(third.skipped, true, 'a genuinely still-indexed, still-hash-matching document is skipped as before');
});

test('delete remains idempotent against the fake store (calling it twice never errors and leaves a consistent terminal state)', async () => {
  const store = createFakeDocumentStore();
  const clientId = 'client-1';
  const { documentId } = await ingestOnce(store, { clientId, sourceProvider: 'gmail', sourceFileId: 'msg-3', contentHash: 'h1' });

  await store.markDocumentDeleted(clientId, documentId);
  await store.markDocumentDeleted(clientId, documentId); // second delete of an already-deleted doc

  const doc = await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-3');
  assert.equal(doc.status, 'deleted');
  assert.equal(doc.content_hash, null);
});
