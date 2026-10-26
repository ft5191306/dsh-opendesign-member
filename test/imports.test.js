/**
 * Import-integrity guard for `index.js`.
 *
 * Why this exists (a real defect found by a live session, not by review): the
 * watcher's "query could not be made" branch called `observeConversation({})`,
 * a function exported by `lib/conversation-watch.js` — and never imported it.
 * `node --check` passes (syntax is fine), every unit test passes (each module is
 * tested on its own), and the failure only appears at runtime as
 * `ReferenceError: observeConversation is not defined` inside a `try/catch` of a
 * long-lived job: the watcher then reports "not ready yet" forever and never a
 * single status change. That is precisely the shape of bug a green suite hides.
 *
 * The guard is deliberately narrow: for every function/class a local `lib/`
 * module exports, if `index.js` calls it, `index.js` must import it from that
 * module. Calls only (`name(`), because a bare identifier would collide with
 * ordinary words in comments and strings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');

/** Every `export function|async function|class|const|let` name in one module. */
function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  return names;
}

/** The exact `import { ... } from './lib/<module>'` clause in index.js, if any. */
function importClauseFor(moduleName) {
  const pattern = new RegExp(`import\\s*\\{([\\s\\S]*?)\\}\\s*from\\s*'\\./lib/${moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
  const match = indexSource.match(pattern);
  return match === null ? undefined : match[1];
}

test('imports: every local lib function index.js calls is imported from that module', async () => {
  const libDir = new URL('../lib/', import.meta.url);
  const files = (await readdir(libDir)).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 8, 'expected the plugin lib modules to be discoverable');

  const missing = [];
  for (const file of files) {
    const source = await readFile(new URL(file, libDir), 'utf8');
    const clause = importClauseFor(file);
    for (const name of exportedNames(source)) {
      // Only names index.js actually invokes; a module exporting something used
      // exclusively by another module (e.g. an event parser) needs no import.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(indexSource)) continue;
      if (clause === undefined || !new RegExp(`\\b${name}\\b`).test(clause)) {
        missing.push(`${name} (called in index.js, exported by lib/${file}, not imported)`);
      }
    }
  }

  assert.deepEqual(
    missing,
    [],
    `an unimported local call throws ReferenceError only at runtime:\n${missing.join('\n')}`,
  );
});

test('imports: the watcher recovery branch uses an imported observation helper', () => {
  // Pinned by name as well, because this is the exact defect that shipped: the
  // branch is inside a try/catch, so the ReferenceError became a permanent
  // "not ready yet" line instead of a visible crash.
  const clause = importClauseFor('conversation-watch.js');
  assert.notEqual(clause, undefined, 'index.js must import from lib/conversation-watch.js');
  for (const required of ['observeConversation', 'observeRun', 'diffConversation']) {
    if (new RegExp(`\\b${required}\\s*\\(`).test(indexSource)) {
      assert.match(clause, new RegExp(`\\b${required}\\b`), `${required} is called but not imported`);
    }
  }
});
