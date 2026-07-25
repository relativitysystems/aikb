'use strict';

// Minimal, additive HMAC-signed request envelope between Relativity and
// AIKB, scoped ONLY to POST /api/knowledge/ask (Relativity -> AIKB),
// POST /api/integrations/slack/deliver (AIKB -> Relativity, reversed), and
// (as of EM8) POST /api/integrations/email/sync/tick (AIKB -> Relativity,
// system-scoped, no clientId) — Architecture Review Phase 4, Milestone 4,
// §4.10; system-scoped envelope added per EMAIL_INGESTION.md §18.3.
//
// This file MUST stay byte-for-byte identical in intent to
// Relativity/services/serviceRequestAuth.js — the signing string format
// has to match exactly or cross-repo verification always fails. Not the
// full future signed ServiceRequest platform (Phase 2 §10) — see that
// file's header comment for the full scope note.
//
// signature = HMAC-SHA256(secret, "requestId.issuedAt.expiresAt.clientId.idempotencyKey.sha256(payload)")
//
// System-scoped variant (signSystemServiceRequest/verifySystemServiceRequest,
// EM8): identical mechanics, but clientId in the signing string is always
// the hardcoded literal 'SYSTEM' rather than a caller-supplied value — used
// only by the AIKB-Inngest-cron tick calling Relativity's sync/tick route,
// which carries zero client-specific data by design (EMAIL_INGESTION.md
// §18.3, §9, §30 item 5 — a narrow, deliberate exception to ADR-001).

const crypto = require('crypto');

const ENVELOPE_TTL_MS = 60 * 1000;

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload || {})).digest('hex');
}

function buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash }) {
  return [requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash].join('.');
}

function signServiceRequest({ clientId, idempotencyKey, payload, secret, now = new Date() }) {
  if (!secret) throw new Error('signServiceRequest requires secret');
  if (!clientId) throw new Error('signServiceRequest requires clientId');
  if (!idempotencyKey) throw new Error('signServiceRequest requires idempotencyKey');

  const requestId = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_MS).toISOString();
  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash });
  const signature = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  return { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature };
}

function verifyServiceRequest({ envelope, payload, secret, now = new Date() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'missing_envelope' };

  const { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature } = envelope;
  if (!requestId || !issuedAt || !expiresAt || !clientId || !idempotencyKey || !signature) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (typeof signature !== 'string') return { ok: false, reason: 'malformed_signature' };

  const expiresAtMs = Date.parse(expiresAt);
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (now.getTime() > expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }
  if (expiresAtMs - issuedAtMs > ENVELOPE_TTL_MS + 1000) {
    return { ok: false, reason: 'invalid_ttl' };
  }

  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId, idempotencyKey, payloadHash });
  const expected = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, reason: 'ok', clientId, idempotencyKey, requestId };
}

const SYSTEM_SCOPE = 'SYSTEM';

function signSystemServiceRequest({ idempotencyKey, payload, secret, now = new Date() }) {
  if (!secret) throw new Error('signSystemServiceRequest requires secret');
  if (!idempotencyKey) throw new Error('signSystemServiceRequest requires idempotencyKey');

  const requestId = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ENVELOPE_TTL_MS).toISOString();
  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId: SYSTEM_SCOPE, idempotencyKey, payloadHash });
  const signature = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  return { requestId, issuedAt, expiresAt, idempotencyKey, signature };
}

function verifySystemServiceRequest({ envelope, payload, secret, now = new Date() }) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'missing_envelope' };

  const { requestId, issuedAt, expiresAt, idempotencyKey, signature } = envelope;
  if (!requestId || !issuedAt || !expiresAt || !idempotencyKey || !signature) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (typeof signature !== 'string') return { ok: false, reason: 'malformed_signature' };

  const expiresAtMs = Date.parse(expiresAt);
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(issuedAtMs)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (now.getTime() > expiresAtMs) {
    return { ok: false, reason: 'expired' };
  }
  if (expiresAtMs - issuedAtMs > ENVELOPE_TTL_MS + 1000) {
    return { ok: false, reason: 'invalid_ttl' };
  }

  const payloadHash = hashPayload(payload);
  const signingString = buildSigningString({ requestId, issuedAt, expiresAt, clientId: SYSTEM_SCOPE, idempotencyKey, payloadHash });
  const expected = crypto.createHmac('sha256', secret).update(signingString).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  const safeEqual = expectedBuf.length === providedBuf.length
    && crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!safeEqual) return { ok: false, reason: 'signature_mismatch' };

  return { ok: true, reason: 'ok', idempotencyKey, requestId };
}

module.exports = {
  signServiceRequest,
  verifyServiceRequest,
  signSystemServiceRequest,
  verifySystemServiceRequest,
  ENVELOPE_TTL_MS,
};
