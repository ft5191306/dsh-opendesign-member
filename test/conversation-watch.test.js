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
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  observeConversation, diffConversation, isWorking, observeRun,
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
