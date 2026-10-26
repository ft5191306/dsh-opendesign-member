/**
 * Tests for reading what a turn actually DID.
 *
 * The incident these encode, measured 2026-10-26: a turn written as a design
 * discussion called Read, Bash and TodoWrite without saying so, and the next turn
 * began a `Write`. The caller believed it was still aligning while Open Design had
 * started building, because the reply text read as a plan with assumptions.
 *
 * Two invariants matter most:
 *   1. An UNREADABLE journal is "unknown", never "zero tool calls". Reporting zero
 *      would tell the caller "this was just talk" about a turn that wrote files.
 *   2. A pure discussion stays silent. If every turn carried a line, the notice that
 *      matters would be lost in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readTurnActions, describeActions } from '../lib/turn-actions.js';
import { tempRoot } from './helpers.js';

/** Write one journal file and return its path. */
async function journal(lines) {
  const dir = await mkdtemp(path.join(tempRoot(), 'od-turn-'));
  const file = path.join(dir, 'events.jsonl');
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  return file;
}

const toolUse = (name) => ({ event: 'agent', data: { type: 'tool_use', name } });
const thinking = () => ({ event: 'agent', data: { type: 'thinking_delta', delta: 'x' } });

test('readTurnActions: counts tool calls and names them', async () => {
  const file = await journal([thinking(), toolUse('Bash'), toolUse('Read'), toolUse('Bash')]);
  const actions = await readTurnActions(file);

  assert.equal(actions.read, true);
  assert.equal(actions.toolCalls, 3);
  assert.deepEqual(actions.tools, { Bash: 2, Read: 1 });
});

test('readTurnActions: a Write marks the turn as having changed files', async () => {
  const actions = await readTurnActions(await journal([toolUse('Read'), toolUse('Write')]));
  assert.equal(actions.wrote, true);
});

test('readTurnActions: reading tools alone do not count as writing', async () => {
  const actions = await readTurnActions(await journal([toolUse('Read'), toolUse('Bash'), toolUse('TodoWrite')]));
  assert.equal(actions.wrote, false);
});

test('readTurnActions: a missing journal is unknown, not zero', async () => {
  const actions = await readTurnActions(path.join(tempRoot(), 'does-not-exist', 'events.jsonl'));
  // `read: false` is the field that stops this being reported as "no tool calls".
  assert.equal(actions.read, false);
  assert.equal(actions.toolCalls, 0);
});

test('readTurnActions: no journal path at all is unknown too', async () => {
  assert.equal((await readTurnActions(undefined)).read, false);
});

test('readTurnActions: a journal with no tool calls is a real zero', async () => {
  const actions = await readTurnActions(await journal([thinking(), thinking()]));
  // Readable AND empty: this is a genuine discussion, and saying so is correct.
  assert.equal(actions.read, true);
  assert.equal(actions.toolCalls, 0);
});

test('readTurnActions: malformed lines are skipped, not fatal', async () => {
  const dir = await mkdtemp(path.join(tempRoot(), 'od-turn-'));
  const file = path.join(dir, 'events.jsonl');
  await writeFile(file, `not json\n${JSON.stringify(toolUse('Write'))}\n{broken`, 'utf8');

  const actions = await readTurnActions(file);
  assert.equal(actions.toolCalls, 1);
  assert.equal(actions.wrote, true);
});

test('describeActions: silence for a turn that touched nothing', () => {
  assert.equal(describeActions({ toolCalls: 0, tools: {}, wrote: false, read: true }), '');
});

test('describeActions: silence when the journal could not be read', () => {
  // Guessing here would be worse than saying nothing: a wrong "no tools" claim is
  // exactly the misreading this whole module exists to prevent.
  assert.equal(describeActions({ toolCalls: 0, tools: {}, wrote: false, read: false }), '');
});

test('describeActions: a writing turn says so, and names the tools', () => {
  const text = describeActions({ toolCalls: 2, tools: { Write: 1, Read: 3 }, wrote: true, read: true });
  assert.match(text, /CHANGED files/);
  assert.match(text, /Read×3/);
  assert.match(text, /Write/);
});

test('describeActions: a reading turn reports its tools without claiming a change', () => {
  const text = describeActions({ toolCalls: 2, tools: { Bash: 2 }, wrote: false, read: true });
  assert.match(text, /2 tool\(s\)/);
  assert.equal(/CHANGED/.test(text), false);
});

/* ------------------------------------------------------------------------- *
 * `expectWork`: the "it only talked" case, measured in a live session.
 *
 * Two turns from real briefs could not be told apart from ones that had started
 * building: one called ZERO tools, the other only `Bash`×1 + `Read`×2, and both
 * replied with a plan. Silence about that IS the misreading.
 * ------------------------------------------------------------------------- */

test('describeActions: a plan-only turn is stated when work was expected', () => {
  const text = describeActions({ toolCalls: 0, tools: {}, wrote: false, read: true }, { expectWork: true });
  assert.match(text, /NO tools/);
  assert.match(text, /nothing was created or changed/);
  // A statement about the journal, not a guess about intent.
  assert.equal(/maybe|probably|might/.test(text), false);
});

test('describeActions: inspection without writing is not reported as building', () => {
  const text = describeActions(
    { toolCalls: 3, tools: { Bash: 1, Read: 2 }, wrote: false, read: true },
    { expectWork: true },
  );
  assert.match(text, /changed NO files/);
  assert.match(text, /did not build/);
  assert.match(text, /Bash/);
});

test('describeActions: an unreadable journal stays silent even when work was expected', () => {
  // "Could not look" must never become "did nothing" — a fabricated fact is worse
  // than no statement.
  assert.equal(describeActions({ toolCalls: 0, tools: {}, wrote: false, read: false }, { expectWork: true }), '');
});

test('describeActions: a writing turn keeps its confident wording under expectWork', () => {
  const text = describeActions({ toolCalls: 2, tools: { Write: 2 }, wrote: true, read: true }, { expectWork: true });
  assert.match(text, /CHANGED files/);
  assert.equal(text.includes('NO tools'), false);
  assert.equal(text.includes('did not build'), false);
});
