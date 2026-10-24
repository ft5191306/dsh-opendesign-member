/**
 * Regression tests for `awaitRun` — the polling half of `opendesign_ask`.
 *
 * The bug these exist to prevent, found in production on 2026-10-25:
 *
 *   The wait budget and the caller's cancellation were merged into one
 *   `AbortSignal` (`AbortSignal.any([signal, AbortSignal.timeout(budget)])`), and
 *   `awaitRun` cancelled the run whenever it observed an abort. So running out of
 *   patience silently pressed Open Design's stop button — while the run itself was
 *   in fact still alive. One turn was left running for 36 minutes and 12.8 MB of
 *   events, its answer permanently uncollectable, and the caller had been told the
 *   call failed.
 *
 * Two invariants follow, and every test here guards one of them:
 *   1. A wait budget that expires must NEVER cancel the run; it reports
 *      `stillRunning` with the coordinates needed to collect the answer later.
 *   2. An explicit cancellation must still cancel the run immediately.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { awaitRun, isTerminalRun } from '../lib/od-client.js';
import { counting, fakeClient, message, runRecord } from './helpers.js';

test('awaitRun: a settled run returns its final assistant text', async () => {
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-a' });
    },
    async listMessages() {
      return [
        message({ id: 'msg-u', role: 'user', content: 'do the thing' }),
        message({ id: 'msg-a', role: 'assistant', content: 'done' }),
      ];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.ok, true);
  assert.equal(result.stillRunning, false);
  assert.equal(result.text, 'done');
  assert.equal(result.assistantMessageId, 'msg-a');
});

test('awaitRun: the answer is read from assistantMessageId, not "the last assistant message"', async () => {
  // A concurrent or retried run could append another assistant turn. Reading the
  // last one would then return somebody else's answer under this run's id.
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-mine' });
    },
    async listMessages() {
      return [
        message({ id: 'msg-mine', role: 'assistant', content: 'THE RIGHT ONE' }),
        message({ id: 'msg-other', role: 'assistant', content: 'THE WRONG ONE' }),
      ];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.text, 'THE RIGHT ONE');
});

test('awaitRun: a wait budget expiring reports stillRunning and does NOT cancel the run', async () => {
  const cancel = counting(async () => ({ ok: true }));
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'running' });
    },
    cancelRun: cancel.fn,
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 5, timeoutMs: 40 });

  assert.equal(result.stillRunning, true);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'running');
  assert.equal(result.runId, 'run-1');
  // The coordinates a later `opendesign_ask({ run_id })` needs to collect it.
  assert.equal(result.projectId, 'proj-1');
  assert.equal(result.conversationId, 'conv-1');
  assert.equal(cancel.calls, 0, 'a wait budget must never cancel the run');
});

test('awaitRun: an explicit cancellation still cancels the run', async () => {
  const cancel = counting(async () => ({ ok: true }));
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'running' });
    },
    cancelRun: cancel.fn,
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);

  await assert.rejects(
    () => awaitRun(client, 'run-1', { pollMs: 5, timeoutMs: 60_000, signal: controller.signal }),
    (error) => {
      assert.equal(error.code, 'cancelled');
      return true;
    },
  );
  assert.equal(cancel.calls, 1, 'an explicit cancellation must stop the run');
});

test('awaitRun: a zero or negative budget means "no deadline", not "fail instantly"', async () => {
  let polls = 0;
  const client = fakeClient({
    async getRun() {
      polls += 1;
      return runRecord({ status: polls >= 3 ? 'succeeded' : 'running' });
    },
    async listMessages() {
      return [message({ id: 'msg-a', role: 'assistant', content: 'late but fine' })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 0 });

  assert.equal(result.stillRunning, false);
  assert.equal(result.text, 'late but fine');
});

test('awaitRun: a question-form turn is a question, not an answer', async () => {
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-a' });
    },
    async listMessages() {
      return [message({
        id: 'msg-a',
        role: 'assistant',
        content: 'Pick one.\n<question-form id="color">{"id":"color","questions":[{"id":"c","type":"radio","options":["red","blue"]}]}</question-form>',
      })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  // The markup must not survive into prose: a caller quoting `answer` would
  // otherwise paste raw tags into a reply.
  assert.equal(result.text, 'Pick one.');
  assert.ok(result.questionForm !== null);
  assert.equal(result.questionForm.id, 'color');
});

test('isTerminalRun: judges by status or a terminal timestamp, never by exitCode', () => {
  assert.equal(isTerminalRun({ status: 'succeeded' }), true);
  assert.equal(isTerminalRun({ status: 'canceled' }), true);
  assert.equal(isTerminalRun({ status: 'running' }), false);
  // A finished run can still carry a nonzero exitCode and must count as settled.
  assert.equal(isTerminalRun({ status: 'succeeded', exitCode: 1 }), true);
  // An unknown status with a terminal timestamp counts too.
  assert.equal(isTerminalRun({ status: 'weird', terminalAt: 1 }), true);
  assert.equal(isTerminalRun(null), false);
});
