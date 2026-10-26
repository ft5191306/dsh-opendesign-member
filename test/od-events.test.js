/**
 * Tests for the SSE wire format of `GET /api/runs/:id/events`.
 *
 * Everything here is a pure function, because the format is where the bugs are:
 * the transport is one `for await` loop, but the framing decides whether a
 * keepalive looks like progress, whether a split chunk loses an event, and
 * whether a truncated data line throws away the run's terminal frame.
 *
 * The frame shape is not guessed. It was read out of this host's Open Design
 * 0.26.1 daemon (`createSseResponse`, `server-H22RVNP3.mjs`):
 *
 *     res.write(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
 *     res.write(': keepalive\n\n')                     // every 25 s
 *
 * so a frame is `id:` / `event:` / `data:` separated by a blank line, and the
 * terminal event is `end`. `parseSseFrame` must return `undefined` for the
 * keepalive: a caller that reported "an event happened" every 25 seconds would
 * turn a stall into progress, which is the same class of defect as the
 * `diffConversation` one AGENTS.md records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSseFrame, takeSseFrames } from '../lib/od-events.js';

/** One frame exactly as the daemon writes it, minus the trailing blank line. */
function frame(event, data, id = undefined) {
  return `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}`;
}

test('parseSseFrame: reads an id/event/data triple', () => {
  const record = parseSseFrame(frame('end', { status: 'succeeded', code: 0 }, 42));

  assert.equal(record.id, 42);
  assert.equal(record.event, 'end');
  assert.deepEqual(record.data, { status: 'succeeded', code: 0 });
  assert.equal(record.parseError, undefined);
});

test('parseSseFrame: a keepalive comment is not an event', () => {
  // The daemon sends `: keepalive` every 25 s. Reporting it as an event would
  // make "no news" indistinguishable from "the run moved".
  assert.equal(parseSseFrame(': keepalive'), undefined);
  // A comment line mixed into a real frame does not make it a comment frame.
  const mixed = 'data: {"type":"tool_use"}\n: keepalive';
  assert.equal(parseSseFrame(mixed).data.type, 'tool_use');
});

test('parseSseFrame: tolerates the single optional space after the colon', () => {
  const withSpace = parseSseFrame('event: delta\ndata: {"delta":"hi"}');
  const withoutSpace = parseSseFrame('event:delta\ndata:{"delta":"hi"}');

  assert.equal(withSpace.event, 'delta');
  assert.deepEqual(withSpace.data, { delta: 'hi' });
  // `data:{"delta":"hi"}` — the leading space is cosmetic in SSE, and both forms
  // must parse to the same JSON.
  assert.deepEqual(withoutSpace.data, { delta: 'hi' });
});

test('parseSseFrame: multi-line data is joined with newlines, per the SSE spec', () => {
  const record = parseSseFrame('event: diagnostic\ndata: {"a":1,\ndata: "b":2}');
  assert.deepEqual(record.data, { a: 1, b: 2 });
});

test('parseSseFrame: malformed data is reported, never thrown', () => {
  // A parser that throws here would kill the wait over one corrupt frame — and
  // the terminal `end` frame might still be coming.
  const record = parseSseFrame('event: end\ndata: {"status":"succeeded"');
  assert.equal(record.event, 'end');
  assert.equal(record.data, undefined);
  assert.equal(record.rawData, '{"status":"succeeded"');
  assert.equal(typeof record.parseError, 'string');
});

test('parseSseFrame: an unknown field alone is not an event', () => {
  // Future daemon versions may add fields. An unrecognized block must not become
  // a phantom event with `data: undefined`.
  assert.equal(parseSseFrame('retry: 5000'), undefined);
  assert.equal(parseSseFrame(''), undefined);
  assert.equal(parseSseFrame(undefined), undefined);
});

test('parseSseFrame: an event with no data line is still a record', () => {
  const record = parseSseFrame('event: end');
  assert.equal(record.event, 'end');
  assert.equal(record.data, undefined);
  assert.equal(record.rawData, undefined);
});

test('takeSseFrames: separates several frames delivered in one chunk', () => {
  const batch = `${frame('agent', { type: 'text_delta', delta: 'Hel' }, 1)}\n\n`
    + `${frame('agent', { type: 'text_delta', delta: 'lo' }, 2)}\n\n`
    + `${frame('end', { status: 'succeeded' }, 3)}\n\n`;

  const { records, rest } = takeSseFrames(batch);

  assert.equal(records.length, 3);
  assert.equal(records[0].data.delta, 'Hel');
  assert.equal(records[1].id, 2);
  assert.equal(records[2].event, 'end');
  assert.equal(rest, '');
});

test('takeSseFrames: keeps a frame split mid-data-line as a partial tail', () => {
  // Chunk boundaries land anywhere. Parsing `data: {"del` on its own would look
  // like corrupt JSON and silently drop a real event.
  const first = 'event: agent\ndata: {"type":"text_del';
  const second = 'ta","delta":"Hi"}\n\n';

  const split = takeSseFrames(first);
  assert.equal(split.records.length, 0);
  assert.equal(split.rest, first);

  const completed = takeSseFrames(split.rest + second);
  assert.equal(completed.records.length, 1);
  assert.equal(completed.records[0].data.delta, 'Hi');
  assert.equal(completed.rest, '');
});

test('takeSseFrames: a frame split exactly between \\n and \\n still completes', () => {
  // The boundary between two frames is two bytes; a chunk can end between them.
  const split = takeSseFrames('event: end\ndata: {"status":"failed"}\n');
  assert.equal(split.records.length, 0);

  const completed = takeSseFrames(`${split.rest}\n`);
  assert.equal(completed.records.length, 1);
  assert.equal(completed.records[0].data.status, 'failed');
});

test('takeSseFrames: CRLF framing is accepted', () => {
  // A proxy is allowed to rewrite line endings; a parser that only knows "\n\n"
  // would then never fire and the wait would die on its budget.
  const { records } = takeSseFrames('id: 7\r\nevent: end\r\ndata: {"status":"succeeded"}\r\n\r\n');
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 7);
  assert.equal(records[0].data.status, 'succeeded');
});

test('takeSseFrames: an interrupted final frame is never parsed as complete', () => {
  // The stream was cut mid-frame. Emitting a record here would report a truncated
  // payload as if it had arrived whole.
  const { records, rest } = takeSseFrames(`${frame('agent', { type: 'thinking' }, 1)}\n\nevent: end\ndata: {"stat`);
  assert.equal(records.length, 1);
  assert.match(rest, /event: end/);
});
