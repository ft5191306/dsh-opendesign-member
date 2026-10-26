/**
 * Tests for `reconcileWatch` — deciding what a conversation is doing right now.
 *
 * The failure these exist to prevent, hit live on 2026-10-26: Open Design had a
 * turn executing (project status `running`, `active-count: 1`) while the bridge
 * reported `pendingRun: null`. The caller saw a tool that neither answered nor
 * failed, and read it as "stuck".
 *
 * Four invariants:
 *   1. A live run the daemon reports wins over a missing bridge record.
 *   2. A failed lookup is UNKNOWN — reported as its own third state, never
 *      flattened into busy or idle. See the note on the unreadable-run test for
 *      both measured consequences of getting this wrong.
 *   3. A verdict always names the run and how to collect it, so the caller never
 *      has to guess whether to collect or re-send.
 *   4. `busy` stays present and boolean for the callers that only ask "is it
 *      busy?" — `null` means unknown, and `=== true` is still the right test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isSettledRun, reconcileWatch } from '../lib/watch.js';

/**
 * The watcher's structure, asserted on the tool source.
 *
 * Checked against the file because these are properties of HOW the loop is
 * written, and a regression there is invisible to every pure-function test above.
 * Two real failures motivate each assertion:
 *
 *   - Two copies of the loop drifted: one provisioned projects via `ensureProject`
 *     and sat inside an import for minutes when the daemon returned an empty data
 *     directory, which is exactly what "the watcher never started" looked like.
 *   - The cached job id was returned without checking the job was alive, so after a
 *     restart the caller polled `job_output` forever and saw nothing.
 */
test('there is exactly ONE watcher loop, and it only reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

  // One implementation. `armWatcher` starts the job; both `opendesign_watch` and
  // `opendesign_ask` call it.
  assert.equal(
    (source.match(/jobs\.start\(/g) ?? []).length,
    1,
    'a second jobs.start means a second watcher implementation, which will drift',
  );

  const arm = source.slice(source.indexOf('function armWatcher'));
  const body = arm.slice(0, arm.indexOf('\n  /**\n   * Run one Open Design turn'));
  // Strip comments: the body NAMES the calls it must not make, explaining why.
  const code = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  assert.equal(/ensureProject\(/.test(code), false, 'the watcher must not provision');
  assert.equal(/ensureConversation\(/.test(code), false, 'the watcher must not provision');
  assert.equal(/discoverDaemon\(/.test(code), false, 'the watcher must not run its own discovery');
});

test('arming twice for one conversation yields one live job', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

  const arm = source.slice(source.indexOf('function armWatcher'));
  const body = arm.slice(0, arm.indexOf('\n  /**\n   * Run one Open Design turn'));

  // Idempotency has to check the recorded job is ALIVE, not merely remembered: the
  // map is process memory, and a job can be killed while the map still names it.
  // Handing back a dead id is worse than starting a second watcher — the caller
  // would poll forever and see nothing.
  assert.match(body, /jobs\.get\(/, 'arming must check the recorded job still exists');
  assert.match(body, /status === 'running'/, 'only a live status may be reused');
  assert.match(body, /armed\.delete\(/, 'a dead record must be replaced, not returned');
});

test('isSettledRun: terminal status or a terminal timestamp, never a nonzero code', () => {
  assert.equal(isSettledRun({ status: 'succeeded' }), true);
  assert.equal(isSettledRun({ status: 'canceled' }), true);
  assert.equal(isSettledRun({ status: 'succeeded', exitCode: 1 }), true);
  assert.equal(isSettledRun({ status: 'weird', terminalAt: 1 }), true);
  assert.equal(isSettledRun({ status: 'running' }), false);
  assert.equal(isSettledRun(undefined), false);
  assert.equal(isSettledRun(null), false);
});

test('reconcileWatch: a live run the daemon reports beats a missing bridge record', () => {
  const verdict = reconcileWatch({
    pendingRun: undefined,
    conversationRun: { runId: 'run-live', status: 'running' },
  });

  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.runId, 'run-live');
  // The source matters: "the bridge lost its record but the daemon still has the
  // run" is a different story from "our own run is still going".
  assert.equal(verdict.source, 'conversation');
  assert.equal(verdict.collectWith, 'opendesign_ask({ run_id: "run-live" })');
});

test('reconcileWatch: the project-level run is used when the conversation lookup found nothing', () => {
  const verdict = reconcileWatch({
    projectRun: { runId: 'run-project', status: 'queued' },
  });

  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.runId, 'run-project');
  assert.equal(verdict.source, 'project');
});

test('reconcileWatch: a recorded run wins when it is the one still live', () => {
  const verdict = reconcileWatch({
    pendingRun: { runId: 'run-recorded' },
    pendingRunStatus: { status: 'running' },
  });

  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.runId, 'run-recorded');
  assert.equal(verdict.source, 'pendingRun');
});

test('reconcileWatch: an unreadable recorded run is UNKNOWN, not live and not finished', () => {
  const verdict = reconcileWatch({
    pendingRun: { runId: 'run-recorded' },
    // Lookup failed: status is undefined.
    pendingRunStatus: undefined,
  });

  // The original version of this test asserted `state: 'busy'`, and its reasoning
  // is preserved here because half of it was right:
  //
  //   "Clearing the record on a failed lookup is exactly how the 2026-10-26 orphan
  //    happened: `GET /runs/:id` times out while a long turn streams, the record is
  //    dropped, and the next call starts a SECOND turn in the same conversation."
  //
  // Dropping the record is indeed wrong, and this verdict still does not drop it —
  // `runId` and `collectWith` are still reported. What was wrong is the CHOICE OF
  // TWO VALUES. Answering `busy` here is what caused the other measured failure on
  // the same inputs: because `state`/`busy` is what `index.js` guards on, a lookup
  // that keeps failing kept the guard armed forever, and every later
  // `opendesign_ask` for that member returned `adopted` without sending anything —
  // a permanently dead member, recoverable only by editing `bindings.json`.
  //
  // "Unknown" is the truthful answer and the one both callers can act on: the
  // recorded id is reported so a possibly-live run is never lost, while permission
  // to start a turn is granted because the daemon's own 409 RUN_IN_PROGRESS is a
  // correct backstop and a permanent block has no backstop at all.
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.busy, null);
  assert.equal(verdict.runId, 'run-recorded');
  assert.equal(verdict.status, 'unknown');
  // Still collectable: the pointer to the run survives even though the state is
  // not known.
  assert.equal(verdict.collectWith, 'opendesign_ask({ run_id: "run-recorded" })');
  assert.match(verdict.note, /could not read the recorded run/);
});

test('reconcileWatch: a live run outranks an unreadable recorded run', () => {
  // Unknown must not mask a run the daemon could actually see: reporting one
  // `unknown` while another observation says `busy` would throw away the only
  // definite fact in hand, and with it the id worth collecting.
  const verdict = reconcileWatch({
    pendingRun: { runId: 'run-recorded' },
    pendingRunStatus: undefined,
    conversationRun: { runId: 'run-live', status: 'running' },
  });

  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.busy, true);
  assert.equal(verdict.runId, 'run-live');
  assert.equal(verdict.source, 'conversation');
});

test('reconcileWatch: a settled recorded run leaves the bridge idle', () => {
  const verdict = reconcileWatch({
    pendingRun: { runId: 'run-done' },
    pendingRunStatus: { status: 'succeeded' },
  });

  assert.equal(verdict.state, 'idle');
  assert.equal(verdict.busy, false);
});

test('reconcileWatch: everything quiet is idle with no note', () => {
  const verdict = reconcileWatch({ activeRunCount: 0 });
  assert.equal(verdict.state, 'idle');
  assert.equal(verdict.note, undefined);
});

test('reconcileWatch: reports when Open Design is busy across several clients', () => {
  const verdict = reconcileWatch({
    conversationRun: { runId: 'run-live', status: 'running' },
    activeRunCount: 3,
  });

  assert.equal(verdict.activeRunCount, 3);
  assert.match(verdict.note, /more than one turn/);
});

test('reconcileWatch: a blank run id is not a run', () => {
  const verdict = reconcileWatch({
    conversationRun: { runId: '   ', status: 'running' },
    projectRun: { runId: '', status: 'running' },
  });
  assert.equal(verdict.state, 'idle');
});
