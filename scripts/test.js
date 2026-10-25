/**
 * Run every test file, one child process each.
 *
 * Why not `node --test "test/*.test.js"`: on this host that glob runs each file in a
 * spawned subprocess and fails with `spawn EPERM` under the sandbox the agent often
 * works in — so the suite was unrunnable exactly where it was most needed, and the
 * documented workaround was "run each file by hand", which nobody does reliably.
 * This runner spawns the same children directly, which the sandbox permits, and
 * turns a green run into one summary line.
 *
 * It also makes the total visible: a stale count in a doc is how "91 tests" stayed
 * written as "75" for a day.
 *
 * @module @local/dsh-opendesign-member/scripts/test
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDirectory = path.join(root, 'test');

const entries = await readdir(testDirectory, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
  .map((entry) => entry.name)
  .sort();

if (files.length === 0) {
  console.error('test: found no *.test.js files — the discovery rule is wrong');
  process.exit(1);
}

let total = 0;
let failed = 0;
const failures = [];

for (const name of files) {
  const file = path.join(testDirectory, name);
  try {
    const { stdout } = await run(process.execPath, [file], { maxBuffer: 16 * 1024 * 1024 });
    const pass = /^# pass (\d+)$/m.exec(stdout) ?? /pass (\d+)/.exec(stdout);
    const fail = /^# fail (\d+)$/m.exec(stdout) ?? /fail (\d+)/.exec(stdout);
    const passed = pass ? Number(pass[1]) : 0;
    const broken = fail ? Number(fail[1]) : 0;
    total += passed + broken;
    failed += broken;
    if (broken > 0) failures.push({ name, count: broken, detail: stdout });
    console.log(`${broken > 0 ? '✖' : '✔'} ${name.padEnd(34)} ${passed} passed${broken > 0 ? `, ${broken} failed` : ''}`);
  } catch (error) {
    // A file that exits non-zero has failing assertions in its own output; capture
    // it so the summary is not the only thing the caller sees.
    const stdout = String(error.stdout ?? '');
    const pass = /pass (\d+)/.exec(stdout);
    const fail = /fail (\d+)/.exec(stdout);
    const passed = pass ? Number(pass[1]) : 0;
    const broken = fail ? Number(fail[1]) : 1;
    total += passed + broken;
    failed += broken;
    failures.push({ name, count: broken, detail: stdout || String(error.message) });
    console.log(`✖ ${name.padEnd(34)} ${passed} passed, ${broken} failed`);
  }
}

if (failed > 0) {
  for (const failure of failures) {
    console.error(`\n=== ${failure.name} ===\n${failure.detail.split('\n').filter((line) => /✖|AssertionError|expected|actual/.test(line)).join('\n')}`);
  }
  console.error(`\n${failed} failed of ${total} tests in ${files.length} file(s)`);
  process.exit(1);
}

console.log(`\n${total} tests passed in ${files.length} file(s)`);
