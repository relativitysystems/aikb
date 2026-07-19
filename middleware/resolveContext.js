'use strict';

const { validateAuthToken, getMemberByAuthUser } = require('../services/supabaseService');

// ---------------------------------------------------------------------------
// requireMemberContext  (use on all public / client-portal chat routes)
//
// Enforces that the request carries a valid Supabase JWT and that the
// authenticated user is a member of the requested client.
//
// Identity flow:
//   1. Requires Authorization: Bearer <supabase-jwt> — returns 401 if missing
//   2. Validates the JWT via Relativity_Global's auth service — returns 401 if invalid
//   3. Looks up Relativity_Global.client_members using (client_id, auth_user_id)
//      — returns 403 if the user is not a member of this client
//   4. Sets req.context = { clientId, authUserId, memberId, memberRole }
//
// member_id is stored in AIKB as a plain UUID with no FK constraint because
// cross-project (cross-database) foreign keys are not supported in Supabase.
// ---------------------------------------------------------------------------

async function requireMemberContext(req, res, next) {
  const clientId = req.body?.clientId || req.params?.clientId || null;

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const token = authHeader.slice(7);

  let user;
  try {
    user = await validateAuthToken(token);
  } catch {
    return res.status(401).json({ error: 'Authentication failed' });
  }

  if (!user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const authUserId = user.id;
  let memberId = null;
  let memberRole = null;

  if (clientId) {
    let member;
    try {
      // member_id comes from Relativity_Global.client_members — plain UUID, no FK
      member = await getMemberByAuthUser(clientId, authUserId);
    } catch {
      return res.status(401).json({ error: 'Member lookup failed' });
    }

    if (!member) {
      return res.status(403).json({ error: 'Access denied: not a member of this client' });
    }

    memberId = member.id;
    memberRole = member.role;
  }

  req.context = { clientId, authUserId, memberId, memberRole };
  next();
}

module.exports = { requireMemberContext };
