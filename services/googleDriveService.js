'use strict';

const { google } = require('googleapis');
const config = require('../config');

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getAuth() {
  if (!config.googleDrive.serviceAccountEmail || !config.googleDrive.privateKey) {
    throw new Error(
      'Google Drive service account credentials are not configured. ' +
      'Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in .env'
    );
  }
  return new google.auth.JWT({
    email: config.googleDrive.serviceAccountEmail,
    key: config.googleDrive.privateKey,
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file', // needed for temp copy + delete
    ],
  });
}

function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuth() });
}

// ---------------------------------------------------------------------------
// File listing
// ---------------------------------------------------------------------------

/**
 * List all non-folder files directly inside a Drive folder.
 * Returns: [{ id, name, mimeType, md5Checksum, modifiedTime }]
 */
async function listFolderFiles(folderId) {
  const drive = getDriveClient();
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, md5Checksum, modifiedTime)',
      pageSize: config.googleDrive.pageSize,
      pageToken: pageToken || undefined,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

// ---------------------------------------------------------------------------
// File metadata
// ---------------------------------------------------------------------------

async function getFileMetadata(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, md5Checksum, modifiedTime',
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// File download
// ---------------------------------------------------------------------------

/**
 * Download a Drive file and return a Buffer.
 *
 * Handles:
 *   - Google Docs  → exported as text/plain (no md5Checksum from Drive; compare modifiedTime instead)
 *   - PDF          → downloaded as binary (parsed by documentParser with pdf-parse)
 *   - text/plain, text/markdown, text/csv → downloaded directly
 *
 * @param {string} fileId
 * @param {string} mimeType  MIME type from Drive metadata
 * @returns {Promise<{ buffer: Buffer, resolvedMimeType: string }>}
 */
async function downloadFileAsText(fileId, mimeType) {
  const drive = getDriveClient();

  // Google Workspace formats must be exported, not downloaded
  if (mimeType === 'application/vnd.google-apps.document') {
    return _exportGoogleDoc(drive, fileId);
  }

  if (
    mimeType === 'application/vnd.google-apps.spreadsheet' ||
    mimeType === 'application/vnd.google-apps.presentation'
  ) {
    return _exportGoogleDoc(drive, fileId, 'text/plain');
  }

  // Binary download for everything else (PDF, plain text, markdown, etc.)
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );
  return {
    buffer: Buffer.from(res.data),
    resolvedMimeType: mimeType,
  };
}

async function _exportGoogleDoc(drive, fileId, exportMimeType = 'text/plain') {
  const res = await drive.files.export(
    { fileId, mimeType: exportMimeType },
    { responseType: 'arraybuffer' }
  );
  return {
    buffer: Buffer.from(res.data),
    resolvedMimeType: exportMimeType,
  };
}

// ---------------------------------------------------------------------------
// Temp copy helpers (stubs — kept for future use if Google's export path is needed for PDFs)
// ---------------------------------------------------------------------------

/**
 * Copy a file as a Google Doc (used in n8n for PDF conversion).
 * In this implementation, PDFs are parsed locally via pdf-parse.
 * This stub is here for future use if the Google conversion path is preferred.
 */
async function _copyAsTempGoogleDoc(fileId) {
  const drive = getDriveClient();
  const res = await drive.files.copy({
    fileId,
    requestBody: {
      mimeType: 'application/vnd.google-apps.document',
      name: `__tmp_rkb_${fileId}`,
    },
  });
  return res.data.id;
}

async function _deleteTempDoc(fileId) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

module.exports = {
  listFolderFiles,
  getFileMetadata,
  downloadFileAsText,
  _copyAsTempGoogleDoc,
  _deleteTempDoc,
};
