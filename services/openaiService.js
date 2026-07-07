'use strict';

const OpenAI = require('openai');
const config = require('../config');

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// Log key presence at startup without printing the value.
console.log(
  `[openaiService] init | OPENAI_API_KEY present=${!!config.openai.apiKey}` +
  ` | embeddingModel=${config.openai.embeddingModel}`
);

// System prompt used for all RAG query completions.
const RAG_SYSTEM_PROMPT = `You are the knowledge assistant for Relativity Systems clients.

Your job is to answer questions using the content of the client's uploaded documents, whatever those
documents are — company policies and SOPs, but equally technical manuals, PDFs, DOCX files, reports,
research notes, or any other uploaded material (including non-business content like stories or poems).
Answer directly from what the document says; explain, summarize, or interpret its content as asked.

Do not invent policies, pricing, procedures, timelines, guarantees, or commitments.

When information is missing, incomplete, outdated, or conflicting, clearly state that and recommend the appropriate next step.

## Core Rules

- Only use information found in the retrieved context below.
- Never create pricing, policies, timelines, guarantees, or commitments that are not documented.
- If the answer is not clearly documented, say: "This is not fully documented in our knowledge base." Then state what was found and recommend the smallest next step.
- If the answer is supported by information in the retrieved context, cite the source document(s) using: Source: filename for non-paginated documents, or Source: filename, p. X when a page number is present in the retrieved context. Never invent a page number.
- If the question is not documented, missing, or cannot be answered from the retrieved context, do NOT cite a retrieved document as if it supports the answer. Use: Source: N/A
- If documents disagree, present both versions and recommend confirmation with the appropriate owner.

## Style

- Summarize and synthesize what the retrieved context says in your own words — do not dump long
  verbatim sections or reproduce the document structure unless the user explicitly asks to see the
  full text, a quote, or the exact wording.
- Prefer concise bullets and action-oriented phrasing over dense paragraphs, especially for
  checklists, steps, or routines.
- If recent conversation messages are included before the context, use them only to understand what
  the user is referring to (e.g. "it", "that", "first", "today") — never as a source of facts. All
  factual claims must still come from the retrieved context below.

## Response Format

TL;DR
Guidance
Next Step
Source`;

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

const EMBEDDING_BATCH_SIZE = 100;
const EMBEDDING_TIMEOUT_MS = 60_000;

/**
 * Generate embeddings for an array of text strings.
 * Batches requests to stay within OpenAI's 2048-input limit per call.
 * Returns a parallel array of float[] embeddings.
 */
async function generateEmbeddings(texts) {
  if (!texts.length) return [];

  const totalBatches = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);
  console.log(
    `[generateEmbeddings] START | model=${config.openai.embeddingModel}` +
    ` | totalTexts=${texts.length} | batchSize=${EMBEDDING_BATCH_SIZE} | totalBatches=${totalBatches}`
  );

  const results = [];

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

    console.log(`[generateEmbeddings] START batch ${batchNum}/${totalBatches} | size=${batch.length}`);
    const start = Date.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS);

    let response;
    try {
      response = await openai.embeddings.create(
        { model: config.openai.embeddingModel, input: batch },
        { signal: controller.signal }
      );
    } catch (err) {
      if (controller.signal.aborted) {
        const msg = `embeddings.create timed out after ${EMBEDDING_TIMEOUT_MS / 1000}s` +
          ` (batch ${batchNum}/${totalBatches})`;
        console.error(`[generateEmbeddings] TIMEOUT batch ${batchNum}/${totalBatches}` +
          ` | elapsed=${Date.now() - start}ms`);
        throw new Error(msg);
      }
      console.error(
        `[generateEmbeddings] ERROR batch ${batchNum}/${totalBatches}` +
        ` | elapsed=${Date.now() - start}ms` +
        ` | status=${err.status ?? 'unknown'}` +
        ` | code=${err.code ?? 'unknown'}` +
        ` | message=${err.message}`
      );
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    console.log(`[generateEmbeddings] END batch ${batchNum}/${totalBatches} | elapsed=${Date.now() - start}ms`);

    const embeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    results.push(...embeddings);
  }

  console.log(`[generateEmbeddings] END | totalEmbeddings=${results.length}`);
  return results;
}

/**
 * Embed a single query string for similarity search.
 */
async function embedQuery(text) {
  const response = await openai.embeddings.create({
    model: config.openai.embeddingModel,
    input: text,
  });
  return response.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

/**
 * Generate a RAG answer given retrieved context chunks and a user question.
 * contextChunks: [{ content, metadata: { fileName, ... } }]
 */
async function generateRagAnswer(question, contextChunks, sessionMessages = []) {
  const contextText = contextChunks
    .map((c, i) => {
      const source = c.metadata && c.metadata.fileName ? c.metadata.fileName : 'unknown';
      const page = c.metadata && c.metadata.pageNumber != null ? `, p. ${c.metadata.pageNumber}` : '';
      return `[${i + 1}] Source: ${source}${page}\n${c.content}`;
    })
    .join('\n\n---\n\n');

  const messages = [
    ...sessionMessages,
    {
      role: 'user',
      content: `Context from knowledge base:\n\n${contextText}\n\n---\n\nQuestion: ${question}`,
    },
  ];

  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [{ role: 'system', content: RAG_SYSTEM_PROMPT }, ...messages],
    temperature: 0.2,
  });

  return response.choices[0].message.content;
}

/**
 * Low-level chat completion with full message control.
 */
async function generateChatCompletion(messages, systemPrompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1',
    messages: [{ role: 'system', content: systemPrompt || RAG_SYSTEM_PROMPT }, ...messages],
    temperature: 0.2,
  });
  return response.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const INTENT_CLASSIFIER_PROMPT = `You are an intent classifier for a knowledge base assistant. The knowledge base is a
generic document store: each client uploads whatever documents matter to them — company
SOPs and policies, yes, but just as often technical manuals, PDFs, DOCX files, contracts,
research notes, school assignments, poems, stories, articles, or any other text content.
You do not know in advance what a given client has uploaded, so never assume the knowledge
base is limited to business/SOP/policy material.

Classify the user message into exactly one of these intents and return strict JSON only.

## Intents

"knowledge_query" — The default classification for any complete sentence, question, or statement
that could plausibly be answered by looking inside an uploaded document, whatever its subject
matter. This includes business questions (policies, SOPs, FAQs, pricing) AND content questions
about any other uploaded material — asking what happens in a story or poem, what a passage means,
summarizing a named document, explaining a technical concept, etc. When in doubt about whether a
topic could be covered by an uploaded document, prefer "knowledge_query" over "unsupported" or
"clarification_needed". Do not require the message to name a specific file or document.
- Questions beginning with "what is", "what are", "how does", "how do", "explain", "summarize",
  "tell me about", "list", or "describe" should usually be "knowledge_query".
- Mentions of SOP, policy, architecture, layers, workflow, process, checklist, pricing, onboarding,
  training, FAQ, document, guide, manual, or system should usually be "knowledge_query".
- A statement — not just a question — that sounds like the user is referencing something that may
  be documented (e.g. "I think there are 5 layers") is still "knowledge_query", not clarification.
- Do not mark a full sentence or question as "clarification_needed" just because it doesn't name a
  specific file.
Examples: "What is our refund policy?", "How do we reschedule last-minute appointments?",
"What happens in the poem?", "What does he mean by that line?", "Summarize the collaborative
response document", "Explain chapter 2", "What are the onboarding steps?", "What are the SOP's?",
"What is the knowledge base architecture?", "I think there are 5 layers"
shouldRunRetrieval: true, shouldAllowKnowledgeGap: true

"casual_conversation" — Greeting, small talk, thanks, acknowledgement, or non-task social phrase.
Examples: "yo", "hi", "hello", "thanks", "ok", "cool", "what's up", "great"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"help_request" — User asks what the assistant can do or how to use it.
Examples: "what can you do?", "how does this work?", "what should I ask?", "help"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"clarification_needed" — Reserved for short fragments that are too incomplete to search reliably —
not full sentences, questions, or statements. Use this only when the message is a bare word or
phrase with no verb and no clear subject, such as "refund", "pricing?", "policy", "that one", or
"what about it" — unless recent session context makes the reference clear (see below). A complete
question or statement should almost never be "clarification_needed", even if it is short — prefer
"knowledge_query" instead.
Examples: "refund", "policy", "pricing?", "that one", "what about it"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

"unsupported" — Request clearly cannot be answered by any document a client could upload:
requests to generate brand-new creative content from scratch, general internet trivia,
current events, live weather, or personal opinions about the assistant itself. This is NOT
about the topic being "business-related" — a question about a poem, story, or technical
subject is still "knowledge_query" if it's asking about content that could be in an uploaded
document. Reserve "unsupported" for things no document lookup could ever answer.
Examples: "what's my favorite ice cream?", "write me a brand new poem about spring",
"who won the Super Bowl last night?", "what's the weather right now?"
shouldRunRetrieval: false, shouldAllowKnowledgeGap: false

## Using recent conversation context
You may be given a short excerpt of recent conversation history right before the latest message.
Use it only to decide whether the latest message is a follow-up that refers back to a document,
topic, or answer already established earlier in the same session — never as a source of facts.

- If the recent conversation shows a document, SOP, checklist, policy, or other retrieved content was
  already being discussed, and the latest message is a short follow-up that leans on that context —
  using words/phrases like "this", "that", "it", "first", "today", "checklist", "routine", "next", or
  "what should I do" — classify it as "knowledge_query", not "clarification_needed". The prior context
  is what makes the reference concrete, even though the message alone looks vague.
- Only apply this when the recent conversation actually establishes a document/topic. If the prior
  messages are casual conversation, a greeting, or there is no conversation context at all, judge the
  latest message strictly on its own — a bare, ambiguous message with nothing to anchor it is still
  "clarification_needed".
- Never use conversation context to answer the question yourself. You are only classifying intent.

## Rules
- Never classify a short greeting as a knowledge gap.
- Never classify an unsupported question as a knowledge gap.
- Only allow knowledge gap when intent is "knowledge_query" and retrieval fails.
- Default to "knowledge_query" for any complete sentence, question, or statement that could
  plausibly relate to uploaded content, even if it doesn't name a specific document, policy, or
  file, and even if your confidence is moderate rather than high.
- Reserve "clarification_needed" for bare fragments with no verb and no clear subject (see examples
  above) — not for full sentences or questions that are merely short.
- Do not classify a question as "unsupported" merely because it isn't about business policies, SOPs, or procedures — the knowledge base can contain any kind of document.

## Output format (strict JSON, no markdown, no extra keys)
{
  "intent": "knowledge_query|casual_conversation|help_request|clarification_needed|unsupported",
  "confidence": 0.0,
  "shouldRunRetrieval": true,
  "shouldAllowKnowledgeGap": true,
  "responseStyle": "rag|conversational|help|clarify|unsupported",
  "reason": "one sentence"
}`;

// Obvious greetings — checked before calling the LLM to avoid unnecessary cost.
const GREETING_WORDS = new Set([
  'yo', 'hi', 'hey', 'hello', 'sup', 'howdy',
  'thanks', 'thank you', 'ty',
  'ok', 'okay', 'cool', 'great', 'nice', 'alright',
  'bye', 'goodbye', 'cya',
]);

// Clearly vague single-word prompts — let LLM clarify rather than searching.
const VAGUE_SINGLE_WORDS = new Set([
  'refund', 'pricing', 'policy', 'onboarding',
  'process', 'procedure', 'info', 'information', 'first',
]);

// Question phrases that signal a real question rather than a bare fragment.
const QUESTION_PHRASE_PATTERN = /\b(what|how|why|when|where|who|explain|summarize|list|describe|tell me)\b/i;

// Domain/document keywords that signal the message likely refers to uploaded content.
// Matched against a copy of the message with apostrophes stripped, so "SOP's" -> "SOPs" matches "sops?".
const DOMAIN_KEYWORD_PATTERN = /\b(sops?|polic(?:y|ies)|architecture|layers?|workflow|process|checklist|pricing|onboarding|training|faq|document|guide|manual|system|knowledge base)\b/i;

// Formats recent session messages into a compact "Role: content" transcript for
// inclusion in LLM prompts. Each message is truncated to keep the prompt small.
function formatSessionContext(sessionMessages) {
  if (!sessionMessages || !sessionMessages.length) return '';
  return sessionMessages
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${(m.content || '').slice(0, 500)}`)
    .join('\n');
}

/**
 * Classify the user's question to decide whether to run vector retrieval.
 * sessionMessages (optional): recent { role, content } messages from the current
 * chat session, oldest-first, used only to disambiguate follow-up questions —
 * never as a source of facts.
 * Returns:
 *   { intent, confidence, shouldRunRetrieval, shouldAllowKnowledgeGap, responseStyle, reason }
 *
 * Classifier failure always falls back to clarification_needed (never retrieval).
 */
async function classifyQueryIntent(question, sessionMessages = []) {
  const trimmed = (question || '').trim();

  // Guardrail: empty input
  if (!trimmed) {
    return {
      intent: 'clarification_needed',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Empty input',
    };
  }

  const lower = trimmed.toLowerCase();

  // Guardrail: obvious greeting (single token, no spaces or known multi-word phrases)
  if (GREETING_WORDS.has(lower) || GREETING_WORDS.has(lower.replace(/[!?.]+$/, ''))) {
    return {
      intent: 'casual_conversation',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'conversational',
      reason: 'Obvious greeting detected by guardrail',
    };
  }

  // Guardrail: clearly vague single-word prompt (no spaces)
  if (!lower.includes(' ') && VAGUE_SINGLE_WORDS.has(lower)) {
    return {
      intent: 'clarification_needed',
      confidence: 1.0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Vague single-word term detected by guardrail',
    };
  }

  // Guardrail: document-style question or statement — 3+ words containing either a question
  // phrase or a domain/document keyword almost always warrants retrieval. This exists because
  // the LLM classifier alone was over-flagging real questions (e.g. "what are the sop's",
  // "what is the knowledge base architecture") as clarification_needed.
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const normalizedForKeywords = lower.replace(/['']/g, '');
  if (
    wordCount >= 3 &&
    (QUESTION_PHRASE_PATTERN.test(lower) || DOMAIN_KEYWORD_PATTERN.test(normalizedForKeywords))
  ) {
    return {
      intent: 'knowledge_query',
      confidence: 0.9,
      shouldRunRetrieval: true,
      shouldAllowKnowledgeGap: true,
      responseStyle: 'rag',
      reason: 'Document-style question detected by guardrail',
    };
  }

  // LLM classifier for everything else
  try {
    const contextBlock = formatSessionContext(sessionMessages);
    const userContent = contextBlock
      ? `Recent conversation (oldest first):\n${contextBlock}\n\nLatest message to classify: "${trimmed}"`
      : trimmed;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: INTENT_CLASSIFIER_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices[0].message.content;
    const result = JSON.parse(raw);

    if (
      typeof result.intent !== 'string' ||
      typeof result.shouldRunRetrieval !== 'boolean' ||
      typeof result.shouldAllowKnowledgeGap !== 'boolean'
    ) {
      throw new Error('Classifier returned unexpected shape');
    }

    console.log('[classifyQueryIntent]', { intent: result.intent, confidence: result.confidence, reason: result.reason });
    return result;
  } catch (err) {
    console.error('[classifyQueryIntent] classifier error, falling back to clarification_needed:', err.message);
    return {
      intent: 'clarification_needed',
      confidence: 0,
      shouldRunRetrieval: false,
      shouldAllowKnowledgeGap: false,
      responseStyle: 'clarify',
      reason: 'Classifier fallback due to error',
    };
  }
}

// ---------------------------------------------------------------------------
// Retrieval query rewriting
// ---------------------------------------------------------------------------

const RETRIEVAL_QUERY_REWRITE_PROMPT = `You rewrite a user's latest chat message into a concise, keyword-rich
search query for a document vector search / title-matching system. You are given recent conversation
history and the latest user message.

Rules:
- If the latest message stands on its own (no ambiguous references, no missing topic), return it
  unchanged, only lightly cleaned up — do not rewrite it.
- If the latest message is a follow-up that depends on the recent conversation (e.g. it uses words
  like "this", "that", "it", "first", "today", "checklist", "routine", "next"), combine the topic or
  document established in the recent conversation with what the latest message is specifically asking
  about into a short keyword phrase.
- Only use topics/documents that are actually present in the recent conversation. Never invent a
  document name or topic that was not mentioned or clearly implied.
- Output ONLY the rewritten search query text — no quotes, no explanation, no markdown, no punctuation
  beyond what's natural in a search phrase.
- Keep it concise: a short phrase of relevant keywords, not a full sentence.
- Never answer the question. You are only producing a search query.`;

/**
 * Builds a concise search query for retrieval by combining the latest question
 * with relevant recent session context (e.g. a document/topic established
 * earlier in the conversation). Falls back to the original question if there
 * is no session context or if the rewrite call fails.
 */
async function buildRetrievalQuery(question, sessionMessages = []) {
  const trimmed = (question || '').trim();
  if (!trimmed || !sessionMessages.length) return trimmed;

  try {
    const contextBlock = formatSessionContext(sessionMessages);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: RETRIEVAL_QUERY_REWRITE_PROMPT },
        {
          role: 'user',
          content: `Recent conversation (oldest first):\n${contextBlock}\n\nLatest user message: "${trimmed}"`,
        },
      ],
      temperature: 0,
    });

    const rewritten = response.choices[0].message.content?.trim();
    return rewritten || trimmed;
  } catch (err) {
    console.error('[buildRetrievalQuery] rewrite error, falling back to original question:', err.message);
    return trimmed;
  }
}

// ---------------------------------------------------------------------------
// Non-retrieval response builders
// ---------------------------------------------------------------------------

function buildConversationalResponse(question) {
  return [
    'TL;DR',
    'Hello! How can I assist you today?',
    '',
    'Guidance',
    'Your message appears to be a greeting. I can help answer questions using your uploaded documents.',
    '',
    'Next Step',
    'Ask me about anything covered in your uploaded documents — a policy, SOP, FAQ, pricing sheet, training guide, or any other document content.',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildHelpResponse() {
  return [
    'TL;DR',
    "I'm your knowledge assistant. I can help you find answers from your uploaded documents.",
    '',
    'Guidance',
    'You can ask me about anything contained in your uploaded documents — policies, SOPs, FAQs, pricing guides, training materials, technical docs, or any other document content.',
    '',
    'Next Step',
    'Try asking something like: "What is our refund policy?" or "Summarize the [document name] document."',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildClarificationResponse(question) {
  return [
    'TL;DR',
    'I need a little more detail before I can search the uploaded documents.',
    '',
    'Guidance',
    `"${question}" is a bit vague on its own. Which document, policy, checklist, process, or topic should I look in?`,
    '',
    'Next Step',
    'Try: "Summarize the onboarding SOP" or "What does the pricing document say about renewals?"',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

function buildUnsupportedResponse(question) {
  return [
    'TL;DR',
    "That question is outside the scope of the knowledge base.",
    '',
    'Guidance',
    "I'm designed to answer questions using the content of your uploaded documents, whatever they contain — policies, manuals, reports, or anything else. I can't help with general knowledge, personal questions, or topics unrelated to your uploaded documents.",
    '',
    'Next Step',
    'Ask me about a topic or document that has actually been uploaded to your knowledge base.',
    '',
    'Source',
    'Source: N/A',
  ].join('\n');
}

/**
 * Dispatch to the appropriate response builder based on intent.responseStyle.
 */
function buildNonRetrievalAnswer(question, intent) {
  switch (intent.responseStyle) {
    case 'conversational': return buildConversationalResponse(question);
    case 'help':           return buildHelpResponse();
    case 'clarify':        return buildClarificationResponse(question);
    default:               return buildUnsupportedResponse(question);
  }
}

module.exports = {
  generateEmbeddings,
  embedQuery,
  generateRagAnswer,
  generateChatCompletion,
  RAG_SYSTEM_PROMPT,
  classifyQueryIntent,
  buildRetrievalQuery,
  buildNonRetrievalAnswer,
};
