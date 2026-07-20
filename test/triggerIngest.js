#!/usr/bin/env node
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { signServiceRequest } = require('../services/serviceRequestAuth');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API_KEY  = process.env.API_KEY  || '';
// POST /ingest requires the same signed envelope as POST /ask (backlog H4)
// — see middleware/serviceRequest.js.
const SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || '';

// ---------------------------------------------------------------------------
// Edit these values to match a real file uploaded to Supabase Storage.
// See test/triggerPortalIngest.js for the recommended portal upload test script.
// ---------------------------------------------------------------------------
const CLIENT_ID      = process.env.TEST_CLIENT_ID    || 'replace-with-a-valid-uuid';
const SOURCE_FILE_ID = process.env.TEST_FILE_ID      || 'replace-with-a-stable-file-id';
const FILE_NAME      = process.env.TEST_FILE_NAME    || 'sample_plain.txt';
const MIME_TYPE      = process.env.TEST_MIME_TYPE    || 'text/plain';
const STORAGE_PATH   = process.env.TEST_STORAGE_PATH || `uploads/${CLIENT_ID}/${FILE_NAME}`;

async function main() {
  console.log(`Triggering ingest for file: ${FILE_NAME} (${SOURCE_FILE_ID})`);
  console.log(`Client ID: ${CLIENT_ID}`);
  console.log(`Server: ${BASE_URL}`);
  console.log('');

  const payload = {
    sourceFileId: SOURCE_FILE_ID,
    fileName: FILE_NAME,
    mimeType: MIME_TYPE,
    sourceProvider: 'portal_upload',
    storagePath: STORAGE_PATH,
  };
  const envelope = signServiceRequest({
    clientId: CLIENT_ID,
    idempotencyKey: crypto.randomUUID(),
    payload,
    secret: SIGNING_SECRET,
  });

  const res = await fetch(`${BASE_URL}/api/knowledge/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
    },
    body: JSON.stringify({ ...envelope, payload }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error('Error:', body);
    process.exit(1);
  }

  console.log('Ingest event queued successfully:');
  console.log(JSON.stringify(body, null, 2));
  console.log('');
  console.log('Watch the Inngest dev dashboard for step progress:');
  console.log('  http://localhost:8288');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
