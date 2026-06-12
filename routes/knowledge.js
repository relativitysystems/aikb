'use strict';

const express = require('express');
const { inngest } = require('../inngest/client');
const supabaseService = require('../services/supabaseService');
const openaiService = require('../services/openaiService');
const config = require('../config');

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
  if (!provided || provided !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

router.use(requireApiKey);

// ---------------------------------------------------------------------------
// POST /api/knowledge/ingest
// Trigger ingestion of a single document (Google Drive or portal upload).
// Body: { clientId, sourceFileId, fileName, mimeType, sourceProvider?, storagePath? }
// ---------------------------------------------------------------------------

router.post('/ingest', async (req, res, next) => {
  try {
    const {
      clientId, sourceFileId, fileName, mimeType,
      sourceProvider = 'google_drive',
      storagePath,
    } = req.body;

    if (!clientId || !sourceFileId || !fileName || !mimeType) {
      return res.status(400).json({ error: 'clientId, sourceFileId, fileName, and mimeType are required' });
    }
    if (sourceProvider !== 'google_drive' && sourceProvider !== 'portal_upload') {
      return res.status(400).json({ error: 'Unsupported sourceProvider' });
    }
    if (sourceProvider === 'portal_upload' && !storagePath) {
      return res.status(400).json({ error: 'storagePath is required when sourceProvider is portal_upload' });
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
// Body: { clientId, sourceFileId, sourceProvider?, fileName?, mimeType?, storagePath? }
// ---------------------------------------------------------------------------

router.post('/reindex', async (req, res, next) => {
  try {
    const {
      clientId,
      sourceFileId,
      sourceProvider = 'google_drive',
      fileName,
      mimeType,
      storagePath,
    } = req.body;

    if (!clientId || !sourceFileId) {
      return res.status(400).json({ error: 'clientId and sourceFileId are required' });
    }
    if (sourceProvider !== 'google_drive' && sourceProvider !== 'portal_upload') {
      return res.status(400).json({ error: 'Unsupported sourceProvider' });
    }
    if (sourceProvider === 'portal_upload' && (!fileName || !mimeType || !storagePath)) {
      return res.status(400).json({
        error: 'fileName, mimeType, and storagePath are required when sourceProvider is portal_upload',
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
    const { clientId, sourceFileId, sourceProvider = 'google_drive' } = req.body || {};

    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }
    if (!documentId && !sourceFileId) {
      return res.status(400).json({ error: 'Provide either a document UUID as :id or sourceFileId in the body' });
    }

    await supabaseService.requireActiveClient(clientId);

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
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge/sync
// Manually trigger the scheduled sync (useful for testing and portal "Sync Now" button).
// ---------------------------------------------------------------------------

router.post('/sync', async (req, res, next) => {
  try {
    const event = await inngest.send({ name: 'knowledge/scheduled-sync', data: {} });
    res.json({ queued: true, eventId: event.ids?.[0] || event.id || null });
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

// ---------------------------------------------------------------------------
// POST /api/knowledge/query
// Synchronous RAG query: vector search + LLM answer.
// Body: { clientId, question, sessionId?, sessionMessages? }
// Returns: { answer, sources, sessionId }
// ---------------------------------------------------------------------------

router.post('/query', async (req, res, next) => {
  try {
    const { clientId, question, sessionId: providedSessionId, sessionMessages = [] } = req.body;
    if (!clientId || !question) {
      return res.status(400).json({ error: 'clientId and question are required' });
    }

    await supabaseService.requireActiveClient(clientId);

    // Resolve or create the chat session
    let sessionId;
    if (providedSessionId) {
      const session = await supabaseService.getChatSession(clientId, providedSessionId);
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      sessionId = session.id;
    } else {
      const title = question.trim().slice(0, 50);
      const session = await supabaseService.createChatSession(clientId, title);
      sessionId = session.id;
    }

    // Save the user message before running RAG so we have its ID for knowledge gap logging
    const userMsg = await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'user',
      content: question,
    });

    // 1. Embed the question
    const queryEmbedding = await openaiService.embedQuery(question);

    // 2. Retrieve relevant chunks scoped to this client
    const chunks = await supabaseService.searchChunks(clientId, queryEmbedding, {
      threshold: 0.3,
      count: 8,
    });

    if (!chunks.length) {
      const answer = 'I couldn\'t find any relevant information in the knowledge base for your question.';
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: answer,
        sources: [],
      });
      await supabaseService.createKnowledgeGap({
        clientId,
        sessionId,
        messageId: userMsg.id,
        question,
        reason: 'no_chunks_found',
      });
      return res.json({ answer, sources: [], sessionId });
    }

    // 3. Generate answer
    const answer = await openaiService.generateRagAnswer(question, chunks, sessionMessages);

    // 4. Build sources list (deduplicated by file name)
    const sourceSet = new Set();
    const sources = [];
    for (const chunk of chunks) {
      const name = chunk.metadata && chunk.metadata.fileName ? chunk.metadata.fileName : 'unknown';
      if (!sourceSet.has(name)) {
        sourceSet.add(name);
        sources.push({ fileName: name, documentId: chunk.document_id });
      }
    }

    // 5. Save the assistant message with sources and chunk metadata
    const metadata = {
      chunkCount: chunks.length,
      documentIds: [...new Set(chunks.map((c) => c.document_id))],
    };
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: answer,
      sources,
      metadata,
    });

    // 6. Log a knowledge gap if the LLM indicated the question wasn't covered,
    //    even though chunks were retrieved (weak vector matches).
    if (isKnowledgeGapAnswer(answer)) {
      await supabaseService.createKnowledgeGap({
        clientId,
        sessionId,
        messageId: userMsg.id,
        question,
        reason: 'answer_indicated_not_found',
      });
    }

    res.json({ answer, sources, sessionId });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/chat/sessions/:clientId
// List all non-deleted sessions for a client (newest first).
// ---------------------------------------------------------------------------

router.get('/chat/sessions/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const sessions = await supabaseService.listChatSessions(clientId);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge/chat/sessions/:clientId/:sessionId/messages
// Return all non-deleted messages for a session, ordered oldest-first.
// ---------------------------------------------------------------------------

router.get('/chat/sessions/:clientId/:sessionId/messages', async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const session = await supabaseService.getChatSession(clientId, sessionId);
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

router.delete('/chat/sessions/:clientId/:sessionId', async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    const session = await supabaseService.getChatSession(clientId, sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    await supabaseService.softDeleteChatSession(clientId, sessionId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/knowledge/chat/history/:clientId
// Soft-delete all sessions and messages for a client.
// ---------------------------------------------------------------------------

router.delete('/chat/history/:clientId', async (req, res, next) => {
  try {
    const { clientId } = req.params;
    await supabaseService.requireActiveClient(clientId);
    await supabaseService.softDeleteAllChatHistory(clientId);
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

router.patch('/chat/sessions/:clientId/:sessionId/title', async (req, res, next) => {
  try {
    const { clientId, sessionId } = req.params;
    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }
    await supabaseService.requireActiveClient(clientId);
    const session = await supabaseService.getChatSession(clientId, sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const updated = await supabaseService.updateChatSessionTitle(clientId, sessionId, title);
    res.json({ session: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
