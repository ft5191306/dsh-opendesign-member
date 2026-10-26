/**
 * Tests for the bindings document.
 *
 * Two properties carry real weight:
 *
 *   1. `flush()` MERGES over what is on disk. Two members writing from separate
 *      tool calls must not clobber each other, and a human editing the file by
 *      hand must not silently lose their edit.
 *   2. Reads never write. `opendesign_status` is documented as read-only; if a
 *      peek created records on disk, merely inspecting the bridge would rewrite
 *      the roster.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { BindingStore, loadBindings, saveBindings } from '../lib/bindings.js';
import { withTempDir } from './helpers.js';

test('loadBindings: a missing or corrupt file reads as an empty roster', async () => {
  await withTempDir(async ({ file }) => {
    assert.deepEqual(loadBindings(file('absent.json')).teams, {});

    const broken = file('broken.json');
    saveBindings(broken, { schemaVersion: 1, teams: {} });
    fs.writeFileSync(broken, 'not json at all', 'utf8');
    assert.deepEqual(loadBindings(broken).teams, {});
  });
});

test('BindingStore: peeking never writes to disk', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    const store = new BindingStore(path);

    // A read-only tool does exactly this much: reload, then peek.
    store.reload();
    store.peekTeam('team-a');
    store.member('team-a', 'lead');
    store.cursor('team-a', 'lead');
    store.bridgeRuns('team-a', 'lead');

    assert.equal(fs.existsSync(path), false, 'inspecting the bridge must not create the file');
  });
});

test('BindingStore: two stores writing different members both survive', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    const a = new BindingStore(path);
    const b = new BindingStore(path);

    // Each instance loads the file before the other writes, so a replace-style
    // flush would drop the other member entirely.
    a.reload();
    b.reload();
    a.setMember('team-a', 'lead', { conversationId: 'conv-lead', projectId: 'p' });
    b.setMember('team-a', 'ui-reviewer', { conversationId: 'conv-ui', projectId: 'p' });

    const onDisk = loadBindings(path);
    const members = Object.keys(onDisk.teams['team-a'].members).sort();
    assert.deepEqual(members, ['lead', 'ui-reviewer']);
    assert.equal(onDisk.teams['team-a'].members.lead.conversationId, 'conv-lead');
    assert.equal(onDisk.teams['team-a'].members['ui-reviewer'].conversationId, 'conv-ui');
  });
});

test('BindingStore: bridge run ids are remembered, de-duplicated, and bounded', async () => {
  await withTempDir(async ({ file }) => {
    const store = new BindingStore(file('bindings.json'));
    store.setMember('team-a', 'lead', { conversationId: 'c', projectId: 'p' });

    store.noteBridgeRun('team-a', 'lead', 'run-1');
    store.noteBridgeRun('team-a', 'lead', 'run-1');
    assert.deepEqual(store.bridgeRuns('team-a', 'lead'), ['run-1'], 'no duplicates');

    // Bounded so the document cannot grow forever; only recent ids are needed,
    // because older answers are already behind the inbound cursor.
    for (let index = 0; index < 60; index += 1) {
      store.noteBridgeRun('team-a', 'lead', `run-extra-${index}`);
    }
    const kept = store.bridgeRuns('team-a', 'lead');
    assert.equal(kept.length, 50);
    assert.equal(kept.at(-1), 'run-extra-59', 'the newest id is kept');
    assert.equal(kept.includes('run-1'), false, 'the oldest id is dropped');
  });
});

test('BindingStore: noteBridgeRun ignores junk instead of recording it', async () => {
  await withTempDir(async ({ file }) => {
    const store = new BindingStore(file('bindings.json'));
    store.setMember('team-a', 'lead', { conversationId: 'c', projectId: 'p' });

    store.noteBridgeRun('team-a', 'lead', '');
    store.noteBridgeRun('team-a', 'lead', null);
    store.noteBridgeRun('team-a', 'lead', undefined);

    assert.deepEqual(store.bridgeRuns('team-a', 'lead'), []);
  });
});

test('BindingStore: a pending run can be recorded, read, and cleared', async () => {
  await withTempDir(async ({ file }) => {
    const store = new BindingStore(file('bindings.json'));
    store.setMember('team-a', 'lead', { conversationId: 'c', projectId: 'p' });

    assert.equal(store.pendingRun('team-a', 'lead'), undefined);

    store.notePendingRun('team-a', 'lead', { runId: 'run-9', startedAt: 123 });
    assert.equal(store.pendingRun('team-a', 'lead').runId, 'run-9');

    store.clearPendingRun('team-a', 'lead');
    assert.equal(store.pendingRun('team-a', 'lead'), undefined);
  });
});

test('BindingStore: an inbound cursor advances and is persisted', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    const store = new BindingStore(path);
    store.setMember('team-a', 'lead', { conversationId: 'c', projectId: 'p' });

    store.setCursor('team-a', 'lead', { id: 'msg-9', createdAt: 999 });

    // A fresh store sees it: the cursor survives a restart, which is what makes
    // inbound delivery exactly-once across sessions.
    const reloaded = new BindingStore(path);
    assert.equal(reloaded.cursor('team-a', 'lead').id, 'msg-9');
  });
});

test('BindingStore: the pending question form round-trips and clears', async () => {
  await withTempDir(async ({ file }) => {
    const store = new BindingStore(file('bindings.json'));
    store.setMember('team-a', 'lead', { conversationId: 'c', projectId: 'p' });

    store.setPendingForm('team-a', 'lead', {
      id: 'color', title: 'Pick a color', questions: [{ id: 'c' }], runId: 'run-1',
    });
    assert.equal(store.member('team-a', 'lead').pendingForm.id, 'color');

    store.clearPendingForm('team-a', 'lead');
    assert.equal(store.member('team-a', 'lead').pendingForm, undefined);
  });
});

test('BindingStore: two stores writing different FIELDS of one member both survive', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    // ONE member, so there is no member key to tell the two writers apart: the
    // merge has to be decided per field or one writer's work disappears.
    const seed = new BindingStore(path);
    seed.setMember('team-a', 'lead', { conversationId: 'conv-lead', projectId: 'p' });

    // Both instances load before either writes. That is not a contrived race: it
    // is what a concurrent `ask` + `inbox` looks like, because `opendesign_ask`
    // records the bridge run (index.js:1853) while `opendesign_inbox` advances
    // the cursor (index.js:2225), and each tool call builds its own store.
    const ask = new BindingStore(path);
    const inbox = new BindingStore(path);
    ask.reload();
    inbox.reload();
    ask.noteBridgeRun('team-a', 'lead', 'run-1');
    inbox.setCursor('team-a', 'lead', { id: 'msg-9', createdAt: 999 });

    const onDisk = loadBindings(path).teams['team-a'].members.lead;
    assert.deepEqual(onDisk.bridgeRuns, ['run-1'], 'the bridge run survives the cursor write');
    // The cursor is the half that must never be lost: without it inbound
    // delivery hands the same Open Design messages over again, which is the
    // exactly-once property this document exists to hold.
    assert.equal(onDisk.cursor?.id, 'msg-9', 'the cursor survives the bridge-run write');

    // The worst-realistic shape: `opendesign_open` spreads a WHOLE member back
    // through `setMember` to change only `model` (index.js:1483). That object
    // carries a stale `cursor`, so a merge that claims every present key would
    // roll the cursor back. Only the coordinates are claimed, so it does not.
    const opener = new BindingStore(path);
    const later = new BindingStore(path);
    opener.reload();
    later.reload();
    const stale = opener.member('team-a', 'lead');
    later.setCursor('team-a', 'lead', { id: 'msg-10', createdAt: 1_000 });
    opener.setMember('team-a', 'lead', { ...stale, model: 'deepseek-v4.1-flash' });

    const afterOpen = loadBindings(path).teams['team-a'].members.lead;
    assert.equal(afterOpen.model, 'deepseek-v4.1-flash', 'the requested model lands');
    assert.equal(afterOpen.cursor?.id, 'msg-10', 'a spread member does not roll the cursor back');
    assert.deepEqual(afterOpen.bridgeRuns, ['run-1'], 'and keeps the bridge run');
  });
});

test('BindingStore: a cleared pendingRun is not resurrected by another store\'s write', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    const seed = new BindingStore(path);
    seed.setMember('team-a', 'lead', { conversationId: 'conv-lead', projectId: 'p' });
    seed.notePendingRun('team-a', 'lead', { runId: 'run-9', startedAt: 123 });

    // The clear is a DELETION, and a deletion has to be published like any other
    // edit: replaying only present fields would let the disk copy restore the
    // record, and a settled run would stay collectable forever.
    const collector = new BindingStore(path);
    const inbox = new BindingStore(path);
    collector.reload();
    inbox.reload();
    inbox.setCursor('team-a', 'lead', { id: 'msg-9', createdAt: 999 });
    collector.clearPendingRun('team-a', 'lead');

    const afterClear = loadBindings(path).teams['team-a'].members.lead;
    assert.equal(afterClear.pendingRun, undefined, 'a collected run is not written back from disk');
    assert.equal(afterClear.cursor?.id, 'msg-9', 'the clear does not roll the cursor back');

    // The other interleaving: the clear flushes first, then a store whose copy
    // still remembers the run writes the cursor. That stale copy must contribute
    // only the cursor.
    seed.notePendingRun('team-a', 'lead', { runId: 'run-10', startedAt: 456 });
    const collector2 = new BindingStore(path);
    const inbox2 = new BindingStore(path);
    collector2.reload();
    inbox2.reload();
    collector2.clearPendingRun('team-a', 'lead');
    inbox2.setCursor('team-a', 'lead', { id: 'msg-10', createdAt: 1_000 });

    const afterReorder = loadBindings(path).teams['team-a'].members.lead;
    assert.equal(afterReorder.pendingRun, undefined, 'a stale copy does not write the run back');
    assert.equal(afterReorder.cursor?.id, 'msg-10', 'the newer cursor still lands');
  });
});

test('BindingStore: rebinding to a new conversation drops the old window\'s state', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('bindings.json');
    const store = new BindingStore(path);
    store.setMember('team-a', 'lead', { conversationId: 'conv-old', projectId: 'p' });
    store.setCursor('team-a', 'lead', { id: 'msg-old', createdAt: 1 });
    store.notePendingRun('team-a', 'lead', { runId: 'run-old', startedAt: 2 });
    store.setPendingForm('team-a', 'lead', { id: 'color' });

    // `force_new` binds a brand-new conversation. The cursor, pending run, and
    // pending form all name messages in the OLD one, so carrying them over would
    // make the fresh window skip its first replies and offer an answer to a
    // question it never asked. Whole-member replacement dropped them implicitly;
    // the field merge has to drop them deliberately.
    store.setMember('team-a', 'lead', { conversationId: 'conv-new', projectId: 'p' });

    const onDisk = loadBindings(path).teams['team-a'].members.lead;
    assert.equal(onDisk.conversationId, 'conv-new');
    assert.equal(onDisk.cursor, undefined);
    assert.equal(onDisk.pendingRun, undefined);
    assert.equal(onDisk.pendingForm, undefined);
  });
});

test('BindingStore: setters on an unknown member are no-ops rather than throwing', async () => {
  await withTempDir(async ({ file }) => {
    const store = new BindingStore(file('bindings.json'));

    // No member has ever been bound. A tool must degrade, not crash, because a
    // thrown error here would surface as a mysterious tool failure.
    assert.equal(store.noteBridgeRun('team-a', 'ghost', 'run-1'), undefined);
    assert.equal(store.setCursor('team-a', 'ghost', { id: 'x' }), undefined);
    assert.equal(store.setPendingForm('team-a', 'ghost', { id: 'f' }), undefined);
    assert.equal(store.notePendingRun('team-a', 'ghost', { runId: 'r' }), undefined);
    assert.equal(store.noteTurn('team-a', 'ghost', { runId: 'r' }), undefined);
  });
});
