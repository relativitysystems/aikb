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
const { buildContextText, formatCitationDate, extractCitedIndices } = require('../services/openaiService');

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

// EM10.5 Scenario 2 bug fix — pinned to UTC so a timestamp near a
// timezone boundary formats deterministically regardless of the host
// process's local timezone (this is what previously caused this file's
// citation date to disagree with portalCitations.js's browser-side one).
test('formatCitationDate is pinned to UTC, not the host process\'s local timezone', () => {
  assert.equal(formatCitationDate('2026-08-04T23:30:00Z'), 'Aug 4, 2026');
  assert.equal(formatCitationDate('2026-08-05T00:30:00Z'), 'Aug 5, 2026');
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

// ─────────────────────────────────────────────
// extractCitedIndices — EM10.5 Scenario 2 bug fix: parses the model's
// trailing "Cited: [n, n]" line so runKnowledgeQuery.js can filter its
// sources[] array down to only what was actually cited.
// ─────────────────────────────────────────────

test('extractCitedIndices parses a well-formed Cited line and strips it from the returned answer', () => {
  const answer = 'TL;DR\nSome answer.\n\nSource: Weekly Sales Meeting Agenda.txt\nCited: [2]';
  const { citedIndices, cleanedAnswer } = extractCitedIndices(answer);
  assert.deepEqual([...citedIndices], [2]);
  assert.doesNotMatch(cleanedAnswer, /Cited/);
  assert.match(cleanedAnswer, /Source: Weekly Sales Meeting Agenda\.txt/);
});

test('extractCitedIndices parses multiple indices', () => {
  const { citedIndices } = extractCitedIndices('Answer.\n\nSource: A, B\nCited: [1, 3]');
  assert.deepEqual([...citedIndices].sort(), [1, 3]);
});

test('extractCitedIndices returns an empty set and the answer unchanged when Cited is explicitly empty', () => {
  const answer = 'Answer.\n\nSource: N/A\nCited: []';
  const { citedIndices, cleanedAnswer } = extractCitedIndices(answer);
  assert.equal(citedIndices.size, 0);
  assert.doesNotMatch(cleanedAnswer, /Cited/);
});

test('extractCitedIndices returns an empty set and the answer byte-for-byte unchanged when no Cited line is present (DI-faked fixtures, non-compliant model output)', () => {
  const answer = 'Answer.\n\nSource: Handbook.pdf';
  const { citedIndices, cleanedAnswer } = extractCitedIndices(answer);
  assert.equal(citedIndices.size, 0);
  assert.equal(cleanedAnswer, answer);
});

test('extractCitedIndices ignores non-numeric/out-of-range garbage inside the brackets rather than throwing', () => {
  const { citedIndices } = extractCitedIndices('Answer.\n\nCited: [1, abc, 0, -3, 2]');
  assert.deepEqual([...citedIndices].sort(), [1, 2]);
});

test('extractCitedIndices never throws on a non-string input', () => {
  const { citedIndices, cleanedAnswer } = extractCitedIndices(null);
  assert.equal(citedIndices.size, 0);
  assert.equal(cleanedAnswer, null);
});
