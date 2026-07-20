'use strict';

const crypto = require('crypto');
const express = require('express');
const { inngest } = require('../inngest/client');
const supabaseService = require('../services/supabaseService');
const config = require('../config');
const { requireMemberContext } = require('../middleware/resolveContext');
const { requireServiceRequest } = require('../middleware/serviceRequest');
const { runKnowledgeQuery, isAdminRole } = require('../services/runKnowledgeQuery');

const router = express.Router();

// ---------------------------------------------------------------------------
// API key middleware
// ---------------------------------------------------------------------------

function requireApiKey(req, res, next) {
  if (!config.apiKey) {
    // No API key configured — allow in development, block in production
    if (config.server.nodeEnv === 'production') {
      return res.status(500).json({ error: 'API_KEY is not configured on this server' });
    }
    return next();
  }
  const provided = req.headers['x-api-key'];
  if (!provided || typeof provided !== 'string') {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(config.apiKey, 'utf8');
  const safeEqual = providedBuf.length === expectedBuf.length
    && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!safeEqual) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

router.use(requireApiKey);

// Sanitizes error_message field values on job records for production responses.
// Long messages or messages containing newlines likely contain internal details.
function sanitizeJobError(msg) {
  if (!msg) return msg;
  if (config.server.nodeEnv !== 'production') return msg;
  if (msg.includes('\n') || msg.length > 300) return 'Ingestion failed. Contact your administrator.';
  return msg;
}

// ---------------------------------------------------------------------------
// POST /api/knowledge/ingest
// Trigger ingestion of a single document (portal upload only).
// Backlog H4: requireServiceRequest ADDITIVE to the router-level
// requireApiKey above — clientId/idempotencyKey come ONLY from the verified
// envelope (req.serviceRequest), never from the request body directly. The
// HMAC signature binds this exact clientId, so a leaked shared x-api-key
// alone can no longer be used to act on an arbitrary client through this
// route — see middleware/serviceRequest.js and POST /ask above for the
// established pattern this mirrors.
// Payload (req.servicePayload): { sourceFileId, fileName, mimeType, storagePath, sourceProvider? }
// ---------------------------------------------------------------------------

router.post('/ingest', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const {
      sourceFileId, fileName, mimeType,
      sourceProvider = 'portal_upload',
      storagePath,
    } = req.servicePayload || {};

    if (!sourceFileId || !fileName || !mimeType) {
      return res.status(400).json({ error: 'sourceFileId, fileName, and mimeType are required' });
    }
    if (sourceProvider !== 'portal_upload') {
      return res.status(400).json({ error: 'Unsupported sourceProvider. This backend currently supports portal_upload only.' });
    }
    if (!storagePath) {
      return res.status(400).json({ error: 'storagePath is required' });
    }

    await supabaseService.requireActiveClient(clientId);

    const event = await inngest.send({
      name: 'knowledge/document.ingest',
      data: { clientId, sourceProvider, sourceFileId, fileName, mimeType, storagePath },
    });

    res.json({ queued: true, eventId: event.ids?.[0] || event.id || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/reindex
// Force re-ingest a document regardless of content hash.
// Backlog H4 — see the note on POST /ingest above; same pattern.
// Payload (req.servicePayload): { sourceFileId, fileName, mimeType, storagePath, sourceProvider? }
// ---------------------------------------------------------------------------

router.post('/reindex', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const {
      sourceFileId,
      sourceProvider = 'portal_upload',
      fileName,
      mimeType,
      storagePath,
    } = req.servicePayload || {};

    if (!sourceFileId) {
      return res.status(400).json({ error: 'sourceFileId is required' });
    }
    if (sourceProvider !== 'portal_upload') {
      return res.status(400).json({ error: 'Unsupported sourceProvider. This backend currently supports portal_upload only.' });
    }
    if (!fileName || !mimeType || !storagePath) {
      return res.status(400).json({
        error: 'fileName, mimeType, and storagePath are required',
      });
    }

    await supabaseService.requireActiveClient(clientId);

    const event = await inngest.send({
      name: 'knowledge/document.reindex',
      data: { clientId, sourceProvider, sourceFileId, fileName, mimeType, storagePath },
    });

    res.json({ queued: true, eventId: event.ids?.[0] || event.id || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/knowledge/document/:id
// Mark a document as deleted and remove its chunks.
// Backlog H4 — see the note on POST /ingest above; same pattern.
// :id can be either the DB document UUID or 'by-source' for source-based lookup
// Payload (req.servicePayload): { sourceFileId?, sourceProvider? }
// ---------------------------------------------------------------------------

router.delete('/document/:id', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const documentId = req.params.id !== 'by-source' ? req.params.id : undefined;
    const { sourceFileId, sourceProvider = 'portal_upload' } = req.servicePayload || {};

    if (!documentId && !sourceFileId) {
      return res.status(400).json({ error: 'Provide either a document UUID as :id or sourceFileId in the payload' });
    }
    if (sourceProvider !== 'portal_upload') {
      return res.status(400).json({ error: 'Unsupported sourceProvider. This backend currently supports portal_upload only.' });
    }

    await supabaseService.requireActiveClient(clientId);

    if (documentId) {
      const doc = await supabaseService.getKnowledgeDocumentById(documentId);
      if (!doc) return res.status(404).json({ error: 'Document not found.' });
      if (doc.client_id !== clientId) return res.status(403).json({ error: 'Access denied.' });
    }

    const event = await inngest.send({
      name: 'knowledge/document.delete',
      data: { clientId, documentId, sourceFileId, sourceProvider },
    });

    res.json({ queued: true, eventId: event.ids?.[0] || event.id || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/knowledge/client/:clientId
// Internal cleanup: hard-deletes ALL AIKB data for a client (storage objects,
// documents, chunks, chat history, gaps, ingestion jobs). Called by
// Relativity's client-deletion flow BEFORE the Global client row is removed.
// Deliberately does NOT call requireActiveClient — this endpoint must work
// even after the Global client record is gone.
// Backlog H4: requireServiceRequest added — unlike requireActiveClient, it
// never touches the database (pure HMAC check), so it stays compatible with
// working after the Global client record is gone. clientId is trusted ONLY
// from the verified envelope (req.serviceRequest), never the URL param; the
// param is kept for REST addressability/logging and cross-checked below.
// ---------------------------------------------------------------------------

router.delete('/client/:clientId', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return res.status(400).json({ error: 'clientId must be a valid UUID' });
    }
    if (req.params.clientId !== clientId) {
      return res.status(400).json({ error: 'URL clientId does not match the signed envelope.' });
    }
    const summary = await supabaseService.deleteAllClientData(clientId);
    res.json({ success: summary.errors.length === 0, clientId, ...summary });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/documents/:clientId
// List all indexed documents for a client.
// Backlog H4 — see the note on POST /ingest above; same pattern, applied to
// a GET route. The signed envelope is sent as a JSON body on this GET
// request (unusual but valid HTTP — express.json() parses req.body
// regardless of verb, and this is a direct server-to-server axios call, not
// routed through any cache/proxy that would strip it). clientId is trusted
// ONLY from req.serviceRequest; the URL param is kept for REST
// addressability/logging and cross-checked below.
// ---------------------------------------------------------------------------

router.get('/documents/:clientId', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    if (req.params.clientId !== clientId) {
      return res.status(400).json({ error: 'URL clientId does not match the signed envelope.' });
    }
    await supabaseService.requireActiveClient(clientId);
    const docs = await supabaseService.getDocumentsByClient(clientId);
    res.json({ documents: docs });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Knowledge collections (Milestone 5)
//
// Organization-wide (client_id-scoped), not member-scoped. Backlog H4:
// requireServiceRequest added to every route below — see the note on
// POST /ingest above for the pattern (and on GET /documents/:clientId for
// the GET-with-signed-body variant used by the one GET route here).
// ---------------------------------------------------------------------------

// GET /api/knowledge/collections/:clientId
router.get('/collections/:clientId', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    if (req.params.clientId !== clientId) {
      return res.status(400).json({ error: 'URL clientId does not match the signed envelope.' });
    }
    await supabaseService.requireActiveClient(clientId);
    const collections = await supabaseService.listCollectionsWithCounts(clientId);
    res.json({ collections });
  } catch (err) {
    next(err);
  }
});

// POST /api/knowledge/collections
// Payload (req.servicePayload): { name }
router.post('/collections', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const { name } = req.servicePayload || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (trimmed.length > 100) {
      return res.status(400).json({ error: 'name must be 100 characters or fewer' });
    }
    await supabaseService.requireActiveClient(clientId);
    const collection = await supabaseService.createCollection(clientId, trimmed);
    res.status(201).json({ collection });
  } catch (err) {
    if (err.code === 'DUPLICATE_NAME') {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// PATCH /api/knowledge/collections/:id
// Payload (req.servicePayload): { name }
router.patch('/collections/:id', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const { name } = req.servicePayload || {};
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (trimmed.length > 100) {
      return res.status(400).json({ error: 'name must be 100 characters or fewer' });
    }
    await supabaseService.requireActiveClient(clientId);

    const collection = await supabaseService.getCollectionById(req.params.id);
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });
    if (collection.client_id !== clientId) return res.status(403).json({ error: 'Access denied.' });

    const updated = await supabaseService.renameCollection(req.params.id, trimmed);
    res.json({ collection: updated });
  } catch (err) {
    if (err.code === 'DUPLICATE_NAME') {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// DELETE /api/knowledge/collections/:id
// Refuses to delete the default ("General") collection, and refuses to
// delete a non-empty collection (defense in depth: the FK is also
// ON DELETE RESTRICT at the DB level — see migrations/006).
router.delete('/collections/:id', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    await supabaseService.requireActiveClient(clientId);

    const collection = await supabaseService.getCollectionById(req.params.id);
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });
    if (collection.client_id !== clientId) return res.status(403).json({ error: 'Access denied.' });
    if (collection.is_default) {
      return res.status(400).json({ error: 'The default collection cannot be deleted.' });
    }

    const withCounts = await supabaseService.listCollectionsWithCounts(clientId);
    const match = withCounts.find((c) => c.id === req.params.id);
    if (match && match.documentCount > 0) {
      return res.status(409).json({ error: 'Collection is not empty.' });
    }

    await supabaseService.deleteCollection(req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'NOT_EMPTY') {
      return res.status(409).json({ error: err.message });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/knowledge/document/:id/collection
// Move a document to a different collection.
// Backlog H4 — see the note on POST /ingest above; same pattern.
// :id can be either the DB document UUID or 'by-source' for source-based lookup.
// Payload (req.servicePayload): { collectionId, sourceFileId?, sourceProvider? }
// ---------------------------------------------------------------------------

router.patch('/document/:id/collection', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId } = req.serviceRequest;
    const documentId = req.params.id !== 'by-source' ? req.params.id : undefined;
    const { collectionId, sourceFileId, sourceProvider = 'portal_upload' } = req.servicePayload || {};

    if (!collectionId) {
      return res.status(400).json({ error: 'collectionId is required' });
    }
    if (!documentId && !sourceFileId) {
      return res.status(400).json({ error: 'Provide either a document UUID as :id or sourceFileId in the payload' });
    }

    await supabaseService.requireActiveClient(clientId);

    const doc = documentId
      ? await supabaseService.getKnowledgeDocumentById(documentId)
      : await supabaseService.getKnowledgeDocumentBySourceId(clientId, sourceProvider, sourceFileId);
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.client_id !== clientId) return res.status(403).json({ error: 'Access denied.' });

    const collection = await supabaseService.getCollectionById(collectionId);
    if (!collection) return res.status(404).json({ error: 'Collection not found.' });
    if (collection.client_id !== clientId) return res.status(403).json({ error: 'Access denied.' });

    const updated = await supabaseService.moveDocumentCollection(doc.id, collectionId);
    res.json({ document: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/jobs/:clientId
// List recent ingestion jobs for a client.
// ---------------------------------------------------------------------------

router.get('/jobs/:clientId', async (req, res, next) => {
  try {
    await supabaseService.requireActiveClient(req.params.clientId);
    const jobs = await supabaseService.getIngestionJobsByClient(req.params.clientId);
    res.json({ jobs: jobs.map((j) => ({ ...j, error_message: sanitizeJobError(j.error_message) })) });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/summary/:clientId
// Returns aggregated document, chunk, job, and chat statistics for a client.
// ---------------------------------------------------------------------------

router.get('/summary/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const summary = await supabaseService.getClientSummaryData(clientId);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/analytics/:clientId
// Returns question counts, knowledge gaps, and ingestion activity for a client.
// ---------------------------------------------------------------------------

router.get('/analytics/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const analytics = await supabaseService.getClientAnalyticsData(clientId);
    res.json(analytics);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/stats/:clientId
//
// Superset of /summary + /analytics + /jobs for a single client — backlog
// L5. Added for callers (e.g. Relativity's admin dashboard) that previously
// fetched all three separately for the same client on every request; each
// underlying table is queried exactly once here instead of up to 4x across
// three round trips. /summary, /analytics, and /jobs are unchanged and still
// used independently elsewhere (e.g. the client portal calls /analytics
// alone), so this is additive, not a replacement.
// ---------------------------------------------------------------------------

router.get('/stats/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const stats = await supabaseService.getClientKnowledgeStats(clientId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/query
// Synchronous RAG query: vector search + LLM answer.
// Body: { clientId, question, sessionId? }
// Recent session context is loaded server-side (see listRecentChatMessages)
// rather than trusted from the request body, so follow-up questions can be
// classified/retrieved using the actual prior conversation.
// Returns: { answer, sources, sessionId }
//
// The actual pipeline (session resolution, intent classification, retrieval,
// generation, gap detection, message persistence) lives in
// services/runKnowledgeQuery.js (Architecture Review Phase 4, Milestone 4,
// §4.9) so it can be shared, unmodified, with POST /ask below. This route
// is now a thin origin: 'portal' adapter around that shared function — its
// request/response shape and behavior are unchanged from before the
// refactor.
// ---------------------------------------------------------------------------

router.post('/query', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, question, sessionId: providedSessionId, allowedCollectionIds } = req.body;
    if (!clientId || !question) {
      return res.status(400).json({ error: 'clientId and question are required' });
    }

    await supabaseService.requireActiveClient(clientId);

    const { memberId, memberRole } = req.context;

    const result = await runKnowledgeQuery({
      clientId,
      question,
      sessionId: providedSessionId,
      memberId,
      memberRole,
      origin: 'portal',
      // Omitted (undefined/null) => no restriction, searches every
      // collection — this is the portal's unchanged default behavior. Only
      // an explicit array restricts retrieval.
      allowedCollectionIds: Array.isArray(allowedCollectionIds) ? allowedCollectionIds : null,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/ask
// Architecture Review Phase 4, Milestone 4 (§4.8-§4.10). The fast
// accept-and-enqueue leg of the Slack Q&A flow — called synchronously by
// Relativity's POST /api/integrations/slack/events handler, before it acks
// Slack. Sits behind BOTH the existing router-level requireApiKey (line 36,
// unchanged) AND requireServiceRequest (the additive HMAC envelope, §4.10) —
// clientId/idempotencyKey come ONLY from the verified envelope
// (req.serviceRequest), never from the request body directly.
//
// Does NOT compute the answer inline — it only enqueues
// knowledge/slack.question.requested onto the existing Inngest pipeline
// (inngest/functions.js) and returns immediately, so this stays fast enough
// for Relativity's own Slack-ack budget.
//
// Never receives or forwards a Slack token/secret — only clientId, the
// already-extracted question, and narrow origin metadata (§4.9).
// ---------------------------------------------------------------------------

router.post('/ask', requireServiceRequest, async (req, res, next) => {
  try {
    const { clientId, idempotencyKey } = req.serviceRequest;
    const { question, originMetadata, allowedCollectionIds } = req.servicePayload || {};

    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question is required' });
    }

    await supabaseService.requireActiveClient(clientId);

    const event = await inngest.send({
      name: 'knowledge/slack.question.requested',
      data: {
        clientId,
        question,
        idempotencyKey,
        originMetadata: originMetadata && typeof originMetadata === 'object' ? originMetadata : null,
        // Fail-closed: anything other than an explicit array (missing,
        // malformed, wrong type) is treated as "zero allowed collections",
        // never as "no restriction" — see match_knowledge_chunks in
        // migrations/006_knowledge_collections.sql for why an empty array
        // is safe (it matches nothing, not everything).
        allowedCollectionIds: Array.isArray(allowedCollectionIds) ? allowedCollectionIds : [],
      },
    });

    res.json({ accepted: true, eventId: event.ids?.[0] || event.id || null });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/chat/sessions/:clientId
// List all non-deleted sessions for a client (newest first).
// ---------------------------------------------------------------------------

router.get('/chat/sessions/:clientId', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);
    const sessions = await supabaseService.listChatSessions(clientId, memberId, isAdmin);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/chat/sessions/:clientId/:sessionId/messages
// Return all non-deleted messages for a session, ordered oldest-first.
// ---------------------------------------------------------------------------

router.get('/chat/sessions/:clientId/:sessionId/messages', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);
    const session = await supabaseService.getChatSession(clientId, sessionId, memberId, isAdmin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const messages = await supabaseService.listChatMessages(clientId, sessionId);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/knowledge/chat/sessions/:clientId/:sessionId
// Soft-delete a single session and all its messages.
// ---------------------------------------------------------------------------

router.delete('/chat/sessions/:clientId/:sessionId', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);
    const session = await supabaseService.getChatSession(clientId, sessionId, memberId, isAdmin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await supabaseService.softDeleteChatSession(clientId, sessionId, memberId, isAdmin);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/knowledge/chat/history/:clientId
// Soft-delete all sessions and messages for a client.
// ---------------------------------------------------------------------------

router.delete('/chat/history/:clientId', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);
    await supabaseService.softDeleteAllChatHistory(clientId, memberId, isAdmin);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/knowledge/chat/sessions/:clientId/:sessionId/title
// Rename a session.
// Body: { title }
// ---------------------------------------------------------------------------

router.patch('/chat/sessions/:clientId/:sessionId/title', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    await supabaseService.requireActiveClient(clientId);
    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);
    const session = await supabaseService.getChatSession(clientId, sessionId, memberId, isAdmin);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const updated = await supabaseService.updateChatSessionTitle(clientId, sessionId, title, memberId, isAdmin);
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/chat/redact
// ADR-007 (Relativity's Architecture repo,
// decisions/ADR-007-SLACK-BOUNDED-DELIVERY-RETRY.md). Called by Relativity
// once a Slack event reaches the terminal delivery_failed state, to redact
// this idempotency key's chat session content on the AIKB side (title,
// message content/sources/metadata). Same auth model as POST /ask —
// requireServiceRequest ADDITIVE to the router-level requireApiKey above —
// clientId/idempotencyKey come ONLY from the verified envelope, never the
// request body. No payload fields are read; the envelope alone identifies
// what to redact. Idempotent: redacting an already-redacted or
// never-created session is a safe no-op (redacted: false).
// ---------------------------------------------------------------------------

router.post('/chat/redact', requireServiceRequest, async (req, res, next) => {
  try {
    // requireServiceRequest (middleware/serviceRequest.js) already rejects
    // any envelope missing idempotencyKey (or clientId) with 401 before
    // req.serviceRequest is ever set — no redundant presence check needed here.
    const { clientId, idempotencyKey } = req.serviceRequest;
    const result = await supabaseService.redactChatSessionByIdempotencyKey(clientId, idempotencyKey);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/gaps
// Explicit save of a knowledge gap — called by the portal when the user
// chooses to save. The query endpoint no longer writes gaps automatically.
// Body: { clientId, sessionId, question, reason, messageId? }
// Returns: { success: true, gap }
// ---------------------------------------------------------------------------

router.post('/gaps', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, sessionId, question, reason, messageId } = req.body;
    if (!clientId || !sessionId || !question || !reason) {
      return res.status(400).json({ error: 'clientId, sessionId, question, and reason are required' });
    }
    await supabaseService.requireActiveClient(clientId);
    const { memberId } = req.context;
    const gap = await supabaseService.createKnowledgeGap({
      clientId,
      sessionId,
      messageId: messageId || null,
      question,
      reason,
      memberId,
    });
    res.json({ success: true, gap });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
