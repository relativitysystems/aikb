'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGapIdempotencyKey, normalizeGapQuestion, isoWeekBucket } = require('../services/knowledgeGapKey');

test('normalizeGapQuestion trims, lowercases, collapses whitespace, and strips trailing punctuation', () => {
  assert.equal(normalizeGapQuestion('  What is our PTO policy?  '), 'what is our pto policy');
  assert.equal(normalizeGapQuestion('What is our PTO policy???'), 'what is our pto policy');
  assert.equal(normalizeGapQuestion('What   is\nour PTO  policy.'), 'what is our pto policy');
});

test('isoWeekBucket returns the same bucket for dates in the same ISO week and a different one across a week boundary', () => {
  const mondayThisWeek = new Date('2026-07-13T00:00:00Z');
  const sundayThisWeek = new Date('2026-07-19T23:59:59Z');
  const nextMonday = new Date('2026-07-20T00:00:00Z');

  assert.equal(isoWeekBucket(mondayThisWeek), isoWeekBucket(sundayThisWeek));
  assert.notEqual(isoWeekBucket(sundayThisWeek), isoWeekBucket(nextMonday));
});

test('buildGapIdempotencyKey is stable for the same question regardless of case/whitespace/punctuation, within the same week', () => {
  const at = new Date('2026-07-19T12:00:00Z');
  const key1 = buildGapIdempotencyKey({ clientId: 'client-1', question: 'What is our PTO policy?', at });
  const key2 = buildGapIdempotencyKey({ clientId: 'client-1', question: '  what is our pto policy  ', at });
  assert.equal(key1, key2);
  assert.match(key1, /^gap:v1:client-1:[0-9a-f]{64}:2026-W\d{2}$/);
});

test('buildGapIdempotencyKey differs across clients, across distinct questions, and across week boundaries', () => {
  const at = new Date('2026-07-19T12:00:00Z');
  const nextWeek = new Date('2026-07-20T12:00:00Z');
  const base = buildGapIdempotencyKey({ clientId: 'client-1', question: 'What is our PTO policy?', at });

  assert.notEqual(base, buildGapIdempotencyKey({ clientId: 'client-2', question: 'What is our PTO policy?', at }));
  assert.notEqual(base, buildGapIdempotencyKey({ clientId: 'client-1', question: 'What is our sick leave policy?', at }));
  assert.notEqual(base, buildGapIdempotencyKey({ clientId: 'client-1', question: 'What is our PTO policy?', at: nextWeek }));
});
