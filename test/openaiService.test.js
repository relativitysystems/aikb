'use strict';

// Unit tests for openaiService.js's pure, non-network functions only.
// generateEmbeddings/embedQuery/generateRagAnswer/generateChatCompletion/
// classifyQueryIntent/buildRetrievalQuery all make a real OpenAI API call
// and have no DI seam in this file (unlike services that take an injected
// client) — this repo's existing convention (confirmed: no prior
// openaiService.test.js existed) is to fake them wholesale at the caller
// (see test/runKnowledgeQuery.test.js's createFakeOpenaiService) rather than
// mock the OpenAI SDK. buildContextText/formatCitationDate (EM10 —
// EMAIL_INGESTION.md §23) were extracted specifically so the citation
// formatting logic itself is directly testable without that limitation.

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.API_KEY = process.env.API_KEY || 'test-api-key';
process.env.AIKB_SUPABASE_URL = process.env.AIKB_SUPABASE_URL || 'https://example.supabase.co';
process.env.AIKB_SUPABASE_SERVICE_KEY = process.env.AIKB_SUPABASE_SERVICE_KEY || 'test-key';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_KEY || 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContextText, formatCitationDate } = require('../services/openaiService');

// ─────────────────────────────────────────────
// formatCitationDate
// ─────────────────────────────────────────────

test('formatCitationDate formats a valid ISO timestamp as a short human-readable date', () => {
  assert.equal(formatCitationDate('2026-07-20T12:00:00Z'), 'Jul 20, 2026');
});

test('formatCitationDate returns null for a null/undefined/empty input, never throws', () => {
  assert.equal(formatCitationDate(null), null);
  assert.equal(formatCitationDate(undefined), null);
  assert.equal(formatCitationDate(''), null);
});

test('formatCitationDate returns null for an unparseable string rather than "Invalid Date"', () => {
  assert.equal(formatCitationDate('not-a-date'), null);
});

// ─────────────────────────────────────────────
// buildContextText — the [i] Source: ... numbered block formatting
// generateRagAnswer sends to the LLM (EMAIL_INGESTION.md §23)
// ─────────────────────────────────────────────

test('buildContextText: a plain document chunk formats as "Source: fileName" with no page suffix when pageNumber is absent', () => {
  const text = buildContextText([{ content: 'Body text.', metadata: { fileName: 'Handbook.pdf' } }]);
  assert.equal(text, '[1] Source: Handbook.pdf\nBody text.');
});

test('buildContextText: a plain document chunk with a pageNumber includes ", p. X"', () => {
  const text = buildContextText([{ content: 'Body text.', metadata: { fileName: 'Handbook.pdf', pageNumber: 5 } }]);
  assert.equal(text, '[1] Source: Handbook.pdf, p. 5\nBody text.');
});

test('buildContextText: a chunk with no metadata falls back to "unknown"', () => {
  const text = buildContextText([{ content: 'Body text.', metadata: null }]);
  assert.equal(text, '[1] Source: unknown\nBody text.');
});

test('buildContextText: an email-sourced chunk (metadata.email present) formats as Email — "subject" from sender, date', () => {
  const text = buildContextText([{
    content: 'Renewal terms are net-30.',
    metadata: { email: { subject: 'Q3 Renewal Terms', from_name: 'Jane Doe', from_address: 'jane@client.com', sent_at: '2026-07-20T12:00:00Z' } },
  }]);
  assert.equal(text, '[1] Source: Email — "Q3 Renewal Terms" from Jane Doe, Jul 20, 2026\nRenewal terms are net-30.');
});

test('buildContextText: an email chunk falls back to from_address when from_name is absent', () => {
  const text = buildContextText([{
    content: 'Body.',
    metadata: { email: { subject: 'Renewal', from_address: 'jane@client.com', sent_at: null } },
  }]);
  assert.equal(text, '[1] Source: Email — "Renewal" from jane@client.com\nBody.');
});

test('buildContextText: an email chunk with no subject falls back to "(no subject)", never crashes on a missing field', () => {
  const text = buildContextText([{
    content: 'Body.',
    metadata: { email: { subject: null, from_address: null, sent_at: null } },
  }]);
  assert.equal(text, '[1] Source: Email — "(no subject)" from unknown sender\nBody.');
});

test('buildContextText: multiple chunks are numbered sequentially and joined by the --- separator, mixing document and email sources', () => {
  const text = buildContextText([
    { content: 'Doc body.', metadata: { fileName: 'Handbook.pdf', pageNumber: 1 } },
    { content: 'Email body.', metadata: { email: { subject: 'Renewal', from_address: 'jane@client.com', sent_at: null } } },
  ]);
  assert.equal(
    text,
    '[1] Source: Handbook.pdf, p. 1\nDoc body.\n\n---\n\n[2] Source: Email — "Renewal" from jane@client.com\nEmail body.'
  );
});

test('buildContextText: an email chunk NEVER falls into the fileName/page branch even if metadata.fileName is also somehow present', () => {
  // Defensive — email takes priority over any stray fileName field, since
  // the enrichment step (runKnowledgeQuery.js) is the only writer of
  // metadata.email and always does so deliberately for an email-sourced chunk.
  const text = buildContextText([{
    content: 'Body.',
    metadata: { fileName: 'stale.txt', pageNumber: 3, email: { subject: 'Renewal', from_address: 'jane@client.com', sent_at: null } },
  }]);
  assert.doesNotMatch(text, /stale\.txt/);
  assert.match(text, /Email — "Renewal"/);
});
