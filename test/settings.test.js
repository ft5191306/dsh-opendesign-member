/**
 * Tests for the settings document and the `provider / model / reasoning`
 * resolution.
 *
 * These cover the two behaviours a user would notice as "the panel lied to me":
 * seeding must happen exactly once (not re-impose Open Design's value on every
 * launch), and a stored value that no longer exists must be REPORTED rather than
 * silently swapped for the first option.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL, SettingsStore, loadSettings, modelNameOf, providerOf, resolveSelection, saveSettings,
} from '../lib/settings.js';
import { withTempDir } from './helpers.js';

test('providerOf / modelNameOf: split a qualified id, keep a bare one whole', () => {
  assert.equal(providerOf('open-design/deepseek-v4-pro'), 'open-design');
  assert.equal(modelNameOf('open-design/deepseek-v4-pro'), 'deepseek-v4-pro');
  // A bare id has no provider segment; `default` is not a provider called "default".
  assert.equal(providerOf('deepseek-v4.1-flash'), undefined);
  assert.equal(modelNameOf('deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(providerOf(DEFAULT_MODEL), undefined);
  assert.equal(modelNameOf(DEFAULT_MODEL), DEFAULT_MODEL);
  assert.equal(providerOf(undefined), undefined);
  assert.equal(modelNameOf(undefined), '');
});

test('loadSettings: a missing or corrupt file reads as "never seeded", not as an error', async () => {
  await withTempDir(async ({ file }) => {
    // Missing file: a fresh install must be distinguishable from a seeded one.
    const absent = loadSettings(file('nope.json'));
    assert.equal(absent.model, DEFAULT_MODEL);
    assert.equal(absent.seededAt, null);

    // Corrupt file: same treatment, because failing activation over it is worse.
    const path = file('broken.json');
    saveSettings(path, {});
    const fs = await import('node:fs');
    fs.writeFileSync(path, '{ not json', 'utf8');
    assert.equal(loadSettings(path).seededAt, null);
  });
});

test('SettingsStore: seeding happens once and never overwrites a user choice', async () => {
  await withTempDir(async ({ file }) => {
    const path = file('settings.json');
    const store = new SettingsStore(path);

    const first = store.seedOnce({ model: 'deepseek-v4-pro', reasoning: 'high' }, 'Open Design amr');
    assert.equal(first.seededNow, true);
    assert.equal(store.current().model, 'deepseek-v4-pro');
    assert.equal(store.current().seededFrom, 'Open Design amr');

    // The user picks something of their own.
    store.update({ model: 'deepseek-v4.1-flash', reasoning: '' });
    assert.equal(store.current().model, 'deepseek-v4.1-flash');

    // A later launch sees Open Design holding something else. It must NOT win:
    // the product decision is "seed once, then this side owns the value".
    const again = store.seedOnce({ model: 'claude-opus-5', reasoning: 'max' }, 'Open Design');
    assert.equal(again.seededNow, false);
    assert.equal(store.current().model, 'deepseek-v4.1-flash');
  });
});

test('SettingsStore: an explicit update marks the document as seeded', async () => {
  await withTempDir(async ({ file }) => {
    const store = new SettingsStore(file('settings.json'));
    assert.equal(store.seeded, false);

    store.update({ model: 'deepseek-v4-pro' });

    // Now that a human chose a value, a re-seed must not quietly replace it.
    assert.equal(store.seeded, true);
    assert.equal(store.seedOnce({ model: 'something-else' }, 'x').seededNow, false);
    assert.equal(store.current().model, 'deepseek-v4-pro');
  });
});

test('resolveSelection: `default` needs no catalogue and accepts no tiers', () => {
  const out = resolveSelection({ model: DEFAULT_MODEL, reasoning: '' }, []);
  assert.equal(out.model, DEFAULT_MODEL);
  assert.deepEqual(out.reasoningOptions, []);
  assert.deepEqual(out.problems, []);
});

test('resolveSelection: a stored model that left the catalogue is reported, not replaced', () => {
  const out = resolveSelection(
    { model: 'open-design/gone-model', reasoning: '' },
    [{ provider: 'open-design', id: 'open-design/other', reasoningOptions: [] }],
  );

  // The whole point of the error band: a stale value must stay visible.
  assert.equal(out.model, 'open-design/gone-model', 'must not be swapped for the first option');
  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /no longer offered by provider "open-design"/);
});

test('resolveSelection: the same model id resolves per provider, not globally', () => {
  // Each provider accepts a DIFFERENT tier set for the same id; collapsing them
  // would offer the user tiers its gateway rejects with a 400.
  const catalogue = [
    { provider: 'open-design', id: 'shared/x', reasoningOptions: [{ id: 'max' }] },
    { provider: 'deepseek-official', id: 'shared/x', reasoningOptions: [{ id: 'low' }, { id: 'max' }] },
  ];

  const viaOfficial = resolveSelection({ model: 'shared/x', reasoning: 'low' }, catalogue);
  assert.equal(viaOfficial.provider, 'open-design', 'a bare id matches the first entry only');
  assert.equal(viaOfficial.problems.length, 1, 'low is not accepted by open-design/shared/x');
});

test('resolveSelection: an unsupported reasoning tier is reported with what IS accepted', () => {
  const out = resolveSelection(
    { model: 'p/m', reasoning: 'low' },
    [{ provider: 'p', id: 'p/m', reasoningOptions: [{ id: 'max' }, { id: 'high' }] }],
  );

  assert.equal(out.problems.length, 1);
  assert.match(out.problems[0], /"low" is not accepted/);
  assert.match(out.problems[0], /accepts: max, high/);
});

test('resolveSelection: a model with no tiers accepts an empty tier silently', () => {
  // `amr` reports 37 models with no `reasoningOptions` at all. Storing no tier
  // must be normal, not an error.
  const out = resolveSelection(
    { model: 'amr/deepseek-v4.1-flash', reasoning: '' },
    [{ provider: 'amr', id: 'amr/deepseek-v4.1-flash', reasoningOptions: [] }],
  );

  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.reasoningOptions, []);
});
