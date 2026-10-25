/**
 * Syntax-check every source file in this package.
 *
 * Why this exists instead of a hard-coded list in package.json: the list was
 * written once and silently stopped covering new files. Measured 2026-10-26: four
 * modules added over a day of work — `turn-plan.js`, `watch.js`,
 * `conversation-watch.js`, `turn-actions.js` — were not in the chain, and a
 * deliberately injected syntax error in `lib/watch.js` left `npm run check`
 * reporting success. A guardrail that passes on broken code is worse than none,
 * because it gets trusted.
 *
 * So the file set comes from the filesystem, never from a hand-maintained list
 * that can drift out of step with reality.
 *
 * Runs `node --check` once per file, in-process-independent, and reports every
 * failure rather than stopping at the first: a broken edit usually breaks one file,
 * but seeing all of them at once is what makes a single fix pass possible.
 *
 * @module @local/dsh-opendesign-member/scripts/check
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every JavaScript file this package ships, discovered rather than listed.
 *
 * `scripts/` is included so the checker itself is checked — an unparseable checker
 * would otherwise fail with a confusing stack trace instead of a clear one.
 *
 * @returns absolute paths, sorted for stable output.
 */
async function sourceFiles() {
  const files = [];
  const topLevel = await readdir(root, { withFileTypes: true });
  for (const entry of topLevel) {
    if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(root, entry.name));
  }
  for (const directory of ['lib', 'scripts', 'test']) {
    let entries;
    try {
      entries = await readdir(path.join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.join(root, directory, entry.name));
      }
    }
  }
  return files.sort();
}

const files = await sourceFiles();
if (files.length === 0) {
  console.error('check: found no source files — the discovery rule is wrong');
  process.exit(1);
}

const failures = [];
for (const file of files) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    failures.push({ file: path.relative(root, file), detail: String(error.stderr ?? error.message).trim() });
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n✖ ${failure.file}\n${failure.detail}`);
  }
  console.error(`\ncheck failed: ${failures.length} of ${files.length} file(s) do not parse`);
  process.exit(1);
}

console.log(`check passed: ${files.length} file(s) parse`);
