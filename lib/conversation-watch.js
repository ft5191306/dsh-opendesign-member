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
 * @param previous - the earlier observation, or undefined for the first one.
 * @param current - this observation.
 * @returns `{ changed, kind, message }` where kind is
 *   `appeared` | `status` | `activity` | `gone` | `none`.
 */
export function diffConversation(previous, current) {
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
    const settled = current.status === 'succeeded' || current.status === 'failed'
      || current.status === 'canceled' || current.status === 'cancelled'
      || current.status === 'error' || current.status === 'timeout';
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
      : (typeof run.status === 'string' ? run.status : 'running'),
    textLength: typeof message?.content === 'string' ? message.content.length : undefined,
  });
}
