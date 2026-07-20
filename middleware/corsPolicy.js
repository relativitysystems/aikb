'use strict';

// Backlog M6 — explicit CORS policy. AIKB's API is only ever called
// server-to-server (Relativity's backend, and Slack's own signed webhook
// via routes/slack.js) — never from a browser — so there is no origin to
// allow-list. `origin: false` makes that a documented decision (no
// Access-Control-Allow-Origin header is ever sent) rather than an
// accidental gap from never having configured CORS at all. Server-to-server
// callers never send an Origin header and are unaffected either way; each
// is already authenticated by its own mechanism (x-api-key,
// requireServiceRequest, Slack signature).

const cors = require('cors');

module.exports = cors({ origin: false });
