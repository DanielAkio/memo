// UserPromptSubmit hook: every request that changes or fixes Memo comes with
// a test that keeps it from coming back (see "Tests for every change" in
// .ai/RULES.md). Prints the reminder the assistant gets with the prompt;
// plain questions get nothing. LLM-agnostic: any tool that runs a command
// on a new prompt can point here.
import { readFileSync } from 'fs';

let prompt = '';
try {
  prompt = JSON.parse(readFileSync(0, 'utf8')).prompt || '';
} catch {
  // no JSON on stdin: remind anyway
}

// A change or fix, in English or Portuguese (a question alone is not).
const CHANGE = /\b(fix|bug|broken|change|add|remove|should|must|make|improve|not working|doesn'?t|isn'?t|corrig|consert|mud[ae]|alter|adicion|remov|exclu|dev[ea]|precis|melhor|n[aã]o (est[aá]|funciona|consigo))/i;
if (prompt && !CHANGE.test(prompt)) process.exit(0);

console.log([
  'Memo rule (.ai/RULES.md, "Tests for every change"): each change or fix asked in this prompt gets a',
  'regression test in the same change, so it is checked from now on: a step in tools/test-ui.mjs',
  '(stage or Memo Web), a cargo test (store.rs, share.rs, ...) or a check in tools/check.mjs.',
  'Run `npm test` before saying it is done.',
].join(' '));
