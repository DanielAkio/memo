#!/usr/bin/env node
// PreToolUse hook for Read: blocks reading a large file whole (no offset/limit),
// so Claude greps for the section it needs instead of spending 10-35k tokens.
// Images and PDFs are left alone. Override per call by passing offset/limit.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 40 * 1024;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.icns', '.pdf']);

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const args = input.tool_input || {};
  const file = args.file_path;
  if (!file || args.offset != null || args.limit != null) process.exit(0);
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) process.exit(0);
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    process.exit(0);
  }
  if (size <= MAX_BYTES) process.exit(0);
  process.stderr.write(
    `${path.basename(file)} is ${Math.round(size / 1024)} KB. Don't read it whole: ` +
      'grep for the symbol or section you need (see the memo-code-map skill), ' +
      'then Read with offset/limit around it.\n'
  );
  process.exit(2);
});
