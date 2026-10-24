/**
 * Durable member-to-conversation bindings for the Open Design bridge.
 *
 * Granularity contract (from the product requirement):
 *   - one Open Design *project* per team, whose agent cwd is that team's
 *     workspace, so Open Design and the Lead edit the same files;
 *   - one Open Design *conversation* per team member, so every member has their
 *     own real chat window, and a newly created member always gets a fresh one;
 *   - never reuse a conversation across members or teams.
 *
 * Storage is a single JSON document under the DSH home directory. It is written
 * atomically (temp + rename) so a crash mid-write cannot lose the roster.
 *
 * @module @local/dsh-opendesign-member/lib/bindings
 */

import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;

/**
 * How many bridge-created run ids to remember per member.
 *
 * Only used to tell this bridge's own answered turns apart from turns the human
 * started in the Open Design window. Anything older is far behind the inbound
 * cursor, so a small ring is enough.
 */
const BRIDGE_RUN_MEMORY = 50;

/**
 * Load the binding document, tolerating absence and corrupt content.
 *
 * @param file - absolute JSON path.
 */
export function loadBindings(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion === SCHEMA_VERSION && parsed.teams) {
      return parsed;
    }
  } catch {
    /* missing or unreadable: start empty */
  }
  return { schemaVersion: SCHEMA_VERSION, teams: {} };
}

/**
 * Persist the binding document atomically.
 *
 * @param file - absolute JSON path.
 * @param doc - document to write.
 */
export function saveBindings(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/**
 * In-memory view over one binding document.
 */
export class BindingStore {
  /**
   * @param file - absolute JSON path.
   */
  constructor(file) {
    this.file = file;
    this.doc = loadBindings(file);
  }

  /** Re-read the document so concurrent writers are observed. */
  reload() {
    this.doc = loadBindings(this.file);
    return this.doc;
  }

  /**
   * Commit the in-memory document to disk.
   *
   * The write merges over what is currently on disk rather than replacing it,
   * so a second writer (another member's tool call in a different process, or a
   * human editing the file) is never silently clobbered. Team and member keys
   * this instance owns win; keys it has never seen are preserved.
   */
  flush() {
    const onDisk = loadBindings(this.file);
    const merged = { schemaVersion: SCHEMA_VERSION, teams: { ...onDisk.teams } };
    for (const [teamId, team] of Object.entries(this.doc.teams)) {
      const prior = merged.teams[teamId] ?? {};
      merged.teams[teamId] = {
        ...prior,
        ...team,
        members: { ...(prior.members ?? {}), ...(team.members ?? {}) },
      };
    }
    saveBindings(this.file, merged);
    this.doc = merged;
  }

  /**
   * Read one team record, creating the in-memory shell if absent.
   *
   * Creation stays in memory: only a setter flushes, so a read-only tool such as
   * `opendesign_status` never rewrites the file just because it looked.
   *
   * @param teamId - Lead session id.
   */
  team(teamId) {
    const key = String(teamId);
    if (!this.doc.teams[key]) {
      this.doc.teams[key] = { teamId: key, project: null, members: {} };
    }
    return this.doc.teams[key];
  }

  /**
   * Read one team record without creating it.
   *
   * @param teamId - Lead session id.
   * @returns the stored record, or undefined when this Team has never bound.
   */
  peekTeam(teamId) {
    return this.doc.teams[String(teamId)];
  }

  /** All team records, for status listings. */
  teams() {
    return Object.values(this.doc.teams);
  }

  /**
   * Read one member binding, or undefined when the member has no window yet.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   */
  member(teamId, member) {
    return this.team(teamId).members[String(member)];
  }

  /**
   * Create or replace one member binding.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param binding - conversation coordinates and chosen model.
   */
  setMember(teamId, member, binding) {
    const team = this.team(teamId);
    team.members[String(member)] = { ...binding, member: String(member), boundAt: Date.now() };
    this.flush();
    return team.members[String(member)];
  }

  /**
   * Remember the team's Open Design project.
   *
   * @param teamId - Lead session id.
   * @param project - project coordinates, baseDir, and binding strategy.
   */
  setProject(teamId, project) {
    const team = this.team(teamId);
    team.project = { ...project, boundAt: Date.now() };
    this.flush();
    return team.project;
  }

  /**
   * Record the last observed Open Design run for one member, so a later turn can
   * report what happened without re-reading the whole conversation.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param turn - run id, status, and timestamps.
   */
  noteTurn(teamId, member, turn) {
    const existing = this.member(teamId, member);
    if (!existing) return undefined;
    existing.lastTurn = { ...turn, at: Date.now() };
    this.flush();
    return existing.lastTurn;
  }

  /**
   * Read how far this member's window has been consumed.
   *
   * The cursor is the id of the last Open Design message already delivered to
   * the member. It makes inbound delivery exactly-once across restarts: a
   * message already handed over is never handed over again, and a message the
   * human sends while the member is idle is not lost.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @returns the member's cursor record, or undefined when never consumed.
   */
  cursor(teamId, member) {
    return this.member(teamId, member)?.cursor;
  }

  /**
   * Advance one member's inbound cursor.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param cursor - last delivered message id and its timestamp.
   */
  setCursor(teamId, member, cursor) {
    const existing = this.member(teamId, member);
    if (!existing) return undefined;
    existing.cursor = { ...cursor, at: Date.now() };
    this.flush();
    return existing.cursor;
  }

  /**
   * Remember that a member's turn is still running after the caller stopped
   * waiting for it.
   *
   * A wait budget expiring is not a failure and not a cancellation: Open Design
   * is still working, and its final answer will arrive later. Without this
   * record nobody would know which run to collect, so a long design turn would
   * be silently abandoned exactly when it was about to produce something.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param run - run id and when waiting for it started.
   */
  notePendingRun(teamId, member, run) {
    const existing = this.member(teamId, member);
    if (!existing) return undefined;
    existing.pendingRun = { ...run, at: Date.now() };
    this.flush();
    return existing.pendingRun;
  }

  /**
   * Record a run this bridge itself started on a member's behalf.
   *
   * Needed because Open Design cannot tell a bridge-created run from one the
   * human started in its own window: both leave an assistant message in the
   * same conversation. The answer to a bridge run was already returned by
   * `opendesign_ask`, so reporting it again as an inbound arrival would make the
   * member read its own answered request back as if it were new. Runs the human
   * started are the interesting ones, and they are exactly the runs NOT in this
   * list.
   *
   * Bounded: only the recent ids are needed, since older answers are already far
   * behind the inbound cursor.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param runId - run created through this bridge.
   */
  noteBridgeRun(teamId, member, runId) {
    if (typeof runId !== 'string' || runId.length === 0) return undefined;
    const existing = this.member(teamId, member);
    if (!existing) return undefined;
    const previous = Array.isArray(existing.bridgeRuns) ? existing.bridgeRuns : [];
    if (previous.includes(runId)) return previous;
    // Keep it bounded: the cursor moves past old turns anyway, and an unbounded
    // list would grow this document forever.
    const next = [...previous, runId].slice(-BRIDGE_RUN_MEMORY);
    existing.bridgeRuns = next;
    this.flush();
    return next;
  }

  /**
   * Read the run ids this bridge created for one member.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   */
  bridgeRuns(teamId, member) {
    const runs = this.member(teamId, member)?.bridgeRuns;
    return Array.isArray(runs) ? runs : [];
  }

  /**
   * Read the run this member left in progress, if any.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   */
  pendingRun(teamId, member) {
    return this.member(teamId, member)?.pendingRun;
  }

  /**
   * Forget the in-progress run once it has settled and been collected.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   */
  clearPendingRun(teamId, member) {
    const existing = this.member(teamId, member);
    if (!existing || existing.pendingRun === undefined) return undefined;
    delete existing.pendingRun;
    this.flush();
    return undefined;
  }

  /**
   * Remember the question form Open Design last asked this member.
   *
   * A form ends an Open Design turn successfully, so without this record the
   * question would be lost the moment the tool result scrolls away: the member
   * would have no way to answer it later, and Open Design would treat the next
   * plain message as a fresh brief.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   * @param form - form id, title, questions, and the run that asked it.
   */
  setPendingForm(teamId, member, form) {
    const existing = this.member(teamId, member);
    if (!existing) return undefined;
    existing.pendingForm = { ...form, at: Date.now() };
    this.flush();
    return existing.pendingForm;
  }

  /**
   * Clear the remembered question form once it has been answered.
   *
   * @param teamId - Lead session id.
   * @param member - member name.
   */
  clearPendingForm(teamId, member) {
    const existing = this.member(teamId, member);
    if (!existing || existing.pendingForm === undefined) return undefined;
    delete existing.pendingForm;
    this.flush();
    return undefined;
  }
}
