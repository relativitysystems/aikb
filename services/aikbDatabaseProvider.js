'use strict';

// ADR-008 (Architecture repo, decisions/ADR-008-CLIENT-AIKB-DATABASE-ROUTING.md):
// this module is the only place in AIKB permitted to construct or select an
// AIKB Supabase client. Every AIKB-owned database and Storage access path
// (services/supabaseService.js, and anything built on top of it) resolves
// its client through getAikbDatabase(clientId) instead of importing
// @supabase/supabase-js directly.
//
// Current behavior: every valid clientId resolves to the same shared AIKB
// Supabase project, configured via AIKB_SUPABASE_URL /
// AIKB_SUPABASE_SERVICE_KEY / AIKB_STORAGE_BUCKET (config/index.js already
// fails fast at startup if these are missing). No dedicated per-client
// project exists yet, no new Supabase project is created here, and no
// client is migrated by this module.
//
// getAikbDatabase is async even though today's resolution is a synchronous,
// cached lookup. This is a deliberate forward-compatibility tradeoff: every
// call site already does `await getAikbDatabase(clientId)`, so a future
// version that needs to perform a real async lookup (e.g. a
// client_database_assignments row in Relativity_Global, per the ADR's
// "Future Resolution Behavior" section) can be dropped in here without
// touching a single caller. The cost is one microtask tick per call today
// for no present benefit — accepted to avoid a second, signature-breaking
// refactor across every ingestion/retrieval/chat/collection/deletion path
// once dedicated routing is actually built.

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

// Constructed lazily (on first call) and cached for the lifetime of the
// process — every getAikbDatabase call after the first reuses this same
// client instead of creating a new one. Never log this value or anything
// derived from config.supabase.aikb.serviceKey.
let sharedClient = null;

function buildSharedClient() {
  if (!sharedClient) {
    sharedClient = createClient(config.supabase.aikb.url, config.supabase.aikb.serviceKey);
  }
  return sharedClient;
}

function isValidClientId(clientId) {
  return typeof clientId === 'string' && clientId.trim().length > 0;
}

/**
 * Resolves the AIKB database (and Storage) access object for a given
 * client. Callers must pass an already-authorized/service-verified
 * clientId (from req.serviceRequest, req.context, an Inngest event's
 * event.data.clientId, etc.) — never an unvalidated value taken directly
 * from a request body.
 *
 * Fails closed: a missing or malformed clientId throws rather than
 * silently falling back to some default client.
 *
 * @param {string} clientId
 * @returns {Promise<{ supabase: import('@supabase/supabase-js').SupabaseClient, storageBucket: string, mode: 'shared' }>}
 */
async function getAikbDatabase(clientId) {
  if (!isValidClientId(clientId)) {
    throw new Error('getAikbDatabase requires a valid, non-empty clientId');
  }

  // Every branch resolves to the shared project today. A future dedicated-
  // routing implementation would look up a Global routing assignment here
  // and must itself fail closed (throw) rather than silently routing a
  // dedicated client into the shared project — see ADR-008's "Future
  // Resolution Behavior".
  return {
    supabase: buildSharedClient(),
    storageBucket: config.storage.bucket,
    mode: 'shared',
  };
}

/**
 * Cross-client administrative accessor — deliberately separate from the
 * per-tenant contract above. Its only legitimate caller is an operation
 * that by definition spans every client in the shared project (currently:
 * services/supabaseService.js#getDistinctClientIds). Tenant-owned
 * database or Storage paths must always resolve through
 * getAikbDatabase(clientId), never this function.
 *
 * @returns {{ supabase: import('@supabase/supabase-js').SupabaseClient, storageBucket: string, mode: 'shared' }}
 */
function getSharedAikbDatabaseForAdminOperation() {
  return {
    supabase: buildSharedClient(),
    storageBucket: config.storage.bucket,
    mode: 'shared',
  };
}

module.exports = {
  getAikbDatabase,
  getSharedAikbDatabaseForAdminOperation,
};
