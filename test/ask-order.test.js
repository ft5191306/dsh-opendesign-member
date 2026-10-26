/**
 * Structural tests for the ASK EXECUTION ORDER in `index.js`.
 *
 * Why these read the source instead of calling something: both defects they pin
 * live in the COMPOSITION of two well-tested pure functions (`planTurn` and
 * `reconcileWatch`), inside a 430-line `execute` body that no test could drive
 * without a real daemon, a real Cordis context, and a real Open Design turn. The
 * three bugs in v0.3.0 were all like this: every participating pure function was
 * correct on its own, so 91 unit tests were green while the tool did the wrong
 * thing. `test/watch.test.js:38` established the technique — grep the source for
 * a property of HOW the loops and calls are arranged — and this file reuses it
 * rather than inventing a harness.
 *
 * The two properties here are ORDER properties, which is exactly the class of bug
 * that a unit test of either function cannot see:
 *
 *   1. bug1 — `watch` must be computed AFTER the interrupt block, not before it.
 *      Before the fix the pre-cancel verdict ("busy, run r1") was used by the
 *      guard after this call had already cancelled r1, so on a live run `inject`
 *      returned `adopted` naming the run it had just killed, and started nothing.
 *
 *   2. bug3 — the guard must block on `busy === true` only. A three-valued watch
 *      reports a failed lookup as `busy: null`, and treating that as a block is
 *      what made one unreadable run freeze a member permanently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** The `opendesign_ask` execute body, with comments stripped. */
async function askBody() {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("name: 'opendesign_ask'");
  assert.notEqual(start, -1, 'opendesign_ask must exist in index.js');
  const end = source.indexOf("name: 'opendesign_status'", start);
  assert.ok(end > start, 'opendesign_ask must be followed by opendesign_status');
  const body = source.slice(start, end);
  // Strip comments before matching: this body NAMES the calls it must not make in
  // order to explain them, so a naive match would pass or fail on prose.
  return body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

test('bug1: ask re-observes what is running AFTER it interrupts, never before', async () => {
  const body = await askBody();

  // Position of the interrupt block that actually cancels the old run, and of the
  // guard that decides whether a new turn may start.
  const interruptAt = body.indexOf('if (plan.interruptRunId !== undefined) {');
  assert.notEqual(interruptAt, -1, 'the interrupt block must exist');
  const cancelAt = body.indexOf('await od.cancelRun(plan.interruptRunId)');
  assert.notEqual(cancelAt, -1, 'the interrupt block must cancel the run');
  const guardAt = body.indexOf('if (watch.busy === true');
  assert.notEqual(guardAt, -1, 'the busy guard must exist');

  // The re-observation must sit between the cancel and the guard. Searching for
  // the CALL (`await observe(`) is deliberate: a future edit that moves the block
  // but keeps a stale variable in scope would still pass a mere declaration check.
  const reobserveAt = body.indexOf('await observe([plan.interruptRunId])');
  assert.notEqual(
    reobserveAt,
    -1,
    'after cancelling, the bridge must ask the daemon again what is running — '
    + 'reusing the pre-cancel verdict is the inject bug',
  );
  assert.ok(
    reobserveAt > cancelAt,
    'the re-observation must come AFTER the cancel it is reacting to',
  );
  assert.ok(
    reobserveAt < guardAt,
    'the re-observation must come BEFORE the guard that consumes its verdict, '
    + 'or the guard reads the stale pre-cancel verdict again',
  );

  // And the guard must consume the fresh verdict. `watch` is assigned from the
  // pre-cancel observation and then replaced by the post-cancel one; a guard
  // reading anything else is the defect back in a new spelling.
  assert.match(
    body,
    /let watch = first\.watch/,
    'the guard variable starts from the first observation',
  );
  assert.match(
    body,
    /watch = after\.watch/,
    'and is REPLACED by the post-cancel observation',
  );
});

test('bug1: an interrupt and a start are reported together, with distinct run ids', async () => {
  const body = await askBody();

  // Both return paths must be able to carry `interrupted`. The old code only
  // spread it into the `stillRunning` branch, so the one case that needs the
  // receipt most — a redirect that ran to completion — could not report what it
  // destroyed. The acceptance criterion is on the RESULT SHAPE, so assert the
  // shape: the settled path spreads `interrupted` too.
  const returns = body.split('return {').slice(1);
  const carriesInterrupt = returns.filter((chunk) => chunk.includes('...(interrupted === undefined'));
  assert.ok(
    carriesInterrupt.length >= 2,
    'both the still-running and the settled return must be able to report `interrupted`',
  );
});

test('bug3: the busy guard blocks on a definite busy, letting unknown through', async () => {
  const body = await askBody();

  const guard = /if \(watch\.busy === (\w+) && plan\.answersReply !== true\)/.exec(body);
  assert.notEqual(guard, null, 'the guard must exist');
  // `=== true` is load-bearing: `busy` is `true | false | null`, and `=== null`
  // or a truthiness test would change which states block.
  assert.equal(
    guard[1],
    'true',
    'the guard must block only on busy === true; unknown (null) must proceed, '
    + 'otherwise one failed lookup blocks the member forever',
  );

  // A truthiness test would ALSO block on null and would also silently change
  // meaning if busy ever became a string. Both are the same defect.
  assert.equal(
    /if \(watch\.busy\s*&&/.test(body),
    false,
    'a truthiness guard would block on unknown',
  );

  // Cancelling for form answers must also only happen on a definite verdict: an
  // unknown verdict has no trustworthy run id, and cancelling a guess destroys a
  // live turn for nothing.
  assert.equal(
    /answers !== undefined && watch\.busy === true\b/.test(body),
    true,
    'the answered-over-run cancel must require a definite busy verdict',
  );
});

test('bug3: the tri-state verdict is what the guard is written against', async () => {
  const { reconcileWatch } = await import('../lib/watch.js');

  // The three states the guard distinguishes, each reachable.
  const busy = reconcileWatch({ conversationRun: { runId: 'r', status: 'running' } });
  const idle = reconcileWatch({});
  const unknown = reconcileWatch({ pendingRun: { runId: 'r' }, pendingRunStatus: undefined });

  assert.deepEqual([busy.state, idle.state, unknown.state], ['busy', 'idle', 'unknown']);
  assert.deepEqual([busy.busy, idle.busy, unknown.busy], [true, false, null]);
  // The guard's whole contract in one line: exactly one state blocks.
  assert.deepEqual([busy, idle, unknown].map((v) => v.busy === true), [true, false, false]);
});

test('ask is fire-and-forget by default: it returns a receipt, it does not wait', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = await askBody();

  // Requirement from the product owner: "lead 调用完直接继续下一步工作".
  // Starting a turn must not block on the answer; the watcher push collects it.
  assert.match(source, /askStartWaitMs: 0,/, 'the non-blocking default must be visible in DEFAULTS');
  assert.match(source, /askStartWaitMs: Math\.max\(0, number\('askStartWaitMs'\)\)/, 'resolveConfig must coerce it');
  assert.match(
    body,
    /waitBudgetMs: explicitBudget === undefined \? config\.askStartWaitMs : explicitBudget/,
    'a new turn waits only when timeout_ms was given explicitly',
  );

  // The early return is REQUIRED: awaitRun treats timeoutMs <= 0 as "no deadline"
  // (wait forever), so handing it 0 would turn fire-and-forget into the longest
  // possible block. The receipt lives in `runTurn`, which is OUTSIDE the ask body.
  const turnAt = source.indexOf('async function runTurn(');
  assert.notEqual(turnAt, -1, 'runTurn must exist');
  const turnEnd = source.indexOf('/** Register the tool set in one exact Agent scope. */', turnAt);
  assert.ok(turnEnd > turnAt, 'runTurn must be followed by install()');
  const turn = source.slice(turnAt, turnEnd);
  const createdAt = turn.indexOf("if (typeof input.onRunCreated === 'function') input.onRunCreated(runId);");
  const guardAt = turn.indexOf('if (waitBudgetMs <= 0) return receipt();');
  const awaitAt = turn.indexOf('const settled = await awaitRun(od, runId, {');
  assert.notEqual(createdAt, -1, 'run creation must be stamped before any wait');
  assert.notEqual(guardAt, -1, 'the non-blocking receipt branch must exist');
  assert.notEqual(awaitAt, -1, 'the waiting branch must still exist for explicit timeout_ms');
  assert.ok(createdAt < guardAt, 'the bridge-run registration must happen even when not waiting');
  assert.ok(guardAt < awaitAt, 'the receipt branch must short-circuit BEFORE awaitRun (which would wait forever on 0)');

  // The receipt carries what the caller needs to continue: run id + status.
  const receiptAt = turn.indexOf('const receipt = () => ({');
  assert.notEqual(receiptAt, -1, 'the receipt shape must exist');
  assert.ok(receiptAt < guardAt, 'the receipt factory must be defined before the guard uses it');
  const receipt = turn.slice(receiptAt, awaitAt);
  assert.match(receipt, /runId,/, 'receipt must carry the run id');
  assert.match(receipt, /stillRunning: true/, 'receipt must say the run is still running');
  assert.match(receipt, /degraded: \[\]/, 'a receipt is not a degraded wait');
});

test('collect waits by default only ~15s: reading a run must not park the whole turn', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = await askBody();

  // Real defect this pins: `opendesign_ask({ run_id })` used to inherit the
  // 600000ms turn ceiling, so a collect on a long OD turn blocked the caller's
  // whole turn even though a watcher could have woken it. Waiting is per SHAPE.
  assert.match(
    source,
    /const COLLECT_DEFAULT_WAIT_MS = 15_000;/,
    'the short collect default must exist and stay visible',
  );
  assert.match(
    body,
    /explicitBudget \?\? COLLECT_DEFAULT_WAIT_MS/,
    'the collect branch must use the short default (explicit timeout_ms still overrides)',
  );

  // A short wait is only acceptable because something else wakes the caller: the
  // still-running collect result must name the live watcher that will push.
  assert.match(body, /const collectWatcher = /, 'the collect path must look up the live watcher');
  assert.match(
    body,
    /watcher: collectWatcher/,
    'a stillRunning collect must report who will wake the caller',
  );
});
