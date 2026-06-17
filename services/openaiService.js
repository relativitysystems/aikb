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
// Mirrors the Relativity AI agent system prompt from the n8n workflow.
const RAG_SYSTEM_PROMPT = `You are the internal knowledge assistant for Relativity Systems clients.

Your job is to help team members find company information, explain procedures, answer operational questions, and draft 
client-facing communications using information contained in the company knowledge base.

Do not invent policies, pricing, procedures, timelines, guarantees, or commitments.

When information is missing, incomplete, outdated, or conflicting, clearly state that and recommend the appropriate next step.

## Core Rules

- Only use information found in the retrieved context below.
- Never create pricing, policies, timelines, guarantees, or commitments that are not documented.
- If the answer is not clearly documented, say: "This is not fully documented in our knowledge base." Then state what was found and recommend the smallest next step.
- If the answer is supported by information in the retrieved context, cite the source document(s) using: Source: filename for non-paginated documents, or Source: filename, p. X when a page number is present in the retrieved context. Never invent a page number.
- If the question is not documented, missing, or cannot be answered from the retrieved context, do NOT cite a retrieved document as if it supports the answer. Use: Source: N/A
- If documents disagree, present both versions and recommend confirmation with the appropriate owner.

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

module.exports = {
  generateEmbeddings,
  embedQuery,
  generateRagAnswer,
  generateChatCompletion,
  RAG_SYSTEM_PROMPT,
};
