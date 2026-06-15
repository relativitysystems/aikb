'use strict';

const crypto = require('crypto');
const { inngest } = require('./client');
const config = require('../config');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const documentParser = require('../services/documentParser');
const chunkService = require('../services/chunkService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tag(jobId, sourceFileId, documentId) {
  const parts = [`srcFile=${sourceFileId}`];
  if (jobId) parts.push(`jobId=${jobId}`);
  if (documentId) parts.push(`docId=${documentId}`);
  return parts.join(' | ');
}

/**
 * Races a promise against a timeout. Throws with a clear message if the
 * timeout fires first so the existing catch block can write error_message.
 */
function withTimeout(ms, label, promise) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(
      () => reject(new Error(`[ingest] TIMEOUT: ${label} did not complete within ${ms / 1000}s`)),
      ms
    );
    promise.then(
      (v) => { clearTimeout(id); resolve(v); },
      (e) => { clearTimeout(id); reject(e); }
    );
  });
}

// ---------------------------------------------------------------------------
// Function 1: knowledge/document.ingest
//
// Full ingest pipeline for a single document. Idempotent: re-running with
// the same content hash is a no-op unless forceReindex is set.
// ---------------------------------------------------------------------------

const ingestDocument = inngest.createFunction(
  {
    id: 'knowledge-document-ingest',
    name: 'Ingest Knowledge Document',
    concurrency: { limit: 2, key: 'event.data.clientId' },
    retries: 3,
    onFailure: async ({ event, error }) => {
      // Backup log — primary error logging is handled via try/catch inside the function
      console.error('[ingest] onFailure', { error: error.message });
    },
  },
  { event: 'knowledge/document.ingest' },
  async ({ event, step }) => {
    const {
      clientId,
      sourceProvider = 'portal_upload',
      sourceFileId,
      fileName,
      mimeType,
      forceReindex = false,
      storagePath,
    } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (!sourceFileId) throw new Error('sourceFileId is required');
    if (!fileName) throw new Error('fileName is required');
    if (!mimeType) throw new Error('mimeType is required');
    if (!storagePath) throw new Error('storagePath is required');
    if (sourceProvider !== 'portal_upload') {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload only.');
    }

    let jobId = null;
    let documentId = null;

    // -- Step 1: Create ingestion job record ----------------------------------
    const job = await step.run('create-job', async () => {
      return supabaseService.createIngestionJob(clientId, sourceFileId);
    });
    jobId = job.id;

    try {
      // -- Step 2: Check for existing document (dedup) ------------------------
      console.log(`[ingest] START check-existing | ${tag(jobId, sourceFileId, documentId)}`);
      const t2 = Date.now();
      const existing = await step.run('check-existing', async () => {
        return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
      });
      console.log(`[ingest] END   check-existing | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t2}ms | found=${!!existing}`);

      // -- Step 3: Mark job running -------------------------------------------
      console.log(`[ingest] START update-job-running | ${tag(jobId, sourceFileId, documentId)}`);
      const t3 = Date.now();
      await step.run('update-job-running', async () => {
        await supabaseService.updateIngestionJob(job.id, { status: 'running' });
      });
      console.log(`[ingest] END   update-job-running | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t3}ms`);

      // -- Step 4: Fetch document from Supabase Storage -----------------------
      console.log(`[ingest] START fetch-document | ${tag(jobId, sourceFileId, documentId)} | storagePath=${storagePath}`);
      const t4 = Date.now();
      const { buffer, resolvedMimeType } = await step.run('fetch-document', async () => {
        const result = await withTimeout(
          30_000,
          'fetch-document / downloadFromStorage',
          supabaseService.downloadFromStorage(storagePath)
        );
        if (result.buffer.length > config.maxUploadBytes) {
          throw new Error(`Uploaded file exceeds max size limit of ${config.maxUploadBytes} bytes`);
        }
        const finalMime = result.resolvedMimeType || mimeType;
        // Buffer doesn't survive Inngest step serialization; convert to base64
        return { buffer: result.buffer.toString('base64'), resolvedMimeType: finalMime };
      });
      console.log(`[ingest] END   fetch-document | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t4}ms | mime=${resolvedMimeType}`);

      // -- Step 5: Parse document to plain text --------------------------------
      console.log(`[ingest] START parse-document | ${tag(jobId, sourceFileId, documentId)} | mime=${resolvedMimeType}`);
      const t5 = Date.now();
      const parsed = await step.run('parse-document', async () => {
        const buf = Buffer.from(buffer, 'base64');
        return withTimeout(
          60_000,
          'parse-document / parseDocument',
          documentParser.parseDocument(buf, resolvedMimeType, fileName)
        );
      });
      console.log(`[ingest] END   parse-document | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t5}ms`);

      const parsedText = typeof parsed === 'string' ? parsed : (parsed && parsed.text) || '';
      const parsedPages = (parsed && typeof parsed === 'object' && parsed.pages) || null;

      console.log(`[ingest] parsed text length=${parsedText.length} | pages=${parsedPages ? parsedPages.length : 'n/a'} | ${tag(jobId, sourceFileId, documentId)}`);

      if (!parsedText || !parsedText.trim()) throw new Error('Parsed document produced no text');

      // -- Step 6: Compute content hash ----------------------------------------
      console.log(`[ingest] START compute-hash | ${tag(jobId, sourceFileId, documentId)}`);
      const t6 = Date.now();
      const contentHash = await step.run('compute-hash', async () => {
        return crypto.createHash('sha256').update(parsedText).digest('hex');
      });
      console.log(`[ingest] END   compute-hash | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t6}ms | hash=${contentHash.slice(0, 12)}...`);

      // Content hash dedup
      if (existing && existing.content_hash === contentHash && !forceReindex) {
        console.log(`[ingest] SKIP unchanged hash | ${tag(jobId, sourceFileId, documentId)}`);
        await step.run('skip-unchanged-by-hash', async () => {
          await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId: existing.id });
        });
        return { skipped: true, reason: 'content hash unchanged', documentId: existing.id };
      }

      // -- Step 6b: Cross-file duplicate content check (same client, skipped on forceReindex) --
      if (!forceReindex) {
        console.log(`[ingest] START check-content-duplicate | ${tag(jobId, sourceFileId, documentId)}`);
        const t6b = Date.now();
        const contentDuplicate = await step.run('check-content-duplicate', async () => {
          return supabaseService.getIndexedDocumentByContentHash(
            clientId, sourceProvider, contentHash, sourceFileId
          );
        });
        console.log(`[ingest] END   check-content-duplicate | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t6b}ms | duplicate=${!!contentDuplicate}`);
        if (contentDuplicate) {
          console.log(`[ingest] SKIP duplicate content | ${tag(jobId, sourceFileId, documentId)}`);
          await step.run('skip-duplicate-content', async () => {
            await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId: contentDuplicate.id });
          });
          return { skipped: true, reason: 'duplicate content', duplicateOfDocumentId: contentDuplicate.id };
        }
      }

      // -- Step 7: Upsert document record --------------------------------------
      console.log(`[ingest] START upsert-document | ${tag(jobId, sourceFileId, documentId)}`);
      const t7 = Date.now();
      const doc = await step.run('upsert-document', async () => {
        return supabaseService.upsertKnowledgeDocument(
          clientId,
          sourceProvider,
          sourceFileId,
          fileName,
          resolvedMimeType,
          contentHash,
          storagePath || undefined
        );
      });
      documentId = doc.id;
      console.log(`[ingest] END   upsert-document | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t7}ms`);

      // -- Step 8: Delete old chunks (clean slate for re-index) ----------------
      console.log(`[ingest] START delete-old-chunks | ${tag(jobId, sourceFileId, documentId)}`);
      const t8 = Date.now();
      await step.run('delete-old-chunks', async () => {
        await supabaseService.deleteChunksForDocument(documentId);
      });
      console.log(`[ingest] END   delete-old-chunks | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t8}ms`);

      // -- Step 9: Split text into chunks --------------------------------------
      console.log(`[ingest] START chunk-text | ${tag(jobId, sourceFileId, documentId)}`);
      const t9 = Date.now();
      const chunks = await step.run('chunk-text', async () => {
        const baseMetadata = { clientId, fileName, sourceProvider, sourceFileId };
        if (parsedPages && parsedPages.length > 0) {
          const allChunks = [];
          let globalIndex = 0;
          for (const page of parsedPages) {
            if (!page.text || !page.text.trim()) continue;
            const pageChunks = chunkService.chunkText(page.text, {
              ...baseMetadata,
              pageNumber: page.pageNumber,
            });
            for (const c of pageChunks) {
              allChunks.push({ ...c, chunkIndex: globalIndex++ });
            }
          }
          if (allChunks.length) return allChunks;
        }
        return chunkService.chunkText(parsedText, baseMetadata);
      });
      console.log(`[ingest] END   chunk-text | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t9}ms | chunkCount=${chunks.length}`);

      if (!chunks.length) throw new Error('Document produced zero chunks');

      // -- Step 10: Generate embeddings ----------------------------------------
      console.log(`[ingest] START generate-embeddings | ${tag(jobId, sourceFileId, documentId)} | chunkCount=${chunks.length}`);
      const t10 = Date.now();
      const embeddings = await step.run('generate-embeddings', async () => {
        return withTimeout(
          90_000,
          'generate-embeddings / generateEmbeddings',
          openaiService.generateEmbeddings(chunks.map((c) => c.content))
        );
      });
      console.log(`[ingest] END   generate-embeddings | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t10}ms | embeddingCount=${embeddings.length}`);

      // -- Step 11: Insert chunks with embeddings into Supabase ----------------
      console.log(`[ingest] START upsert-chunks | ${tag(jobId, sourceFileId, documentId)} | chunkCount=${chunks.length}`);
      const t11 = Date.now();
      await step.run('upsert-chunks', async () => {
        const rows = chunks.map((chunk, i) => ({
          document_id: documentId,
          client_id: clientId,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          embedding: embeddings[i],
          metadata: chunk.metadata,
        }));
        await supabaseService.insertKnowledgeChunks(rows);
      });
      console.log(`[ingest] END   upsert-chunks | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t11}ms`);

      // -- Step 12: Mark document indexed --------------------------------------
      console.log(`[ingest] START mark-indexed | ${tag(jobId, sourceFileId, documentId)}`);
      const t12 = Date.now();
      await step.run('mark-indexed', async () => {
        await supabaseService.markDocumentIndexed(documentId);
      });
      console.log(`[ingest] END   mark-indexed | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t12}ms`);

      // -- Step 13: Complete job -----------------------------------------------
      console.log(`[ingest] START complete-job | ${tag(jobId, sourceFileId, documentId)}`);
      const t13 = Date.now();
      await step.run('complete-job', async () => {
        await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId });
      });
      console.log(`[ingest] END   complete-job | ${tag(jobId, sourceFileId, documentId)} | elapsed=${Date.now() - t13}ms`);

      return { success: true, documentId, chunkCount: chunks.length };
    } catch (err) {
      console.error(`[ingest] ERROR | ${tag(jobId, sourceFileId, documentId)} | ${err.message}`);
      if (jobId) await supabaseService.logIngestionError(jobId, documentId || null, err);
      if (documentId) {
        await supabaseService.markDocumentError(documentId, err.message).catch((dbErr) => {
          console.error('[ingest] markDocumentError failed:', dbErr.message);
        });
      }
      throw err;
    }
  }
);

// ---------------------------------------------------------------------------
// Function 2: knowledge/document.delete
//
// Mark a document as deleted and remove its chunks from the vector store.
// Lookup can be by documentId OR (sourceProvider + sourceFileId).
// ---------------------------------------------------------------------------

const deleteDocument = inngest.createFunction(
  {
    id: 'knowledge-document-delete',
    name: 'Delete Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.delete' },
  async ({ event, step }) => {
    const { clientId, documentId: inputDocumentId, sourceFileId, sourceProvider = 'portal_upload' } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (sourceProvider !== 'portal_upload') {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload only.');
    }

    // -- Step 1: Find document ------------------------------------------------
    const doc = await step.run('find-document', async () => {
      if (inputDocumentId) {
        const found = await supabaseService.getKnowledgeDocumentById(inputDocumentId);
        if (found && found.client_id !== clientId) {
          throw new Error('Document does not belong to client');
        }
        return found;
      }
      return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
    });

    if (!doc) {
      return { skipped: true, reason: 'document not found' };
    }

    // -- Step 2: Delete chunks ------------------------------------------------
    await step.run('delete-chunks', async () => {
      await supabaseService.deleteChunksForDocument(doc.id);
    });

    // -- Step 3: Mark document deleted ----------------------------------------
    await step.run('mark-deleted', async () => {
      await supabaseService.markDocumentDeleted(doc.id);
    });

    // -- Step 4 (optional): Remove file from Supabase Storage -----------------
    if (doc.storage_path) {
      await step.run('delete-storage-file', async () => {
        await supabaseService.deleteFromStorage(doc.storage_path);
      });
    }

    return { success: true, documentId: doc.id };
  }
);

// ---------------------------------------------------------------------------
// Function 3: knowledge/document.reindex
//
// Force re-ingest of a specific document regardless of content hash.
// Emits knowledge/document.ingest with forceReindex: true.
// ---------------------------------------------------------------------------

const reindexDocument = inngest.createFunction(
  {
    id: 'knowledge-document-reindex',
    name: 'Reindex Knowledge Document',
    retries: 3,
  },
  { event: 'knowledge/document.reindex' },
  async ({ event, step }) => {
    const {
      clientId, sourceFileId, sourceProvider = 'portal_upload',
      fileName, mimeType, storagePath,
    } = event.data;

    if (!clientId) throw new Error('clientId is required');
    if (!sourceFileId) throw new Error('sourceFileId is required');
    if (sourceProvider !== 'portal_upload') {
      throw new Error('Unsupported sourceProvider. This backend currently supports portal_upload only.');
    }

    const fileMeta = await step.run('validate-file-metadata', async () => {
      if (!fileName || !mimeType || !storagePath) {
        throw new Error('reindex requires fileName, mimeType, and storagePath');
      }
      return { name: fileName, mimeType };
    });

    await step.sendEvent('trigger-ingest', {
      name: 'knowledge/document.ingest',
      data: {
        clientId,
        sourceProvider: 'portal_upload',
        sourceFileId,
        fileName: fileMeta.name,
        mimeType: fileMeta.mimeType,
        forceReindex: true,
        storagePath,
      },
    });

    return { triggered: true, sourceFileId };
  }
);

const functions = [ingestDocument, deleteDocument, reindexDocument];

module.exports = { functions, ingestDocument, deleteDocument, reindexDocument };
