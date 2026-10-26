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
 * Member state that belongs to ONE conversation, written by the per-turn
 * setters — everything `setMember` does NOT own.
 *
 * This is the list that makes the field-level merge safe. `flush()` decides a
 * field by "did this call change it", and `setMember` is handed a WHOLE member
 * by its callers (`store.setMember(team, name, { ...binding, model })` in
 * `opendesign_open`, index.js:1483), so the object it receives also carries a
 * possibly stale `cursor`. Treating those keys as written would roll a newer
 * cursor back — losing it makes inbound delivery hand the same Open Design
 * messages over twice, which is the exactly-once property this document exists
 * to hold. Everything outside this list is a coordinate, and `setMember` is its
 * single writer.
 *
 * A member REBOUND to a different conversation must not inherit this state
 * either: the cursor would name a message the new window does not contain, and
 * the remembered runs and pending form point at turns that happened in the old
 * one. Whole-object replacement dropped them implicitly; the field merge has to
 * say so.
 */
const CONVERSATION_STATE_FIELDS = ['cursor', 'bridgeRuns', 'pendingRun', 'pendingForm', 'lastTurn'];

/**
 * The fields of one member object that `setMember` is allowed to publish.
 *
 * Derived from the object it was handed rather than from a fixed list: a new
 * coordinate must not be silently dropped by the merge just because nobody
 * remembered to add it here, while the conversation-state fields above it must
 * never be claimed. Absent keys are excluded — `setMember` has no "delete a
 * coordinate" operation, so an absent key means "not my business".
 *
 * @param member - the member object `setMember` just built.
 */
function claimableFields(member) {
  const fields = [];
  for (const field of Object.keys(member)) {
    if (CONVERSATION_STATE_FIELDS.includes(field)) continue;
    if (member[field] === undefined) continue;
    fields.push(field);
  }
  return fields;
}

/**
 * Remember which member fields this call just wrote or deleted.
 *
 * Scoped to one store instance and cleared by every flush: it describes edits
 * still unpublished, not a permanent claim on a field. That distinction is what
 * lets a later flush adopt someone else's newer value from disk, while the edits
 * that have not gone out yet still win.
 *
 * A DELETION is recorded the same way as a write. `clearPendingRun` /
 * `clearPendingForm` leave the field absent, so the absence itself is the edit
 * being published; skipping absent fields would let the disk copy resurrect what
 * was just cleared.
 *
 * @param pending - per-team map of member name to touched field names.
 * @param teamId - Lead session id.
 * @param member - member name.
 * @param fields - field names written or deleted by this call.
 */
function markFields(pending, teamId, member, fields) {
  const teamKey = String(teamId);
  const memberKey = String(member);
  let team = pending.get(teamKey);
  if (team === undefined) {
    team = new Map();
    pending.set(teamKey, team);
  }
  let touched = team.get(memberKey);
  if (touched === undefined) {
    touched = new Set();
    team.set(memberKey, touched);
  }
  for (const field of fields) touched.add(field);
}

/**
 * Merge one member field by field over the copy currently on disk.
 *
 * Touched fields come from this store; everything else comes from disk. A
 * touched field that is now absent is a deletion to replay, not a field to skip.
 *
 * @param prior - member as currently stored on disk, if any.
 * @param local - member as this store holds it, if any.
 * @param touched - fields this store has written or deleted since its last flush.
 */
function mergeMember(prior, local, touched) {
  if (local === undefined) return prior;
  // Nothing on disk means no competitor: this store is the only writer.
  if (prior === undefined) return { ...local };
  const merged = { ...prior };
  // A member REBOUND to a different conversation must not inherit the previous
  // window's state: its cursor names a message the new conversation does not
  // contain, and the remembered runs and pending form belong to turns that
  // happened in the old one. Whole-object replacement dropped them implicitly;
  // a field merge has to say so, or a forced rebind would carry a stale cursor
  // into a fresh window and silently skip its first replies.
  //
  // Gated on `conversationId` being written by THIS call. A per-turn setter that
  // merely holds an old copy must not wipe the state of a window someone else
  // has just rebound the member to.
  if (touched?.has('conversationId')
    && typeof prior.conversationId === 'string'
    && local.conversationId !== undefined
    && prior.conversationId !== local.conversationId) {
    for (const field of CONVERSATION_STATE_FIELDS) delete merged[field];
  }
  if (touched === undefined) return merged;
  for (const field of touched) {
    if (local[field] === undefined) delete merged[field];
    else merged[field] = local[field];
  }
  return merged;
}

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
    /**
     * Member fields this instance has changed but not yet published, as
     * team id → member name → field names. Cleared by every flush, because after
     * a successful write the disk copy is the authoritative one again.
     */
    this.pending = new Map();
  }

  /** Re-read the document so concurrent writers are observed. */
  reload() {
    this.doc = loadBindings(this.file);
    // Whatever was staged has not been published; the reloaded document is now
    // the truth, so replaying those edits afterwards would fight the disk.
    this.pending = new Map();
    return this.doc;
  }

  /**
   * Commit the in-memory document to disk.
   *
   * The write merges over what is currently on disk rather than replacing it,
   * so a second writer (another member's tool call in a different process, or a
   * human editing the file) is never silently clobbered. Team keys this instance
   * owns win; keys it has never seen are preserved.
   *
   * MEMBERS are merged one FIELD at a time, not one object at a time. Whole
   * object replacement looked safe — a member is a small object, so replacing it
   * should be enough — but two tool calls routinely hold different halves of the
   * same member: `opendesign_ask` writes `bridgeRuns`, `opendesign_inbox` writes
   * `cursor`. Whichever flushed last erased the other's field. The cursor is the
   * one that hurts: losing it makes inbound delivery hand the same messages over
   * again, which is the exactly-once property this document exists to hold.
   *
   * So: fields this instance has touched win (including deletions), every other
   * field is taken from disk as it is at write time.
   */
  flush() {
    const onDisk = loadBindings(this.file);
    const merged = { schemaVersion: SCHEMA_VERSION, teams: { ...onDisk.teams } };
    for (const [teamId, team] of Object.entries(this.doc.teams)) {
      const prior = merged.teams[teamId] ?? {};
      const priorMembers = prior.members ?? {};
      const localMembers = team.members ?? {};
      const touchedMembers = this.pending.get(teamId);
      const members = { ...priorMembers };
      // A member this instance merely loaded is not an edit: leaving it to the
      // disk copy is what lets another process's newer field survive.
      if (touchedMembers !== undefined) {
        for (const [memberName, touched] of touchedMembers) {
          const memberMerged = mergeMember(priorMembers[memberName], localMembers[memberName], touched);
          if (memberMerged === undefined) delete members[memberName];
          else members[memberName] = memberMerged;
        }
      }
      merged.teams[teamId] = { ...prior, ...team, members };
    }
    saveBindings(this.file, merged);
    // Only now are the staged edits published. Clearing before the write would
    // lose them if the write threw, and silently dropping an edit is worse than
    // a loud failure.
    this.pending = new Map();
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
    const key = String(member);
    team.members[key] = { ...binding, member: key, boundAt: Date.now() };
    // Only the coordinates, and only the ones this call actually carries. The
    // conversation-state fields in the same object came from the caller's spread
    // of a possibly stale copy, and claiming them would overwrite whatever the
    // real owner last wrote.
    markFields(this.pending, teamId, key, claimableFields(team.members[key]));
    this.flush();
    // The merged document is authoritative now, so report from it rather than
    // from the object just built: unclaimed fields may have come from disk.
    return this.member(teamId, key);
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
    markFields(this.pending, teamId, member, ['lastTurn']);
    this.flush();
    return this.member(teamId, member)?.lastTurn;
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
    markFields(this.pending, teamId, member, ['cursor']);
    this.flush();
    return this.member(teamId, member)?.cursor;
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
    markFields(this.pending, teamId, member, ['pendingRun']);
    this.flush();
    return this.member(teamId, member)?.pendingRun;
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
    markFields(this.pending, teamId, member, ['bridgeRuns']);
    this.flush();
    return this.bridgeRuns(teamId, member);
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
    // A deletion is an edit like any other, and `flush()` replays it by removing
    // the field from the disk copy. Without recording it the record would be
    // resurrected from disk and the cleared run would stay collectable forever.
    markFields(this.pending, teamId, member, ['pendingRun']);
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
    markFields(this.pending, teamId, member, ['pendingForm']);
    this.flush();
    return this.member(teamId, member)?.pendingForm;
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
    markFields(this.pending, teamId, member, ['pendingForm']);
    this.flush();
    return undefined;
  }
}
