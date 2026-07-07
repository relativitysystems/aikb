'use strict';

const express = require('express');
const { inngest } = require('../inngest/client');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const config = require('../config');
const { requireMemberContext } = require('../middleware/resolveContext');

const router = express.Router();

// Returns true for roles that can see/manage all sessions under a client.
function isAdminRole(role) {
  return role === 'owner' || role === 'admin';
}

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
  if (!provided || provided !== config.apiKey) {
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
// Body: { clientId, sourceFileId, fileName, mimeType, storagePath, sourceProvider? }
// ---------------------------------------------------------------------------

router.post('/ingest', async (req, res, next) => {
  try {
    const {
      clientId, sourceFileId, fileName, mimeType,
      sourceProvider = 'portal_upload',
      storagePath,
    } = req.body;

    if (!clientId || !sourceFileId || !fileName || !mimeType) {
      return res.status(400).json({ error: 'clientId, sourceFileId, fileName, and mimeType are required' });
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
// Body: { clientId, sourceFileId, fileName, mimeType, storagePath, sourceProvider? }
// ---------------------------------------------------------------------------

router.post('/reindex', async (req, res, next) => {
  try {
    const {
      clientId,
      sourceFileId,
      sourceProvider = 'portal_upload',
      fileName,
      mimeType,
      storagePath,
    } = req.body;

    if (!clientId || !sourceFileId) {
      return res.status(400).json({ error: 'clientId and sourceFileId are required' });
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
// Body or query: { clientId, sourceFileId?, sourceProvider? }
// :id can be either the DB document UUID or 'by-source' for source-based lookup
// ---------------------------------------------------------------------------

router.delete('/document/:id', async (req, res, next) => {
  try {
    const documentId = req.params.id !== 'by-source' ? req.params.id : undefined;
    const { clientId, sourceFileId, sourceProvider = 'portal_upload' } = req.body || {};

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!documentId && !sourceFileId) {
      return res.status(400).json({ error: 'Provide either a document UUID as :id or sourceFileId in the body' });
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
// even after the Global client record is gone. Protection is inherited from
// the router-level requireApiKey gate above (line 36), same as every other
// route in this file — do not add requireActiveClient here.
// ---------------------------------------------------------------------------

router.delete('/client/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) {
      return res.status(400).json({ error: 'clientId must be a valid UUID' });
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
// ---------------------------------------------------------------------------

router.get('/documents/:clientId', async (req, res, next) => {
  try {
    await supabaseService.requireActiveClient(req.params.clientId);
    const docs = await supabaseService.getDocumentsByClient(req.params.clientId);
    res.json({ documents: docs });
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
// isKnowledgeGapAnswer
// Returns true when the LLM answer indicates the question is not covered by
// the knowledge base, even though some chunks were retrieved (weak matches).
// ---------------------------------------------------------------------------

function isKnowledgeGapAnswer(answer) {
  const normalized = answer.toLowerCase();
  return [
    'not documented in',
    'not found in',
    'couldn\'t find',
    'could not find',
    'no information in',
    'not in the knowledge base',
    'not available in the knowledge base',
    'not provided in the documentation',
    'there is no information',
  ].some((phrase) => normalized.includes(phrase));
}

// Replaces any "Source: <filename>" line with "Source: N/A".
// If no Source line exists, appends one so the response format stays consistent.
function normalizeGapAnswerSource(answer) {
  if (/^Source\s*:/im.test(answer)) {
    return answer.replace(/^Source\s*:\s*.*$/gim, 'Source: N/A');
  }
  return `${answer}\n\nSource: N/A`;
}

// ---------------------------------------------------------------------------
// POST /api/knowledge/query
// Synchronous RAG query: vector search + LLM answer.
// Body: { clientId, question, sessionId? }
// Recent session context is loaded server-side (see listRecentChatMessages)
// rather than trusted from the request body, so follow-up questions can be
// classified/retrieved using the actual prior conversation.
// Returns: { answer, sources, sessionId }
// ---------------------------------------------------------------------------

router.post('/query', requireMemberContext, async (req, res, next) => {
  try {
    const { clientId, question, sessionId: providedSessionId } = req.body;
    if (!clientId || !question) {
      return res.status(400).json({ error: 'clientId and question are required' });
    }

    await supabaseService.requireActiveClient(clientId);

    const { memberId, memberRole } = req.context;
    const isAdmin = isAdminRole(memberRole);

    // Resolve or create the chat session
    let sessionId;
    if (providedSessionId) {
      const session = await supabaseService.getChatSession(clientId, providedSessionId, memberId, isAdmin);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      sessionId = session.id;
    } else {
      const title = question.trim().slice(0, 50);
      const session = await supabaseService.createChatSession(clientId, title, memberId);
      sessionId = session.id;
    }

    // Save the user message before running RAG so we have its ID for knowledge gap logging
    const userMsg = await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'user',
      content: question,
      memberId,
    });

    // Load recent session history server-side (not trusted from the request body) so
    // follow-up questions can be classified/retrieved using the actual prior conversation.
    // Excludes the message just saved above and any deleted messages; capped to a small
    // window so prompts stay small.
    const recentMessages = await supabaseService.listRecentChatMessages(clientId, sessionId, 8);
    const recentSessionMessages = recentMessages
      .filter((m) => m.id !== userMsg.id)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    // Classify intent before running retrieval to avoid vector search on greetings,
    // small talk, and help requests — these can never be answered from documents.
    // Recent session messages let the classifier recognize follow-ups (e.g. "what should
    // I do first") that reference a document/topic already established in this session.
    const intent = await openaiService.classifyQueryIntent(question, recentSessionMessages);

    // The classifier has no visibility into what a client has actually uploaded — a
    // knowledge base can contain poems, technical docs, school papers, etc., not just
    // business SOPs. So a classifier verdict of "unsupported" is not trusted outright:
    // if the client has indexed documents, retrieval still runs, and we only fall back
    // to the unsupported response if retrieval genuinely finds nothing relevant.
    let runRetrieval = intent.shouldRunRetrieval;
    if (!runRetrieval && intent.intent === 'unsupported') {
      runRetrieval = await supabaseService.hasIndexedDocuments(clientId);
    }

    console.log('[query] intent classification', {
      question,
      clientId,
      sessionContextMessages: recentSessionMessages.length,
      intent: intent.intent,
      confidence: intent.confidence,
      classifierShouldRunRetrieval: intent.shouldRunRetrieval,
      retrievalSkipped: !runRetrieval,
      reason: intent.reason,
    });

    if (!runRetrieval) {
      const answer = openaiService.buildNonRetrievalAnswer(question, intent);
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: answer,
        sources: [],
        metadata: { question, retrievalQuery: null, intent, retrievalSkipped: true },
        memberId,
      });
      return res.json({
        answer,
        sources: [],
        sessionId,
        isKnowledgeGap: false,
        isConversational: intent.intent === 'casual_conversation',
        intent,
        userMessageId: userMsg.id,
      });
    }

    // Rewrite the retrieval query using session context so follow-ups (e.g. "what about
    // the checklist") search using the topic/document established earlier in the session.
    // The original user question is still what gets answered — only retrieval uses this.
    const retrievalQuery = await openaiService.buildRetrievalQuery(question, recentSessionMessages);

    // 1. Embed the (possibly rewritten) retrieval query
    const queryEmbedding = await openaiService.embedQuery(retrievalQuery);

    // 2. Retrieve relevant chunks scoped to this client. If the retrieval query references
    // a document by title/filename (e.g. "the collaborative response document"),
    // that document's chunks are guaranteed to be included and ranked first.
    const { chunks, matchedDocumentIds } = await supabaseService.searchChunksWithTitleBoost(
      clientId, queryEmbedding, retrievalQuery, { threshold: 0.15, count: 10 }
    );

    console.log('[query] retrieval summary', {
      question,
      retrievalQuery,
      intent: intent.intent,
      retrievalSkipped: false,
      titleMatchedDocumentIds: matchedDocumentIds,
      chunkCount: chunks.length,
      retrievedChunks: chunks.map((c) => ({
        documentId: c.document_id,
        fileName: c.metadata?.fileName ?? null,
        similarity: c.similarity,
        titleMatched: !!c.titleMatched,
      })),
      topScore: chunks[0]?.similarity ?? null,
      topSource: chunks[0]?.metadata?.fileName ?? null,
      topPage: chunks[0]?.metadata?.pageNumber ?? null,
    });

    if (!chunks.length) {
      const answer = normalizeGapAnswerSource('I couldn\'t find any relevant information in the knowledge base for your question.');
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: answer,
        sources: [],
        metadata: { question, retrievalQuery, intent, retrievalSkipped: false },
        memberId,
      });
      return res.json({ answer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'no_chunks_found', userMessageId: userMsg.id, intent });
    }

    // 3. Generate answer — always answers the original question, using session
    // messages only to understand context, and chunks as the sole source of facts.
    const answer = await openaiService.generateRagAnswer(question, chunks, recentSessionMessages);

    // 4. Build sources list (deduplicated by documentId, with page numbers when available)
    const sourceMap = new Map();
    for (const chunk of chunks) {
      const name = chunk.metadata && chunk.metadata.fileName ? chunk.metadata.fileName : 'unknown';
      const docId = chunk.document_id;
      if (!sourceMap.has(docId)) {
        sourceMap.set(docId, { fileName: name, documentId: docId, pages: new Set() });
      }
      if (chunk.metadata && chunk.metadata.pageNumber != null) {
        sourceMap.get(docId).pages.add(chunk.metadata.pageNumber);
      }
    }
    const sources = Array.from(sourceMap.values()).map((s) => {
      const src = { fileName: s.fileName, documentId: s.documentId };
      if (s.pages.size > 0) {
        src.pages = Array.from(s.pages).sort((a, b) => a - b);
      }
      return src;
    });

    const chunkMetadata = {
      question,
      retrievalQuery,
      chunkCount: chunks.length,
      documentIds: [...new Set(chunks.map((c) => c.document_id))],
    };
    const isGap = isKnowledgeGapAnswer(answer);

    if (isGap) {
      // The LLM indicated this question isn't covered despite chunks being retrieved
      // (weak vector match). Normalize the Source line, return no sources.
      const normalizedAnswer = normalizeGapAnswerSource(answer);
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: normalizedAnswer,
        sources: [],
        metadata: { ...chunkMetadata, intent, retrievalSkipped: false },
        memberId,
      });
      return res.json({ answer: normalizedAnswer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'answer_indicated_not_found', userMessageId: userMsg.id, intent });
    }

    // 5. Save the assistant message with real sources and chunk metadata
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: answer,
      sources,
      metadata: { ...chunkMetadata, intent, retrievalSkipped: false },
      memberId,
    });

    res.json({ answer, sources, sessionId, isKnowledgeGap: false, userMessageId: userMsg.id, intent });
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
