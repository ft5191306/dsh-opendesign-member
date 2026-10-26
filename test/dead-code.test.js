/**
 * Tests for the dead-code removals (Step 6, the subset that carried no behaviour).
 *
 * These are source-level assertions because dead code has no other observable
 * behaviour: the entire defect is that a declaration exists while nothing reads
 * it. That is worse than absent code in two ways, and both have bitten this
 * project:
 *
 *   - A declared-but-unread parameter LIES TO THE MODEL. `opendesign_watch`'s
 *     `stop_when_idle` was documented in README and described in the tool schema as
 *     "stops itself once idle", and `execute` never read `args.stop_when_idle`. A
 *     caller passing it changed nothing and had no way to tell.
 *   - A field that is never assigned looks like a working signal to whoever next
 *     reads the module. `observeConversation`'s `eventsBytes` axis was defined,
 *     documented, and covered by 13 tests while production never set it, so
 *     `grew` was a constant.
 *
 * Asserting absence is the only honest guard: if either comes back, these fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('step6: opendesign_watch declares no parameter its execute never reads', () => {
  // `stop_when_idle` was declared here and never read. Removing the declaration is
  // what tells the caller the truth; keeping it "for compatibility" would keep
  // lying, since the parameter never did anything to be compatible with.
  assert.equal(
    source.includes('stop_when_idle'),
    false,
    'a declared but unread parameter misleads the model — delete the declaration instead',
  );

  // The parameters that ARE read must still be declared, or the tool stops
  // accepting them.
  const watchAt = source.indexOf("name: 'opendesign_watch'");
  assert.notEqual(watchAt, -1);
  const watchBody = source.slice(watchAt, source.indexOf("name: 'opendesign_inbox'", watchAt));
  assert.match(watchBody, /member: \{/, 'member is read by execute and must stay declared');
  assert.match(watchBody, /interval_ms: \{/, 'interval_ms is read by execute and must stay declared');
});

test('step6: every declared parameter of every tool is actually referenced', () => {
  // A general guard, so the next version of this bug is caught by the same test
  // rather than needing someone to notice it. Compares `args.<name>` reads against
  // the declared parameter names inside each tool's block.
  const tools = [...source.matchAll(/name: '(opendesign_\w+)'/g)];
  assert.ok(tools.length >= 4, 'expected at least four opendesign tools');

  for (let index = 0; index < tools.length; index += 1) {
    const name = tools[index][1];
    const start = tools[index].index;
    const end = index + 1 < tools.length ? tools[index + 1].index : source.length;
    const block = source.slice(start, end);

    // Each declaration is `<key>: {` inside the `parameters: {` object.
    const parametersAt = block.indexOf('parameters: {');
    if (parametersAt === -1) continue;
    const outputAt = block.indexOf('output:', parametersAt);
    const parameterBlock = block.slice(parametersAt, outputAt === -1 ? undefined : outputAt);
    const declared = [...parameterBlock.matchAll(/^\s{10}(\w+): \{/gm)].map((match) => match[1]);

    for (const parameter of declared) {
      assert.match(
        block,
        new RegExp(`args\\.${parameter}\\b`),
        `${name} declares "${parameter}" but its execute never reads args.${parameter}`,
      );
    }
  }
});

test('step6: the conversation-watch activity axis does not promise a signal nobody sends', async () => {
  const { observeConversation } = await import('../lib/conversation-watch.js');

  // `eventsBytes` and `textLength` are still accepted (they are useful to any
  // caller that HAS them, and `observeRun` supplies `textLength`), but the
  // production watcher passes neither. What must not happen is a caller reading
  // `activity` as a working liveness signal — so the honest statement is that this
  // is only as good as the inputs.
  //
  // Assert the axis stays internally consistent: absent inputs never fabricate
  // growth, which is what would produce a false "still working" line.
  const bare = observeConversation({ runId: 'r', status: 'running' });
  assert.equal(bare.eventsBytes, undefined);
  assert.equal(bare.textLength, undefined);

  const { diffConversation } = await import('../lib/conversation-watch.js');
  const report = diffConversation(
    observeConversation({ runId: 'r', status: 'running' }),
    observeConversation({ runId: 'r', status: 'running' }),
  );
  // No inputs, no growth: silent, not a fabricated activity line.
  assert.equal(report.changed, false);
  assert.equal(report.kind, 'none');
});
