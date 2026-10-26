/**
 * Read what one turn actually DID, from its event journal.
 *
 * The reason this exists, measured 2026-10-26: a turn written as a design
 * discussion silently called three tools (Read, Bash, TodoWrite) and a following
 * turn began a `Write` — so the caller believed it was still talking while Open
 * Design had started building. The reply text looked like a plan with assumptions;
 * nothing in `questionForm` or the prose said "I have begun".
 *
 * Counting tool calls turns that into a fact the caller can act on: a turn that
 * touched nothing is a discussion, and a turn that wrote files is not.
 *
 * Deliberately reads the journal rather than parsing prose. What a turn SAID about
 * itself is exactly what misled the caller; what it DID is recorded separately.
 *
 * @module @local/dsh-opendesign-member/lib/turn-actions
 */

import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

/** Tools that change the workspace, as opposed to reading it. */
const MUTATING = new Set(['write', 'edit', 'apply_patch', 'multiedit', 'notebookedit', 'str_replace_editor']);

/**
 * Summarize one journal line without keeping the payload.
 *
 * The journal reaches tens of megabytes (measured: 8.8 MB for one thinking-heavy
 * turn), so this returns counts and names only.
 *
 * @param line - one JSONL record.
 * @param tally - accumulator to update.
 */
function tallyEvent(line, tally) {
  if (typeof line !== 'string' || line.length === 0) return;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  const data = record?.data;
  if (data === null || typeof data !== 'object') return;
  const type = typeof data.type === 'string' ? data.type : undefined;
  if (type !== 'tool_use') return;
  const name = typeof data.name === 'string' ? data.name : 'unknown';
  tally.toolCalls += 1;
  tally.tools[name] = (tally.tools[name] ?? 0) + 1;
  if (MUTATING.has(name.toLowerCase())) tally.wrote = true;
}

/**
 * Count the tool calls one run made.
 *
 * @param journalPath - the run's `eventsLogPath`, when the daemon reported one.
 * @param options.maxLines - stop after this many records; a bound, not a target.
 * @returns `{ toolCalls, tools, wrote, read }` where `read` says whether the
 *   journal could be examined at all. Never throws: an unreadable journal means
 *   "unknown", and reporting zero would be a lie the caller would act on.
 */
export async function readTurnActions(journalPath, options = {}) {
  const tally = { toolCalls: 0, tools: {}, wrote: false };
  if (typeof journalPath !== 'string' || journalPath.length === 0) {
    return { ...tally, read: false };
  }
  const maxLines = Number.isFinite(options.maxLines) ? options.maxLines : 500_000;
  try {
    await fs.promises.access(journalPath, fs.constants.R_OK);
  } catch {
    return { ...tally, read: false };
  }
  try {
    const stream = createReadStream(journalPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let seen = 0;
    for await (const line of lines) {
      tallyEvent(line, tally);
      seen += 1;
      if (seen >= maxLines) break;
    }
    lines.close();
    stream.destroy();
    return { ...tally, read: true };
  } catch {
    // A partially read journal still tells the truth about what it contained.
    return { ...tally, read: tally.toolCalls > 0 };
  }
}

/**
 * Describe a turn's actions in one line, or nothing when it touched nothing.
 *
 * Silence for a PURE discussion is deliberate: every design conversation would
 * otherwise carry a line saying it did nothing, and the caller would stop reading
 * these lines — which is how a real "it wrote files" notice gets missed.
 *
 * But there is one case where silence is actively harmful, and it was measured:
 * a turn whose whole reply is a PLAN, that called no tools at all, reads to the
 * Lead exactly like a turn that started building. The Lead then either re-briefs
 * work that never began, or waits for files that will never appear. Callers that
 * asked Open Design to BUILD pass `expectWork: true`, and then a zero-tool turn is
 * stated plainly instead of being swallowed:
 *
 *   `this turn called NO tools — it only replied; nothing was changed`
 *
 * That is a fact from the journal, not an inference from the prose, which is the
 * whole point of this module.
 *
 * @param actions - the result of {@link readTurnActions}.
 * @param options.expectWork - true when the caller asked for work to be done, so a
 *   plan-only reply must be called out rather than left implicit.
 */
export function describeActions(actions, options = {}) {
  if (actions === undefined || actions === null) return '';
  // The journal could not be read. Saying "nothing happened" here would be a
  // fabricated fact — the one thing worse than saying nothing.
  if (actions.read !== true) return '';
  const expectWork = options.expectWork === true;
  if (actions.toolCalls === 0) {
    return expectWork
      ? 'this turn called NO tools — it only replied, so nothing was created or changed'
      : '';
  }
  const names = Object.entries(actions.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name))
    .join(', ');
  if (actions.wrote) {
    return `this turn called ${actions.toolCalls} tool(s) and CHANGED files (${names})`;
  }
  // Tools were used but nothing was written. Worth stating when work was asked for:
  // "it read and ran commands" is a very different answer from "it built it".
  return expectWork
    ? `this turn called ${actions.toolCalls} tool(s) but changed NO files (${names}) — it inspected, it did not build`
    : `this turn called ${actions.toolCalls} tool(s) (${names})`;
}
