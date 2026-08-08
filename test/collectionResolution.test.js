'use strict';

// EM10.5 Scenario 3 follow-up bug fix (Architecture/architecture/EM10_5_STAGING_CHECKLIST.md).
//
// Production evidence: two Gmail Full Scan re-ingests of soft-deleted
// documents ("Project Phoenix Onboarding SOP", "Customer Refund Policy")
// failed in index-document-core with
// `upsertKnowledgeDocument: null value in column "collection_id" ... violates
// not-null constraint`, even though both existing rows already had a valid
// collection_id. Root cause: inngest/functions.js only resolved a
// collection_id `if (!existing)`, leaving it undefined for any re-ingest of
// an existing row (soft-deleted or not) — and Postgres's
// `INSERT ... ON CONFLICT DO UPDATE` validates NOT NULL constraints against
// the candidate INSERT row before it resolves the conflict, so an omitted
// collection_id fails even though the UPDATE branch would never have
// touched that column.
//
// resolveDocumentCollectionId is pure/side-effect-free (same convention as
// ingestDedup.js#canSkipUnchangedHash), so its decision table is covered
// directly with plain inputs — no DB required.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDocumentCollectionId } = require('../services/collectionResolution');

const GENERAL = 'c033f615-57ea-42a0-956a-3d9ba5875bf5';
const RULE_MATCH = 'aaaaaaaa-1111-2222-3333-444444444444';

// ─────────────────────────────────────────────
// resolveDocumentCollectionId — decision table
// ─────────────────────────────────────────────

test('1. first-time ingest with explicit collection_id: uses the explicit value', () => {
  const result = resolveDocumentCollectionId({ existing: null, collectionId: RULE_MATCH });
  assert.deepEqual(result, { source: 'explicit', collectionId: RULE_MATCH });
});

test('1b. first-time ingest with no explicit collection_id: signals the caller to resolve the client default', () => {
  const result = resolveDocumentCollectionId({ existing: null, collectionId: null });
  assert.equal(result.source, 'default');
  assert.equal(result.collectionId, null);
});

test('2. healthy same-document re-ingest with no explicit collection_id: preserves the existing collection', () => {
  const existing = { id: 'doc-1', status: 'indexed', collection_id: GENERAL };
  const result = resolveDocumentCollectionId({ existing, collectionId: null });
  assert.deepEqual(result, { source: 'existing', collectionId: GENERAL });
});

test('3. soft-deleted document re-ingest with existing collection_id and no new collection_id: preserves old collection_id', () => {
  // Mirrors the exact production shape from both failed runs' check-existing
  // step output: status='deleted', collection_id still populated (delete
  // never clears it — see markDocumentDeleted in supabaseService.js).
  const existing = { id: 'doc-1', status: 'deleted', collection_id: GENERAL };
  const result = resolveDocumentCollectionId({ existing, collectionId: null });
  assert.deepEqual(result, { source: 'existing', collectionId: GENERAL });
  assert.ok(result.collectionId, 'must never resolve to a falsy value that upsertKnowledgeDocument would omit');
});

test('4. soft-deleted document re-ingest with a valid explicit collection_id: the explicit value wins over the old one', () => {
  const existing = { id: 'doc-1', status: 'deleted', collection_id: GENERAL };
  const result = resolveDocumentCollectionId({ existing, collectionId: RULE_MATCH });
  assert.deepEqual(result, { source: 'explicit', collectionId: RULE_MATCH });
});

test('5. existing document with null collection_id and no supplied collection: signals an error instead of a silent null write', () => {
  const existing = { id: 'doc-1', status: 'indexed', collection_id: null };
  const result = resolveDocumentCollectionId({ existing, collectionId: null });
  assert.equal(result.source, 'error');
  assert.equal(result.collectionId, null);
});

test('5b. existing document with undefined collection_id and no supplied collection: also signals an error', () => {
  const existing = { id: 'doc-1', status: 'error' };
  const result = resolveDocumentCollectionId({ existing, collectionId: undefined });
  assert.equal(result.source, 'error');
});

test('6. non-Gmail (portal_upload) soft-delete/re-ingest: the helper is provider-agnostic, same outcome as Gmail', () => {
  const existing = { id: 'doc-2', status: 'deleted', collection_id: GENERAL };
  const result = resolveDocumentCollectionId({ existing, collectionId: null });
  assert.deepEqual(result, { source: 'existing', collectionId: GENERAL });
});

test('empty-string collectionId is treated as not supplied, same as null/undefined', () => {
  const existing = { id: 'doc-1', status: 'indexed', collection_id: GENERAL };
  const result = resolveDocumentCollectionId({ existing, collectionId: '' });
  assert.deepEqual(result, { source: 'existing', collectionId: GENERAL });
});

// ─────────────────────────────────────────────
// 7. Full lifecycle against a fake mirroring the real supabaseService
// surface — proves the fix end-to-end at the same boundary
// test/ingestDedup.test.js already covers for canSkipUnchangedHash, and
// that existing dedup/skip behavior is untouched by this change.
// ─────────────────────────────────────────────

const { canSkipUnchangedHash } = require('../services/ingestDedup');

function createFakeDocumentStore() {
  const documents = new Map();
  let nextId = 1;
  const key = (clientId, sourceProvider, sourceFileId) => `${clientId}:${sourceProvider}:${sourceFileId}`;

  return {
    documents,

    // Mirrors the real upsertKnowledgeDocument: only writes collection_id
    // into the row when truthy, and — like the real
    // INSERT ... ON CONFLICT DO UPDATE — throws the same NOT NULL error a
    // genuinely new row would if collection_id is missing.
    async upsertKnowledgeDocument(clientId, sourceProvider, sourceFileId, fileName, mimeType, contentHash, storagePath, collectionId) {
      const k = key(clientId, sourceProvider, sourceFileId);
      const existing = documents.get(k);
      if (!existing && !collectionId) {
        throw new Error('upsertKnowledgeDocument: null value in column "collection_id" of relation "knowledge_documents" violates not-null constraint');
      }
      const doc = {
        id: existing ? existing.id : `doc-${nextId++}`,
        client_id: clientId, source_provider: sourceProvider, source_file_id: sourceFileId,
        content_hash: contentHash, status: 'indexing',
        collection_id: collectionId || (existing ? existing.collection_id : null),
      };
      documents.set(k, doc);
      return doc;
    },

    async getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId) {
      return documents.get(key(clientId, sourceProvider, sourceFileId)) || null;
    },

    async markDocumentIndexed(clientId, documentId) {
      for (const doc of documents.values()) if (doc.id === documentId) doc.status = 'indexed';
    },

    async markDocumentDeleted(clientId, documentId) {
      for (const doc of documents.values()) {
        if (doc.id === documentId) {
          doc.status = 'deleted';
          doc.content_hash = null;
          // collection_id intentionally untouched — matches the real
          // markDocumentDeleted (supabaseService.js).
        }
      }
    },
  };
}

// Drives the same resolution + upsert sequence functions.js's
// index-document-core step performs.
async function ingestOnce(store, { clientId, sourceProvider, sourceFileId, contentHash, collectionId = null, defaultCollectionId = GENERAL, forceReindex = false }) {
  const existing = await store.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);

  const hashAndStatusMatch = !forceReindex && existing && existing.content_hash === contentHash && existing.status === 'indexed';
  if (canSkipUnchangedHash({ existing, contentHash, forceReindex, chunkCount: hashAndStatusMatch ? 1 : 0 })) {
    return { skipped: true, documentId: existing.id };
  }

  const resolution = resolveDocumentCollectionId({ existing, collectionId });
  let newDocCollectionId;
  if (resolution.source === 'default') {
    newDocCollectionId = defaultCollectionId;
  } else if (resolution.source === 'error') {
    throw new Error(`Cannot resolve collection_id for existing document ${existing.id}`);
  } else {
    newDocCollectionId = resolution.collectionId;
  }

  const doc = await store.upsertKnowledgeDocument(clientId, sourceProvider, sourceFileId, 'file.txt', 'text/plain', contentHash, 'storage/path', newDocCollectionId);
  await store.markDocumentIndexed(clientId, doc.id);
  return { skipped: false, documentId: doc.id, collectionId: doc.collection_id };
}

test('lifecycle: soft-deleted Gmail document re-ingest with unchanged content restores successfully and keeps its collection (the exact production scenario)', async () => {
  const store = createFakeDocumentStore();
  const clientId = 'client-1';
  const target = { clientId, sourceProvider: 'gmail', sourceFileId: 'msg-1', contentHash: 'body-hash-abc' };

  const first = await ingestOnce(store, target);
  assert.equal(first.skipped, false);
  assert.equal(first.collectionId, GENERAL);

  await store.markDocumentDeleted(clientId, first.documentId);
  assert.equal((await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-1')).status, 'deleted');

  // Pre-fix: this threw the exact production error (collectionId stayed
  // undefined because `existing` was truthy). Post-fix: it must succeed and
  // reuse the document's original collection.
  const second = await ingestOnce(store, target);
  assert.equal(second.skipped, false, 'must not throw the collection_id NOT NULL error on re-ingest of a soft-deleted row');
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.collectionId, GENERAL, 'the pre-existing collection is preserved, not reset to null or a different default');
  assert.equal((await store.getKnowledgeDocumentBySourceId(clientId, 'gmail', 'msg-1')).status, 'indexed', 'status is restored to indexed, mirroring the real mark-indexed step');
});

test('lifecycle: existing dedup/skip behavior for a genuinely unchanged healthy document is untouched', async () => {
  const store = createFakeDocumentStore();
  const clientId = 'client-1';
  const target = { clientId, sourceProvider: 'gmail', sourceFileId: 'msg-2', contentHash: 'body-hash-xyz' };

  await ingestOnce(store, target);
  const again = await ingestOnce(store, target);
  assert.equal(again.skipped, true, 'a still-indexed, still-hash-matching document is skipped as before');
});
