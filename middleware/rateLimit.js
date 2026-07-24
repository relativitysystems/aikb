'use strict';

// Backlog M6 — general-purpose rate limiting for AIKB's x-api-key-gated
// routes (/api/knowledge/*). Relativity is this API's only expected
// caller, so the limit is generous — this exists as a defense-in-depth cap
// against a leaked x-api-key/service-request secret being hammered from an
// unexpected source, or a runaway retry loop, not as a per-tenant quota
// (per-client entitlement is handled separately, at the route level).
//
// In-memory (express-rate-limit's default MemoryStore) — adequate for this
// service's current single-instance deployment; a future multi-instance
// deployment would need a shared store (e.g. Redis) instead.

const rateLimit = require('express-rate-limit');
const config = require('../config');

const knowledgeApiLimiter = rateLimit({
  windowMs: config.rateLimit.knowledgeApi.windowMs,
  limit: config.rateLimit.knowledgeApi.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

module.exports = { knowledgeApiLimiter };
