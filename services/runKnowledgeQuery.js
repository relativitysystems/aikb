'use strict';

// Shared RAG pipeline extracted from POST /api/knowledge/query's handler
// body (Architecture Review Phase 4, Milestone 4, §4.9). Both the existing
// /query route (origin: 'portal') and the new POST /api/knowledge/ask route
// (origin: 'slack') call this — the retrieval/generation/citation/
// gap-detection logic itself is NOT duplicated; only the two routes' auth
// and request-shape adapters differ.
//
// This function's observable behavior for origin: 'portal' with no
// idempotencyKey is intentionally IDENTICAL to /query's pre-refactor
// behavior — same session resolution, same message persistence, same
// response shape ({ answer, sources, sessionId, isKnowledgeGap, gapReason?,
// userMessageId, intent, isConversational? }).
//
// Retrieval scope (Milestone 5, Knowledge Collections): callers may pass
// allowedCollectionIds to restrict retrieval to a subset of a client's
// knowledge_collections. null/undefined (the portal's default — /query
// never sets this) means no restriction, searching every collection,
// unchanged from before this milestone. An explicit array (including an
// empty one, which Slack sends when zero collections are allowed) restricts
// searchChunksWithTitleBoost's underlying SQL query itself — see
// aikb/migrations/006_knowledge_collections.sql's match_knowledge_chunks —
// so a restricted chunk is never fetched, and therefore never reaches the
// LLM prompt built below.

const defaultSupabaseService = require('./supabaseService');
const defaultOpenaiService = require('./openaiService');

function isAdminRole(role) {
  return role === 'owner' || role === 'admin';
}

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

function normalizeGapAnswerSource(answer) {
  if (/^Source\s*:/im.test(answer)) {
    return answer.replace(/^Source\s*:\s*.*$/gim, 'Source: N/A');
  }
  return `${answer}\n\nSource: N/A`;
}

/**
 * Reconstructs a runKnowledgeQuery-shaped response from an already-persisted
 * session's most recent assistant message, without re-running retrieval/
 * generation. Used only for the idempotency short-circuit (§4.19) — a
 * retried Slack /ask call (e.g. a redelivered Inngest step, or the
 * Relativity Cron sweep) with the same idempotencyKey lands here instead of
 * doing a second OpenAI round trip or risking a duplicate Slack reply.
 */
async function replayExistingSession({ supabaseService, clientId, session }) {
  const messages = await supabaseService.listChatMessages(clientId, session.id);
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');

  if (!lastAssistant) {
    // Session exists but no assistant message was ever persisted (e.g. a
    // crash between session creation and the first message write) — treat
    // as if nothing happened yet, so the caller re-runs the pipeline.
    return null;
  }

  const metadata = lastAssistant.metadata || {};
  return {
    answer: lastAssistant.content,
    sources: Array.isArray(lastAssistant.sources) ? lastAssistant.sources : [],
    sessionId: session.id,
    isKnowledgeGap: !!metadata.isKnowledgeGap,
    gapReason: metadata.gapReason || undefined,
    userMessageId: lastUser ? lastUser.id : null,
    intent: metadata.intent || null,
    replayed: true,
  };
}

/**
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.question
 * @param {string|null} [params.sessionId] - continue an existing session (portal only; Slack never sets this).
 * @param {string|null} [params.memberId]
 * @param {'portal'|'slack'} [params.origin]
 * @param {object|null} [params.originMetadata] - narrow, safe metadata only (never a token/secret).
 * @param {string|null} [params.idempotencyKey] - Slack: "slack:<event_id>". Never used for portal today.
 * @param {string[]|null} [params.allowedCollectionIds] - null = no restriction (portal default); an array (possibly empty) restricts retrieval.
 * @param {object} [params.deps] - DI'd for tests; each defaults to the real singleton service.
 */
async function runKnowledgeQuery({
  clientId,
  question,
  sessionId: providedSessionId = null,
  memberId = null,
  memberRole = null,
  origin = 'portal',
  originMetadata = null,
  idempotencyKey = null,
  allowedCollectionIds = null,
  deps = {},
}) {
  const supabaseService = deps.supabaseService || defaultSupabaseService;
  const openaiService = deps.openaiService || defaultOpenaiService;

  if (!clientId) throw new Error('runKnowledgeQuery requires clientId');
  if (!question) throw new Error('runKnowledgeQuery requires question');

  const isAdmin = isAdminRole(memberRole);

  // Idempotency short-circuit (§4.19) — only relevant when a caller
  // supplies idempotencyKey without an explicit sessionId (Slack's
  // one-shot-per-event model; portal never sets idempotencyKey today).
  if (idempotencyKey && !providedSessionId) {
    const existingSession = await supabaseService.getChatSessionByIdempotencyKey(clientId, idempotencyKey);
    if (existingSession) {
      const replayed = await replayExistingSession({ supabaseService, clientId, session: existingSession });
      if (replayed) return replayed;
    }
  }

  // Resolve or create the chat session.
  let sessionId;
  if (providedSessionId) {
    const session = await supabaseService.getChatSession(clientId, providedSessionId, memberId, isAdmin);
    if (!session) {
      const err = new Error('Session not found');
      err.status = 404;
      throw err;
    }
    sessionId = session.id;
  } else {
    const title = question.trim().slice(0, 50);
    const session = await supabaseService.createChatSession(clientId, title, memberId, { origin, originMetadata, idempotencyKey });
    sessionId = session.id;
  }

  // Save the user message before running RAG so we have its ID for knowledge gap logging.
  const userMsg = await supabaseService.createChatMessage({
    clientId,
    sessionId,
    role: 'user',
    content: question,
    memberId,
  });

  // Load recent session history server-side so follow-up questions can be
  // classified/retrieved using the actual prior conversation. For Slack,
  // this session is brand new, so this is always empty — no conversation
  // memory across separate app_mention events, per §4.12.
  const recentMessages = await supabaseService.listRecentChatMessages(clientId, sessionId, 8);
  const recentSessionMessages = recentMessages
    .filter((m) => m.id !== userMsg.id)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const intent = await openaiService.classifyQueryIntent(question, recentSessionMessages);

  let runRetrieval = intent.shouldRunRetrieval;
  if (!runRetrieval && intent.intent === 'unsupported') {
    runRetrieval = await supabaseService.hasIndexedDocuments(clientId);
  }

  console.log('[runKnowledgeQuery] intent classification', {
    clientId,
    origin,
    sessionContextMessages: recentSessionMessages.length,
    intent: intent.intent,
    confidence: intent.confidence,
    classifierShouldRunRetrieval: intent.shouldRunRetrieval,
    retrievalSkipped: !runRetrieval,
  });

  if (!runRetrieval) {
    const answer = openaiService.buildNonRetrievalAnswer(question, intent);
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: answer,
      sources: [],
      metadata: { question, retrievalQuery: null, intent, retrievalSkipped: true, isKnowledgeGap: false },
      memberId,
    });
    return {
      answer,
      sources: [],
      sessionId,
      isKnowledgeGap: false,
      isConversational: intent.intent === 'casual_conversation',
      intent,
      userMessageId: userMsg.id,
    };
  }

  const retrievalQuery = await openaiService.buildRetrievalQuery(question, recentSessionMessages);
  const queryEmbedding = await openaiService.embedQuery(retrievalQuery);

  const { chunks, matchedDocumentIds } = await supabaseService.searchChunksWithTitleBoost(
    clientId, queryEmbedding, retrievalQuery, { threshold: 0.15, count: 10, allowedCollectionIds }
  );

  console.log('[runKnowledgeQuery] retrieval summary', {
    clientId,
    origin,
    retrievalSkipped: false,
    titleMatchedDocumentIds: matchedDocumentIds,
    chunkCount: chunks.length,
    topScore: chunks[0]?.similarity ?? null,
  });

  if (!chunks.length) {
    const answer = normalizeGapAnswerSource('I couldn\'t find any relevant information in the knowledge base for your question.');
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: answer,
      sources: [],
      metadata: { question, retrievalQuery, intent, retrievalSkipped: false, isKnowledgeGap: true, gapReason: 'no_chunks_found' },
      memberId,
    });
    return { answer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'no_chunks_found', userMessageId: userMsg.id, intent };
  }

  const answer = await openaiService.generateRagAnswer(question, chunks, recentSessionMessages);

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
    const normalizedAnswer = normalizeGapAnswerSource(answer);
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: normalizedAnswer,
      sources: [],
      metadata: { ...chunkMetadata, intent, retrievalSkipped: false, isKnowledgeGap: true, gapReason: 'answer_indicated_not_found' },
      memberId,
    });
    return { answer: normalizedAnswer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'answer_indicated_not_found', userMessageId: userMsg.id, intent };
  }

  await supabaseService.createChatMessage({
    clientId,
    sessionId,
    role: 'assistant',
    content: answer,
    sources,
    metadata: { ...chunkMetadata, intent, retrievalSkipped: false, isKnowledgeGap: false },
    memberId,
  });

  return { answer, sources, sessionId, isKnowledgeGap: false, userMessageId: userMsg.id, intent };
}

module.exports = {
  runKnowledgeQuery,
  isKnowledgeGapAnswer,
  normalizeGapAnswerSource,
  isAdminRole,
};
