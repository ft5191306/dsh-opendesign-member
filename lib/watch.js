/**
 * Decide what one Open Design conversation is doing right now.
 *
 * The problem this solves, hit live: the bridge believed nothing was running
 * (`pendingRun: null`) while Open Design had a turn executing. The tool then
 * either blocked for the whole wait budget or started a competing turn, and the
 * caller read both as "stuck".
 *
 * The fix is to never trust one source of truth. Three independent facts are
 * compared, strongest first:
 *
 *   1. the run this bridge recorded when its own wait expired (`pendingRun`);
 *   2. a run that is live in the CONVERSATION, whoever started it;
 *   3. the project-level `status.runId` the daemon maintains.
 *
 * THE VERDICT IS THREE-VALUED, and that is the whole point of this module's
 * current shape. `busy: true | false` cannot express "I could not find out", so
 * every caller was forced to pick a side for it, and both sides are wrong in a
 * way that has been measured:
 *
 *   - Compress "unknown" into BUSY and a single failed lookup becomes a
 *     permanent block. Measured 2026-10-26: `pendingRun` named a run, every
 *     `GET /api/runs/:id` for it timed out because the single-threaded daemon was
 *     busy streaming, the bridge reported `busy: true` forever, and every later
 *     `opendesign_ask` for that member returned `adopted` without sending
 *     anything. The member was dead until someone edited `bindings.json`.
 *   - Compress "unknown" into IDLE and the bridge starts a second turn over a
 *     live one, interleaving two histories in one conversation.
 *
 * So `unknown` is reported AS ITSELF (`state: 'unknown'`, `busy: null`) and the
 * callers are told to treat it as permission to proceed: the worst case is one
 * speculative run, which the daemon answers with `409 RUN_IN_PROGRESS`, while a
 * wrong block costs the member all further work.
 *
 * Pure function, so the reconciliation is testable without a daemon.
 *
 * @module @local/dsh-opendesign-member/lib/watch
 */

/** Run statuses that mean the turn is over. */
const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'error', 'timeout']);

/**
 * Whether a run payload describes a finished turn.
 *
 * @param run - `GET /api/runs/:id` payload, or undefined.
 * @returns whether there is nothing further to wait for.
 */
export function isSettledRun(run) {
  if (run === undefined || run === null) return false;
  if (typeof run.status === 'string' && TERMINAL.has(run.status)) return true;
  return typeof run.terminalAt === 'number';
}

/**
 * Classify one candidate observation.
 *
 * Four answers, not three: `absent` (nothing here to judge — no candidate, or no
 * usable run id) is distinct from `unknown` (a real recorded run whose status
 * could not be read). Collapsing the two would let a blank string masquerade as a
 * lookup failure.
 *
 * A candidate with no status string is only treated as `unknown` when it is the
 * run this bridge itself recorded. The conversation and project observations are
 * only ever produced WITH a status (`findLiveRun` / `liveProjectRun` call
 * `getRun`), so a statusless one of those means the caller had nothing to say.
 *
 * @param candidate - `{ runId, status }`, possibly undefined.
 * @param recordedId - the run id this bridge recorded, or undefined.
 * @returns `'live' | 'settled' | 'unknown' | 'absent'`.
 */
function candidateState(candidate, recordedId) {
  if (candidate === undefined || candidate === null) return 'absent';
  if (typeof candidate.runId !== 'string' || candidate.runId.trim().length === 0) return 'absent';
  if (typeof candidate.status !== 'string') {
    return candidate.runId === recordedId ? 'unknown' : 'absent';
  }
  return TERMINAL.has(candidate.status) ? 'settled' : 'live';
}

/**
 * Reconcile what this bridge recorded with what the daemon reports.
 *
 * @param input - the three observations, each possibly missing.
 * @param input.pendingRun - `{ runId, startedAt }` this bridge recorded.
 * @param input.pendingRunStatus - that run's payload, or undefined when unknown.
 * @param input.conversationRun - `{ runId, status }` live in the conversation.
 * @param input.projectRun - `{ runId, status }` from the project's own status.
 * @param input.activeRunCount - daemon-wide count, for the "busy elsewhere" note.
 * @returns a verdict the tool can act on and report verbatim. `state` is
 *   `'busy' | 'idle' | 'unknown'` and `busy` is `true | false | null`, so a
 *   caller that only ever asked "is it busy?" can keep doing so with `=== true`.
 */
export function reconcileWatch(input = {}) {
  const pendingId = typeof input.pendingRun?.runId === 'string' ? input.pendingRun.runId : undefined;
  const conversationRun = input.conversationRun;
  const projectRun = input.projectRun;
  const pendingCandidate = { runId: pendingId, status: input.pendingRunStatus?.status };

  // A run the daemon itself says is live wins over everything else: the record
  // can be missing (a lost write, a restart) but a live run cannot.
  const candidates = [conversationRun, projectRun, pendingCandidate];
  const states = candidates.map((candidate) => candidateState(candidate, pendingId));
  const liveAt = states.indexOf('live');
  const unknownAt = states.indexOf('unknown');

  if (liveAt !== -1) {
    const live = candidates[liveAt];
    return {
      state: 'busy',
      busy: true,
      runId: live.runId,
      status: typeof live.status === 'string' ? live.status : 'unknown',
      // Where the answer will come from, spelled out so the caller never has to
      // guess between collecting and re-sending.
      collectWith: `opendesign_ask({ run_id: "${live.runId}" })`,
      // Which observation produced the verdict. Worth reporting: "the bridge lost
      // its record but the daemon still has the run" is a different story from
      // "this bridge's own run is still going", and only one of them is a bug.
      source: live === conversationRun
        ? 'conversation'
        : (live === projectRun ? 'project' : 'pendingRun'),
      ...(input.activeRunCount !== undefined && input.activeRunCount > 1
        ? { activeRunCount: input.activeRunCount, note: 'Open Design is running more than one turn across all clients' }
        : {}),
      ...(unknownAt !== -1
        ? { note: 'this bridge could not read the recorded run; the live run below is the one to collect' }
        : {}),
    };
  }

  // Nothing is definitely live, but a recorded run could not be checked. Saying
  // "idle" here is what starts a duplicate turn; saying "busy" is what blocks the
  // member forever. Neither is the truth, so report the third value and let the
  // caller decide — `opendesign_ask` proceeds, and the daemon's 409 catches the
  // one case where a turn really was still going.
  if (unknownAt !== -1) {
    return {
      state: 'unknown',
      busy: null,
      // Still named: the recorded id is the only pointer to a run that might be
      // alive, so the caller can attach to it rather than losing it.
      runId: pendingId,
      status: 'unknown',
      collectWith: `opendesign_ask({ run_id: "${pendingId}" })`,
      source: 'pendingRun',
      note: 'this bridge could not read the recorded run, so whether it is still running is unknown; '
        + 'a new turn is allowed (Open Design refuses a competing one with 409 RUN_IN_PROGRESS), '
        + 'and the recorded run id is reported in case it is the one to collect',
      ...(input.activeRunCount !== undefined && input.activeRunCount > 0
        ? { activeRunCount: input.activeRunCount, note: 'Open Design reports turns active across all clients; '
          + 'this bridge could not read the recorded one, so whether it is still running is unknown; '
          + 'a new turn is allowed (the daemon refuses a competing one with 409 RUN_IN_PROGRESS)' }
        : {}),
    };
  }

  return { state: 'idle', busy: false };
}

/**
 * Resolve a verdict from ONE authoritative observation: the daemon's own list of
 * active runs for this conversation.
 *
 * This is the better input for {@link reconcileWatch}'s question — the three-source
 * version has to guess which of three partial views to believe, while
 * `GET /api/runs?conversationId=X&status=active` simply answers it. It is kept
 * separate rather than folded in so that a caller on the older path keeps working
 * during the transition, and so the two can be compared while the change lands.
 *
 * Failure is `unknown`, never `idle`: "the daemon did not answer" says nothing
 * about whether a turn is executing, and guessing idle there starts a duplicate.
 *
 * @param input.activeRuns - the daemon's active-run list, or undefined when unread.
 * @param input.lookupFailed - true when the list could not be obtained.
 * @param input.activeRunCount - daemon-wide count, for the "busy elsewhere" note.
 * @param input.excludeRunIds - run ids the caller is handling explicitly.
 */
export function verdictFromActiveRuns(input = {}) {
  const exclude = new Set(
    (Array.isArray(input.excludeRunIds) ? input.excludeRunIds : [])
      .filter((id) => typeof id === 'string' && id.length > 0),
  );
  const runs = Array.isArray(input.activeRuns) ? input.activeRuns : [];

  if (input.lookupFailed === true) {
    return {
      state: 'unknown',
      busy: null,
      note: 'the active-run query did not answer, so whether a turn is running is unknown; '
        + 'a new turn is allowed (the daemon refuses a competing one with 409 RUN_IN_PROGRESS)',
    };
  }

  const live = runs.find((run) => typeof run?.id === 'string'
    && run.id.trim().length > 0
    && !exclude.has(run.id));
  if (live === undefined) {
    return { state: 'idle', busy: false };
  }
  return {
    state: 'busy',
    busy: true,
    runId: live.id,
    status: typeof live.status === 'string' ? live.status : 'unknown',
    collectWith: `opendesign_ask({ run_id: "${live.id}" })`,
    source: 'activeRuns',
    ...(input.activeRunCount !== undefined && input.activeRunCount > 1
      ? { activeRunCount: input.activeRunCount, note: 'Open Design is running more than one turn across all clients' }
      : {}),
  };
}
