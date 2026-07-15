'use strict';

// Calls Relativity's POST /api/integrations/slack/deliver once a
// Slack-originated question has an answer (or has definitively failed) —
// Architecture Review Phase 4, Milestone 4, §4.3, §4.8. Signs the request
// with the same additive HMAC service-request envelope used the other
// direction for POST /api/knowledge/ask (services/serviceRequestAuth.js),
// reversed: AIKB signs here, Relativity verifies.
//
// Never sends a Slack token (AIKB never has one) — only the answer,
// citations, and narrow origin metadata already known to this call.

const config = require('../config');
const { signServiceRequest } = require('./serviceRequestAuth');

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'RELATIVITY_DELIVER_NOT_CONFIGURED',
  HTTP_ERROR: 'RELATIVITY_DELIVER_HTTP_ERROR',
  TIMEOUT: 'RELATIVITY_DELIVER_TIMEOUT',
});

function createRelativityDeliverError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.idempotencyKey - echoed back exactly as received on POST /ask.
 * @param {object} params.payload - either { answer, sources, isKnowledgeGap, gapReason, sessionId } or { error: true, errorCode }.
 */
async function deliverResult({ clientId, idempotencyKey, payload }) {
  const baseUrl = config.relativity.apiBaseUrl;
  const signingSecret = config.serviceRequest.signingSecret;

  if (!baseUrl || !signingSecret) {
    throw createRelativityDeliverError(ERROR_CODES.NOT_CONFIGURED, 'Relativity deliver callback is not configured on this server.');
  }

  const envelope = signServiceRequest({ clientId, idempotencyKey, payload, secret: signingSecret });

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/integrations/slack/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload }),
      signal: AbortSignal.timeout(config.relativity.deliverTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw createRelativityDeliverError(ERROR_CODES.TIMEOUT, 'Relativity deliver callback timed out.');
    }
    throw createRelativityDeliverError(ERROR_CODES.HTTP_ERROR, 'Relativity deliver callback failed.');
  }

  if (!response.ok) {
    throw createRelativityDeliverError(ERROR_CODES.HTTP_ERROR, `Relativity deliver callback returned HTTP ${response.status}.`);
  }

  return { delivered: true };
}

module.exports = { deliverResult, ERROR_CODES };
