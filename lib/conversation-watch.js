/**
 * A long-lived watcher that reports every run-status change in one Open Design
 * conversation.
 *
 * Why it is a background JOB rather than a per-call watcher: the previous design
 * watched only while `opendesign_ask` was blocked, so it went blind the moment a
 * call returned — which is exactly when a run continues without the caller
 * holding it. A Lead that timed out, or that had its turn end, lost all visibility
 * while Open Design kept working. A job outlives the call that started it.
 *
 * What it reports is deliberately narrow: the STATUS of the run in this member's
 * conversation, and each change to it. Not the answer text — the answer is
 * collected by `opendesign_ask({ run_id })`, and a watcher that also quoted prose
 * would become a second, unreliable source of truth. Its job is to tell the Lead
 * "something changed, go look".
 *
 * @module @local/dsh-opendesign-member/lib/conversation-watch
 */

import { isTerminalRun } from './od-client.js';

/**
 * One observation of a conversation's run state.
 *
 * @param input.status - the run's status, or undefined when there is no run.
 * @param input.runId - the run's id, or undefined.
 * @param input.eventsBytes - its event journal size, when measurable.
 * @param input.textLength - length of its assistant text so far.
 * @returns a compact, comparable snapshot.
 */
export function observeConversation(input = {}) {
  const runId = typeof input.runId === 'string' && input.runId.trim().length > 0
    ? input.runId
    : undefined;
  return {
    runId,
    status: typeof input.status === 'string' && input.status.length > 0 ? input.status : 'idle',
    eventsBytes: Number.isFinite(input.eventsBytes) ? input.eventsBytes : undefined,
    textLength: Number.isFinite(input.textLength) ? input.textLength : undefined,
  };
}

/**
 * Compare two observations.
 *
 * The distinction this preserves is the one that matters to a Lead: a STATUS
 * change (`queued → running → succeeded`) is a real event worth checking the
 * output for, while the journal growing is merely "still working". Reporting both
 * as "changed" would train the caller to ignore the signal.
 *
 * `unknown` is not a state, it is a MISSING observation, and it must never be
 * reported as an event. This is not a stylistic preference — it shipped as a real
 * defect: one fire-and-forget `opendesign_ask` produced THREE queued messages for
 * one run, because a poll that could not reach the daemon (`.dsh` is a huge
 * project and the single-threaded daemon times out while a run is working) was
 * read as `running → unknown` ("now unknown") and then, once the query recovered
 * and the run was gone, as `gone (was unknown)` claiming an answer was collectable
 * on evidence nobody had. Three lines for one completion, two of them invented.
 *
 * Two rules follow, and both live in this function because it is the only place
 * that decides what counts as news:
 *
 *   1. An `unknown` observation reports NOTHING, whichever side it is on. "I could
 *      not look" is not "something happened".
 *   2. The caller keeps the last DEFINITE observation as its baseline
 *      (`index.js` `armWatcher`), so recovery after a blind poll still compares
 *      against what was really seen: `gone (was running)`, never `was unknown`.
 *
 * The `gone` branch additionally refuses to claim collectability when the last
 * definite status is unknown — defence in depth, in case a caller ever breaks
 * rule 2.
 *
 * @param previous - the earlier observation, or undefined for the first one.
 * @param current - this observation.
 * @returns `{ changed, kind, message }` where kind is
 *   `appeared` | `status` | `activity` | `gone` | `none`.
 */
export function diffConversation(previous, current) {
  // The guard sits FIRST so it also covers the `appeared` branch below: a first
  // sight of `unknown` is a blind poll, not a run appearing out of nowhere.
  if (current === undefined || current === null || current.status === 'unknown') {
    return { changed: false, kind: 'none', message: 'status unknown; staying quiet' };
  }

  if (previous === undefined) {
    if (current.status === 'idle') {
      return { changed: false, kind: 'none', message: 'no run in this conversation' };
    }
    return {
      changed: true,
      kind: 'appeared',
      message: `run ${short(current.runId)} is ${current.status}`,
    };
  }

  // A run finishing and being replaced by nothing is a change worth reporting: it
  // is the moment the answer becomes collectable.
  if (current.status === 'idle' && previous.status !== 'idle') {
    // A run that vanished AFTER it was already seen to finish is not news: its
    // completion was reported by the status transition itself. Reporting the
    // disappearance too would deliver one finished turn twice — and on a daemon
    // that keeps run records only for a while, that second message is guaranteed
    // eventually rather than unlikely.
    if (isTerminalStatus(previous.status)) {
      return { changed: false, kind: 'none', message: `run ${short(previous.runId)} finished; record is gone too` };
    }
    // Defence in depth. With rule 2 honoured the baseline is never `unknown`, so
    // this branch should be unreachable; if it ever is reached, the honest report
    // is "this run is no longer visible", NOT "its answer can be collected" —
    // claiming a collectable answer nobody has evidence for is exactly the lie
    // that produced the three-message incident.
    if (previous.status === 'unknown') {
      return {
        changed: true,
        kind: 'gone',
        message: `run ${short(previous.runId)} is no longer visible (last status unknown)`,
      };
    }
    return {
      changed: true,
      kind: 'gone',
      message: `run ${short(previous.runId)} is no longer live (was ${previous.status}) — its answer can be collected`,
    };
  }

  if (current.runId !== previous.runId && current.runId !== undefined) {
    return {
      changed: true,
      kind: 'appeared',
      message: `run ${short(current.runId)} is ${current.status}`,
    };
  }

  if (current.status !== previous.status) {
    const settled = isTerminalStatus(current.status);
    return {
      changed: true,
      kind: 'status',
      message: settled
        ? `run ${short(current.runId)} ${current.status} — check the output with opendesign_ask({ run_id: "${current.runId}" })`
        : `run ${short(current.runId)} now ${current.status}`,
    };
  }

  const grew = (current.eventsBytes ?? 0) > (previous.eventsBytes ?? 0)
    || (current.textLength ?? 0) > (previous.textLength ?? 0);
  if (grew) {
    return {
      changed: false,
      kind: 'activity',
      message: `run ${short(current.runId)} still ${current.status}`,
    };
  }

  return { changed: false, kind: 'none', message: `run ${short(current.runId)} still ${current.status}` };
}

/** First 8 characters of a run id, for readable lines. */
function short(runId) {
  return typeof runId === 'string' ? runId.slice(0, 8) : 'unknown';
}

/**
 * Whether a status string means the turn is over.
 *
 * Exported so the watcher and this module agree on one list: a "settled" run whose
 * record later disappears must not be reported a second time as a disappearance.
 *
 * @param status - an observed status string.
 */
export function isTerminalStatus(status) {
  return status === 'succeeded' || status === 'failed'
    || status === 'canceled' || status === 'cancelled'
    || status === 'error' || status === 'timeout';
}

/**
 * The newest run in a conversation that has not finished yet, from its message
 * rows.
 *
 * Why the rows rather than the run LIST: measured against 0.26.1 (2026-10-26),
 * `GET /api/runs?conversationId=…&projectId=…&status=active` answered
 * `{"runs":[]}` for the whole life of a run that `GET /api/runs/:id` reported as
 * `running` — every filter combination, including no filter, came back empty. An
 * empty list reads exactly like "nothing is running", which is why the watcher
 * spent whole tasks blind. The rows are the other way round: every assistant row
 * carries `runId` and `runStatus`, so there is no window in which a run is
 * executing and the conversation cannot name it.
 *
 * A row whose `runStatus` is absent is still a candidate — the daemon writes the
 * assistant row when the run starts, and its status may lag by a moment. Only a
 * clearly TERMINAL newest row means "nothing is running".
 *
 * @param rows - `listMessages` output, in display order.
 * @returns a run id, or undefined when nothing is running.
 */
export function latestUnfinishedRunId(rows) {
  if (!Array.isArray(rows)) return undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const runId = typeof row?.runId === 'string' && row.runId.trim().length > 0 ? row.runId : undefined;
    if (runId === undefined) continue;
    // The newest row naming a run decides the answer: if that run has finished,
    // nothing is running (and an older run id is not a candidate — it is history).
    return isTerminalStatus(row?.runStatus) ? undefined : runId;
  }
  return undefined;
}

/**
 * Whether a run is worth continuing to watch.
 *
 * A settled run is not "done watching": the answer becoming collectable IS the
 * event the caller is waiting for, so the watcher keeps a heartbeat until the
 * conversation goes idle or the job is stopped. This function only answers
 * whether the current status means work is happening.
 *
 * @param status - the observed status.
 */
export function isWorking(status) {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

/**
 * Turn one run payload plus its assistant row into an observation.
 *
 * A run whose status could not be read is reported as `unknown`, NOT as
 * `running`. That distinction is the same one `lib/watch.js` makes for the ask
 * path, for the same measured reason: a status of `running` is a claim that
 * something is executing, and the watcher would then report a status CHANGE the
 * moment the lookup recovered — a line saying a turn appeared out of nowhere, at
 * a time when nothing actually happened. `diffConversation` swallows `unknown`
 * entirely, and the watcher keeps the last DEFINITE observation as its baseline,
 * so a partially-blind watcher is quiet instead of wrong.
 *
 * Kept here rather than in the tool so the shape is testable without a daemon.
 *
 * @param run - `GET /api/runs/:id` payload, or undefined.
 * @param message - the run's assistant row, when it could be read.
 */
export function observeRun(run, message) {
  if (run === undefined || run === null) {
    return observeConversation({});
  }
  return observeConversation({
    runId: typeof run.id === 'string' ? run.id : run.runId,
    status: isTerminalRun(run)
      ? (typeof run.status === 'string' ? run.status : 'settled')
      : (typeof run.status === 'string' ? run.status : 'unknown'),
    textLength: typeof message?.content === 'string' ? message.content.length : undefined,
  });
}
