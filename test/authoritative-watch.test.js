/**
 * Tests for the single authoritative busy check (Step 5) and the cost properties
 * that must survive it.
 *
 * The three-source reconciliation in `lib/watch.js` still exists and still has its
 * tests; what these pin is that the PRIMARY path no longer guesses. Two properties
 * are asserted on the source because neither is reachable from a pure function:
 *
 *   1. `liveProjectRun` is GONE. It read `listProjects` and reinterpreted a
 *      project-level status string, which after the authoritative query existed
 *      could only contribute a second, weaker opinion — and it cost a request on
 *      every status call.
 *   2. `opendesign_status` and the watcher loop both read the AUTHORITATIVE query,
 *      not the message scan. This is the cost property that keeps the 46–63 ms
 *      baseline: `opendesign_status` is called for alignment before UI work, and
 *      the watcher polls for the whole life of a task.
 *
 * Regression the second one guards, from AGENTS.md: a status call that grew to
 * 9–19 s because something pulled `/api/agents` on the hot path. A message scan
 * plus five `getRun` calls is the same class of mistake in slower motion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { verdictFromActiveRuns } from '../lib/watch.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const odSource = await readFile(new URL('../lib/od-client.js', import.meta.url), 'utf8');

test('step5: the project-status heuristic is deleted, not left unused', () => {
  // Unused-but-present is the worst state: it reads like a guard that fires, and
  // someone later "restores" it. `liveProjectRun` must not exist at all.
  assert.equal(
    /function liveProjectRun\(/.test(source),
    false,
    'liveProjectRun must be removed, not merely unreferenced',
  );
  assert.equal(
    /liveProjectRun\(/.test(source),
    false,
    'no call site may remain either',
  );
});

test('step5: a run is discovered from the conversation, never from the run LIST', () => {
  // Measured against 0.26.1 on 2026-10-26, with a run genuinely `running`:
  //
  //   GET /api/runs?conversationId=…&status=active          -> 200 {"runs":[]}
  //   GET /api/runs?conversationId=…&projectId=…&status=active -> 200 {"runs":[]}
  //   GET /api/runs/<id>                                    -> running
  //
  // The list route is blind for these projects, and an empty list is
  // indistinguishable from "nothing is running". Every consumer therefore takes
  // the run id from the conversation's message rows (which carry `runId` /
  // `runStatus`) and confirms it with `GET /api/runs/:id`.
  assert.equal(
    /od\s*\.?\s*listRuns\(/.test(source),
    false,
    'the run list must not be used as an observation source: it answers [] while a run is live',
  );

  const statusAt = source.indexOf("name: 'opendesign_status'");
  assert.notEqual(statusAt, -1);
  const statusBody = source.slice(statusAt, source.indexOf("name: 'opendesign_watch'", statusAt));
  assert.match(statusBody, /latestUnfinishedRunId\(rows\)/, 'status must discover the run from the conversation');
  assert.match(statusBody, /od\.getRun\(candidateId\)/, 'and confirm it by id');

  const watcherAt = source.indexOf('function armWatcher');
  assert.notEqual(watcherAt, -1);
  const watcherBody = source.slice(watcherAt, source.indexOf('\n  /**\n   * Run one Open Design turn'));
  assert.match(watcherBody, /latestUnfinishedRunId\(rows\)/, 'the watcher must discover the run from the conversation');
  assert.match(watcherBody, /od\.getRun\(knownRunId\)/, 'and poll it by id, which does answer');
  // The watcher must NOT scan messages any more: it polls forever, so the scan
  // would be paid on every tick.
  assert.equal(
    /findLiveRun\(/.test(watcherBody),
    false,
    'the watcher loop must not fall back to the message scan on the normal path',
  );
});

test('step5: a discovered run is released once it stops working', () => {
  // A settled run left in `knownRunId` would make the watcher poll it forever and
  // never notice the NEXT turn. Released on "not working", deliberately NOT on
  // "could not look" — dropping the id on a failed lookup blinds the watcher
  // exactly when the daemon is busy.
  assert.match(
    source,
    /if \(observation\.status !== 'unknown' && !isWorking\(observation\.status\)\) knownRunId = undefined;/,
    'the watcher must forget a run once it is no longer working',
  );
});

test('step5: the seed hook lets a reused watcher follow a newly started run', () => {
  // `opendesign_ask` arms the watcher BEFORE it creates the run, and a reused
  // watcher was armed by an earlier call. Without the hook it would keep polling
  // the run it already finished.
  assert.match(source, /const seedRun = \(runId\) => \{/, 'the watcher must expose one way to retarget it');
  assert.match(source, /armedWatcher\?\.seedRun\?\.\(createdRunId\)/, 'ask must retarget the watcher it just armed');
  assert.match(source, /recorded\.seedRun\?\.\(input\.seedRunId\)/, 'the reuse path must retarget too');
});

test('step5: an unanswerable authoritative query is unknown, never idle', () => {
  const failed = verdictFromActiveRuns({ lookupFailed: true });
  assert.equal(failed.state, 'unknown');
  assert.equal(failed.busy, null);
  assert.equal(failed.busy === true, false, 'unknown must not block a new turn');

  const empty = verdictFromActiveRuns({ activeRuns: [] });
  assert.equal(empty.state, 'idle');
  assert.equal(empty.busy, false);
});

test('step5: an active run from any source is reported with how to collect it', () => {
  const verdict = verdictFromActiveRuns({
    activeRuns: [
      { id: 'run-live', status: 'running', clientRequestId: 'uuid-from-human' },
    ],
  });

  assert.equal(verdict.state, 'busy');
  assert.equal(verdict.busy, true);
  assert.equal(verdict.runId, 'run-live');
  assert.equal(verdict.collectWith, 'opendesign_ask({ run_id: "run-live" })');
  assert.equal(verdict.source, 'activeRuns');
});

test('step5: an explicitly handled run is not reported as the blocker', () => {
  // The interrupt path has already cancelled and reported its run; re-reporting it
  // as the thing to collect is precisely the inject defect this construction fixed.
  const verdict = verdictFromActiveRuns({
    activeRuns: [
      { id: 'run-being-handled', status: 'running' },
      { id: 'run-other', status: 'queued' },
    ],
    excludeRunIds: ['run-being-handled'],
  });

  assert.equal(verdict.runId, 'run-other');

  const nothingLeft = verdictFromActiveRuns({
    activeRuns: [{ id: 'run-being-handled', status: 'running' }],
    excludeRunIds: ['run-being-handled'],
  });
  assert.equal(nothingLeft.state, 'idle');
});

test('step5: a run payload without a usable id is not a run', () => {
  const verdict = verdictFromActiveRuns({
    activeRuns: [{ id: '   ', status: 'running' }, { status: 'running' }, {}],
  });
  assert.equal(verdict.state, 'idle');
});
