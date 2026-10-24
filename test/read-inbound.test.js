/**
 * Regression tests for `readInbound` — the inbound half of the bridge.
 *
 * The bug these exist to prevent, found in production on 2026-10-25:
 *
 *   `readInbound` skipped every message whose role was not `user`. That is
 *   correct for FILTERING human input, but it meant a reply Open Design produced
 *   on its own was invisible. The human typed "暂停" into the Open Design window,
 *   Open Design ran a turn and wrote a 459-character status report, and the Lead —
 *   which only ever saw the two-word prompt — concluded the work had merely been
 *   halted and knew nothing about what had actually been finished.
 *
 * The fix widens the return value to two separate lists, because the two kinds of
 * arrival must stay distinguishable:
 *   - `messages`  — what the human typed (ordinary team input);
 *   - `odReplies` — what Open Design answered on its own (a turn this bridge did
 *                   not start).
 *
 * The hard part is NOT double-reporting: a bridge-started turn's answer was
 * already returned by `opendesign_ask`, so replaying it would make a member read
 * its own answered request back as though Open Design had spoken unprompted.
 * Three signals decide ownership, strongest first, and each has a test below.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readInbound } from '../lib/od-client.js';
import { fakeClient, message } from './helpers.js';

/** A client whose whole conversation is fixed and whose runs are classified by id. */
function conversationClient(conversation, bridgeOwned = new Set()) {
  return fakeClient({
    async listMessages() {
      return conversation;
    },
    async getRun(id) {
      // Bridge submissions carry a `dsh-…` id; a human-started turn carries a UUID.
      return {
        id,
        clientRequestId: bridgeOwned.has(id) ? 'dsh-1700000000000-xxxxxxxx' : '5f2b1c8e-0000-4000-8000-000000000000',
      };
    },
  });
}

test('readInbound: an Open Design reply the human caused is delivered as odReplies', async () => {
  const client = conversationClient([
    message({ id: 'u1', role: 'user', content: '暂停', createdAt: 1 }),
    message({
      id: 'a1', role: 'assistant', content: '已暂停，未再改动任何文件。', runId: 'run-human', runStatus: 'succeeded', createdAt: 2,
    }),
  ]);

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  assert.deepEqual(out.messages.map((entry) => entry.text), ['暂停']);
  assert.deepEqual(out.odReplies.map((entry) => entry.text), ['已暂停，未再改动任何文件。']);
  assert.equal(out.odReplies[0].runId, 'run-human');
  assert.equal(out.odReplies[0].runStatus, 'succeeded');
});

test('readInbound: a bridge-started answer is NOT replayed as a new arrival', async () => {
  // Signal 1: the run id is remembered in the bindings document.
  const client = conversationClient([
    message({ id: 'u1', role: 'user', content: '[lead (DSH lead)]\n\nmake it sweeter', createdAt: 1 }),
    message({ id: 'a1', role: 'assistant', content: 'ANSWER ALREADY RETURNED', runId: 'run-1', runStatus: 'succeeded', createdAt: 2 }),
  ], new Set(['run-1']));

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: ['run-1'],
  });

  assert.deepEqual(out.messages, [], 'the bridge outbound prompt is not human input');
  assert.deepEqual(out.odReplies, [], 'an already-returned answer is not new');
});

test('readInbound: ownership is recovered from clientRequestId when nothing was recorded', async () => {
  // Signal 2, and the reason it exists: it is the only signal that works for runs
  // created before this bridge started recording its own run ids. Without it, a
  // real conversation replayed six old answers as brand-new arrivals.
  //
  // NOTE the prompts below deliberately carry NO `[name (DSH role)]` prefix, so
  // signal 3 cannot answer this: the run record must decide on its own.
  const client = conversationClient([
    message({ id: 'u1', role: 'user', content: '[probe] reply OK', createdAt: 1 }),
    message({ id: 'a1', role: 'assistant', content: 'OLD ANSWER A', runId: 'run-old-a', runStatus: 'succeeded', createdAt: 2 }),
    message({ id: 'u2', role: 'user', content: '暂停', createdAt: 3 }),
    message({ id: 'a2', role: 'assistant', content: 'GENUINE REPLY', runId: 'run-human', runStatus: 'succeeded', createdAt: 4 }),
  ], new Set(['run-old-a']));

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  assert.deepEqual(out.messages.map((entry) => entry.text), ['[probe] reply OK', '暂停']);
  assert.deepEqual(out.odReplies.map((entry) => entry.text), ['GENUINE REPLY']);
});

test('readInbound: the answered prompt identifies ownership when the run carries no id at all', async () => {
  // Signal 3: the oldest generation of runs left `clientRequestId` empty, so
  // neither list nor id can classify them. The prompt it answered still can.
  const client = fakeClient({
    async listMessages() {
      return [
        message({ id: 'u1', role: 'user', content: '[lead (DSH lead)]\n\nlegacy brief', createdAt: 1 }),
        message({ id: 'a1', role: 'assistant', content: 'LEGACY ANSWER', runId: 'run-empty', runStatus: 'succeeded', createdAt: 2 }),
      ];
    },
    async getRun() {
      return { id: 'run-empty', clientRequestId: '' };
    },
  });

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  assert.deepEqual(out.odReplies, []);
});

test('readInbound: a reply that has not finished is not reported as an answer', async () => {
  const client = conversationClient([
    message({ id: 'u1', role: 'user', content: '继续', createdAt: 1 }),
    message({ id: 'a1', role: 'assistant', content: '', runId: 'run-live', runStatus: 'running', createdAt: 2 }),
  ]);

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  // The human prompt is still delivered — only the unfinished answer waits.
  assert.deepEqual(out.messages.map((entry) => entry.text), ['继续']);
  assert.deepEqual(out.odReplies, []);
});

test('readInbound: consumption is exactly once from the cursor', async () => {
  const conversation = [
    message({ id: 'u1', role: 'user', content: '暂停', createdAt: 1 }),
    message({ id: 'a1', role: 'assistant', content: 'REPLY ONE', runId: 'run-human', runStatus: 'succeeded', createdAt: 2 }),
  ];
  const client = conversationClient(conversation);

  const first = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });
  assert.equal(first.messages.length + first.odReplies.length, 2);
  assert.equal(first.nextCursor.id, 'a1');

  // Re-reading with the returned cursor yields nothing: both lists share it.
  const second = await readInbound(client, {
    projectId: 'p',
    conversationId: 'c',
    memberName: 'lead',
    bridgeRuns: [],
    cursorId: first.nextCursor.id,
    cursorAt: first.nextCursor.createdAt,
  });
  assert.deepEqual(second.messages, []);
  assert.deepEqual(second.odReplies, []);
});

test('readInbound: a vanished cursor falls back to its timestamp instead of replaying history', async () => {
  const client = conversationClient([
    message({ id: 'old-u', role: 'user', content: 'ancient', createdAt: 100 }),
    message({ id: 'a-u', role: 'assistant', content: 'ANCIENT REPLY', runId: 'r-a', runStatus: 'succeeded', createdAt: 101 }),
    message({ id: 'new-u', role: 'user', content: 'fresh', createdAt: 900 }),
  ]);

  const out = await readInbound(client, {
    projectId: 'p',
    conversationId: 'c',
    memberName: 'lead',
    bridgeRuns: [],
    // A cursor id that is not in this conversation any more (fork / clear / reset).
    cursorId: 'does-not-exist',
    cursorAt: 500,
  });

  assert.deepEqual(out.messages.map((entry) => entry.text), ['fresh']);
  assert.deepEqual(out.odReplies, [], 'history before the cursor is not replayed');
});

test('readInbound: an unreadable run is treated as human-started so its answer is not lost', async () => {
  // A duplicate is a smaller failure than a silently dropped message.
  const client = fakeClient({
    async listMessages() {
      return [
        message({ id: 'u1', role: 'user', content: '暂停', createdAt: 1 }),
        message({ id: 'a1', role: 'assistant', content: 'REPLY', runId: 'run-gone', runStatus: 'succeeded', createdAt: 2 }),
      ];
    },
    async getRun() {
      throw new Error('HTTP 404');
    },
  });

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  assert.deepEqual(out.odReplies.map((entry) => entry.text), ['REPLY']);
});

test('readInbound: each distinct run is fetched once per read, not once per message', async () => {
  // Reading a long conversation must not turn into one HTTP request per reply;
  // Open Design's daemon is single-threaded, so that cost is real.
  let fetches = 0;
  const client = fakeClient({
    async listMessages() {
      return [
        message({ id: 'u1', role: 'user', content: 'go', createdAt: 1 }),
        message({ id: 'a1', role: 'assistant', content: 'one', runId: 'run-x', runStatus: 'succeeded', createdAt: 2 }),
        message({ id: 'a2', role: 'assistant', content: 'two', runId: 'run-x', runStatus: 'succeeded', createdAt: 3 }),
        message({ id: 'a3', role: 'assistant', content: 'three', runId: 'run-x', runStatus: 'succeeded', createdAt: 4 }),
      ];
    },
    async getRun() {
      fetches += 1;
      return { id: 'run-x', clientRequestId: '5f2b1c8e-0000-4000-8000-000000000000' };
    },
  });

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: [],
  });

  assert.equal(out.odReplies.length, 3);
  assert.equal(fetches, 1, 'the run record is memoised for the duration of one read');
});

test('readInbound: a remembered run id short-circuits without any request', async () => {
  let fetches = 0;
  const client = fakeClient({
    async listMessages() {
      return [
        message({ id: 'a1', role: 'assistant', content: 'mine', runId: 'run-known', runStatus: 'succeeded', createdAt: 1 }),
      ];
    },
    async getRun() {
      fetches += 1;
      return { id: 'run-known', clientRequestId: 'dsh-x' };
    },
  });

  const out = await readInbound(client, {
    projectId: 'p', conversationId: 'c', memberName: 'lead', bridgeRuns: ['run-known'],
  });

  assert.deepEqual(out.odReplies, []);
  assert.equal(fetches, 0, 'the recorded list is the fast path');
});
