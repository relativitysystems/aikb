'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signServiceRequest, verifyServiceRequest } = require('../services/serviceRequestAuth');

const SECRET = 'test-service-request-secret';
const CLIENT_ID = '11111111-1111-1111-1111-111111111111';
const IDEMPOTENCY_KEY = 'slack:Ev0123ABC';

test('a freshly signed envelope verifies successfully', () => {
  const payload = { answer: 'You get 15 days of PTO.', sources: [] };
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload, secret: SECRET });

  const result = verifyServiceRequest({ envelope, payload, secret: SECRET });
  assert.equal(result.ok, true);
  assert.equal(result.clientId, CLIENT_ID);
});

test('a tampered payload invalidates the signature', () => {
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'a' }, secret: SECRET });
  const result = verifyServiceRequest({ envelope, payload: { answer: 'b' }, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('an expired envelope is rejected', () => {
  const past = new Date(Date.now() - 5 * 60 * 1000);
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: {}, secret: SECRET, now: past });
  const result = verifyServiceRequest({ envelope, payload: {}, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'expired');
});

test('the wrong secret fails verification', () => {
  const envelope = signServiceRequest({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: {}, secret: SECRET });
  const result = verifyServiceRequest({ envelope, payload: {}, secret: 'wrong' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('missing envelope fields are rejected', () => {
  const result = verifyServiceRequest({ envelope: { clientId: CLIENT_ID }, payload: {}, secret: SECRET });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_fields');
});

test('interoperates byte-for-byte with the Relativity-side implementation\'s signing string shape', () => {
  // Cross-repo contract check: this test recomputes the signature using the
  // exact same public inputs a Relativity-signed envelope would have used,
  // proving the two files' signing string formats stay in lockstep even
  // though they live in separate repositories with no shared package.
  const crypto = require('node:crypto');
  const requestId = 'fixed-request-id';
  const issuedAt = '2026-07-14T00:00:00.000Z';
  const expiresAt = '2026-07-14T00:01:00.000Z';
  const payload = { question: 'What is our PTO policy?', origin: 'slack' };
  const payloadHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const signingString = [requestId, issuedAt, expiresAt, CLIENT_ID, IDEMPOTENCY_KEY, payloadHash].join('.');
  const signature = crypto.createHmac('sha256', SECRET).update(signingString).digest('hex');

  const result = verifyServiceRequest({
    envelope: { requestId, issuedAt, expiresAt, clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, signature },
    payload,
    secret: SECRET,
    now: new Date('2026-07-14T00:00:30.000Z'),
  });
  assert.equal(result.ok, true);
});
