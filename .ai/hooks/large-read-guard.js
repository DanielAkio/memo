#!/usr/bin/env node
// PreToolUse hook for Read (Claude Code) and read_file (Antigravity):
// blocks reading a large file whole (no offset/limit or StartLine/EndLine),
// so the agent greps for the section it needs instead of spending 10-35k tokens.
// For Antigravity, also enforces the same read-deny paths as .claude/settings.json.
// Images and PDFs are left alone. Override per call by passing a line range.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 40 * 1024;
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.icns', '.pdf']);
const DENY_RE = /(?:^|\/)(?:src\/vendor\/|src-tauri\/icons\/|assets\/|src-tauri\/Cargo\.lock$|package-lock\.json$|src-tauri\/target\/|src-tauri\/gen\/|node_modules\/|dist\/)/;

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const isAgy = Boolean(input && input.toolCall);
  const allow = () => {
    if (isAgy) process.stdout.write(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  };
  const deny = (reason) => {
    if (isAgy) {
      process.stdout.write(JSON.stringify({ decision: 'deny', reason }));
      process.exit(0);
    }
    process.stderr.write(reason + '\n');
    process.exit(2);
  };

  const args = (isAgy ? input.toolCall.args : input.tool_input) || {};
  const file = isAgy ? args.Path : args.file_path;
  if (!file) return allow();

  if (isAgy) {
    const norm = file.replace(/\\/g, '/');
    if (DENY_RE.test(norm)) {
      return deny(`Reading ${path.basename(file)} is denied by project rules (see .ai/RULES.md).`);
    }
  }

  const hasRange = isAgy
    ? args.StartLine != null || args.EndLine != null || args.ByteOffset != null
    : args.offset != null || args.limit != null;
  if (hasRange) return allow();
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) return allow();

  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return allow();
  }
  if (size <= MAX_BYTES) return allow();

  deny(
    `${path.basename(file)} is ${Math.round(size / 1024)} KB. Don't read it whole: ` +
      'grep for the symbol or section you need (see the memo-code-map skill), ' +
      'then Read with offset/limit (or StartLine/EndLine) around it.'
  );
});
