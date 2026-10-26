/**
 * Push one Open Design run-status change TO THE MODEL, not only into the job
 * output ring.
 *
 * The watcher (`index.js` `armWatcher`) already appends a line to its job output
 * whenever `diffConversation` reports a real change. That ring is only read when
 * the caller remembers to call `job_output` — and the moment a run continues
 * unattended is exactly the moment nobody remembers. This module turns the same
 * change into a durable user message on the live Agent, so the model sees it on
 * its next turn without polling anything.
 *
 * The delivery call is `agent.followup(message)`: the same entry point
 * `dsh-schedule` uses to deliver reminders (a durable inbox splice that wakes an
 * idle driver). This module wraps it in the two properties a long-lived loop
 * needs:
 *
 *   1. **Never throw into the watcher.** A watcher that dies because the model
 *      could not be reached is worse than one that only writes its job output:
 *      it is the thing keeping the run visible after the caller stopped waiting.
 *      Every failure is caught and recorded ONCE, for the job output to report.
 *   2. **Never push the same transition twice.** Duplicate notifications are how
 *      a push channel becomes noise people learn to ignore.
 *
 * All state is process memory: a restarted watcher starts with no history, which
 * is correct — its first observation is a fresh "this is what exists now" and is
 * worth reporting on its own.
 *
 * @module @local/dsh-opendesign-member/lib/watch-push
 */

import { randomUUID } from 'node:crypto';

/**
 * `source.kind` recorded on every pushed message.
 *
 * A custom kind is accepted on a user message (the host uses its own kinds for
 * reminders and model-switch notices), and it is what lets a reader tell these
 * messages apart from anything the human typed. Kept here as one spelling so the
 * writer and every test agree on it.
 */
export const PUSH_SOURCE_KIND = 'opendesign-watch';

/**
 * Upper bound on remembered transitions.
 *
 * A watcher can live for days; a daemon that flaps would otherwise grow the
 * dedupe set without limit. Only the recent past matters: the dedupe exists to
 * stop the SAME observed transition (one batch reported twice, or a retry of the
 * same line) from being delivered as two messages, not to remember every run of
 * a week.
 */
const MAX_REMEMBERED_TRANSITIONS = 64;

/** First usable run id among the candidates, or undefined. */
function firstRunId(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

/** Human-readable message for one caught value. */
function detailOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Build the short, model-facing English text for one reported change.
 *
 * Deliberately NOT the job-output line: that line is a timestamped record for a
 * human reading `job_output` (`<iso> <kind>: <message>`), and repeating it here
 * would make the model duplicate the record. This text names the member and the
 * change, and — when a run id is known — spells out the one call that collects
 * the answer, in the same form the tool schemas use, so it can be copied
 * verbatim.
 *
 * @param input.member - member whose conversation is watched.
 * @param input.kind - change kind from `diffConversation`.
 * @param input.message - the change sentence from `diffConversation`.
 * @param input.runId - run id, when one is known.
 * @returns one paragraph of plain text.
 */
function composeMessage(input) {
  const member = typeof input.member === 'string' && input.member.length > 0
    ? input.member
    : 'unknown member';
  const kind = typeof input.kind === 'string' && input.kind.length > 0 ? input.kind : 'change';
  const change = typeof input.message === 'string' && input.message.length > 0
    ? input.message
    : `the conversation changed (${kind})`;
  const runId = firstRunId(input.runId);
  // `diffConversation` already spells out the collect call for a settled status.
  // Adding it again would read as two separate instructions to copy.
  const collect = runId === undefined || change.includes('opendesign_ask')
    ? ''
    : ` Collect the answer with opendesign_ask({ run_id: "${runId}" }).`;
  return `Open Design watch (${kind}) for member "${member}": ${change}.${collect}`;
}

/**
 * Create the notifier for ONE watcher job.
 *
 * @param input.resolveAgent - `(sessionId) => Agent | undefined`, called on EVERY
 *   push. Resolving per push rather than once is load-bearing: the watcher
 *   outlives turns, and an Agent captured at arm time can be disposed long before
 *   the run it is watching settles.
 * @param input.owner - the session id owning the watcher job; passed to
 *   `resolveAgent`.
 * @param input.member - member name, named in the pushed text.
 * @param input.conversationId - conversation being watched, used in diagnostics.
 * @param input.clock - `() => number`; defaults to `Date.now`.
 * @returns `{ notify(report, observation, previous), notes() }`.
 */
export function createWatchNotifier(input = {}) {
  const resolveAgent = typeof input.resolveAgent === 'function' ? input.resolveAgent : undefined;
  const owner = input.owner;
  const member = input.member;
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId : '';
  const clock = typeof input.clock === 'function' ? input.clock : Date.now;

  /** Transition keys already reported, oldest first (insertion order is the cap). */
  const reported = new Map();
  /** One-time reasons a push could not happen, for the job output. */
  const recordedReasons = [];
  const noted = new Set();

  /** Record a reason at most once per distinct kind, however often it recurs. */
  function noteOnce(key, text) {
    if (noted.has(key)) return;
    noted.add(key);
    recordedReasons.push(text);
  }

  /** True when this exact transition was already reported; records it otherwise. */
  function alreadyReported(key) {
    if (reported.has(key)) return true;
    reported.set(key, clock());
    if (reported.size > MAX_REMEMBERED_TRANSITIONS) {
      reported.delete(reported.keys().next().value);
    }
    return false;
  }

  /** The conversation half of every failure note: enough to locate the watcher. */
  function where() {
    const parts = [];
    if (typeof owner === 'string' && owner.length > 0) parts.push(`owner session ${owner}`);
    if (conversationId.length > 0) parts.push(`conversation ${conversationId}`);
    return parts.length === 0 ? 'the watched conversation' : parts.join(', ');
  }

  /**
   * Report one change from `diffConversation` to the model.
   *
   * @param report - `{ changed, kind, message }` from `diffConversation`.
   * @param observation - the current observation (`{ runId, status }`).
   * @param previous - the previous observation, when there is one; a `gone`
   *   report names the run that no longer exists, so the run id is only in
   *   `previous`.
   * @returns a small result: `{ pushed: true, text }`, or `{ pushed: false }`
   *   with `reason` (failure) or `deduped: true` (already reported).
   */
  function notify(report, observation, previous) {
    // The watcher calls this only inside `if (report.changed)`. Re-checking here
    // is the guard that keeps this module safe to call anywhere: `activity`
    // (journal growth) is NOT a change, and pushing it every poll is the failure
    // this feature exists to avoid.
    if (report === undefined || report === null || report.changed !== true) {
      return { pushed: false };
    }

    const current = observation ?? {};
    const runId = firstRunId(current.runId, previous?.runId);
    const transition = `${String(report.kind)}|${runId ?? '-'}|${String(current.status ?? 'idle')}`;
    if (alreadyReported(transition)) {
      return { pushed: false, deduped: true };
    }

    const text = composeMessage({ member, kind: report.kind, message: report.message, runId });

    if (resolveAgent === undefined) {
      noteOnce('no-resolver', `push is not wired to the agent registry (${where()})`);
      return { pushed: false, reason: 'no-resolver' };
    }

    let agent;
    try {
      agent = resolveAgent(owner);
    } catch (error) {
      noteOnce('resolve-failed', `could not resolve the live agent (${where()}): ${detailOf(error)}`);
      return { pushed: false, reason: 'resolve-failed' };
    }
    if (agent === undefined || agent === null) {
      // The normal quiet case: the session ended while its watcher job is still
      // alive. The job keeps appending to its output; there is simply nobody to
      // wake. Recorded once so the job output says why the model is silent.
      noteOnce('missing-agent', `no live agent for ${where()}, so the model was not notified`);
      return { pushed: false, reason: 'missing-agent' };
    }
    if (typeof agent.followup !== 'function') {
      noteOnce('unsupported-agent', `the live agent has no followup(), so ${where()} was not pushed`);
      return { pushed: false, reason: 'unsupported-agent' };
    }

    const message = {
      // Unique per message: the inbox is durable, and two notifications about two
      // different transitions must never collapse into one entry.
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: PUSH_SOURCE_KIND },
    };

    let handing;
    try {
      handing = agent.followup(message);
    } catch (error) {
      noteOnce('followup-failed', `agent.followup() failed (${where()}): ${detailOf(error)}`);
      return { pushed: false, reason: 'followup-failed' };
    }
    // `followup` is synchronous in the host's loop, but a promise is tolerated:
    // an async rejection must become a note, not an unhandled rejection that
    // crashes the process the watcher lives in.
    if (handing !== undefined && handing !== null && typeof handing.then === 'function') {
      handing.then(undefined, (error) => {
        noteOnce('followup-failed', `agent.followup() failed (${where()}): ${detailOf(error)}`);
      });
    }

    return { pushed: true, text, message, at: clock() };
  }

  /**
   * Every distinct reason a push has failed so far, oldest first.
   *
   * The watcher appends each one to its job output once. That is the whole
   * degradation: the durable record keeps working, and the caller can see why the
   * model was not told.
   *
   * @returns a copy, so a caller cannot rewrite this module's history.
   */
  function notes() {
    return [...recordedReasons];
  }

  return { notify, notes };
}
