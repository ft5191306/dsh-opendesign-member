/**
 * Regression tests for `awaitRun` — the waiting half of `opendesign_ask`.
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
 *
 * Since the wait now prefers the daemon's SSE stream, both invariants are pinned
 * on BOTH transports. The stream is an optimization, so a third invariant rides
 * on it: when it is unavailable the fallback must be visible (`degraded`), never
 * silent. A silent downgrade is how "the daemon stopped streaming" would go
 * unnoticed for months.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { awaitRun, isTerminalRun } from '../lib/od-client.js';
import { counting, fakeClient, message, runRecord } from './helpers.js';

/**
 * A `fetch`-shaped stub that answers with a real `text/event-stream` body.
 *
 * `frames` are SSE frames WITHOUT their trailing blank line, exactly as
 * `lib/od-events.js`'s parser expects them. `holdOpen: true` keeps the body
 * yielding keepalives instead of ending, which is how a still-running turn looks
 * on the wire: the stream stays open and quiet until it has something to say.
 *
 * @param frames - complete frames to emit in order.
 * @param options - `holdOpen` to never end the body, `hang` to never emit anything.
 */
function sseFetch(frames = [], options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (options.reject === true) throw new Error('connect ECONNREFUSED');
    const encoder = new TextEncoder();
    const body = {
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) {
          yield encoder.encode(`${frame}\n\n`);
        }
        // Yield the keepalive at a pace slower than the wait budget, which is
        // what the daemon does (25 s) and what a timeout has to interrupt.
        while (options.holdOpen === true) {
          await new Promise((resolve) => setTimeout(resolve, 2));
          yield encoder.encode(': keepalive\n\n');
        }
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body,
    };
  };
  return { fetch, calls };
}

/** One SSE frame in the daemon's exact field order. */
function sseFrame(event, data, id = undefined) {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}`;
}

/**
 * The same route answering as JSON — an older Open Design, or a proxy that
 * re-frames the body. This is the fallback trigger.
 *
 * @param payload - JSON body to answer with.
 */
function jsonFetch(payload = { ok: true }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

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

test('awaitRun: an SSE wait budget expiring aborts the connection, never the run', async () => {
  // The measured failure this pins: a timed-out turn that was also cancelled kept
  // working for 36 minutes and 12.8 MB of events, and nobody could collect the
  // answer. Aborting the connection is "I stop listening"; the run must survive it.
  const cancel = counting(async () => ({ ok: true }));
  const { fetch } = sseFetch([sseFrame('agent', { type: 'thinking' }, 1)], { holdOpen: true });
  const client = fakeClient({
    baseUrl: 'http://127.0.0.1:9999',
    fetch,
    async getRun() {
      return runRecord({ status: 'running' });
    },
    cancelRun: cancel.fn,
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 5, timeoutMs: 60 });

  assert.equal(result.stillRunning, true, 'the run is still working, not failed');
  assert.equal(result.ok, false);
  assert.equal(result.runId, 'run-1');
  // A resume point that survives re-attaching from the daemon's journal.
  assert.equal(result.lastEventId, 1);
  assert.equal(cancel.calls, 0, 'a wait budget must never cancel the run on the SSE path');
  // The stream was usable, so nothing was degraded — and the field exists on the
  // timeout path too, so a caller can always check it.
  assert.deepEqual(result.degraded, []);
});

test('awaitRun: an `end` event settles the run and reads its answer', async () => {
  const listMessages = counting(async () => [
    message({ id: 'msg-a', role: 'assistant', content: 'the streamed answer' }),
  ]);
  const { fetch, calls } = sseFetch([
    sseFrame('agent', { type: 'text_delta', delta: 'partial' }, 1),
    sseFrame('agent', { type: 'text_delta', delta: ' more' }, 2),
    sseFrame('end', { status: 'succeeded', code: 0, terminalAt: 1 }, 3),
  ]);
  const client = fakeClient({
    baseUrl: 'http://127.0.0.1:9999',
    fetch,
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-a' });
    },
    listMessages: listMessages.fn,
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.stillRunning, false);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.text, 'the streamed answer');
  assert.equal(result.assistantMessageId, 'msg-a');
  // Only the final assistant message is the answer: the streamed deltas are
  // progress, never accumulated into the returned text.
  assert.ok(!result.text.includes('partial'));
  assert.equal(listMessages.calls, 1);
  // One connection, and one record read — not one request per second.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.accept, 'text/event-stream');
});

test('awaitRun: a non-event-stream response falls back to polling and says so', async () => {
  // Old Open Design, or a proxy that re-frames `text/event-stream`. The analyst
  // flagged SSE-through-proxy truncation as UNVERIFIED on this host, so the only
  // safe design is: keep polling, and make the downgrade visible.
  const { fetch, calls } = jsonFetch({ run: { status: 'running' } });
  let polls = 0;
  const client = fakeClient({
    baseUrl: 'http://127.0.0.1:9999',
    fetch,
    async getRun() {
      polls += 1;
      return runRecord({
        status: polls >= 3 ? 'succeeded' : 'running',
        assistantMessageId: 'msg-a',
      });
    },
    async listMessages() {
      return [message({ id: 'msg-a', role: 'assistant', content: 'polled answer' })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.stillRunning, false);
  assert.equal(result.text, 'polled answer');
  assert.equal(polls, 3, 'the polling fallback must actually run');
  assert.equal(calls.length, 1, 'the stream is probed once, then left alone');
  // LOUD: the reason names the content type that was returned instead.
  assert.equal(result.degraded.length, 1);
  assert.match(result.degraded[0], /text\/event-stream/);
  assert.match(result.degraded[0], /application\/json/);
});

test('awaitRun: a stream that closes without `end` is not a settled run', async () => {
  // The daemon gives up on journal replay with an empty 200 body ("durable event
  // replay failed"). Reporting that as a finished turn would invent a verdict the
  // daemon never gave — so it re-attaches, then falls back to polling.
  const { fetch } = sseFetch([sseFrame('agent', { type: 'thinking' }, 1)]);
  let polls = 0;
  const client = fakeClient({
    baseUrl: 'http://127.0.0.1:9999',
    fetch,
    async getRun() {
      polls += 1;
      return runRecord({
        status: polls >= 2 ? 'succeeded' : 'running',
        assistantMessageId: 'msg-a',
      });
    },
    async listMessages() {
      return [message({ id: 'msg-a', role: 'assistant', content: 'answer after replay trouble' })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.text, 'answer after replay trouble');
  assert.equal(polls, 2);
  assert.ok(result.degraded.length >= 1);
  assert.match(result.degraded.join(' '), /without an end event/);
});

test('awaitRun: a client without fetch degrades loudly instead of failing', async () => {
  // `fakeClient` is exactly this shape, and it is what every other test in this
  // file uses. Naming the reason keeps the fallback visible even here.
  const client = fakeClient({
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-a' });
    },
    async listMessages() {
      return [message({ id: 'msg-a', role: 'assistant', content: 'ok' })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.text, 'ok');
  assert.equal(result.stillRunning, false);
  assert.match(result.degraded.join(' '), /no fetch/);
});

test('awaitRun: a stream that dies mid-turn re-attaches from Last-Event-ID', async () => {
  // The daemon re-binds its port on every launch (measured 8620 → 10191 → … →
  // 14197), so a mid-turn break is normal, not exceptional. `Last-Event-ID` is
  // the daemon's documented recovery: the journal replays the gap, so the caller
  // must not lose the frames it missed.
  const calls = [];
  let attempt = 0;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    attempt += 1;
    const encoder = new TextEncoder();
    const first = attempt === 1;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        async *[Symbol.asyncIterator]() {
          if (first) {
            // First attempt: one frame, then the connection dies without `end`.
            yield encoder.encode(`${sseFrame('agent', { type: 'thinking' }, 8)}\n\n`);
            throw new Error('socket hang up');
          }
          yield encoder.encode(`${sseFrame('end', { status: 'succeeded' }, 9)}\n\n`);
        },
      },
    };
  };
  const reconnect = counting(async () => 'http://127.0.0.1:10000');
  const client = fakeClient({
    baseUrl: 'http://127.0.0.1:9999',
    fetch,
    reconnect: reconnect.fn,
    async getRun() {
      return runRecord({ status: 'succeeded', assistantMessageId: 'msg-a' });
    },
    async listMessages() {
      return [message({ id: 'msg-a', role: 'assistant', content: 'survived the restart' })];
    },
  });

  const result = await awaitRun(client, 'run-1', { pollMs: 1, timeoutMs: 5_000 });

  assert.equal(result.text, 'survived the restart');
  assert.equal(result.lastEventId, 9);
  assert.equal(calls.length, 2);
  // The re-attach asks the daemon to continue from the last frame it delivered,
  // and it re-resolves the port first because a break is usually a restart.
  assert.equal(calls[1].init.headers['last-event-id'], '8');
  assert.equal(reconnect.calls, 1);
  assert.equal(result.degraded.length, 1);
  assert.match(result.degraded[0], /re-attached with Last-Event-ID 8/);
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
