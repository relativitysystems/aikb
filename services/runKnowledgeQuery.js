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
//
// Backlog M4: as of this change, this function DOES auto-persist a
// knowledge_gaps row (reportedBy: 'system') itself whenever it detects a
// gap, for both origins — this is a deliberate reversal of the prior
// "never auto-persists, only POST /api/knowledge/gaps does" invariant.
// Dedup is via the idempotencyKey built by services/knowledgeGapKey.js
// (client+question+ISO-week), not by this function refusing to try — see
// supabaseService.js#createKnowledgeGap's upsert-on-conflict semantics.
// This is best-effort: a failure here is logged and swallowed, never
// thrown, since gap logging is review-workflow/analytics data, not core to
// answering the user (unlike message persistence above, which is core to
// session continuity and is allowed to throw).
//
// Backlog M13 (revised): gap logging is a deliberate, narrow exception to
// persistConversation: false below — knowledge_gaps is admin review-queue
// data, never exposed through any portal chat/session read path, and a
// gap row is only ever written when a real gap was actually detected (not
// on every question). Product decision: still store the real question text
// on a detected gap, for both origins, unchanged by this milestone.

const crypto = require('crypto');
const config = require('../config');
const defaultSupabaseService = require('./supabaseService');
const defaultOpenaiService = require('./openaiService');
const defaultToolExecutionClient = require('./toolExecutionClient');
const { SEARCH_EMAIL_MESSAGES_TOOL, GET_EMAIL_CONTENT_TOOL, TOOL_NAMES } = require('./emailToolSchemas');
const { buildGapIdempotencyKey } = require('./knowledgeGapKey');

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
 * Best-effort auto-persist of a detected knowledge gap (Backlog M4). Never
 * throws — a failure here must not break the user-facing answer/Slack
 * reply, since this is review-workflow/analytics data, not the response
 * itself.
 */
async function persistGapBestEffort({ supabaseService, clientId, sessionId, userMessageId, question, reason, memberId, origin, originMetadata }) {
  try {
    const idempotencyKey = buildGapIdempotencyKey({ clientId, question });
    await supabaseService.createKnowledgeGap({
      clientId, sessionId, messageId: userMessageId, question, reason, memberId,
      origin, originMetadata, idempotencyKey, reportedBy: 'system',
    });
  } catch (err) {
    console.error('[runKnowledgeQuery] createKnowledgeGap failed (best-effort, swallowed)', {
      clientId, origin, reason, message: err.message,
    });
  }
}

/**
 * Reconstructs a runKnowledgeQuery-shaped response from an already-persisted
 * session's most recent assistant message, without re-running retrieval/
 * generation. Used only for the idempotency short-circuit (§4.19) — a
 * retried Slack /ask call (e.g. a redelivered Inngest step, or one of
 * Relativity's own bounded in-flow retries around its accept-and-enqueue
 * call, per ADR-007) with the same idempotencyKey lands here instead of
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

// ---------------------------------------------------------------------------
// EL5 — bounded live-email tool orchestration (Architecture/architecture/
// LIVE_EMAIL_LOOKUP.md §1.1 steps 5-13, §1.3 Option C, ADR-010 Conformance's
// confirmed two-call bound, §6.2's source shape).
// ---------------------------------------------------------------------------

/**
 * §6.2 — maps a search_email_messages match into the shared live-source
 * shape. Used both when the model answers directly from search snippets
 * (no fetch needed — the common case) and, for whichever result actually
 * got fetched, superseded by liveSourcesFromContentMessages below.
 */
function liveSourcesFromSearchMatches(matches, memberId) {
  return (matches || []).map((m) => ({
    type: 'live_email_message',
    subject: m.subject,
    from: m.fromAddress,
    receivedAt: m.date,
    mailboxOwnerMemberId: memberId,
    providerMessageId: m.messageId,
    providerThreadId: m.threadId || null,
    deepLinkUrl: m.deepLinkUrl || null,
    live: true,
  }));
}

/**
 * §6.2 — maps get_email_content's returned message(s) into live sources.
 * More than one message back (a fetched thread) is reported as
 * live_email_thread; a single message (either a lone messageId fetch or a
 * one-message thread) is live_email_message — a simplification EL8
 * ("Citations and live-source UI") owns refining further, not required by
 * this milestone's own scope.
 */
function liveSourcesFromContentMessages(messages, memberId) {
  const type = (messages || []).length > 1 ? 'live_email_thread' : 'live_email_message';
  return (messages || []).map((m) => ({
    type,
    subject: m.subject,
    from: m.fromAddress,
    receivedAt: m.date,
    mailboxOwnerMemberId: memberId,
    providerMessageId: m.messageId,
    providerThreadId: m.threadId || null,
    deepLinkUrl: m.deepLinkUrl || null,
    live: true,
  }));
}

/**
 * The bounded, two-stage tool-calling loop. The ADR-010 Conformance section's
 * confirmed maximum (search, optionally then one fetch, never more) is
 * enforced STRUCTURALLY, not by counting calls at runtime: call 1 is offered
 * ONLY search_email_messages, call 2 (if reached) is offered ONLY
 * get_email_content, and the final call (if reached) is offered no tools at
 * all — the model cannot request a third call, cannot fetch before
 * searching, and cannot search twice, because the schema it is given each
 * time never allows it.
 *
 * A get_email_content request for an id search_email_messages did not
 * actually return is rejected locally (never sent to Relativity) — the
 * spec's "cannot call get_email_content for an id it did not receive from
 * Call 1" requirement.
 *
 * Deliberately NOT implemented here (§8.3's "Deduplication against
 * already-retrieved ingested emails" token-control optimization — checking
 * email_source_messages for a providerMessageId before fetching live): a
 * cost optimization, not part of this milestone's stated Objective/Security
 * requirements/Tests, left for a follow-up once real usage data justifies it.
 *
 * @returns {Promise<{answer:string, liveSources:object[]}>}
 */
async function runEmailToolAugmentedGeneration({
  openaiService, toolExecutionClient, clientId, memberId, origin, originMetadata, question, enrichedChunks, recentSessionMessages,
}) {
  const first = await openaiService.generateRagAnswerWithTools(question, enrichedChunks, recentSessionMessages, [SEARCH_EMAIL_MESSAGES_TOOL]);
  if (first.type === 'text') {
    return { answer: first.content, liveSources: [] };
  }
  if (first.toolCall.name !== TOOL_NAMES.SEARCH_EMAIL_MESSAGES) {
    // Structurally unreachable (search_email_messages is the only tool
    // offered this call) — defensive fallback only.
    return { answer: 'I ran into an issue searching your email — please try rephrasing your question.', liveSources: [] };
  }

  const searchResult = await toolExecutionClient
    .executeTool({
      clientId,
      requestingMemberId: memberId,
      origin,
      originMetadata,
      idempotencyKey: crypto.randomUUID(),
      toolName: TOOL_NAMES.SEARCH_EMAIL_MESSAGES,
      args: first.toolCall.args,
    })
    .catch((err) => ({ status: 'error', reason: 'provider_timeout', message: err.message }));

  const knownIds = new Set();
  for (const m of searchResult.matches || []) {
    if (m.messageId) knownIds.add(m.messageId);
    if (m.threadId) knownIds.add(m.threadId);
  }

  const second = await openaiService.continueRagAnswerWithToolResult({
    priorMessages: first.conversationMessages,
    toolCall: first.toolCall,
    toolResult: searchResult,
    tools: [GET_EMAIL_CONTENT_TOOL],
  });

  if (second.type === 'text') {
    const liveSources = searchResult.status === 'ok' ? liveSourcesFromSearchMatches(searchResult.matches, memberId) : [];
    return { answer: second.content, liveSources };
  }
  if (second.toolCall.name !== TOOL_NAMES.GET_EMAIL_CONTENT) {
    // Structurally unreachable — defensive fallback only.
    return { answer: 'I ran into an issue reading that email — please try rephrasing your question.', liveSources: [] };
  }

  const requestedId = second.toolCall.args.messageId || second.toolCall.args.threadId;
  const idIsKnown = Boolean(requestedId) && knownIds.has(requestedId);

  const contentResult = idIsKnown
    ? await toolExecutionClient
        .executeTool({
          clientId,
          requestingMemberId: memberId,
          origin,
          originMetadata,
          idempotencyKey: crypto.randomUUID(),
          toolName: TOOL_NAMES.GET_EMAIL_CONTENT,
          args: second.toolCall.args,
        })
        .catch((err) => ({ status: 'error', reason: 'provider_timeout', message: err.message }))
    : { status: 'error', reason: 'validation_error' };

  // Final call: no tools offered — structurally the last call this turn can make.
  const final = await openaiService.continueRagAnswerWithToolResult({
    priorMessages: second.conversationMessages,
    toolCall: second.toolCall,
    toolResult: contentResult,
    tools: undefined,
  });

  const liveSources = contentResult.status === 'ok' ? liveSourcesFromContentMessages(contentResult.messages, memberId) : [];
  return { answer: final.type === 'text' ? final.content : '', liveSources };
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
 * @param {boolean} [params.persistConversation] - Backlog M13 (revised): default true (portal, unchanged). false means NO knowledge_chat_sessions row and NO knowledge_chat_messages rows are ever created for this call — used by the Slack ask path (both 'slack' and 'slack_dm') so Slack-originated conversations are never persisted. The idempotency-based session-replay short-circuit is skipped in this mode (dedup for Slack instead lives in routes/knowledge.js POST /ask, backed by knowledge_slack_request_log — see services/slackRequestLogService.js — since there is no session to replay from). Knowledge-gap auto-persist (persistGapBestEffort, below) is NOT gated by this flag: a detected gap still stores the real question text, unchanged, per product decision (knowledge_gaps is review-queue data, never exposed through any portal chat/session read path).
 * @param {boolean} [params.emailLookupAvailable] - EL5 (LIVE_EMAIL_LOOKUP.md §1.1 step 4). Relativity-supplied: whether the requesting member currently has an active, live-lookup-enabled Gmail connection. Default false (the caller-not-set default before EL6 wires this up from a real signal). Combined with classifyQueryIntent's mayNeedLiveEmailLookup as the two-stage gate (§1.3 Option C) — both must be true for the model to ever be offered the email tools.
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
  persistConversation = true,
  emailLookupAvailable = false,
  deps = {},
}) {
  const supabaseService = deps.supabaseService || defaultSupabaseService;
  const openaiService = deps.openaiService || defaultOpenaiService;
  const toolExecutionClient = deps.toolExecutionClient || defaultToolExecutionClient;

  if (!clientId) throw new Error('runKnowledgeQuery requires clientId');
  if (!question) throw new Error('runKnowledgeQuery requires question');

  const isAdmin = isAdminRole(memberRole);

  // Idempotency short-circuit (§4.19) — only relevant when a caller
  // supplies idempotencyKey without an explicit sessionId (Slack's
  // one-shot-per-event model; portal never sets idempotencyKey today).
  // Never applicable when persistConversation is false — there is no
  // persisted session to look up or replay from (Backlog M13, revised).
  if (persistConversation && idempotencyKey && !providedSessionId) {
    const existingSession = await supabaseService.getChatSessionByIdempotencyKey(clientId, idempotencyKey);
    if (existingSession) {
      const replayed = await replayExistingSession({ supabaseService, clientId, session: existingSession });
      if (replayed) return replayed;
    }
  }

  // Resolve or create the chat session. Skipped entirely when
  // persistConversation is false — sessionId/userMsg stay null, and no
  // knowledge_chat_sessions/knowledge_chat_messages row is ever written
  // (Backlog M13, revised).
  let sessionId = null;
  let userMsg = null;
  let recentSessionMessages = [];

  if (persistConversation) {
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
    userMsg = await supabaseService.createChatMessage({
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
    const recentMessages = await supabaseService.listRecentChatMessages(clientId, sessionId, config.pagination.chatContextMessageLimit);
    recentSessionMessages = recentMessages
      .filter((m) => m.id !== userMsg.id)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  }

  const intent = await openaiService.classifyQueryIntent(question, recentSessionMessages);

  let runRetrieval = intent.shouldRunRetrieval;
  if (!runRetrieval && intent.intent === 'unsupported') {
    runRetrieval = await supabaseService.hasIndexedDocuments(clientId);
  }

  // EL5 (§1.3 Option C) — the two-stage gate: both the classifier's own
  // signal AND Relativity's emailLookupAvailable must pass. A member with
  // no live-lookup-enabled connection never has the tools offered
  // regardless of what the classifier thinks the question is about.
  const emailToolsAvailable = Boolean(intent.mayNeedLiveEmailLookup) && Boolean(emailLookupAvailable) && Boolean(memberId);

  console.log('[runKnowledgeQuery] intent classification', {
    clientId,
    origin,
    sessionContextMessages: recentSessionMessages.length,
    intent: intent.intent,
    confidence: intent.confidence,
    classifierShouldRunRetrieval: intent.shouldRunRetrieval,
    retrievalSkipped: !runRetrieval,
    mayNeedLiveEmailLookup: Boolean(intent.mayNeedLiveEmailLookup),
    emailLookupAvailable: Boolean(emailLookupAvailable),
    emailToolsOffered: emailToolsAvailable,
  });

  if (!runRetrieval) {
    const answer = openaiService.buildNonRetrievalAnswer(question, intent);
    if (persistConversation) {
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: answer,
        sources: [],
        metadata: { question, retrievalQuery: null, intent, retrievalSkipped: true, isKnowledgeGap: false },
        memberId,
      });
    }
    return {
      answer,
      sources: [],
      sessionId,
      isKnowledgeGap: false,
      isConversational: intent.intent === 'casual_conversation',
      intent,
      userMessageId: userMsg ? userMsg.id : null,
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

  // EM10 (EMAIL_INGESTION.md §23) — resolve email_source_messages once, by
  // the distinct document ids among THIS query's retrieved chunks (never
  // every email document for the client), keyed for both generateRagAnswer's
  // context-block formatting and the sourceMap-building step below to share.
  // chunk.metadata.sourceProvider (set at ingest time, inngest/functions.js's
  // baseMetadata) is the discriminator — a chunk from a portal_upload/Slack
  // document never matches and skips this entirely.
  const emailDocumentIds = [...new Set(
    chunks
      .filter((c) => c.metadata && ['gmail', 'microsoft'].includes(c.metadata.sourceProvider))
      .map((c) => c.document_id)
  )];
  const emailSourceMessages = emailDocumentIds.length
    ? await supabaseService.getEmailSourceMessagesByDocumentIds(clientId, emailDocumentIds)
    : [];
  const emailByDocumentId = new Map(emailSourceMessages.map((m) => [m.document_id, m]));
  const enrichedChunks = emailByDocumentId.size === 0
    ? chunks
    : chunks.map((c) => {
        const email = emailByDocumentId.get(c.document_id);
        return email ? { ...c, metadata: { ...c.metadata, email } } : c;
      });

  // EL5 — when live email tools are offered, zero stored chunks no longer
  // means an immediate gap answer: the model still gets a chance to answer
  // via a live mailbox search (LIVE_EMAIL_LOOKUP.md §1.1's "Live email
  // lookup only" sequence — retrieval runs, 0 relevant chunks, generation
  // still proceeds with tools=[...]). Every client without live lookup
  // available takes the exact unchanged shortcut below.
  if (!chunks.length && !emailToolsAvailable) {
    const answer = normalizeGapAnswerSource('I couldn\'t find any relevant information in the knowledge base for your question.');
    if (persistConversation) {
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: answer,
        sources: [],
        metadata: { question, retrievalQuery, intent, retrievalSkipped: false, isKnowledgeGap: true, gapReason: 'no_chunks_found' },
        memberId,
      });
    }
    await persistGapBestEffort({
      supabaseService, clientId, sessionId, userMessageId: userMsg ? userMsg.id : null, question,
      reason: 'no_chunks_found', memberId, origin, originMetadata,
    });
    return { answer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'no_chunks_found', userMessageId: userMsg ? userMsg.id : null, intent };
  }

  let answer;
  let liveSources = [];
  if (emailToolsAvailable) {
    const toolAugmented = await runEmailToolAugmentedGeneration({
      openaiService, toolExecutionClient, clientId, memberId, origin, originMetadata, question, enrichedChunks, recentSessionMessages,
    });
    answer = toolAugmented.answer;
    liveSources = toolAugmented.liveSources;
  } else {
    answer = await openaiService.generateRagAnswer(question, enrichedChunks, recentSessionMessages);
  }

  // EM10 (§23) — an email-sourced document (chunk.metadata.email, set by
  // the enrichment above) gets a distinct citation shape from a plain
  // uploaded document: subject/from/sentAt/deepLinkUrl instead of
  // fileName/pages, plus providerThreadId for the portal's thread-grouped
  // display (§20 "Threading UI"). `title` is included on the email shape
  // specifically so services/slackAnswerFormatter.js's existing
  // `source.title || source.fileName` fallback keeps working unchanged for
  // Slack-originated answers, without that file needing an email-specific
  // branch of its own.
  const sourceMap = new Map();
  for (const chunk of enrichedChunks) {
    const docId = chunk.document_id;
    const email = chunk.metadata && chunk.metadata.email;
    if (!sourceMap.has(docId)) {
      if (email) {
        sourceMap.set(docId, {
          type: 'email',
          documentId: docId,
          subject: email.subject || '(no subject)',
          from: email.from_name || email.from_address || null,
          sentAt: email.sent_at || null,
          deepLinkUrl: email.deep_link_url || null,
          providerThreadId: email.provider_thread_id || null,
        });
      } else {
        const name = chunk.metadata && chunk.metadata.fileName ? chunk.metadata.fileName : 'unknown';
        sourceMap.set(docId, { type: 'document', fileName: name, documentId: docId, pages: new Set() });
      }
    }
    if (!email && chunk.metadata && chunk.metadata.pageNumber != null) {
      sourceMap.get(docId).pages.add(chunk.metadata.pageNumber);
    }
  }
  const sources = Array.from(sourceMap.values()).map((s) => {
    if (s.type === 'email') {
      const src = {
        documentId: s.documentId,
        fileName: `${s.subject}.txt`, // backward-compatible fallback for any consumer that only ever reads fileName
        title: `"${s.subject}" from ${s.from || 'unknown sender'}`,
        subject: s.subject,
        from: s.from,
        sentAt: s.sentAt,
        deepLinkUrl: s.deepLinkUrl,
      };
      if (s.providerThreadId) src.providerThreadId = s.providerThreadId;
      return src;
    }
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
  // EL5 — a live source means the model demonstrably found an answer
  // outside stored knowledge; isKnowledgeGapAnswer's phrase-matching (tuned
  // for a stored-context-only answer) is never consulted once that's true,
  // so a correct live-email answer can never be misclassified as "not
  // documented in the knowledge base."
  const isGap = liveSources.length === 0 && isKnowledgeGapAnswer(answer);
  const allSources = [...sources, ...liveSources];

  if (isGap) {
    const normalizedAnswer = normalizeGapAnswerSource(answer);
    if (persistConversation) {
      await supabaseService.createChatMessage({
        clientId,
        sessionId,
        role: 'assistant',
        content: normalizedAnswer,
        sources: [],
        metadata: { ...chunkMetadata, intent, retrievalSkipped: false, isKnowledgeGap: true, gapReason: 'answer_indicated_not_found' },
        memberId,
      });
    }
    await persistGapBestEffort({
      supabaseService, clientId, sessionId, userMessageId: userMsg ? userMsg.id : null, question,
      reason: 'answer_indicated_not_found', memberId, origin, originMetadata,
    });
    return { answer: normalizedAnswer, sources: [], sessionId, isKnowledgeGap: true, gapReason: 'answer_indicated_not_found', userMessageId: userMsg ? userMsg.id : null, intent };
  }

  if (persistConversation) {
    await supabaseService.createChatMessage({
      clientId,
      sessionId,
      role: 'assistant',
      content: answer,
      sources: allSources,
      metadata: { ...chunkMetadata, intent, retrievalSkipped: false, isKnowledgeGap: false },
      memberId,
    });
  }

  return { answer, sources: allSources, sessionId, isKnowledgeGap: false, userMessageId: userMsg ? userMsg.id : null, intent };
}

module.exports = {
  runKnowledgeQuery,
  isKnowledgeGapAnswer,
  normalizeGapAnswerSource,
  isAdminRole,
};
