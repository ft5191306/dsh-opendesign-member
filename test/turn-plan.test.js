/**
 * Tests for `planTurn` / `composeRunMessage` — what one `opendesign_ask` means.
 *
 * The behaviour these pin was established by driving the real Open Design
 * desktop app on 2026-10-25, not by reading its bundle. Two separate tests:
 *
 * 1. `POST /api/runs/:id/steer` against a LIVE `amr` turn answers 409
 *    `RUN_STEERING_UNSUPPORTED` ("its stdin is closed together with the opening
 *    prompt"). That refusal is what made real mid-turn steering look impossible.
 *
 * 2. But the UI's 「引导对话」 button does not call that route. Pressing it with a
 *    turn running produced a NEW run (`8473cde6`) while the old one
 *    (`56f9c028`) was still working — 105 ms before it ended — left NO user
 *    message row for the typed text, and marked the old run
 *    `cancel_origin: user_stop`. The new run reached the prior context through
 *    `prior_transcript`.
 *
 * So redirection = cancel-and-restart, and the invariants below keep it honest:
 *   1. It never claims to inject into a running turn.
 *   2. It only interrupts a run that is actually still live.
 *   3. The new instruction is not also written into history, so it appears once.
 *   4. Collecting a run never also sends something.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planTurn, composeRunMessage } from '../lib/turn-plan.js';

test('planTurn: collecting a run is a read and sends nothing', () => {
  const plan = planTurn({
    runId: 'run-1',
    prompt: 'this must be ignored',
    inject: 'so must this',
    pendingRun: { runId: 'run-1' },
  });

  assert.equal(plan.kind, 'collect');
  assert.equal(plan.runId, 'run-1');
  // A collect that also wrote a message would start a second turn on top of the
  // one it is collecting, and the answer would land in the wrong place.
  assert.equal(plan.prompt, undefined);
});

test('planTurn: redirecting a live turn interrupts it and runs the text', () => {
  const plan = planTurn({
    inject: '算了，画个房子吧',
    pendingRun: { runId: 'run-live' },
    pendingRunActive: true,
  });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, '算了，画个房子吧');
  // The run to stop, named explicitly so the tool cannot forget to stop it —
  // and so the caller can be told what work was traded away.
  assert.equal(plan.interruptRunId, 'run-live');
});

test('planTurn: redirecting with nothing in flight just runs the text', () => {
  const plan = planTurn({ inject: 'just build it' });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, 'just build it');
  assert.equal(plan.injectedAsTurn, true);
  // Nothing to cancel, so no interrupt is requested and none is pretended.
  assert.equal(plan.interruptRunId, undefined);
});

test('planTurn: redirecting a settled run does not interrupt anything', () => {
  const plan = planTurn({
    inject: 'still want the dark palette',
    pendingRun: { runId: 'run-done' },
    pendingRunActive: false,
  });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, 'still want the dark palette');
  // Cancelling an already-finished run would be a lie in the result: nothing was
  // interrupted, so nothing may be reported as interrupted.
  assert.equal(plan.interruptRunId, undefined);
  assert.equal(plan.staleRunId, 'run-done');
});

test('planTurn: redirecting never writes a separate history row', () => {
  const plan = planTurn({
    inject: 'make it a house',
    pendingRun: { runId: 'run-live' },
    pendingRunActive: true,
  });

  // The text becomes the new run's own user message. A `userMessageId` here would
  // mean an existing row gets adopted — i.e. a second copy of a sentence that was
  // never sent as an ordinary message.
  assert.equal(plan.userMessageId, undefined);
  assert.equal(plan.consumingInject, undefined);
});

test('planTurn: a plain prompt is a plain turn', () => {
  const plan = planTurn({ prompt: 'brief the landing page' });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, 'brief the landing page');
  assert.equal(plan.interruptRunId, undefined);
});

test('planTurn: nothing to do is an error with a usable reason', () => {
  const plan = planTurn({});
  assert.equal(plan.kind, 'error');
  assert.match(plan.reason, /no prompt/);
});

test('planTurn: blank strings are not prompts, ids, or injections', () => {
  assert.equal(planTurn({ prompt: '   ' }).kind, 'error');
  assert.equal(planTurn({ prompt: '   ', inject: '  ' }).kind, 'error');
  // A blank run id must not shadow a real prompt: trimming happens before the
  // branch, so this stays an ordinary turn.
  const plan = planTurn({ runId: '  ', prompt: 'build the page' });
  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, 'build the page');
});

test('planTurn: a stale pending run does not swallow a prompt', () => {
  const plan = planTurn({
    prompt: 'next thing',
    pendingRun: { runId: 'run-done' },
    pendingRunActive: false,
  });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.prompt, 'next thing');
  assert.equal(plan.staleRunId, undefined, 'staleness is only reported when it changed the plan');
});

test('planTurn: a form answer is a REPLY and says so on the plan', () => {
  // Measured regression, 2026-10-26: a busy-guard added for a different reason
  // held form answers back, so Open Design never received them and asked the same
  // form again on the next turn. The plan has to carry "this is a reply", because
  // a reply must never be dropped the way a fresh request may be deferred.
  const plan = planTurn({
    prompt: '[form answers — form]\n- temperature: warm-paper',
    hasFormAnswers: true,
  });

  assert.equal(plan.kind, 'run');
  assert.equal(plan.answersReply, true);
});

test('planTurn: an ordinary prompt is not a reply', () => {
  const plan = planTurn({ prompt: 'build the landing page' });
  assert.equal(plan.answersReply, undefined);
});

test('planTurn: hasFormAnswers without a prompt is still an error', () => {
  // The answers alone say nothing to run: the caller must supply the composed
  // reply text. Silently running an empty turn would burn a run to say nothing.
  const plan = planTurn({ hasFormAnswers: true });
  assert.equal(plan.kind, 'error');
});

test('composeRunMessage: a normal turn carries the sender prefix exactly once', () => {
  const message = composeRunMessage({
    sender: 'lead (DSH lead)',
    prompt: 'build the landing page',
  });

  assert.equal(message, '[lead (DSH lead)]\n\nbuild the landing page');
});

test('composeRunMessage: a turn adopting a row sends the row text verbatim', () => {
  // The regression this pins, hit live on 2026-10-25: the daemon overwrites an
  // adopted row's content with the run's `message`, so prefixing again left the
  // window reading "[lead (DSH lead)]\n\n[lead (DSH lead)]\n\nthe sentence".
  const rowText = '[lead (DSH lead)]\n\n改一下：做浅灰底、高对比文字。';
  const message = composeRunMessage({
    sender: 'lead (DSH lead)',
    prompt: rowText,
    userMessageId: 'msg-adopted',
  });

  assert.equal(message, rowText);
  assert.equal(message.match(/\[lead \(DSH lead\)\]/g).length, 1);
});

test('composeRunMessage: no sender means no prefix', () => {
  assert.equal(composeRunMessage({ prompt: 'bare text' }), 'bare text');
});
