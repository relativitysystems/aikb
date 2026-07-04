'use strict';

/**
 * Quick smoke-test for parseDocument with DOCX input.
 *
 * Usage:
 *   node scripts/testDocxParse.js path/to/file.docx
 *
 * Prints the extracted text length and a preview.
 */

const path = require('path');
const fs = require('fs');
const { parseDocument } = require('../services/documentParser');

async function main() {
  const docxPath = process.argv[2];
  if (!docxPath) {
    console.error('Usage: node scripts/testDocxParse.js <path-to-docx>');
    process.exit(1);
  }

  const resolved = path.resolve(docxPath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(resolved);
  console.log(`\nLoaded: ${path.basename(resolved)} (${buffer.length.toLocaleString()} bytes)`);

  const mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const result = await parseDocument(buffer, mimeType, path.basename(resolved));

  console.log(`Page count : ${result.pages.length} (expected 0 — DOCX has no page metadata)`);
  console.log(`Total chars: ${result.text.length.toLocaleString()}`);
  console.log(`\n--- Preview ---`);
  console.log(result.text.slice(0, 500));
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
