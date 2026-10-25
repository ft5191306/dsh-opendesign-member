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
 * Whether one candidate names a run that is still live.
 *
 * A candidate with no status is only trusted when its id is the recorded run and
 * that run could not be looked up — see {@link reconcileWatch} for why that
 * distinction decides whether the bridge keeps or drops its record.
 *
 * @param candidate - `{ runId, status }`, possibly undefined.
 * @param trustedWithoutStatusId - a run id whose missing status means "unknown".
 */
function isLiveCandidate(candidate, trustedWithoutStatusId) {
  if (candidate === undefined || candidate === null) return false;
  if (typeof candidate.runId !== 'string' || candidate.runId.trim().length === 0) return false;
  if (typeof candidate.status !== 'string') return candidate.runId === trustedWithoutStatusId;
  return !TERMINAL.has(candidate.status);
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
 * @returns a verdict the tool can act on and report verbatim.
 */
export function reconcileWatch(input = {}) {
  const pendingId = typeof input.pendingRun?.runId === 'string' ? input.pendingRun.runId : undefined;
  const conversationRun = input.conversationRun;
  const projectRun = input.projectRun;

  // A run the daemon itself says is live wins over the bridge's own record: the
  // record can be missing (a lost write, a restart) but a live run cannot.
  const candidates = [conversationRun, projectRun, { runId: pendingId, status: input.pendingRunStatus?.status }];
  const live = candidates.find((candidate) => isLiveCandidate(candidate, pendingId));

  // `pendingRunStatus === undefined` means "could not look it up", not "finished".
  // Reporting that as settled is how a live turn gets orphaned, so it is treated
  // as unknown and the bridge keeps its record instead of clearing it.
  const pendingUnknown = pendingId !== undefined && input.pendingRunStatus === undefined;

  if (live === undefined) {
    return {
      state: 'idle',
      busy: false,
      ...(pendingUnknown ? { note: 'a recorded run could not be checked, so it may still be running' } : {}),
    };
  }

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
    ...(pendingUnknown ? { note: 'this bridge could not read the recorded run; the live run below is the one to collect' } : {}),
  };
}
