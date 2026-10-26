/**
 * Tests for the conversation watcher's judgement.
 *
 * The design constraint these pin comes straight from the failure they replace:
 * a previous per-call watchdog went blind the moment `opendesign_ask` returned, so
 * a Lead whose turn ended could no longer see that Open Design was still working.
 * The watcher here is meant to run as a background job and outlive the call.
 *
 * What it must get right:
 *   1. A status change is reported as an event worth checking the output for.
 *   2. Journal growth is NOT a status change — treating it as one would train the
 *      caller to ignore the signal.
 *   3. A run disappearing is itself the news: that is when the answer becomes
 *      collectable.
 *   4. `unknown` is a MISSING observation, never an event. The incident these
 *      tests pin: one fire-and-forget `ask` produced three queued messages for one
 *      run — `appeared` (the receipt echoed), `now unknown` (a poll that timed out
 *      on the busy daemon), and `gone (was unknown)` claiming an answer was
 *      collectable on evidence nobody had.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  observeConversation, diffConversation, isWorking, observeRun, isTerminalStatus, latestUnfinishedRunId,
} from '../lib/conversation-watch.js';

test('observeConversation: an absent run reads as idle, not as unknown', () => {
  const seen = observeConversation({});
  assert.equal(seen.status, 'idle');
  assert.equal(seen.runId, undefined);
});

test('observeConversation: a blank run id is not a run', () => {
  assert.equal(observeConversation({ runId: '   ', status: 'running' }).runId, undefined);
});

test('diffConversation: first sight of a live run is an event', () => {
  const report = diffConversation(undefined, observeConversation({ runId: 'abcdef1234', status: 'running' }));
  assert.equal(report.changed, true);
  assert.equal(report.kind, 'appeared');
  assert.match(report.message, /abcdef12/);
});

test('diffConversation: first sight of no run is not an event', () => {
  const report = diffConversation(undefined, observeConversation({}));
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});

test('diffConversation: a status change is the event the Lead cares about', () => {
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'queued' }),
    observeConversation({ runId: 'run-1', status: 'running' }),
  );

  assert.equal(report.changed, true);
  assert.equal(report.kind, 'status');
  assert.match(report.message, /now running/);
});

test('diffConversation: a turn settling tells the Lead how to collect it', () => {
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'running' }),
    observeConversation({ runId: 'run-1', status: 'succeeded' }),
  );

  assert.equal(report.kind, 'status');
  assert.match(report.message, /opendesign_ask\(\{ run_id: "run-1" \}\)/);
});

test('diffConversation: journal growth is activity, not a change', () => {
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'running', eventsBytes: 1_000 }),
    observeConversation({ runId: 'run-1', status: 'running', eventsBytes: 9_000 }),
  );

  // Reporting this as "changed" would make every poll look like news, and the
  // caller would stop trusting the signal.
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'activity');
});

test('diffConversation: a run vanishing is reported, because the answer is ready', () => {
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'running' }),
    observeConversation({}),
  );

  assert.equal(report.changed, true);
  assert.equal(report.kind, 'gone');
  assert.match(report.message, /can be collected/);
});

test('diffConversation: a different run id is a new run, not a status change', () => {
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'running' }),
    observeConversation({ runId: 'run-2', status: 'running' }),
  );

  assert.equal(report.kind, 'appeared');
  assert.match(report.message, /run-2/);
});

test('diffConversation: two identical observations report nothing', () => {
  const seen = observeConversation({ runId: 'run-1', status: 'running', eventsBytes: 500 });
  const report = diffConversation(seen, observeConversation({ runId: 'run-1', status: 'running', eventsBytes: 500 }));
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});

test('isWorking: only live statuses count as work', () => {
  assert.equal(isWorking('running'), true);
  assert.equal(isWorking('queued'), true);
  assert.equal(isWorking('stopping'), true);
  assert.equal(isWorking('succeeded'), false);
  assert.equal(isWorking('idle'), false);
});

test('observeRun: a settled run keeps its status rather than reading as running', () => {
  const seen = observeRun({ id: 'run-9', status: 'succeeded', terminalAt: 1_700_000_000_000 }, { content: 'done' });
  assert.equal(seen.status, 'succeeded');
  assert.equal(seen.textLength, 4);
});

test('observeRun: no run reads as idle', () => {
  assert.equal(observeRun(undefined, undefined).status, 'idle');
});

/* ------------------------------------------------------------------------- *
 * `unknown` is not a state, it is a missing observation.
 * ------------------------------------------------------------------------- */

test('diffConversation: a blind poll is not a status change', () => {
  // The daemon timed out mid-poll (measured on a large project). Reporting
  // `running → unknown` put "now unknown" in the caller's queue as if something
  // had happened.
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'running' }),
    observeRun({ id: 'run-1', status: undefined }),
  );

  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
  assert.doesNotMatch(report.message, /now unknown/);
});

test('diffConversation: a first sight of unknown is not a run appearing', () => {
  const report = diffConversation(undefined, observeRun({ id: 'run-1', status: undefined }));
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});

test('diffConversation: unknown → unknown reports nothing at all', () => {
  const report = diffConversation(
    observeRun({ id: 'run-1', status: undefined }),
    observeRun({ id: 'run-1', status: undefined }),
  );
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});

test('diffConversation: after a blind poll, recovery reports the last DEFINITE status', () => {
  // How the watcher keeps its baseline: an `unknown` observation does not become
  // the thing the next poll is compared against, so a run that disappeared while
  // the watcher was blind is reported as `gone (was running)` — not
  // `was unknown`, which claimed evidence that never existed.
  const definite = observeConversation({ runId: 'run-1', status: 'running' });
  const report = diffConversation(definite, observeConversation({}));

  assert.equal(report.kind, 'gone');
  assert.match(report.message, /was running/);
  assert.match(report.message, /can be collected/);
});

test('diffConversation: gone with an unknown baseline never claims a collectable answer', () => {
  // Defence in depth: with the baseline rule honoured this cannot happen, but if
  // a caller ever passes it, the honest sentence is "no longer visible". It was
  // exactly this claim ("its answer can be collected") that made the third queued
  // message a lie.
  const report = diffConversation(
    observeRun({ id: 'run-1', status: undefined }),
    observeConversation({}),
  );

  assert.equal(report.changed, true);
  assert.equal(report.kind, 'gone');
  assert.match(report.message, /no longer visible/);
  assert.match(report.message, /last status unknown/);
  assert.doesNotMatch(report.message, /can be collected/);
});

test('isWorking: a statusless observation is not work', () => {
  // The watcher uses this to decide whether a run it started is still merely
  // echoing its receipt; `unknown` must never read as "still working", or the
  // push for its real completion would be skipped.
  assert.equal(isWorking('unknown'), false);
  assert.equal(isWorking(undefined), false);
});

/* ------------------------------------------------------------------------- *
 * Discovering WHICH run is live, from the conversation's own message rows.
 *
 * This exists because the daemon's run LIST is blind for these projects: with a
 * run genuinely `running`, every filter combination answered `{"runs":[]}` while
 * `GET /api/runs/:id` reported the truth. An empty list is indistinguishable from
 * "nothing is running", so the whole watcher sat silent for entire tasks.
 * ------------------------------------------------------------------------- */

test('latestUnfinishedRunId: the newest live run is the one being executed', () => {
  const rows = [
    { role: 'assistant', runId: 'old-run', runStatus: 'succeeded' },
    { role: 'assistant', runId: 'live-run', runStatus: 'running' },
  ];
  assert.equal(latestUnfinishedRunId(rows), 'live-run');
});

test('latestUnfinishedRunId: a newest row that finished means nothing is running', () => {
  // Not "keep looking for an older unfinished one": that would resurrect history
  // and report a finished turn as live.
  const rows = [
    { role: 'assistant', runId: 'older-run', runStatus: 'running' },
    { role: 'assistant', runId: 'newest-run', runStatus: 'succeeded' },
  ];
  assert.equal(latestUnfinishedRunId(rows), undefined);
});

test('latestUnfinishedRunId: a row whose status has not landed yet is still a candidate', () => {
  // The assistant row is written when the run STARTS; its status can lag. Missing
  // status must not read as "finished", or the watcher would skip the very run it
  // was armed for.
  const rows = [{ role: 'assistant', runId: 'fresh-run' }];
  assert.equal(latestUnfinishedRunId(rows), 'fresh-run');
});

test('latestUnfinishedRunId: rows without a run id are skipped, not fatal', () => {
  const rows = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', runId: '   ', runStatus: 'running' },
    { role: 'assistant', runId: 'right-run', runStatus: 'queued' },
  ];
  assert.equal(latestUnfinishedRunId(rows), 'right-run');
});

test('latestUnfinishedRunId: no rows means nothing is running', () => {
  assert.equal(latestUnfinishedRunId([]), undefined);
  assert.equal(latestUnfinishedRunId(undefined), undefined);
});

test('diffConversation: a finished run whose record is reaped is not reported twice', () => {
  // The completion was already reported by the status transition. When the daemon
  // later forgets the run, "it is gone" is the same fact again — and on a daemon
  // that reaps records it is guaranteed rather than unlikely.
  const report = diffConversation(
    observeConversation({ runId: 'run-1', status: 'succeeded' }),
    observeConversation({}),
  );

  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});

test('isTerminalStatus: settled statuses are the ones whose disappearance is silent', () => {
  for (const status of ['succeeded', 'failed', 'canceled', 'cancelled', 'error', 'timeout']) {
    assert.equal(isTerminalStatus(status), true, `${status} ends a turn`);
  }
  for (const status of ['queued', 'running', 'stopping', 'unknown', undefined]) {
    assert.equal(isTerminalStatus(status), false, `${status} is not a finished turn`);
  }
});
