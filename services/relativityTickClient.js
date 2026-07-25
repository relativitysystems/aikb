'use strict';

// Calls Relativity's POST /api/integrations/email/sync/tick on a cron
// interval — the automatic-sync scheduler (EM8 — EMAIL_INGESTION.md §18.3).
// Mirrors services/relativityDeliverClient.js's shape exactly, but signs
// with the SYSTEM-SCOPED envelope (signSystemServiceRequest), not the
// clientId-scoped one — this call carries zero client-specific or
// provider-specific data by design: it does not know which clients have
// email connections, never touches oauth_connections, and never becomes
// provider-aware. It contributes only "a clock" — see services/
// serviceRequestAuth.js's system-scoped-envelope comment and
// EMAIL_INGESTION.md §9/§18.3/§30 item 5 for the ADR-001 boundary this is a
// narrow, deliberate exception to.

const config = require('../config');
const { signSystemServiceRequest } = require('./serviceRequestAuth');

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'RELATIVITY_TICK_NOT_CONFIGURED',
  HTTP_ERROR: 'RELATIVITY_TICK_HTTP_ERROR',
  TIMEOUT: 'RELATIVITY_TICK_TIMEOUT',
});

function createRelativityTickError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @returns {Promise<{processed:number, succeeded:number, failed:number, connectionIds:string[]}>}
 */
async function callTick() {
  const baseUrl = config.relativity.apiBaseUrl;
  const signingSecret = config.serviceRequest.signingSecret;

  if (!baseUrl || !signingSecret) {
    throw createRelativityTickError(ERROR_CODES.NOT_CONFIGURED, 'Relativity tick callback is not configured on this server.');
  }

  // A fresh idempotency key per call — this endpoint is naturally idempotent
  // per-connection anyway (§20's existing dedup key), so this exists only to
  // satisfy the shared envelope's required field, not to dedupe tick calls
  // themselves.
  const idempotencyKey = `email-sync-tick:${new Date().toISOString()}`;
  const payload = {};
  const envelope = signSystemServiceRequest({ idempotencyKey, payload, secret: signingSecret });

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/integrations/email/sync/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload }),
      signal: AbortSignal.timeout(config.relativity.tickTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw createRelativityTickError(ERROR_CODES.TIMEOUT, 'Relativity tick callback timed out.');
    }
    throw createRelativityTickError(ERROR_CODES.HTTP_ERROR, 'Relativity tick callback failed.');
  }

  if (!response.ok) {
    throw createRelativityTickError(ERROR_CODES.HTTP_ERROR, `Relativity tick callback returned HTTP ${response.status}.`);
  }

  return response.json();
}

module.exports = { callTick, ERROR_CODES };
