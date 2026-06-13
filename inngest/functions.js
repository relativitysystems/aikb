'use strict';

const crypto = require('crypto');
const { inngest } = require('./client');
const config = require('../config');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const documentParser = require('../services/documentParser');
const chunkService = require('../services/chunkService');

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
      const existing = await step.run('check-existing', async () => {
        return supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
      });

      // -- Step 3: Mark job running -------------------------------------------
      await step.run('update-job-running', async () => {
        await supabaseService.updateIngestionJob(job.id, { status: 'running' });
      });

      // -- Step 4: Fetch document from Supabase Storage -----------------------
      const { buffer, resolvedMimeType } = await step.run('fetch-document', async () => {
        const result = await supabaseService.downloadFromStorage(storagePath);
        const finalMime = result.resolvedMimeType || mimeType;
        // Buffer doesn't survive Inngest step serialization; convert to base64
        return { buffer: result.buffer.toString('base64'), resolvedMimeType: finalMime };
      });

      // -- Step 5: Parse document to plain text --------------------------------
      const rawText = await step.run('parse-document', async () => {
        const buf = Buffer.from(buffer, 'base64');
        return documentParser.parseDocument(buf, resolvedMimeType, fileName);
      });

      if (!rawText || !rawText.trim()) throw new Error('Parsed document produced no text');

      // -- Step 6: Compute content hash ----------------------------------------
      const contentHash = await step.run('compute-hash', async () => {
        return crypto.createHash('sha256').update(rawText).digest('hex');
      });

      // Content hash dedup
      if (existing && existing.content_hash === contentHash && !forceReindex) {
        await step.run('skip-unchanged-by-hash', async () => {
          await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId: existing.id });
        });
        return { skipped: true, reason: 'content hash unchanged', documentId: existing.id };
      }

      // -- Step 7: Upsert document record --------------------------------------
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

      // -- Step 8: Delete old chunks (clean slate for re-index) ----------------
      await step.run('delete-old-chunks', async () => {
        await supabaseService.deleteChunksForDocument(documentId);
      });

      // -- Step 9: Split text into chunks --------------------------------------
      const chunks = await step.run('chunk-text', async () => {
        return chunkService.chunkText(rawText, {
          clientId,
          fileName,
          sourceProvider,
          sourceFileId,
        });
      });

      if (!chunks.length) throw new Error('Document produced zero chunks');

      // -- Step 10: Generate embeddings ----------------------------------------
      const embeddings = await step.run('generate-embeddings', async () => {
        return openaiService.generateEmbeddings(chunks.map((c) => c.content));
      });

      // -- Step 11: Insert chunks with embeddings into Supabase ----------------
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

      // -- Step 12: Mark document indexed --------------------------------------
      await step.run('mark-indexed', async () => {
        await supabaseService.markDocumentIndexed(documentId);
      });

      // -- Step 13: Complete job -----------------------------------------------
      await step.run('complete-job', async () => {
        await supabaseService.updateIngestionJob(job.id, { status: 'completed', documentId });
      });

      return { success: true, documentId, chunkCount: chunks.length };
    } catch (err) {
      if (jobId) await supabaseService.logIngestionError(jobId, documentId || null, err);
      if (documentId) await supabaseService.markDocumentError(documentId, err.message);
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

    const fileMeta = await step.run('fetch-file-metadata', async () => {
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
