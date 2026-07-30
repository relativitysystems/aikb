'use strict';

// EL3 (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §1.1 step 7, ADR-010)
// — signs and calls Relativity's POST /api/tools/execute. Sibling to
// services/relativityDeliverClient.js, same template (config.relativity.*,
// signServiceRequest, global fetch + AbortSignal.timeout, a frozen
// ERROR_CODES triplet). Unlike deliverResult, this DOES parse and return
// the response body — the tool result is the actual data the caller needs,
// matching relativityTickClient.js#callTick's pattern, not deliverResult's
// ignore-the-body pattern.
//
// Not called from anywhere yet — no route or Inngest function wires this
// in this milestone. That's EL5 (AIKB orchestration/tool-calling).

const config = require('../config');
const { signServiceRequest } = require('./serviceRequestAuth');

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'TOOL_EXECUTE_NOT_CONFIGURED',
  HTTP_ERROR: 'TOOL_EXECUTE_HTTP_ERROR',
  TIMEOUT: 'TOOL_EXECUTE_TIMEOUT',
});

function createToolExecuteError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * @param {object} params
 * @param {string} params.clientId
 * @param {string} params.idempotencyKey
 * @param {string} params.toolName
 * @param {object} [params.args]
 * @param {string} [params.requestingMemberId]
 * @param {string} [params.origin]
 * @param {object} [params.originMetadata]
 * @returns {Promise<object>} the tool's result, exactly as Relativity returned it.
 */
async function executeTool({ clientId, idempotencyKey, toolName, args, requestingMemberId, origin, originMetadata }) {
  const baseUrl = config.relativity.apiBaseUrl;
  const signingSecret = config.serviceRequest.signingSecret;

  if (!baseUrl || !signingSecret) {
    throw createToolExecuteError(ERROR_CODES.NOT_CONFIGURED, 'Tool execution call is not configured on this server.');
  }

  const payload = { toolName, args, requestingMemberId, origin, originMetadata };
  const envelope = signServiceRequest({ clientId, idempotencyKey, payload, secret: signingSecret });

  let response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, payload }),
      signal: AbortSignal.timeout(config.relativity.toolExecuteTimeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw createToolExecuteError(ERROR_CODES.TIMEOUT, 'Tool execution call timed out.');
    }
    throw createToolExecuteError(ERROR_CODES.HTTP_ERROR, 'Tool execution call failed.');
  }

  if (!response.ok) {
    throw createToolExecuteError(ERROR_CODES.HTTP_ERROR, `Tool execution call returned HTTP ${response.status}.`);
  }

  return response.json();
}

module.exports = { executeTool, ERROR_CODES };
