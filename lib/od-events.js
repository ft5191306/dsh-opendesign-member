/**
 * Open Design run events — the wait half of `opendesign_ask`, spoken over the
 * daemon's Server-Sent-Events stream instead of a polling loop.
 *
 * Why this module exists, measured 2026-10-26 against Open Design 0.26.1:
 * `awaitRun` answered "is it done yet?" with `GET /api/runs/:id` once a second.
 * The bridge's own default turn budget is 600_000 ms (`turnTimeoutMs` in
 * `index.js`), so one default turn spent up to ~600 requests asking a question
 * the daemon can answer by pushing. `GET /api/runs/:id/events` is the native
 * capability: one connection, a 25 s keepalive, journal replay, and
 * `Last-Event-ID` for re-attaching mid-run.
 *
 * Three facts read out of the daemon source shape this module:
 *
 *   1. Frames are `id: <n>` / `event: <name>` / `data: <json>`, one field per
 *      line, separated by a blank line. Keepalives are COMMENT frames
 *      (`: keepalive`). A parser that treats every blank-line-separated block as
 *      an event therefore "receives" a fake empty event every 25 seconds, which
 *      is how a progress-driven caller ends up reporting a stall as activity.
 *   2. The terminal event is `end`; the stream closes immediately after it. A
 *      stream that closes WITHOUT `end` is not a finished run: the daemon gave up
 *      on the journal replay ("durable event replay failed") or a proxy cut the
 *      body. Falling back to polling on that distinction is what keeps a daemon
 *      hiccup from being reported as a settled turn.
 *   3. The route may not exist at all (older Open Design, a proxy that re-frames
 *      or truncates `text/event-stream`). That failure mode is UNVERIFIED on this
 *      host, which is exactly why the caller keeps today's polling loop as a LOUD
 *      fallback instead of trusting the stream.
 *
 * What this module must never do is turn a wait budget into a cancel. Aborting
 * the connection means "I stop listening"; the run keeps going and the caller
 * gets `stillRunning` plus `lastEventId`, which is a better re-attach point than
 * today's `runId` (the daemon replays from its journal instead of the caller
 * re-reading the whole message list). The measured cost of getting that wrong
 * once: a timed-out turn kept executing for another 36 minutes, wrote 12.8 MB of
 * events, and its answer was never collected.
 *
 * Pure wire parsing (`parseSseFrame`, `takeSseFrames`) is deliberately separate
 * from I/O (`followRun`), so the format has tests that need neither a daemon nor
 * a network stream.
 *
 * @module @local/dsh-opendesign-member/lib/od-events
 */

/**
 * How many times one broken stream may be re-attached before giving up.
 *
 * One, not more: `Last-Event-ID` reconnect is the daemon's designed recovery for
 * a dropped connection, but a stream that breaks twice in a row is a different
 * problem (daemon restarting on a new port, proxy refusing long bodies). More
 * retries would spin while the caller's budget drains, and the polling fallback
 * already exists — retry once, then hand over loudly.
 */
const MAX_RECONNECTS = 1;

/**
 * Parse ONE SSE frame into a record.
 *
 * `frame` is the text between two blank lines, exactly as it appeared on the
 * wire. Returns `undefined` when the frame carries no event at all — which is
 * the keepalive case and must not be mistaken for a record, because a keepalive
 * recorded as an event would look like "the run is moving" every 25 seconds.
 *
 * The returned record keeps `rawData` alongside the parsed `data`: when the
 * daemon (or a proxy) emits a data line that is not JSON, the caller can report
 * the bytes that actually arrived instead of dropping the frame silently. A bad
 * data line never throws — it must not be able to kill the wait, and the
 * terminal `end` frame is still the only thing that settles the run.
 *
 * @param frame - one blank-line-terminated frame, without its trailing blank line.
 * @returns `{ id, event, data, rawData, parseError? }`, or `undefined` for a comment-only frame.
 */
export function parseSseFrame(frame) {
  if (typeof frame !== 'string' || frame.length === 0) return undefined;
  let id = null;
  let event = null;
  const dataLines = [];
  let sawField = false;

  for (const line of frame.split(/\r?\n/)) {
    if (line.length === 0) continue;
    // ": keepalive" and any other comment line. The SSE spec makes this the
    // heartbeat channel, and it is the only thing a quiet 25 s window sends.
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    // One optional leading space is part of the format, not of the value.
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') {
      // The daemon's event ids are integers from its JSONL journal; keep them
      // numeric so they round-trip through `Last-Event-ID` unchanged. Anything
      // else is preserved as a string rather than coerced to NaN.
      id = value.length === 0 ? null : (Number.isInteger(Number(value)) ? Number(value) : value);
      sawField = true;
    } else if (field === 'event') {
      event = value.length === 0 ? null : value;
      sawField = true;
    } else if (field === 'data') {
      dataLines.push(value);
      sawField = true;
    }
    // Any other field (`retry:`, future additions) is ignored on purpose: a
    // frame we do not fully understand must not become an event.
  }

  if (!sawField) return undefined;
  const rawData = dataLines.length > 0 ? dataLines.join('\n') : undefined;
  if (rawData === undefined) return { id, event, data: undefined, rawData };
  try {
    return { id, event, data: JSON.parse(rawData), rawData };
  } catch (error) {
    return {
      id,
      event,
      data: undefined,
      rawData,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Split whatever has been received so far into complete SSE records.
 *
 * Streaming bodies hand out arbitrary chunk boundaries: one read can carry
 * several frames, or half of one. Returning the unconsumed tail (`rest`) is what
 * makes the split testable as a pure function and what stops a half-frame from
 * being parsed as a complete event — parsing `data: {"st` on its own would look
 * like corrupt JSON rather than a frame still in flight.
 *
 * @param buffer - all bytes decoded so far, in order.
 * @returns the records completed by this buffer, plus the partial tail to keep.
 */
export function takeSseFrames(buffer) {
  const records = [];
  let rest = typeof buffer === 'string' ? buffer : '';
  for (;;) {
    // Accept CRLF as well as LF: the daemon writes LF, but a proxy may rewrite
    // line endings, and a parser that only knows "\n\n" would then never fire.
    const boundary = /\r?\n\r?\n/.exec(rest);
    if (boundary === null) break;
    const frame = rest.slice(0, boundary.index);
    rest = rest.slice(boundary.index + boundary[0].length);
    const record = parseSseFrame(frame);
    if (record !== undefined) records.push(record);
  }
  return { records, rest };
}

/**
 * Follow one run's event stream until `end`, the wait budget, or cancellation.
 *
 * This function is I/O only: it never throws for a daemon-side problem, because
 * every one of those has a defined answer for the caller.
 *
 * Returned `kind`, and what the caller is supposed to do with it:
 *   - `ended`     — the run settled; `ended` holds the `end` event's data.
 *   - `timeout`   — the wait budget ran out; the connection was aborted and the
 *                   run is STILL RUNNING. Re-attach later with `lastEventId`.
 *   - `cancelled` — the caller's own signal fired. Only this case may cancel the
 *                   run, and the caller does it (this module holds no policy
 *                   about runs).
 *   - `not-sse`   — the route answered, but not with `text/event-stream`
 *                   (old daemon, proxy truncation). Loud: `degraded` says why.
 *   - `incomplete`— the stream closed without `end`, and re-attaching did not fix
 *                   it. The run's state is unknown; do not report it settled.
 *   - `failed`    — the connection could not be established at all.
 *
 * @param client - client for the confirmed daemon (`baseUrl`, `fetch`, optional `reconnect`).
 * @param runId - run being followed; used for messages only.
 * @param options - `path` (already filled from ROUTES), absolute `deadlineAt`,
 *   caller `signal`, and an optional `onEvent` for incremental progress.
 * @returns `{ kind, ended, lastEventId, eventCount, degraded, status }`.
 */
export async function followRun(client, runId, options = {}) {
  const path = typeof options.path === 'string' ? options.path : '';
  const deadlineAt = typeof options.deadlineAt === 'number' ? options.deadlineAt : undefined;
  const signal = options.signal;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : undefined;
  const degraded = [];
  let lastEventId = null;
  let eventCount = 0;
  let ended = null;

  /** Assemble the public result so every exit path has the same shape. */
  const snapshot = (kind) => ({
    kind,
    ended,
    lastEventId,
    eventCount,
    degraded,
    status: typeof ended?.status === 'string' ? ended.status : null,
    runId,
  });

  if (path.length === 0) {
    degraded.push('run-events: no route was supplied for the event stream');
    return snapshot('not-sse');
  }
  if (typeof client?.fetch !== 'function') {
    // Not a daemon failure: a client without `fetch` cannot stream. Say so, and
    // let the caller poll, instead of pretending the route was probed.
    degraded.push('run-events: the client has no fetch, streaming unavailable');
    return snapshot('not-sse');
  }
  if (signal?.aborted) return snapshot('cancelled');

  let timedOut = false;
  const controller = new AbortController();
  let timer = null;
  if (deadlineAt !== undefined) {
    const budget = deadlineAt - Date.now();
    if (budget <= 0) {
      // The budget was already spent before the connection existed (a caller
      // re-attaching after a previous wait). Report it as a timeout without
      // opening a socket that would be aborted immediately.
      timedOut = true;
    } else {
      timer = setTimeout(() => {
        timedOut = true;
        // Aborts the CONNECTION only. There is deliberately no cancelRun here,
        // and none anywhere else on the timeout path: the run is still working
        // and its answer is still collectable.
        controller.abort();
      }, budget);
      timer.unref?.();
    }
  }

  const onCallerAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onCallerAbort, { once: true });

  /** One GET on the stream route. Transport failures retry once after rediscovery. */
  const connect = async (resumeFrom) => {
    const headers = {
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
      // Ask for an unbuffered body. `X-Accel-Buffering: no` is the daemon's side
      // of this; `identity` is ours, and it is what stops a compressing proxy
      // from holding frames until its own buffer fills — the concrete shape of
      // "SSE works locally but not through the proxy".
      'accept-encoding': 'identity',
    };
    if (resumeFrom !== null && resumeFrom !== undefined) {
      headers['last-event-id'] = String(resumeFrom);
    }
    const url = `${typeof client.baseUrl === 'string' ? client.baseUrl : ''}${path}`;
    const init = { method: 'GET', headers, signal: controller.signal };
    try {
      return await client.fetch(url, init);
    } catch (error) {
      if (signal?.aborted || timedOut || typeof client.reconnect !== 'function') throw error;
      // Same rule as `OdClient#request`: the daemon binds a fresh port on every
      // launch, so one rediscovery-and-retry is what makes a cached client
      // survive an Open Design restart.
      const moved = await client.reconnect().catch(() => undefined);
      if (moved === undefined) throw error;
      return await client.fetch(`${typeof client.baseUrl === 'string' ? client.baseUrl : ''}${path}`, init);
    }
  };

  /**
   * Read one response to its `end` event.
   *
   * `closed` means the body ended without `end`; `broken` means it ended in an
   * error. Both are recoverable by re-attaching, and both are emphatically NOT
   * "the run settled".
   */
  const consume = async (response) => {
    const decoder = new TextDecoder();
    let buffer = '';
    // A 200 with no body is a stream that produced nothing, not a broken read:
    // treat it like a close so the re-attach path can use the journal cursor.
    if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
      return { kind: 'closed' };
    }
    try {
      for await (const chunk of response.body) {
        if (signal?.aborted) return { kind: 'cancelled' };
        if (timedOut) return { kind: 'timeout' };
        buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        const split = takeSseFrames(buffer);
        buffer = split.rest;
        for (const record of split.records) {
          if (record.id !== null) lastEventId = record.id;
          eventCount += 1;
          // The terminal frame is the ONLY thing that settles a run. An
          // intermediate `status` observed on the stream (or on a progress
          // event) is not a verdict; `isTerminalRun` on a re-read record is.
          if (record.event === 'end') {
            ended = record.data ?? {};
            return { kind: 'ended' };
          }
          // Incremental progress is surfaced, never accumulated: the product
          // contract is that only the final assistant message is the answer.
          await onEvent?.(record);
        }
      }
      // A trailing partial frame is dropped, not parsed: without its blank line
      // it is a truncated frame, and its JSON would be a lie about what arrived.
      return { kind: 'closed' };
    } catch (error) {
      // Caller cancellation outranks the timeout: a caller that aborted must
      // still get its run cancelled, and the budget expiring must never do so.
      if (signal?.aborted) return { kind: 'cancelled' };
      if (timedOut) return { kind: 'timeout' };
      return { kind: 'broken', error };
    }
  };

  try {
    for (let attempt = 0; attempt <= MAX_RECONNECTS; attempt += 1) {
      if (signal?.aborted) return snapshot('cancelled');
      if (timedOut) return snapshot('timeout');

      let response;
      try {
        response = await connect(attempt === 0 ? null : lastEventId);
      } catch (error) {
        if (signal?.aborted) return snapshot('cancelled');
        if (timedOut) return snapshot('timeout');
        degraded.push(`run-events: transport failed: ${error instanceof Error ? error.message : String(error)}`);
        return snapshot('failed');
      }

      const contentType = typeof response?.headers?.get === 'function'
        ? String(response.headers.get('content-type') ?? '')
        : '';
      if (response?.ok !== true || !contentType.toLowerCase().includes('text/event-stream')) {
        // This is the fallback trigger the brief is strict about: report it, do
        // not silently poll. Old Open Design, a proxy that re-frames the body, or
        // a truncating middlebox all land here — and the last one is UNVERIFIED
        // on this host, so it must be visible when it happens.
        // Release the unread JSON body so the socket is not held; a client that
        // omits `body.cancel` is fine too, hence the optional chains.
        try {
          await response?.body?.cancel?.();
        } catch {
          /* releasing the body is best-effort; the reason below is the real report */
        }
        if (response?.ok !== true) {
          degraded.push(`run-events: events route answered HTTP ${response?.status ?? 'no response'}`);
        } else {
          degraded.push(
            `run-events: events route answered content-type "${contentType || '(none)'}", not text/event-stream`,
          );
        }
        return snapshot('not-sse');
      }

      const outcome = await consume(response);
      if (outcome.kind === 'ended') return snapshot('ended');
      if (outcome.kind === 'cancelled') return snapshot('cancelled');
      if (outcome.kind === 'timeout') return snapshot('timeout');

      // Closed or broken before `end`. Re-attach once from the journal cursor;
      // if that fails too, hand back "unknown, go poll" rather than a verdict.
      if (attempt < MAX_RECONNECTS) {
        const reason = outcome.kind === 'broken'
          ? `stream broke: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
          : 'stream closed without an end event';
        degraded.push(`run-events: ${reason}; re-attached with Last-Event-ID ${String(lastEventId ?? 0)}`);
        if (outcome.kind === 'broken' && typeof client.reconnect === 'function') {
          // A break is often the daemon restarting on a new port; rediscovery
          // before the retry is the only way re-attaching can find it.
          await client.reconnect().catch(() => undefined);
        }
        continue;
      }
      degraded.push(
        outcome.kind === 'broken'
          ? `run-events: stream broke twice: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`
          : 'run-events: stream closed without an end event',
      );
      return snapshot('incomplete');
    }
    // The loop only exits by returning; this is the unreachable floor.
    return snapshot('incomplete');
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCallerAbort);
    // Releases the connection on every early exit (end, timeout, cancellation).
    // For the `ended` case the body has already run dry, so this is a no-op.
    controller.abort();
  }
}
