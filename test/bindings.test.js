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
