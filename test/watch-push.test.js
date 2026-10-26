/**
 * Tests for `lib/watch-push.js` — pushing Open Design status changes to the model.
 *
 * The earlier design appended every change only to the watcher job's output ring,
 * so seeing it depended on the caller remembering to call `job_output`. That is
 * exactly the manual recall the push exists to remove: a run left unattended is
 * the case where nobody remembers.
 *
 * What these tests pin, in the order the three failures would hurt:
 *
 *   1. One push per REAL change. `diffConversation` already separates
 *      `appeared` / `status` / `gone` from mere `activity`; a push on journal
 *      growth would arrive every poll and train the model to ignore the channel.
 *   2. A durable, model-visible message is built and handed to the LIVE agent —
 *      resolved per push, because a watcher outlives the turn that armed it.
 *   3. A push can never kill the watcher. Missing/disposed agents and delivery
 *      errors are recorded as one-time notes for the job output, never thrown.
 *
 * Two source-level tests then pin the WIRING, because unit tests of this module
 * cannot see it: the call must sit inside the `report.changed` branch of the one
 * and only watcher loop, and the repo must still have exactly one `jobs.start(`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as nextImmediate } from 'node:timers/promises';

import { createWatchNotifier, PUSH_SOURCE_KIND } from '../lib/watch-push.js';
import { diffConversation } from '../lib/conversation-watch.js';

/** An Agent-shaped object that records what it was handed. */
function fakeAgent() {
  const calls = [];
  return {
    calls,
    followup(message) {
      calls.push(message);
      return { ok: true };
    },
  };
}

/** A notifier wired to one fake member's conversation. */
function notifierFor(resolveAgent, options = {}) {
  return createWatchNotifier({
    resolveAgent,
    owner: 'session-lead',
    member: 'designer',
    conversationId: 'conv-abc',
    clock: () => 1_700_000_000_000,
    ...options,
  });
}

/** The real report shape, produced by the same function the watcher uses. */
function reportBetween(previous, current) {
  return diffConversation(previous, current);
}

test('one changed batch becomes exactly one model-visible user message', () => {
  const agent = fakeAgent();
  const notifier = notifierFor(() => agent);
  const current = { runId: 'run-abc123', status: 'queued' };
  const report = reportBetween(undefined, current);

  assert.equal(report.changed, true, 'the fixture must be a real change');
  const result = notifier.notify(report, current, undefined);

  assert.equal(result.pushed, true);
  assert.equal(agent.calls.length, 1, 'exactly one message per changed batch');
  const message = agent.calls[0];

  // The message must be a plain user message the host's inbox accepts: durable
  // id, user role, one text block, and a source kind that marks its origin.
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length >= 8, 'the id must be usable as a durable inbox id');
  assert.equal(message.role, 'user');
  assert.equal(message.source.kind, PUSH_SOURCE_KIND);
  assert.equal(PUSH_SOURCE_KIND, 'opendesign-watch');
  assert.deepEqual(message.content.map((block) => block.type), ['text']);
  const text = message.content[0].text;
  assert.equal(typeof text, 'string');
  assert.equal(text.includes('\n'), false, 'the push is one short paragraph');

  // Model-facing content: names the member and the change, and spells out the
  // collect call verbatim when the run id is known.
  assert.match(text, /designer/);
  assert.match(text, /appeared/);
  assert.ok(
    text.includes('opendesign_ask({ run_id: "run-abc123" })'),
    `the push must carry the exact collect call, got: ${text}`,
  );

  // Not the raw job-output line: no ISO timestamp prefix, and not the bare
  // sentence the job appends.
  assert.notEqual(text, report.message);
  assert.equal(/^\d{4}-\d{2}-\d{2}T/.test(text), false);
  assert.equal(text.startsWith('appeared:'), false);
});

test('a non-changed report is never pushed and never even resolves an agent', () => {
  let resolved = 0;
  const notifier = notifierFor(() => {
    resolved += 1;
    return fakeAgent();
  });

  // First observation of an idle conversation: quiet.
  const idle = reportBetween(undefined, { status: 'idle' });
  assert.equal(notifier.notify(idle, { status: 'idle' }).pushed, false);

  // Journal growth on a running turn is `activity`, NOT a change. Pushing it
  // every poll is the noise this design exists to prevent.
  const previous = { runId: 'run-1', status: 'running', eventsBytes: 100, textLength: 10 };
  const current = { runId: 'run-1', status: 'running', eventsBytes: 900, textLength: 90 };
  const grew = reportBetween(previous, current);
  assert.equal(grew.changed, false, 'the fixture must be activity, not a change');
  assert.equal(grew.kind, 'activity');
  assert.equal(notifier.notify(grew, current, previous).pushed, false);

  assert.equal(resolved, 0, 'no agent lookup may happen for a quiet poll');
});

test('the same transition is pushed once, and the next transition still is', () => {
  const agent = fakeAgent();
  const notifier = notifierFor(() => agent);

  const queued = { runId: 'run-1', status: 'queued' };
  const appeared = reportBetween(undefined, queued);
  assert.equal(notifier.notify(appeared, queued, undefined).pushed, true);

  // The same report observed twice (a retry, or two summaries of one batch) must
  // not become two user messages.
  const duplicate = notifier.notify(appeared, queued, undefined);
  assert.equal(duplicate.pushed, false);
  assert.equal(duplicate.deduped, true);
  assert.equal(agent.calls.length, 1);

  // A genuinely new transition is not suppressed by the dedupe.
  const running = { runId: 'run-1', status: 'running' };
  const changed = reportBetween(queued, running);
  assert.equal(notifier.notify(changed, running, queued).pushed, true);
  assert.equal(agent.calls.length, 2);

  // Durable inbox ids must be distinct, or two real notifications collapse.
  assert.notEqual(agent.calls[0].id, agent.calls[1].id);
});

test('the live agent is resolved on every push, not captured at creation', () => {
  const first = fakeAgent();
  const second = fakeAgent();
  let resolved = 0;
  const notifier = notifierFor(() => {
    resolved += 1;
    return resolved === 1 ? first : second;
  });

  const queued = { runId: 'run-1', status: 'queued' };
  notifier.notify(reportBetween(undefined, queued), queued, undefined);
  const running = { runId: 'run-1', status: 'running' };
  notifier.notify(reportBetween(queued, running), running, queued);

  assert.equal(resolved, 2, 'resolving once and caching would miss a re-created agent');
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1, 'the second push must reach the CURRENT live agent');
});

test('the owner session id is what resolves the agent', () => {
  const seen = [];
  const notifier = notifierFor((sessionId) => {
    seen.push(sessionId);
    return fakeAgent();
  });
  const queued = { runId: 'run-1', status: 'queued' };
  notifier.notify(reportBetween(undefined, queued), queued, undefined);
  assert.deepEqual(seen, ['session-lead']);
});

test('a missing live agent is reported once, never thrown', () => {
  const notifier = notifierFor(() => undefined);

  const queued = { runId: 'run-1', status: 'queued' };
  const first = notifier.notify(reportBetween(undefined, queued), queued, undefined);
  assert.equal(first.pushed, false);
  assert.equal(first.reason, 'missing-agent');

  // A later, different change also fails quietly — but the reason is recorded
  // ONCE, so the job output does not repeat it for every change.
  const running = { runId: 'run-1', status: 'running' };
  const second = notifier.notify(reportBetween(queued, running), running, queued);
  assert.equal(second.pushed, false);
  assert.equal(second.reason, 'missing-agent');

  const notes = notifier.notes();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no live agent/);
  // Locatable: the note names the owner session and conversation it was watched
  // through, so the job output can be acted on.
  assert.match(notes[0], /session-lead/);
});

test('a disposed agent (followup throws) is reported once, never thrown', () => {
  const notifier = notifierFor(() => ({
    followup() {
      throw new Error('agent disposed');
    },
  }));

  const queued = { runId: 'run-1', status: 'queued' };
  const first = notifier.notify(reportBetween(undefined, queued), queued, undefined);
  assert.equal(first.pushed, false);
  assert.equal(first.reason, 'followup-failed');

  const running = { runId: 'run-1', status: 'running' };
  notifier.notify(reportBetween(queued, running), running, queued);

  const notes = notifier.notes();
  assert.equal(notes.length, 1);
  assert.match(notes[0], /agent disposed/);
});

test('an agent without followup() is reported, never thrown', () => {
  const notifier = notifierFor(() => ({}));
  const queued = { runId: 'run-1', status: 'queued' };
  const result = notifier.notify(reportBetween(undefined, queued), queued, undefined);
  assert.equal(result.pushed, false);
  assert.equal(result.reason, 'unsupported-agent');
  assert.match(notifier.notes()[0], /no followup/);
});

test('an async-rejected followup becomes a note instead of an unhandled rejection', async () => {
  const notifier = notifierFor(() => ({
    followup() {
      return Promise.reject(new Error('driver gone'));
    },
  }));
  const queued = { runId: 'run-1', status: 'queued' };

  // Handing the message off is the push; the rejection arrives later and must be
  // caught by the notifier, not crash the process the watcher lives in.
  const result = notifier.notify(reportBetween(undefined, queued), queued, undefined);
  assert.equal(result.pushed, true);
  await nextImmediate();
  assert.match(notifier.notes()[0], /driver gone/);
});

test('a gone report uses the previous observation, the only source of the run id', () => {
  const agent = fakeAgent();
  const notifier = notifierFor(() => agent);
  const previous = { runId: 'run-gone-123', status: 'running' };
  const current = { status: 'idle' };
  const report = reportBetween(previous, current);
  assert.equal(report.kind, 'gone', 'the fixture must be a disappearance');

  const result = notifier.notify(report, current, previous);
  assert.equal(result.pushed, true);
  assert.ok(
    agent.calls[0].content[0].text.includes('opendesign_ask({ run_id: "run-gone-123" })'),
    'the collect call must name the run that just stopped being live',
  );
});

test('a change with no known run id is still pushed, without a collect call', () => {
  const agent = fakeAgent();
  const notifier = notifierFor(() => agent);
  const report = { changed: true, kind: 'status', message: 'the conversation changed' };

  const result = notifier.notify(report, { status: 'unknown' }, undefined);
  assert.equal(result.pushed, true);
  const text = agent.calls[0].content[0].text;
  assert.equal(text.includes('opendesign_ask'), false, 'inventing a run id would be a lie');
  assert.match(text, /designer/);
});

test('notes() hands out a copy, so a caller cannot rewrite the recorded history', () => {
  const notifier = notifierFor(() => undefined);
  const queued = { runId: 'run-1', status: 'queued' };
  notifier.notify(reportBetween(undefined, queued), queued, undefined);

  const notes = notifier.notes();
  notes.push('invented');
  assert.equal(notifier.notes().length, 1);
});

/* ------------------------------------------------------------------------- *
 * Wiring tests: the module can be perfect and still never be called. These read
 * `index.js` for the same reason `test/watch.test.js` and
 * `test/ask-order.test.js` do — the property is HOW the one watcher loop is
 * arranged, and no unit test of any exported function can see it.
 * ------------------------------------------------------------------------- */

/** `index.js` source and the `armWatcher` body with comments stripped. */
async function watcherSource() {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function armWatcher(');
  assert.notEqual(start, -1, 'index.js must contain the one watcher implementation');
  // The watcher is immediately followed by `runTurn`'s JSDoc; the marker is the
  // same one `test/watch.test.js` slices on, so both tests agree on the boundary.
  const end = source.indexOf('\n  /**\n   * Run one Open Design turn', start);
  assert.ok(end > start, 'armWatcher must be followed by runTurn');
  const body = source
    .slice(start, end)
    // Strip comments: the body NAMES these calls to explain why they must exist.
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  return { source, body };
}

test('the push sits INSIDE the report.changed branch, once per batch', async () => {
  const { body } = await watcherSource();

  const changedAt = body.indexOf('if (report.changed) {');
  assert.notEqual(changedAt, -1, 'the change gate must exist');
  const branchEnd = body.indexOf('previous = observation;', changedAt);
  assert.ok(branchEnd > changedAt, 'the gate must be a block, not a bare if');
  const branch = body.slice(changedAt, branchEnd);

  assert.equal(
    (branch.match(/notifier\.notify\(/g) ?? []).length,
    1,
    'one push per changed batch: a second call means per-line or per-poll pushes',
  );
  assert.match(
    branch,
    /notifier\.notify\(report, observation/,
    'the notifier must see the report it is deciding on, not a re-derived summary',
  );

  // Pushing is ADDITIVE: the durable job line still has to be written, or a
  // caller who never reads its inbox loses the record.
  assert.match(branch, /job\.append\(/, 'the job output must keep recording the change');

  // And nothing outside the branch may push: `activity` (journal growth) is
  // reported as `changed: false`, so any push outside the gate defeats the split.
  assert.equal(
    (body.match(/notifier\.notify\(/g) ?? []).length,
    1,
    'the only push call belongs to the changed branch',
  );
  assert.ok(body.indexOf('notifier.notify(') > changedAt);
});

test('the watcher resolves the injected agents service on every push', async () => {
  const { source, body } = await watcherSource();

  assert.match(body, /createWatchNotifier\(\{/);

  // `ctx.agents.get(...)` is the verified way to reach the live agent. The
  // resolver must be a function (per push), not an agent captured at arm time.
  assert.match(
    body,
    /resolveAgent:[\s\S]{0,120}ctx\.agents\.get\(/,
    'the push must resolve the live agent through ctx.agents',
  );

  // `agents` is a hard inject of this plugin today; if it is dropped, the
  // resolver silently degrades into "no live agent" notes and the model is
  // never notified. The mechanism depends on this list.
  const inject = /export const inject = \[([^\]]*)\]/.exec(source);
  assert.notEqual(inject, null, 'the plugin must declare its inject list');
  assert.match(inject[1], /'agents'/, 'push delivery requires the agents service to be injected');
});

test('a failed push is surfaced in the job output, not swallowed', async () => {
  const { body } = await watcherSource();
  const changedAt = body.indexOf('if (report.changed) {');
  const notesAt = body.indexOf('notifier.notes()', changedAt);
  assert.ok(notesAt > changedAt, 'the changed branch must consume the recorded push failures');
  // The reason goes back to the caller through the job output — the durable
  // record that keeps working when the model cannot be woken.
  assert.match(body.slice(notesAt, notesAt + 400), /job\.append\(/);
});

test('there is still exactly ONE watcher loop in the repo', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.equal(
    (source.match(/jobs\.start\(/g) ?? []).length,
    1,
    'a second jobs.start means a second watcher implementation, which will drift',
  );
  assert.match(
    source,
    /import \{ createWatchNotifier \} from '\.\/lib\/watch-push\.js';/,
    'the watcher must import the notifier module, or nothing is ever pushed',
  );
});

test('a run the arming call already carries is reported, not pushed twice', async () => {
  const { source, body } = await watcherSource();
  const changedAt = body.indexOf('if (report.changed) {');
  assert.notEqual(changedAt, -1);
  const branch = body.slice(changedAt, body.indexOf('if (observation.status !== \'unknown\') previous = observation;', changedAt));

  // The set is owned by the WATCHER, and both the create and the reuse path hand
  // the same set back: otherwise an ask that reuses a live watcher cannot claim
  // its own run, and every ask after the first re-pushes a delivered turn.
  assert.match(body, /const selfHandled = new Set\(\);/, 'the watcher must own one live set');
  assert.match(
    body,
    /reused: true[\s\S]{0,200}selfHandled: recorded\.selfHandled/,
    'the reuse path must return the SAME set',
  );
  assert.match(body, /armed\.set\(key, \{ jobId, selfHandled, startedHere, seedRun \}\)/, 'both sets and the seed hook are stored with the job id');
  assert.match(branch, /selfHandled\.has\(changedRunId\)/, 'the skip decision must be per run id');
  assert.match(branch, /push skipped/, 'the job record must still show the change happened');

  // The ask side owns both halves of the rule: claim the run when Open Design
  // accepts it, release it only when the wait ended before it settled.
  const askAt = source.indexOf("name: 'opendesign_ask'");
  const askEnd = source.indexOf("name: 'opendesign_status'", askAt);
  const ask = source.slice(askAt, askEnd);
  assert.match(ask, /const selfHandledRuns = armedWatcher\?\.selfHandled/, 'the arming call takes the watcher\'s live set');
  assert.match(ask, /selfHandledRuns\?\.add\(createdRunId\)/, 'the arming call must claim its own run');
  assert.match(ask, /selfHandledRuns\?\.delete\(settled\.runId\)/, 'stillRunning must release the run to the watcher');
  assert.match(ask, /settled\.stillRunning === true/, 'only a wait that delivered no answer releases the run');
});

test('a run this call just started is not announced back to it', async () => {
  const { source, body } = await watcherSource();
  const changedAt = body.indexOf('if (report.changed) {');
  assert.notEqual(changedAt, -1, 'the change gate must exist');
  const branch = body.slice(changedAt, body.indexOf('previous = observation;', changedAt));

  // The receipt already says the run is queued/running. Re-announcing its
  // appearance (and then every queued→running step) put two extra queue entries
  // in front of the caller for one completion.
  assert.match(body, /const startedHere = new Set\(\);/, 'the watcher must track the runs this process started');
  assert.match(branch, /startedHere\.has\(changedRunId\)/, 'the skip decision must consult it per run id');
  assert.match(branch, /isWorking\(observation\.status\)/, 'only the still-working phase is suppressed — the completion must be pushed');
  assert.match(branch, /this call just started that run/, 'the job record must say why nothing was pushed');

  // Released when the run stops working, so a long-lived watcher cannot grow it.
  assert.match(body, /startedHere\.delete\(changedRunId\)/, 'a finished run must be forgotten');

  // Shared with a reused watcher, exactly like `selfHandled`: an ask that joins a
  // running watcher still has to be able to claim its own run.
  assert.match(
    body,
    /reused: true[\s\S]{0,300}startedHere: recorded\.startedHere/,
    'the reuse path must hand back the same startedHere set',
  );

  // Explicit `opendesign_watch` starts nothing, so it must not fill the set: a run
  // the human started in the window is real news.
  const watchAt = source.indexOf("name: 'opendesign_watch'");
  const watchEnd = source.indexOf("name: 'opendesign_inbox'", watchAt);
  const watch = source.slice(watchAt, watchEnd);
  assert.equal(
    /startedHere\??\.add\(/.test(watch),
    false,
    'opendesign_watch must not claim runs — it has no receipt to be redundant with',
  );
});

test('a run this call interrupted is reported in the result, not pushed again', async () => {
  const { source } = await watcherSource();
  // The redirect result already carries `interrupted: { status, cancelOrigin,
  // answerSoFar }`. The watcher then sees that run go `canceled` — the same fact,
  // which would arrive as a second message for one turn. Measured: one redirect
  // produced exactly that extra push.
  assert.match(
    source,
    /if \(interrupted\?\.runId !== undefined\) selfHandledRuns\?\.add\(interrupted\.runId\)/,
    'the interrupted run must be claimed as already reported',
  );
});

test('the baseline is only advanced by a definite observation', async () => {
  const { body } = await watcherSource();

  // `unknown` is a missing observation, not a state. Letting it become the
  // baseline is what made recovery report `gone (was unknown)` — a disappearance
  // of something that had never been seen — and it claimed a collectable answer
  // on no evidence.
  assert.match(
    body,
    /if \(observation\.status !== 'unknown'\) previous = observation;/,
    'a failed poll must not overwrite the last definite observation',
  );
  assert.equal(
    /^\s*previous = observation;$/m.test(body),
    false,
    'the unconditional assignment is the defect: it lets a blind poll win the baseline',
  );
});
