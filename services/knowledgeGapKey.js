'use strict';

// Shared idempotency-key derivation for knowledge_gaps (Backlog M4/M12).
// Both runKnowledgeQuery's auto-persist call and POST /api/knowledge/gaps's
// manual-save call derive the SAME key from (clientId, question, week), so
// a user manually saving a gap that the pipeline already auto-detected
// lands on the same row (see supabaseService.js#createKnowledgeGap's
// upsert-on-conflict semantics) instead of creating a duplicate.
//
// This is distinct from chat sessions' 'slack:<event_id>' idempotency key
// (migration 005) — that key dedupes *event delivery*; this one dedupes
// *question content* within a time window, and portal has no event id at
// all to key off of.

const crypto = require('crypto');

function normalizeGapQuestion(question) {
  return question.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/, '');
}

// ISO week bucket (UTC), e.g. "2026-W29". Week-, not day-, granularity: an
// unresolved recurring question surfaces as a fresh 'open' row roughly
// weekly rather than staying silently open forever, while repeats of the
// same question within the same week collapse onto a single row instead of
// spamming the review queue.
function isoWeekBucket(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildGapIdempotencyKey({ clientId, question, at = new Date() }) {
  const hash = crypto.createHash('sha256').update(normalizeGapQuestion(question)).digest('hex');
  return `gap:v1:${clientId}:${hash}:${isoWeekBucket(at)}`;
}

module.exports = { buildGapIdempotencyKey, normalizeGapQuestion, isoWeekBucket };
