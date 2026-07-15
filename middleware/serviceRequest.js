'use strict';

// Verifies the additive HMAC service-request envelope on inbound
// Relativity -> AIKB requests (Architecture Review Phase 4, Milestone 4,
// §4.10) — currently only POST /api/knowledge/ask. Sits ALONGSIDE the
// existing router-level requireApiKey gate (routes/knowledge.js), not
// instead of it — defense in depth, unchanged for every other route.
//
// clientId must be read from req.serviceRequest ONLY, never from
// req.body.clientId or req.body.payload — the envelope is the sole trusted
// source for it on this route.

const config = require('../config');
const { verifyServiceRequest } = require('../services/serviceRequestAuth');

function requireServiceRequest(req, res, next) {
  const secret = config.serviceRequest && config.serviceRequest.signingSecret;
  if (!secret) {
    return res.status(500).json({ error: 'Service request signing is not configured on this server.' });
  }

  const body = req.body || {};
  const { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature, payload } = body;

  const result = verifyServiceRequest({
    envelope: { requestId, issuedAt, expiresAt, clientId, idempotencyKey, signature },
    payload,
    secret,
  });

  if (!result.ok) {
    return res.status(401).json({ error: 'Invalid service request.' });
  }

  req.serviceRequest = { clientId: result.clientId, idempotencyKey: result.idempotencyKey, requestId: result.requestId };
  req.servicePayload = payload || {};
  next();
}

module.exports = { requireServiceRequest };
