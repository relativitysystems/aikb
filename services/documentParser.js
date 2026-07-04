'use strict';

class UnsupportedMimeTypeError extends Error {
  constructor(mimeType) {
    super(`Unsupported MIME type: ${mimeType}`);
    this.name = 'UnsupportedMimeTypeError';
    this.mimeType = mimeType;
  }
}

// Maximum time to wait for a single pdfParse() call before giving up.
const PDF_PARSE_TIMEOUT_MS = 60_000;

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Some upload paths (browser file pickers, generic storage clients) hand back a
// generic content-type instead of the real DOCX MIME type. When that happens,
// fall back to the file extension so local uploads and Google Drive imports —
// which both flow through the same portal_upload ingest event — resolve to the
// same parser branch.
const GENERIC_MIME_TYPES = new Set(['application/octet-stream', 'application/zip', '']);

/**
 * Extract plain text from a DOCX buffer via mammoth.
 */
async function parseDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return { text: cleanText(result.value || ''), pages: [] };
}

/**
 * Wraps a pdfParse() call with a hard timeout so that a hanging
 * getTextContent() inside pdf.js cannot freeze the Inngest step indefinitely.
 */
function parsePdf(buffer, opts) {
  const pdfParse = require('pdf-parse');
  return new Promise((resolve, reject) => {
    const id = setTimeout(
      () => reject(new Error(`PDF parsing timed out after ${PDF_PARSE_TIMEOUT_MS / 1000}s`)),
      PDF_PARSE_TIMEOUT_MS
    );
    pdfParse(buffer, opts).then(
      (r) => { clearTimeout(id); resolve(r); },
      (e) => { clearTimeout(id); reject(e); }
    );
  });
}

/**
 * Extract plain text from a document buffer.
 *
 * Supported MIME types:
 *   text/plain, text/markdown, text/csv  — decoded as UTF-8
 *   application/pdf                      — extracted via pdf-parse
 *   .docx (openxmlformats wordprocessingml) — extracted via mammoth
 *   application/vnd.google-apps.*        — should never reach here;
 *                                          googleDriveService exports Google Docs as text/plain
 *
 * Throws UnsupportedMimeTypeError for unrecognised types.
 *
 * @param {Buffer} buffer    Raw file content
 * @param {string} mimeType  MIME type string
 * @param {string} fileName  Used only for error messages
 * @returns {Promise<{ text: string, pages: Array<{ pageNumber: number, text: string }> } | string>}
 */
async function parseDocument(buffer, mimeType, fileName) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError('parseDocument: buffer must be a Buffer');
  }

  let type = (mimeType || '').toLowerCase().split(';')[0].trim();

  // Normalize generic/missing MIME types to DOCX when the file extension says so.
  if (GENERIC_MIME_TYPES.has(type) && /\.docx$/i.test(fileName || '')) {
    type = DOCX_MIME;
  }

  if (type === 'text/plain' || type === 'text/markdown' || type === 'text/csv' || type === '') {
    return cleanText(buffer.toString('utf8'));
  }

  if (type === DOCX_MIME) {
    return parseDocx(buffer);
  }

  if (type === 'application/pdf') {
    // Do NOT use a custom pagerender callback.  The async getTextContent()
    // call on the pdf.js page proxy can hang indefinitely for certain PDF
    // structures, leaving the Promise unresolved and the Inngest step frozen
    // with no error ever logged.
    //
    // Instead we use pdf-parse's built-in renderer (which passes proper
    // normalizeWhitespace options to getTextContent) and reconstruct per-page
    // text via differential parsing: pdfParse(buffer, { max: N }).text
    // contains the concatenated text of pages 1..N separated by "\n\n", so
    // slicing off the previous cumulative string isolates page N.

    // Full parse — gives us the complete text and the total page count.
    const fullResult = await parsePdf(buffer);
    const numPages = fullResult.numpages;
    const fullText = cleanText(fullResult.text);

    if (numPages === 0) {
      return { text: fullText, pages: [] };
    }

    if (numPages === 1) {
      return { text: fullText, pages: [{ pageNumber: 1, text: fullText }] };
    }

    // Multi-page: derive each page's text by slicing the cumulative string.
    // We reuse fullResult for the last page to save one extra pdfParse call.
    const pages = [];
    let cumulative = '';
    for (let i = 1; i <= numPages; i++) {
      const r = i === numPages ? fullResult : await parsePdf(buffer, { max: i });
      const rawPage = r.text.slice(cumulative.length);
      pages.push({ pageNumber: i, text: cleanText(rawPage) });
      cumulative = r.text;
    }

    return { text: fullText, pages };
  }

  // Google Docs exports should have already been converted to text/plain by googleDriveService
  if (type.startsWith('application/vnd.google-apps.')) {
    throw new UnsupportedMimeTypeError(
      `${mimeType} — Google Docs must be exported as text/plain before parsing`
    );
  }

  throw new UnsupportedMimeTypeError(mimeType || 'unknown');
}

/**
 * Strip null bytes, control characters (except newlines/tabs), and
 * collapse runs of blank lines down to two newlines.
 */
function cleanText(text) {
  return text
    .replace(/\0/g, '')                          // null bytes
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '') // control chars (keep \t \n \r)
    .replace(/\r\n/g, '\n')                      // normalise line endings
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')                  // collapse excess blank lines
    .trim();
}

module.exports = { parseDocument, cleanText, UnsupportedMimeTypeError };
