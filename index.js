/**
 * Open Design as a first-class Team member.
 *
 * The problem this solves: Agent Teams members must be in-process continuable
 * children, so an external application cannot appear in the roster by itself.
 * This plugin therefore bridges real DSH teammates to real Open Design
 * conversations instead of faking a roster entry:
 *
 *   1. `opendesign_ask` lets the Lead (or any teammate) consult Open Design
 *      synchronously and receive only that turn's FINAL answer — never
 *      intermediate streamed output.
 *   2. `opendesign_open` gives the caller their own real Open Design chat
 *      window, aligned to the Team workspace and a chosen model. A new member
 *      always gets a new conversation; conversations are never shared across
 *      members or teams.
 *   3. `opendesign_status` reports daemon reachability, version, capability
 *      gaps, and every alignment, so drift after either client upgrades is
 *      visible instead of silent.
 *
 * Binding granularity follows the product requirement: one Open Design project
 * per Team (workspace-aligned, so both sides edit the same files), one
 * conversation per Team member.
 *
 * Upgrade strategy (both clients upgrade independently):
 *   - No version assertions anywhere. Every daemon capability is detected.
 *   - All daemon routes live in one table (`ROUTES`) in lib/od-client.js.
 *   - Bindings record the capability report they were created under.
 *   - The sidecar token channel and the token-free fallback both degrade into a
 *     named diagnostic rather than throwing across the tool boundary.
 *
 * @module @local/dsh-opendesign-member
 */

import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from './lib/tool.js';
import {
  discoverDaemon, OdClient, awaitRun, isTerminalRun, readInbound, splitQuestionForm,
  renderQuestionForm, composeFormAnswers, OdError,
} from './lib/od-client.js';
import { mintImportToken } from './lib/sidecar-token.js';
import { BindingStore } from './lib/bindings.js';
import { SettingsStore, resolveSelection, DEFAULT_MODEL } from './lib/settings.js';
import { planTurn, composeRunMessage } from './lib/turn-plan.js';
import { reconcileWatch, isSettledRun } from './lib/watch.js';
import { observeRun, diffConversation } from './lib/conversation-watch.js';
import { describeActions } from './lib/turn-actions.js';

/** Cordis plugin name. */
export const name = 'opendesign-member';

/**
 * Services required before this plugin can activate.
 *
 * `jobs` is NOT listed: it is an optional service imported with `ctx.get('jobs')`
 * at the point of use, so the bridge still loads in a composition that has no
 * background-job registry. Requiring it would make the whole plugin unavailable
 * just because one feature has nowhere to run.
 */
export const inject = ['tools', 'systemPrompt', 'agentTeams', 'agents', 'workingDirectory'];

/**
 * Bundle package name. The Plugin Manager page and the client half both key off
 * it, so it is written once here rather than repeated as a literal.
 */
const PACKAGE_NAME = '@local/dsh-opendesign-member';

/** Host route the browser half reads and writes this bundle's settings through. */
const SETTINGS_ROUTE = '/api/opendesign-member/settings';

/**
 * How long a probed model catalogue stays usable.
 *
 * One probe costs 9–11 seconds because Open Design re-runs the runtime's model
 * enumeration every time, with no server-side cache. The catalogue only changes
 * when the `open-design` profile or an upstream gateway changes — a rare event
 * that a user notices and fixes by pressing Refresh — so this cache is
 * deliberately LONG-LIVED and backed by disk: it survives a plugin restart, so
 * the ten-second cost is paid once per CLI rather than once per session. Only an
 * explicit refresh (or a change of selected CLI) re-probes it.
 */
const CATALOGUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Display name for the provider segment used by a model id with no slash.
 *
 * Open Design's own runtime CLI reports bare ids (`deepseek-v4.1-flash`) rather
 * than `provider/model`, because that CLI has a single upstream and no provider
 * dimension. Labelling that empty segment "unknown" would misdescribe it: those
 * models come from Open Design itself, so they are named as such.
 */
const CLI_DEFAULT_PROVIDER_LABEL = 'Open Design 官方';

/**
 * Defaults for every config field.
 *
 * This plugin deliberately exports no `Config` schema: it ships as a linked
 * directory, so it cannot import `@deepseek-ai/schemastery` by name, and a
 * hard-coded schema is also the part most likely to break across DSH upgrades.
 * Values are coerced defensively instead, so an unexpected type degrades to its
 * default rather than failing activation.
 */
const DEFAULTS = {
  baseUrl: '',
  // Empty means "follow the CLI Open Design currently has selected", read from
  // `app-config.agentId`. It is intentionally NOT a fixed agent: the human
  // switches Open Design's CLI from its own settings page, and a pinned id would
  // keep reading (and starting runs against) a CLI that is no longer selected —
  // exactly the mismatch this bridge must avoid. Set it only to override.
  agentId: '',
  model: '',
  // Deliberately empty: an explicit tier here would make every turn inherit it,
  // and the gateway's `max` tier can drive single turns long enough to block
  // Open Design's single-threaded daemon. Empty means "profile default".
  reasoning: '',
  sessionMode: 'chat',
  pollMs: 1000,
  // Ten minutes is already generous for one design turn. Callers that truly need
  // longer pass `timeout_ms` on that one call instead of raising this default.
  turnTimeoutMs: 600_000,
  /**
   * How often a background watcher polls Open Design, in milliseconds.
   *
   * Five seconds is chosen against the cost measured on this host: one status poll
   * is a local HTTP call plus a `getRun`, so it is cheap enough to leave running
   * for hours, and fast enough that a status change reaches the job output while
   * the Lead is still reading the previous line.
   */
  watchIntervalMs: 5_000,  instructions: '',
  storePath: 'opendesign-member/bindings.json',
  // The plugin-level model settings document the Plugin Manager page edits.
  // Separate from the Team bindings on purpose: that page has no Session, so it
  // cannot name a Team, and these values are one standing choice for this side.
  settingsPath: 'opendesign-member/settings.json',
  bindWorkspace: true,
  policyOrder: 60,
};

/**
 * Coerce one raw loader config into the typed shape, keeping defaults for
 * missing or mistyped fields.
 *
 * @param raw - config as the Loader supplied it.
 */
function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof input[key] === 'string' ? input[key] : DEFAULTS[key]);
  const number = (key) => (Number.isFinite(input[key]) ? input[key] : DEFAULTS[key]);
  const flag = (key) => (typeof input[key] === 'boolean' ? input[key] : DEFAULTS[key]);
  return {
    baseUrl: text('baseUrl').trim(),
    agentId: text('agentId').trim() || DEFAULTS.agentId,
    model: text('model').trim(),
    reasoning: text('reasoning').trim(),
    sessionMode: text('sessionMode').trim() || DEFAULTS.sessionMode,
    pollMs: Math.max(200, number('pollMs')),
    turnTimeoutMs: Math.max(0, number('turnTimeoutMs')),
    watchIntervalMs: Math.max(500, number('watchIntervalMs')),
    instructions: text('instructions'),
    storePath: text('storePath').trim() || DEFAULTS.storePath,
    settingsPath: text('settingsPath').trim() || DEFAULTS.settingsPath,
    bindWorkspace: flag('bindWorkspace'),
    policyOrder: number('policyOrder'),
  };
}

/** Longest final answer text one tool result carries back to the caller. */
const MAX_ANSWER_BYTES = 96_000;

/**
 * Truncate text to a UTF-8 byte budget without splitting a character.
 *
 * @param text - candidate text.
 * @param budget - maximum bytes.
 */
function truncateUtf8(text, budget) {
  const size = (value) => Buffer.byteLength(value, 'utf8');
  if (size(text) <= budget) return { text, truncated: false };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

/** Deterministic project id for one Team, so re-binding finds the same project. */
function teamProjectId(teamId) {
  const compact = String(teamId).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  return `dsh-team-${compact || 'unknown'}`;
}

/** Whether a value is a usable Open Design project id. */
function isProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{4,80}$/.test(value);
}

/**
 * Resolve the store path from config and the harness home.
 *
 * @param config - resolved plugin config.
 */
function resolveStorePath(config) {
  if (path.isAbsolute(config.storePath)) return config.storePath;
  const home = process.env.DSH_HOME
    ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return path.join(home, config.storePath);
}

/**
 * Resolve the settings document path, next to the bindings document.
 *
 * @param config - resolved plugin config.
 */
function resolveSettingsPath(config) {
  if (path.isAbsolute(config.settingsPath)) return config.settingsPath;
  const home = process.env.DSH_HOME
    ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return path.join(home, config.settingsPath);
}

/**
 * Resolve the on-disk model-catalogue cache path, beside the settings document.
 *
 * @param config - resolved plugin config.
 */
function resolveCatalogueCachePath(config) {
  const settingsFile = resolveSettingsPath(config);
  return path.join(path.dirname(settingsFile), 'catalogue-cache.json');
}

/**
 * Model-facing guidance. Deliberately short: it rides every Team member's system
 * prompt, and the tool descriptions carry the operative detail.
 *
 * @param config - resolved plugin config.
 */
function alignmentPolicy(config) {
  const model = config.model || 'the runtime default';
  return `Open Design is this Team's frontend/UI specialist, available through the \`opendesign_*\` tools.

\`opendesign_ask\` runs one real Open Design turn and returns ONLY that turn's final answer; intermediate streaming output is never returned, so never quote partial output as a reply.

Each Team member has their own real Open Design chat window, created by \`opendesign_open\` on first use. A new member always gets a fresh conversation, and windows are never shared between members or Teams. The human can read and steer the same conversation in the Open Design app.

\`opendesign_inbox\` is the inbound half of that bridge: it returns what the human typed in the window since you last read it, so treat those messages as ordinary team input. Call it at the start of a task when the human may have steered the window directly.

Reading the result of \`opendesign_ask\`:
- \`answer\` is the turn's prose. Quote only that.
- A non-empty \`questionForm\` means the turn was a QUESTION, not an answer: Open Design ended it successfully after emitting a decision form its own UI renders. Never quote the form as if it were a reply, and never report it as a failure or a hang — the run succeeded.
- Answer it with \`opendesign_ask({ form_answers: [{ id, label?, value }] })\`, using the ids and values the form reported. Open Design then treats those answers as authoritative and will not re-ask them.
- If the decision is yours to make, answer with the option Open Design marked as its default, or pass a decision of your own.
- When you want Open Design to stop asking and proceed on its own judgment, say so plainly in the next \`opendesign_ask\` prompt (for example "Skip discovery; proceed with your defaults").
- \`actions\` reports what the turn actually DID: \`toolCalls\`, the tool \`tools\` it used, and \`wrote\` when it changed files. Read it when a reply reads like a plan — a turn can be building while its prose sounds like a proposal.

WHO BUILDS IT — this is the one that gets misread, so it is stated plainly:
- **Open Design is the implementer, not an adviser.** It writes the files in this workspace. Your job is to brief it, answer its questions, and verify what it delivered. Do not write the frontend implementation yourself.
- **A plan is not permission for you to start.** When a turn comes back with a proposal and NO \`questionForm\`, that is not "confirmed, now I build it" — it is Open Design waiting to be told to go. The next move is always another \`opendesign_ask\`: "Go ahead and build it as described", or the change you want first. Answering a form and then writing the page yourself produces two implementations of one design and wastes the turn you just paid for.
- If you catch yourself planning file writes, SVG coordinates, or "how I will build this", stop: those belong in a prompt to Open Design, not in your own tool calls.
- What IS yours: writing the brief, choosing between options only the human owns, and verifying the delivered result (running the app, looking at it). Verifying is not implementing.

Requirements for every task that involves frontend or UI work:
1. Do at least one alignment round before asking for work: state what the thing is for and let Open Design answer. Alignment is a conversation about intent, not a spec hand-off.
2. Verify alignment first with \`opendesign_status\` when the workspace or the model matters. The bridge aligns Open Design to this Team's working directory and to ${model}.
3. Open Design edits the same workspace as the Team, so coordinate write scopes exactly as with a human teammate.

How to brief Open Design — it is a strong designer, and it does its best work when the two halves of a request are kept apart:
- Describe the NEED subjectively: intent, audience, feeling, tone, the impression the result should leave, what matters and what must not happen. Say what you want people to feel, not which hex code or pixel value to use. Leave visual judgement to it; that is its craft.
- Constrain with OBJECTIVE facts: the existing project framework and stack, file layout and entry point, component or API interfaces and their exact shapes, data schemas and field names, required formats and dimensions, offline/network limits, browser targets. Anything that must match an existing system is stated as a fact, not as a preference.
- Put both in one message. Do not dilute hard constraints into adjectives, and do not hand it visual opinions it should be forming itself.
- When a constraint is not yet known, look it up in the workspace first; ask Open Design only for choices the human owns.

What NOT to send it, because this is its craft rather than your constraint: responsive breakpoints and target viewport widths, motion and \`prefers-reduced-motion\` handling, keyboard operability, focus visibility, ARIA and live-region announcements, colour-blind-safe shape coding, checklists of acceptance criteria for the UI itself. Open Design is the specialist and already holds these standards. Reciting them reads as distrust, expands the brief into a compliance list, and measurably makes the result worse: the model spends the turn ticking boxes instead of designing, and a brief that does this was rejected by the human as "constraints a great designer does not need". State the goal, the facts it must match, and stop. If a real accessibility or platform requirement is genuinely non-obvious for this project, name that one fact plainly — do not compile a specification.

Do not hand Open Design the acceptance-testing labour. Starting servers, waiting for health checks, driving a browser, and replaying your verification cases are YOUR work, not the designer's. An instruction to "verify it yourself end to end" turns one design turn into a long autonomous session: measured on this host, one such brief ran 36+ minutes with 64 shell calls and never returned an answer, so the caller blocked on nothing. Ask for the design; verify it yourself after it lands.

When a turn keeps working past your wait:
- A result with \`stillRunning: true\` means Open Design is STILL WORKING, not that it failed. The turn was not cancelled and its output is not lost.
- Do not re-send the request and do not treat it as an error: collect the answer with \`opendesign_ask({ run_id })\` using that runId. Repeated collection calls are safe while it is still running.
- If you no longer have the runId, \`opendesign_status\` reports the run that member left in progress, with the exact call that collects it. Use that instead of asking again.
- Only a cancellation from the human stops the turn. Never kill a design turn because it is slow.

Redirecting a turn that is already running:
- \`opendesign_ask({ inject })\` STOPS that turn and starts a new one with this text. That is what Open Design's own 「引导对话」 does — verified against the live app: the running turn is cancelled (\`cancel_origin: user_stop\`) and a new run starts with the prior context. It is not a mid-turn message; Open Design cannot deliver one on this CLI.
- Nothing is written to the conversation for the injected text beyond the new run's own user message, so the instruction appears once.
- The unfinished work of the stopped turn is lost. The result carries \`interrupted.answerSoFar\`, which is what that turn had produced, so you can see what was traded.
- To keep the old turn running instead, collect it with \`opendesign_ask({ run_id })\` and send the new direction afterwards as an ordinary prompt.`;
}

/** One compact output declaration: JSON text plus the canonical value. */
function jsonOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
}

const OPEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'member', 'role', 'projectId', 'conversationId', 'workspace', 'strategy',
    'model', 'agentId', 'projectReused', 'conversationReused',
  ],
  properties: {
    member: { type: 'string' },
    role: { type: 'string' },
    projectId: { type: 'string' },
    conversationId: { type: 'string' },
    workspace: { type: 'string' },
    resolvedDir: { type: 'string' },
    strategy: { type: 'string' },
    model: { type: 'string' },
    agentId: { type: 'string' },
    odVersion: { type: 'string' },
    degraded: { type: 'array', items: { type: 'string' } },
    /** Whether this Team's shared Open Design project already existed. */
    projectReused: { type: 'boolean' },
    /** Whether this member's own conversation already existed. */
    conversationReused: { type: 'boolean' },
    alignments: { type: 'array', items: { type: 'string' } },
  },
};

const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'conversationId', 'model', 'status', 'answer', 'questionForm', 'truncated', 'runId', 'durationMs', 'stillRunning'],
  properties: {
    member: { type: 'string' },
    conversationId: { type: 'string' },
    model: { type: 'string' },
    status: { type: 'string' },
    /** The turn's final prose answer, with any form block removed. */
    answer: { type: 'string' },
    /**
     * Non-empty when this turn is a QUESTION rather than an answer. Open Design
     * ends such a turn successfully after emitting a `<question-form>`, so treat
     * this as a request for a decision, not as a reply to quote.
     */
    questionForm: { type: 'string' },
    truncated: { type: 'boolean' },
    runId: { type: 'string' },
    durationMs: { type: 'number' },
    /**
     * True when the wait budget ran out while Open Design was still working.
     * The turn is NOT lost: it keeps running, and `runId` collects it later.
     * Never read this as a failure, and never quote it as an answer.
     */
    stillRunning: { type: 'boolean' },
    /**
     * Present when this call started nothing because a turn was ALREADY running
     * in that conversation. Reports which run it found and how to collect it, so
     * the caller can attach instead of waiting on a run that will never answer.
     */
    adopted: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    /**
     * The watcher armed for this conversation: `{ jobId, reused }`. Read its lines
     * with `job_output`, stop it with `job_kill`. `reused: true` means one was
     * already running, since arming is idempotent per conversation.
     */
    watcher: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    /**
     * What the turn actually DID: `{ toolCalls, tools, wrote, read, summary }`.
     * `wrote` means it changed files. Absent when the journal could not be read —
     * "unknown" is never reported as "did nothing".
     */
    actions: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    /**
     * Present when a stale run had to be stopped so form answers could be
     * delivered as their own turn. Form answers are a reply to a question, not a
     * new request, so they are never held back by the busy guard.
     */
    answeredOverRun: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    /**
     * Present only when this call stopped a turn to redirect it.
     * `answerSoFar` is what that turn had produced before it was cut off, so the
     * cost of the redirect is visible instead of silent.
     */
    interrupted: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
  },
};

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'role', 'workspace', 'configuredModel', 'configuredAgentId'],
  properties: {
    member: { type: 'string' },
    role: { type: 'string' },
    daemon: { type: 'object', additionalProperties: true },
    /** Empty object when this Team has not opened a project yet. */
    project: { type: 'object', additionalProperties: true },
    members: { type: 'array', items: { type: 'object', additionalProperties: true } },
    /**
     * The live verdict on this member's conversation: `state` is `busy` or
     * `idle`, and a busy verdict carries the run id plus the exact call that
     * collects it. Reconciled from three independent observations, so it stays
     * right even when this bridge's own record is missing.
     */
    watch: { type: 'object', additionalProperties: true },
    /**
     * The run this member left in progress, or null. Present so a run whose
     * answer was never collected can be found again after the caller lost its id.
     *
     * Declared with `oneOf` because the tool-output schema subset has no
     * "nullable" spelling: `type` may sit beside `oneOf`, but a plain
     * `type: 'object'` rejects a null that means something real.
     */
    pendingRun: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    /**
     * Whether this CLI accepts a message mid-turn; null when not yet known.
     * It is informational only: redirection does not rely on it, because the
     * measured behaviour on this CLI is cancel-and-restart, not mid-turn input.
     */
    steering: {
      oneOf: [
        { type: 'object', additionalProperties: true },
        { type: 'null' },
      ],
    },
    workspace: { type: 'string' },
    configuredModel: { type: 'string' },
    configuredAgentId: { type: 'string' },
    alignments: { type: 'object', additionalProperties: true },
  },
};
const WATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'conversationId', 'jobId', 'intervalMs', 'watch', 'note'],
  properties: {
    member: { type: 'string' },
    /**
     * The conversation being watched. Empty on the first call when the binding is
     * not on disk yet: the job resolves it on its own first tick, so this call
     * never waits for the daemon. The job output then names it.
     */
    conversationId: { type: 'string' },
    /** Id of the background job. Read it with job_output, stop it with job_kill. */
    jobId: { type: 'string' },
    intervalMs: { type: 'integer' },
    /** The exact calls that read and stop this watcher. */
    watch: { type: 'string' },
    note: { type: 'string' },
  },
};
const INBOX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['member', 'conversationId', 'messages', 'odReplies', 'delivered', 'pending'],
  properties: {
    member: { type: 'string' },
    conversationId: { type: 'string' },
    /** Human messages waiting in the window, oldest first. */
    messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
    /**
     * Open Design's own replies since the last read, when they were produced by a
     * turn this bridge did not start — for example the human paused or redirected
     * the conversation directly in the Open Design window. Answers this bridge
     * already returned are excluded, so nothing is reported twice.
     */
    odReplies: { type: 'array', items: { type: 'object', additionalProperties: true } },
    /** How many items were newly delivered to this member now. */
    delivered: { type: 'number' },
    /** How many remain unread (0 when drain consumed them all). */
    pending: { type: 'number' },
  },
};

/**
 * Activate the bridge.
 *
 * @param ctx - hosting Cordis context.
 * @param rawConfig - loader config, coerced against {@link DEFAULTS}.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);

  const store = new BindingStore(resolveStorePath(config));
  const settings = new SettingsStore(resolveSettingsPath(config));
  /** Lazily established daemon connection, shared by every tool. */
  let connection;
  /**
   * On-disk cache of model catalogues, one entry per CLI.
   *
   * Separate from the in-memory copy because the probe it saves costs 9–11
   * seconds: persisting it means that cost is paid once per CLI, not once per
   * plugin activation or host restart.
   */
  const catalogueCachePath = resolveCatalogueCachePath(config);
  /**
   * In-memory copy of one CLI's catalogue, so repeated panel reads and writes do
   * not even touch the disk.
   */
  let catalogueCache;

  /**
   * Discover the daemon and build a client bound to it.
   *
   * The returned client carries a `rediscover` hook, so a port change after an
   * Open Design restart repairs itself on the next request instead of poisoning
   * every later tool call.
   */
  async function connect() {
    const found = await discoverDaemon({ ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
    const od = new OdClient({
      baseUrl: found.baseUrl,
      rediscover: async () => {
        const again = await discoverDaemon({ ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
        // Keep the cached connection object so callers holding it stay valid.
        if (connection) connection.health = again.health;
        return again.baseUrl;
      },
    });
    od.health = found.health;
    connection = od;
    return od;
  }

  /**
   * Connect once, then reuse. A failed connection is not cached, so the next
   * call retries and can pick up a freshly launched Open Design app. Live
   * connections self-heal through the client's own `rediscover` hook.
   */
  async function client() {
    if (connection) return connection;
    return await connect();
  }

  /**
   * Identify which Open Design CLI is selected, right now.
   *
   * Deliberately reads ONLY `app-config`, which answers in single-digit
   * milliseconds. The expensive part of knowing about a CLI is its model
   * catalogue (`GET /api/agents`, 9–11 s), so the two are separated: this call is
   * cheap enough to make on every read, which is what makes a CLI switch visible
   * immediately instead of after a cache expires.
   *
   * @param od - connected client.
   * @param prefetchedAppConfig - an already-read `app-config`, so one call can
   *   identify the CLI without issuing the same request twice.
   * @returns `{ agentId, appConfig }`.
   */
  async function currentCli(od, prefetchedAppConfig) {
    const appConfig = prefetchedAppConfig ?? await od.appConfig();
    const selected = typeof appConfig?.agentId === 'string' && appConfig.agentId.length > 0
      ? appConfig.agentId
      : undefined;
    const agentId = config.agentId || selected;
    if (agentId === undefined) {
      throw new OdError(
        'Open Design reports no selected CLI, and this plugin has no agentId configured',
        'agent-unresolved',
      );
    }
    return { agentId, appConfig };
  }

  /**
   * Read one CLI's catalogue from memory or disk WITHOUT touching the daemon.
   *
   * This is the cheap half of {@link catalogue}: a hot path such as
   * `opendesign_status` needs to know "does this CLI have models, and is it
   * available" without paying nine seconds for `/api/agents`. A cache miss here
   * is reported as "not known yet", never as "no models".
   *
   * @param agentId - CLI the catalogue belongs to.
   * @param now - current time in ms.
   * @returns `{ at, data }` or undefined when no fresh copy is on hand.
   */
  function cachedCatalogue(agentId, now) {
    if (catalogueCache !== undefined
      && catalogueCache.agentId === agentId
      && now - catalogueCache.at < CATALOGUE_TTL_MS) {
      return { at: catalogueCache.at, data: catalogueCache.data };
    }
    const saved = readCatalogueCache(agentId, now);
    if (saved !== undefined) {
      catalogueCache = { at: saved.at, agentId, data: saved.data };
      return saved;
    }
    return undefined;
  }

  /**
   * Build the provider → model → reasoning catalogue for one CLI.
   *
   * Provider is a first-class dimension, not a prefix of the model id: Open
   * Design reports the same model id under several providers, and each provider
   * accepts a DIFFERENT set of reasoning tiers for it (for example
   * `deepseek-v4-pro` accepts `low` under `deepseek-official` but not under
   * `open-design`). Collapsing the two would offer tiers the gateway rejects.
   * Some CLIs report bare ids with no provider segment at all; those are grouped
   * under the empty provider instead of being dropped.
   *
   * CACHED PER CLI, because `GET /api/agents` is expensive: Open Design re-probes
   * every agent on each call (it runs the runtime's model enumeration internally),
   * measured at 9–11 seconds on this host with no server-side cache. The cache key
   * is the CLI id, so switching CLI in Open Design invalidates it at once — a
   * time-only cache would keep serving the previous CLI's models for its whole
   * TTL, which reads as "it did not notice the switch".
   *
   * @param od - connected client.
   * @param input - the CLI id, plus `force` to re-probe regardless of the cache.
   * @returns `{ providers, entries, agentId, agentName, agentAvailable, promptInputFormat }`.
   */
  async function catalogue(od, input) {
    const { agentId } = input;
    const now = Date.now();
    // Memory first, then disk: the disk copy is what makes a ten-second probe a
    // once-per-CLI cost instead of a once-per-restart cost.
    if (input.force !== true) {
      const cached = cachedCatalogue(agentId, now);
      if (cached !== undefined) return cached.data;
    }
    // `agents` is the expensive check, so this probe skips paying for it twice:
    // the enumeration itself is the call right below.
    const agents = await od.listAgents();
    const agent = agents.find((entry) => entry.id === agentId);
    const entries = [];
    const providers = [];
    for (const model of agent?.models ?? []) {
      const at = typeof model.id === 'string' ? model.id.indexOf('/') : -1;
      // A bare id carries no provider segment: the CLI behind it has a single
      // upstream and no provider dimension (Open Design's own runtime CLI reports
      // every model this way). Those are grouped under the empty provider and
      // labelled as coming from Open Design itself, rather than as "unknown".
      const provider = at > 0 ? model.id.slice(0, at) : '';
      const providerLabel = provider === ''
        ? CLI_DEFAULT_PROVIDER_LABEL
        : (provider === 'open-design' ? 'Open Design' : provider);
      if (!providers.includes(provider)) providers.push(provider);
      entries.push({
        provider,
        providerLabel,
        id: model.id,
        label: model.label ?? model.id,
        reasoningOptions: (model.reasoningOptions ?? []).map((option) => ({
          id: option.id,
          label: option.label ?? option.id,
          default: option.default === true,
        })),
      });
    }
    const data = {
      providers,
      entries,
      agentId,
      agentName: agent?.name ?? agentId,
      agentAvailable: agent?.available === true,
      /**
       * The runtime's input format, kept because it is the ONLY thing that
       * decides whether a mid-turn message is possible: Open Design accepts one
       * solely when this is `stream-json` (every other runtime closes the child's
       * stdin with the opening prompt, so a later write goes nowhere and the
       * steer route answers 409 `RUN_STEERING_UNSUPPORTED`).
       *
       * Stored here rather than read fresh because it lives in `GET /api/agents`,
       * the 9–11 s call: a status check must not pay that to learn one property
       * of one CLI. It changes only when the human switches CLI, which this cache
       * is already keyed on.
       */
      promptInputFormat: typeof agent?.promptInputFormat === 'string' ? agent.promptInputFormat : '',
    };
    catalogueCache = { at: now, data };
    writeCatalogueCache(agentId, now, data);
    return data;
  }

  /**
   * Read one CLI's catalogue from the on-disk cache.
   *
   * Kept beside the settings document so the expensive probe survives a plugin
   * restart. Entries older than the TTL are ignored, which is the only thing that
   * makes the cache expire: refreshing is otherwise an explicit action.
   *
   * @param agentId - CLI the catalogue belongs to.
   * @param now - current time in ms.
   * @returns `{ at, data }` or undefined when absent, unreadable, or stale.
   */
  function readCatalogueCache(agentId, now) {
    try {
      const raw = fs.readFileSync(catalogueCachePath, 'utf8');
      const parsed = JSON.parse(raw);
      const hit = parsed?.entries?.[agentId];
      if (hit === undefined || !Number.isFinite(hit.at) || !Array.isArray(hit.data?.entries)) {
        return undefined;
      }
      if (now - hit.at >= CATALOGUE_TTL_MS) return undefined;
      return { at: hit.at, data: hit.data };
    } catch {
      // A missing or corrupt cache is not an error: it just costs one probe.
      return undefined;
    }
  }

  /**
   * Persist one CLI's catalogue to the on-disk cache, merging other CLIs.
   *
   * @param agentId - CLI the catalogue belongs to.
   * @param at - probe timestamp.
   * @param data - the resolved catalogue.
   */
  function writeCatalogueCache(agentId, at, data) {
    try {
      let doc = { schemaVersion: 1, entries: {} };
      try {
        const parsed = JSON.parse(fs.readFileSync(catalogueCachePath, 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && parsed.entries !== null) doc = parsed;
      } catch {
        /* first write */
      }
      doc.entries = { ...doc.entries, [agentId]: { at, data } };
      fs.mkdirSync(path.dirname(catalogueCachePath), { recursive: true });
      const temporary = `${catalogueCachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, catalogueCachePath);
    } catch {
      // Losing the cache only costs time later; never fail a tool over it.
    }
  }

  /**
   * Read the model Open Design currently has stored for one CLI.
   *
   * Read from `appModels[agentId]` in the daemon's config, which is where Open
   * Design records the model chosen on its own settings page — this is the value
   * the human means by "the model Open Design is using".
   *
   * @param appConfig - the daemon config already read for this call.
   * @param agentId - the resolved CLI id.
   * @returns `{ model, reasoning }` or undefined when Open Design has no record.
   */
  function odSelection(appConfig, agentId) {
    const entry = appConfig?.agentModels?.[agentId];
    if (entry === undefined || typeof entry.model !== 'string') return undefined;
    return {
      model: entry.model,
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : '',
    };
  }

  /**
   * Produce the whole snapshot the Plugin Manager page renders.
   *
   * Seeding happens here, once, because this is the single place that both knows
   * Open Design's current value and the product decision "a fresh install copies
   * it once". After that the stored values win and Open Design is only consulted
   * for the catalogue.
   */
  async function settingsSnapshot(options = {}) {
    let odError;
    let catalogueData = { providers: [], entries: [], agentId: null };
    let seededNow = false;
    let odCurrent;
    try {
      const od = await client();
      // Cheap: identifies the selected CLI in milliseconds, so a switch made in
      // Open Design shows up on the next read rather than after a cache expires.
      const { agentId, appConfig } = await currentCli(od);
      // Expensive, but cached per CLI: only paid when the CLI actually changes.
      catalogueData = await catalogue(od, { agentId, force: options.force === true });
      // Read Open Design's own stored model for the SAME CLI every time, not only
      // while seeding: the panel shows what Open Design holds so a divergence is
      // visible instead of silent.
      odCurrent = odSelection(appConfig, agentId);
      if (!settings.seeded && odCurrent !== undefined) {
        settings.seedOnce(odCurrent, `${catalogueData.agentName ?? agentId} (Open Design)`);
        seededNow = true;
      }
    } catch (error) {
      odError = error instanceof Error ? error.message : String(error);
    }
    const values = settings.reload();
    const selection = resolveSelection(values, catalogueData.entries);
    // Whether the DSH side currently agrees with Open Design. Reported, never
    // auto-corrected: silently changing the model under a stored choice would be
    // the exact "you think it is X but it runs Y" failure this bridge avoids.
    const followsOd = odCurrent !== undefined && odCurrent.model === values.model
      && (odCurrent.reasoning || '') === (values.reasoning || '');
    return {
      settings: {
        model: values.model,
        reasoning: values.reasoning,
        seededAt: values.seededAt,
        seededFrom: values.seededFrom,
      },
      selection,
      catalogue: catalogueData.entries,
      providers: catalogueData.providers,
      seededNow,
      agentId: catalogueData.agentId ?? null,
      agentName: catalogueData.agentName ?? null,
      agentAvailable: catalogueData.agentAvailable === true,
      odCurrent: odCurrent ?? null,
      followsOd,
      ...(odError === undefined ? {} : { odError }),
    };
  }

  /**
   * Read the run id a project says it is executing, if any.
   *
   * Open Design keeps a per-project `status.runId`, and it is the one observation
   * that survives BOTH a lost bridge record AND a conversation whose assistant row
   * has not been written yet — the window where a caller concludes "nothing is
   * happening" while a turn is streaming.
   *
   * Note the asymmetry, verified against the live daemon: the LIST route carries
   * `status`, the single-project route does NOT. Reading `GET /projects/:id` and
   * looking for `status` silently yields nothing, which would make this guard look
   * implemented while never firing.
   *
   * @param od - connected client.
   * @param projectId - the Team's project.
   */
  async function liveProjectRun(od, projectId) {
    const projects = await od.listProjects();
    const project = projects.find((entry) => entry?.id === projectId);
    const status = project?.status;
    const runId = typeof status?.runId === 'string' ? status.runId : undefined;
    if (runId === undefined || runId.length === 0) return undefined;
    const value = typeof status?.value === 'string' ? status.value : undefined;
    // A project can keep a stale runId after the run settled; the value is the
    // field that says which state it is in.
    if (value !== undefined && /^(succeeded|failed|canceled|cancelled|error|timeout|idle|done)$/i.test(value)) {
      return undefined;
    }
    return { runId, status: value };
  }

  /**
   * Find a run that is still live in one conversation, whatever started it.
   *
   * Open Design does not serialise ordinary chat turns, so this is the only
   * defence against two runs interleaving their history in one conversation. It
   * deliberately looks at the CONVERSATION rather than at this bridge's own
   * records: the turn that matters may have been started by a previous bridge
   * process, or by the human in the Open Design window.
   *
   * Bounded on purpose — it reads the recent assistant rows rather than every
   * message, and gives up quietly. A guard that fails must not block the caller's
   * actual request, so "could not tell" reports nothing and lets the turn start.
   *
   * @param od - connected client.
   * @param projectId - the Team's project.
   * @param conversationId - the member's conversation.
   * @param ignore - run ids the caller already handles explicitly.
   * @returns `{ runId, status, text }` for the newest live run, or undefined.
   */
  async function findLiveRun(od, projectId, conversationId, ignore = []) {
    const skip = new Set(ignore.filter((id) => typeof id === 'string' && id.length > 0));
    let messages;
    try {
      messages = await od.listMessages(projectId, conversationId);
    } catch {
      return undefined;
    }
    // Newest first: the turn worth reporting is the most recent one.
    const runs = [];
    for (const message of [...messages].reverse()) {
      if (message?.role !== 'assistant') continue;
      if (typeof message?.runId !== 'string' || message.runId.length === 0) continue;
      if (skip.has(message.runId)) continue;
      if (runs.includes(message.runId)) continue;
      runs.push(message.runId);
      if (runs.length >= 5) break;
    }
    for (const runId of runs) {
      let run;
      try {
        run = await od.getRun(runId);
      } catch {
        // Cannot tell; do not block the caller on a failed lookup.
        continue;
      }
      if (run === undefined || isTerminalRun(run)) continue;
      const assistant = messages.find((message) => message?.id === run.assistantMessageId);
      return {
        runId,
        status: typeof run.status === 'string' ? run.status : 'running',
        text: typeof assistant?.content === 'string' ? assistant.content : '',
      };
    }
    return undefined;
  }

  /**
   * Report whether this CLI can accept a message mid-turn — and never more.
   *
   * Open Design's own criterion (`agentSupportsMidTurnSteering` in its daemon) is
   * `promptInputFormat === 'stream-json'`: every other runtime closes the child's
   * stdin together with the opening prompt, so a later write goes nowhere and
   * `POST /runs/:id/steer` answers 409 `RUN_STEERING_UNSUPPORTED`. Its own source
   * comment says clients must stop advertising the affordance rather than retry.
   *
   * Read from the cached catalogue, never from `GET /api/agents`: that call takes
   * 9–11 s for one property of one CLI, and this answer is requested on the
   * injection path where the whole point is to react immediately.
   *
   * `supported: null` means "not known yet" (cold cache) — never `false`, which
   * would state a capability the bridge has not checked.
   *
   * @param agentId - the CLI to describe.
   */
  function steeringCapabilityFromCache(agentId) {
    const cached = cachedCatalogue(agentId, Date.now());
    if (cached === undefined) {
      return {
        supported: null,
        agentId,
        reason: 'the model catalogue has not been probed yet, so the input format is unknown; open the plugin settings page once, or pass include_models to opendesign_status',
      };
    }
    const format = typeof cached.data.promptInputFormat === 'string' ? cached.data.promptInputFormat : '';
    const supported = format === 'stream-json';
    return {
      supported,
      agentId,
      inputFormat: format,
      reason: supported
        ? `CLI ${agentId} keeps its input open mid-turn (promptInputFormat: stream-json)`
        : `CLI ${agentId} does not accept a mid-turn message (promptInputFormat: ${format === '' ? '""' : format}). Redirecting a running turn therefore stops it and starts a new one, which is what Open Design's own 「引导对话」 does on this CLI.`,
    };
  }

  /**
   * Serve the settings route the browser half uses.
   *
   * Deliberately registered on `connection.fetch`, NOT on `webServer.register`.
   * A `webServer` exact route is matched BEFORE the `/api` auth prefix, so it
   * would answer unauthenticated — verified on this host: `/` and `/api/health`
   * returned 401 while a `webServer` route returned 200, and an unauthenticated
   * POST really changed the stored settings. This route writes state and makes
   * the daemon do a round-trip, so it must stay behind the same authenticated
   * channel the rest of the client API uses.
   *
   * Registration is optional by design: a composition without `connection` keeps
   * the plugin working, and the page's own read then fails loudly instead of
   * showing invented values.
   */
  function installSettingsRoute() {
    ctx.inject(['connection'], (scoped) => {
      const connection = scoped.get('connection');
      const register = typeof connection?.fetch?.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined;
      if (register === undefined) return;

      /** One JSON response, never cached: these values change under the page. */
      const reply = (value) => Response.json(value, { headers: { 'cache-control': 'no-store' } });
      /** Typed failure envelope, matching the shape the Connection RPC carries. */
      const failure = (code, message) => reply({ ok: false, error: { code, message } });

      const handler = async (request) => {
        let body = {};
        if (request.method === 'POST') {
          try {
            const parsed = await request.json();
            body = parsed !== null && typeof parsed === 'object' ? parsed : {};
          } catch {
            return failure('opendesign-member/bad-request', 'request body is not JSON');
          }
        }
        try {
          if (request.method === 'GET') {
            // `?refresh=1` re-probes the daemon instead of using the cached
            // catalogue, so a provider switch is picked up on demand without
            // paying ten seconds on every open.
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const force = url.searchParams.get('refresh') === '1';
            return reply({ ok: true, value: await settingsSnapshot({ force }) });
          }
          // Validate against the catalogue of the CLI Open Design CURRENTLY has
          // selected before persisting: storing a model or tier that CLI does not
          // accept would only fail later, at run time, where the reason is much
          // harder to see. The catalogue is reused when this CLI's entry is warm,
          // so a normal switch stays instant.
          const od = await client();
          const { agentId } = await currentCli(od);
          const current = await catalogue(od, { agentId });
          const wanted = typeof body.model === 'string' ? body.model : settings.current().model;
          const check = resolveSelection({ model: wanted, reasoning: '' }, current.entries);
          if (check.problems.length > 0) {
            return failure('opendesign-member/model-unavailable', check.problems.join('; '));
          }
          if (typeof body.reasoning === 'string' && body.reasoning.length > 0) {
            const accepted = check.reasoningOptions.map((option) => option.id);
            if (!accepted.includes(body.reasoning)) {
              return failure(
                'opendesign-member/reasoning-unsupported',
                `${check.provider}/${check.modelName} does not accept reasoning tier "${body.reasoning}" (accepts: ${accepted.join(', ') || 'none'})`,
              );
            }
          }
          settings.update({
            ...(typeof body.model === 'string' ? { model: body.model } : {}),
            ...(typeof body.reasoning === 'string' ? { reasoning: body.reasoning } : {}),
          });
          return reply({ ok: true, value: await settingsSnapshot() });
        } catch (error) {
          return failure('opendesign-member/internal', error instanceof Error ? error.message : String(error));
        }
      };

      scoped.effect(() => register({
        path: SETTINGS_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), 'opendesign-member.settingsRoute()');
    });
  }

  /** Resolve the caller's Team identity, or fail loudly. */
  function membership(agent) {
    if (agent === undefined) throw new Error('Open Design tools require a calling Team member');
    const found = ctx.agentTeams.tryMembership(agent);
    if (found === undefined) throw new Error('Open Design tools are available only inside a Team');
    return found;
  }

  /**
   * Ensure the Team's Open Design project exists and is aligned to the Team
   * workspace. Folder-backed alignment makes the Open Design agent's cwd the
   * same directory, so both sides edit the same files.
   *
   * @param od - connected client.
   * @param teamId - Lead session id.
   * @param workspace - the Team's shared working directory.
   */
  async function ensureProject(od, teamId, workspace) {
    const team = store.team(teamId);
    if (team.project && isProjectId(team.project.projectId)) {
      try {
        const existing = await od.getProject(team.project.projectId);
        const resolved = existing.resolvedDir ?? existing.project?.resolvedDir ?? null;
        const needsRebind = config.bindWorkspace
          && team.project.baseDir !== workspace
          && resolved !== workspace;
        if (!needsRebind) {
          return { project: team.project, resolvedDir: resolved, reused: true };
        }
      } catch (error) {
        if (!(error instanceof OdError) || error.details?.status !== 404) throw error;
        team.project = null;
        store.flush();
      }
    }

    // Only version and capability gaps are wanted here, and both come from cheap
    // routes. The `agents` enumeration is skipped: it costs 9–11 s, and a project
    // binding needs nothing from it — the CLI is resolved per turn from
    // `app-config`, not from this report.
    const report = await od.probe({ skip: ['agents'] });
    const projectId = teamProjectId(teamId);
    const desiredName = `DSH Team ${String(teamId).slice(0, 8)}`;
    const instructions = config.instructions.trim();
    const customInstructions = instructions.length > 0 ? instructions.slice(0, 5_000) : undefined;

    const base = {
      teamId,
      projectId: null,
      baseDir: workspace,
      strategy: 'pending',
      // Recorded for diagnostics only. The CLI actually driven is resolved per
      // call from Open Design's own selection, so this value may be stale.
      agentId: config.agentId || null,
      model: config.model || 'default',
      reasoning: config.reasoning || null,
      odVersion: report.version,
      degraded: report.degraded,
    };

    // Preferred: import the workspace as the project root, so cwd matches.
    if (config.bindWorkspace) {
      try {
        const minted = await mintImportToken(workspace);
        const imported = await od.importFolder({
          baseDir: workspace,
          name: desiredName,
          token: minted.token,
          ...(customInstructions ? { customInstructions } : {}),
        });
        const created = {
          ...base,
          projectId: imported.project?.id ?? projectId,
          strategy: 'folder-backed',
          conversationId: imported.conversationId ?? null,
          tokenExpiresAt: minted.expiresAt,
        };
        store.setProject(teamId, created);
        return { project: created, resolvedDir: workspace, reused: false };
      } catch (error) {
        // Fall through to the token-free path, keeping the reason for status.
        base.bindError = error instanceof Error ? error.message : String(error);
      }
    }

    // Fallback: a project without a folder root. The agent then runs in the
    // daemon-owned directory; linkedDirs still lets it READ the workspace, so
    // consultation keeps working with reduced fidelity.
    const created = await od
      .createProject({
        id: projectId,
        name: desiredName,
        designSystemId: 'default',
        linkedDirs: [workspace],
        ...(customInstructions ? { customInstructions } : {}),
      })
      .catch(async (error) => {
        if (error instanceof OdError && error.details?.status === 400) {
          const existing = await od.getProject(projectId);
          return { project: existing.project ?? { id: projectId } };
        }
        throw error;
      });

    const effectiveProjectId = created.project?.id ?? projectId;
    const conversations = await od.listConversations(effectiveProjectId).catch(() => []);
    let conversationId = conversations[0]?.id ?? null;
    if (conversationId === null) {
      const conversation = await od.createConversation(effectiveProjectId, {
        title: desiredName,
        sessionMode: config.sessionMode,
      });
      conversationId = conversation.conversation?.id ?? null;
    }

    const fallback = {
      ...base,
      projectId: effectiveProjectId,
      strategy: 'linked-dirs',
      conversationId,
    };
    store.setProject(teamId, fallback);
    return { project: fallback, resolvedDir: null, reused: false };
  }

  /**
   * Ensure one member owns a real Open Design conversation. A binding is never
   * reused for a different member or across Teams, which is what makes "new
   * member, new conversation" hold.
   *
   * @param od - connected client.
   * @param teamId - Lead session id.
   * @param memberName - member name from the roster.
   * @param project - the Team's project binding.
   * @param options - force a brand-new conversation.
   */
  async function ensureConversation(od, teamId, memberName, project, options = {}) {
    const existing = store.member(teamId, memberName);
    if (existing && !options.force && typeof existing.conversationId === 'string') {
      try {
        await od.listMessages(project.projectId, existing.conversationId);
        return { binding: existing, reused: true };
      } catch (error) {
        if (!(error instanceof OdError) || error.details?.status !== 404) throw error;
      }
    }
    const created = await od.createConversation(project.projectId, {
      title: `Team ${memberName}`,
      sessionMode: config.sessionMode,
    });
    const conversationId = created.conversation?.id;
    if (typeof conversationId !== 'string') {
      throw new OdError('Open Design did not return a conversation id', 'conversation-create-failed', { created });
    }
    const binding = store.setMember(teamId, memberName, {
      conversationId,
      projectId: project.projectId,
      workspace: project.baseDir,
      model: config.model || 'default',
      agentId: config.agentId || null,
      odVersion: project.odVersion,
      strategy: project.strategy,
    });
    return { binding, reused: false };
  }

  /** Watchers already armed, keyed by `<owner session>:<conversation id>`. */
  const armed = new Map();

  /**
   * Start one long-lived watcher job for a conversation, or return the one already
   * running for it.
   *
   * Why this is not only the `opendesign_watch` tool: a job lives inside the DSH
   * process, so a DSH restart silently takes every watcher with it and nothing
   * restarts them until somebody remembers to call the tool again. Measured — the
   * watcher was reported as "not started" while `job_list` was simply empty after a
   * restart. So `opendesign_ask` arms a watcher as part of the turn it is already
   * running: the turn and the thing watching it start together, which is the
   * behaviour a caller wants and cannot forget to ask for.
   *
   * IDEMPOTENT, in the sense that matters: calling this twice for one conversation
   * yields exactly one running job and the same id. That requires checking the
   * recorded job is still ALIVE rather than merely remembered — `armed` is process
   * memory, and a job can be killed or reaped while the map still names it.
   * Returning a dead id would be worse than starting a second watcher: the caller
   * would poll `job_output` forever and see nothing, which is precisely the failure
   * this whole feature exists to remove.
   *
   * @param input.jobs - the background registry; callers without one get nothing.
   * @param input.owner - the session that owns the job.
   * @param input.od - connected Open Design client.
   * @param input.projectId - the Team's project.
   * @param input.conversationId - the conversation to watch.
   * @param input.member - member name, for the job label.
   * @param input.intervalMs - poll cadence.
   * @returns `{ jobId, reused }`, or undefined when watching is unavailable.
   */
  function armWatcher(input) {
    const { jobs } = input;
    if (jobs === undefined) return undefined;
    const key = `${input.owner}:${input.conversationId}`;

    // Reuse ONLY a job that is still live. `jobs.get` throws for an unknown or
    // foreign id, which is exactly the stale case that must restart.
    const recorded = armed.get(key);
    if (recorded !== undefined) {
      let live = false;
      try {
        const view = jobs.get(recorded, input.owner);
        live = view?.status === 'running' || view?.status === 'stopping';
      } catch {
        live = false;
      }
      if (live) return { jobId: recorded, reused: true };
      // Remembered but gone: forget it so the new id replaces it.
      armed.delete(key);
    }

    const intervalMs = Number.isFinite(input.intervalMs) ? input.intervalMs : config.watchIntervalMs;
    const { projectId, conversationId, member, od } = input;
    let previous;
    let lastProblem;

    const jobId = jobs.start({
      kind: 'bash',
      label: `opendesign-watch ${member} ${String(conversationId).slice(0, 8)}`,
      owner: input.owner,
      run: (job) => {
        let stopped = false;
        const loop = (async () => {
          job.append(`watching ${member} conversation ${conversationId} every ${intervalMs}ms\n`);
          while (!stopped) {
            try {
              const run = await findLiveRun(od, projectId, conversationId).catch(() => undefined);
              const projectRun = run === undefined
                ? await liveProjectRun(od, projectId).catch(() => undefined)
                : undefined;
              const live = run ?? projectRun;
              const observation = observeRun(
                live === undefined
                  ? undefined
                  : await od.getRun(live.runId).catch(() => ({ id: live.runId, status: live.status })),
                undefined,
              );
              const report = diffConversation(previous, observation);
              if (report.changed) {
                job.append(`${new Date().toISOString()} ${report.kind}: ${report.message}\n`);
                job.updateProgress(report.message);
                // A status change means the caller should look at the output.
                if (observation.runId !== undefined) {
                  job.append(`  → check the output: opendesign_ask({ run_id: "${observation.runId}" })\n`);
                }
              }
              previous = observation;
              if (lastProblem !== undefined) {
                job.append(`${new Date().toISOString()} recovered\n`);
                lastProblem = undefined;
              }
            } catch (error) {
              // One line per distinct problem, and the client is KEPT: it carries
              // `rediscover`, which repairs a port change inside the next request.
              const detail = error instanceof Error ? error.message : String(error);
              if (detail !== lastProblem) {
                lastProblem = detail;
                job.append(`${new Date().toISOString()} not ready yet: ${detail}\n`);
              }
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
          }
          return { status: 'completed' };
        })();
        return {
          done: loop,
          cancel: () => {
            stopped = true;
          },
        };
      },
    });
    armed.set(key, jobId);
    return { jobId, reused: false };
  }

  /**
   * Run one Open Design turn and return only its final text.
   *
   * The prompt carries its sender as a prefix so the conversation records who
   * asked exactly once: Open Design itself writes the user message and the
   * assistant reply, so this bridge never injects duplicate rows.
   *
   * @param od - connected client.
   * @param input - project, conversation, prompt, and model overrides.
   */
  async function runTurn(od, input) {
    // The CLI is identified live, never taken from config directly: Open Design's
    // selected CLI can change from its own settings page at any moment, and a run
    // started against a CLI that is no longer selected would answer from the
    // wrong provider while the panel claimed otherwise. Reading it costs one
    // `app-config` call (milliseconds), so it is affordable per turn.
    const { agentId } = await currentCli(od);
    // Precedence for the values a turn runs with, strongest first:
    //   1. this one call's explicit argument,
    //   2. the standing choice made on the Plugin Manager page,
    //   3. the plugin config.
    // Open Design's own stored model is deliberately NOT in this chain: the
    // product decision is that this side's settings govern the run. Open Design
    // is only read to identify which CLI is selected and to show what it holds.
    const stored = settings.current();
    const model = typeof input.model === 'string' && input.model.length > 0
      ? input.model
      : (stored.model && stored.model !== DEFAULT_MODEL
        ? stored.model
        : (config.model || DEFAULT_MODEL));
    const reasoning = typeof input.reasoning === 'string' && input.reasoning.length > 0
      ? input.reasoning
      : (stored.reasoning || config.reasoning);
    let accepted;
    try {
      accepted = await od.createRun({
        projectId: input.projectId,
        conversationId: input.conversationId,
        agentId,
        // The sender prefix is added once, HERE, for a normal turn. A consuming
        // turn sends the injected row's own text, which already carries it, so
        // prefixing again would double it. `composeRunMessage` owns that rule and
        // has its own test: this was a real bug, caught by reading the conversation
        // the feature had just written into.
        message: composeRunMessage({
          sender: input.sender,
          prompt: input.prompt,
          userMessageId: input.userMessageId,
        }),
        // Set only when this turn consumes an injected message: the row already
        // exists in the conversation, so the daemon adopts it rather than seeding a
        // second copy of the same words.
        ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
        model,
        ...(reasoning ? { reasoning } : {}),
        clientRequestId: `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      });
    } catch (error) {
      // A conversation that already owns a live run answers 409 RUN_IN_PROGRESS.
      // Passing that through verbatim tells the caller nothing it can act on, so
      // say which run to attach to and how — that is the whole difference between
      // a dead end and a usable answer.
      if (error instanceof OdError && error.details?.status === 409) {
        const live = await findLiveRun(od, input.projectId, input.conversationId).catch(() => undefined);
        if (live !== undefined) {
          throw new OdError(
            `a turn is already running in this conversation (run ${live.runId}, status ${live.status}). `
            + `Collect it with opendesign_ask({ run_id: "${live.runId}" }), or stop it deliberately with opendesign_ask({ inject: ... }). `
            + `Starting a second turn would interleave their history in one conversation.`,
            'conversation-busy',
            { runId: live.runId, status: live.status },
          );
        }
      }
      throw error;
    }
    const runId = accepted.runId;
    if (typeof runId !== 'string') {
      throw new OdError('Open Design did not accept the turn', 'run-create-failed', { accepted });
    }
    // Record it BEFORE waiting: the answer is already going to be returned by
    // this call, so the inbound reader must never report it as a new arrival.
    // Doing this after the wait would leave a window where a concurrent
    // `opendesign_inbox` could deliver the same answer twice.
    if (typeof input.onRunCreated === 'function') input.onRunCreated(runId);
    // Only the settled result is returned: intermediate streamed frames are
    // never collected, so a caller can never quote partial output. The wait
    // budget is a deadline on OUR patience only — it is passed as `timeoutMs`,
    // which reports `stillRunning` rather than cancelling the run.
    const settled = await awaitRun(od, runId, {
      pollMs: config.pollMs,
      timeoutMs: typeof input.waitBudgetMs === 'number' ? input.waitBudgetMs : config.turnTimeoutMs,
      signal: input.signal,
    });
    // Report what this turn ACTUALLY ran with, not what a stale binding says.
    // The binding records the model chosen when the conversation was created;
    // reporting it here would tell the caller "default" while the run really
    // used something else — an inaccurate report is worse than no report.
    return {
      ...settled,
      effectiveAgentId: agentId,
      effectiveModel: model,
      effectiveReasoning: reasoning,
    };
  }
  /** Register the tool set in one exact Agent scope. */
  function install(agent) {
    const scoped = agent.ctx;
    const disposers = [];
    const register = (disposer) => disposers.push(disposer);

    try {
      register(scoped.tools.register(defineTool({
        name: 'opendesign_open',
        description:
          'Open (or reuse) the calling member\'s own real Open Design chat window and align it with this Team. Aligns the Open Design workspace to the Team working directory and reports the model in use. A new Team member always gets a fresh conversation. Reports project, conversation, workspace, model, and any capability gaps.',
        parameters: {
          force_new: {
            type: 'boolean',
            description: 'Open a brand-new conversation for this member instead of reusing the bound one.',
          },
          model: {
            type: 'string',
            description: 'Model id to align this member\'s Open Design window to, e.g. deepseek-v4.1-flash. Omit to keep the Team default.',
          },
          workspace: {
            type: 'string',
            description: 'Absolute workspace directory to align to. Omit to use the Team working directory.',
          },
        },
        output: jsonOutput(OPEN_SCHEMA),
        async execute(args, exec) {
          const member = membership(exec.agent);
          const od = await client();
          const workspace = typeof args.workspace === 'string' && path.isAbsolute(args.workspace)
            ? args.workspace
            : ctx.workingDirectory.get(exec.agent.session);
          const ensured = await ensureProject(od, member.root.id, workspace);
          const conversation = await ensureConversation(od, member.root.id, member.name, ensured.project, {
            force: args.force_new === true,
          });
          const { binding } = conversation;
          // Report the CLI Open Design actually has selected, plus the standing
          // model choice a turn would use. Neither is read from a stale binding.
          const { agentId: activeCli } = await currentCli(od);
          const standing = settings.current();
          const standingModel = standing.model && standing.model !== DEFAULT_MODEL
            ? standing.model
            : (config.model || 'default');
          if (typeof args.model === 'string' && args.model.length > 0) {
            store.setMember(member.root.id, member.name, { ...binding, model: args.model });
            binding.model = args.model;
            settings.update({ model: args.model });
          }
          return {
            member: member.name,
            role: member.role,
            projectId: ensured.project.projectId,
            conversationId: binding.conversationId,
            workspace,
            ...(ensured.resolvedDir ? { resolvedDir: ensured.resolvedDir } : {}),
            strategy: ensured.project.strategy,
            model: typeof args.model === 'string' && args.model.length > 0 ? args.model : standingModel,
            agentId: activeCli,
            ...(ensured.project.odVersion ? { odVersion: ensured.project.odVersion } : {}),
            degraded: ensured.project.degraded ?? [],
            // Two independent facts, reported separately so neither misleads:
            // the Team project is shared and normally reused, while this
            // member's own conversation is created once and then resumed.
            projectReused: ensured.reused,
            conversationReused: conversation.reused,
            alignments: [
              `workspace: ${workspace}`,
              `cwd: ${ensured.resolvedDir ?? '(not folder-backed)'}`,
              `model: ${typeof args.model === 'string' && args.model.length > 0 ? args.model : standingModel}`,
              `cli: ${activeCli}`,
            ],
          };
        },
      })));

      register(scoped.tools.register(defineTool({
        name: 'opendesign_ask',
        description:
          'Run one Open Design turn and return ONLY that turn\'s final answer. Open Design is this Team\'s frontend implementer: it writes the files, and you brief it rather than building the UI yourself. Intermediate streaming output is never returned. Runs in the caller\'s own Open Design window unless `member` selects another member\'s window. Brief it in two parts: describe the need subjectively (intent, audience, tone, impression) and constrain with objective facts (stack, file layout, component/API interfaces, data schemas, formats). A reply with prose and no `questionForm` is a proposal waiting for you to say "go ahead" — send that as another turn; it does not hand the work to you.',
        parameters: {
          prompt: {
            type: 'string',
            description: 'The complete, self-contained request for Open Design. Required unless form_answers is given.',
          },
          member: {
            type: 'string',
            description: 'Run the turn in this Team member\'s Open Design window instead of your own.',
          },
          model: {
            type: 'string',
            description: 'Override the model for this turn only.',
          },
          reasoning: {
            type: 'string',
            description: 'Reasoning tier for this turn only.',
          },
          timeout_ms: {
            type: 'integer',
            description: 'How long to wait for this turn to settle, in milliseconds. Defaults to the configured ceiling. Running out does NOT cancel the turn: the result reports stillRunning with its runId instead.',
          },
          run_id: {
            type: 'string',
            description: 'Collect the answer of a run that was still working when you stopped waiting. Pass the runId from a stillRunning result; do not send a prompt with it.',
          },
          inject: {
            type: 'string',
            description:
              'Redirect a turn that is already running. This STOPS that turn and starts a new one with this text, which is what Open Design\'s own 「引导对话」 does — verified against the live app: the running turn is cancelled (cancel_origin: user_stop) and a new run starts with the prior context. The unfinished work of the stopped turn is lost, and the result reports where it had got to. Open Design cannot accept a message into a turn in flight on this CLI, so a "mid-turn steer" is not something this bridge can offer. To keep the old turn running instead, send this as a normal prompt after collecting it.',
          },
          form_answers: {
            type: 'array',
            description:
              'Submit answers to a question form Open Design asked in a previous turn. Each entry is { id, label?, value }. Use the ids and values reported in that turn\'s questionForm. Open Design treats a submitted form as authoritative and will not re-ask it.',
            items: { type: 'object' },
          },
          form_id: {
            type: 'string',
            description: 'The form id reported by the turn that asked the question. Defaults to the last form this member was asked.',
          },
        },
        output: jsonOutput(ASK_SCHEMA),
        async execute(args, exec) {
          const member = membership(exec.agent);
          const od = await client();
          const workspace = ctx.workingDirectory.get(exec.agent.session);
          const ensured = await ensureProject(od, member.root.id, workspace);
          const targetMember = typeof args.member === 'string' && args.member.length > 0
            ? args.member
            : member.name;
          const { binding } = await ensureConversation(od, member.root.id, targetMember, ensured.project);
          const budget = typeof args.timeout_ms === 'number' && args.timeout_ms > 0
            ? args.timeout_ms
            : config.turnTimeoutMs;

          // Submitting form answers is a distinct shape: Open Design only treats
          // the message as authoritative when it opens with the exact
          // `[form answers — id]` header its designer prompt defines.
          const answers = Array.isArray(args.form_answers) && args.form_answers.length > 0
            ? args.form_answers
            : undefined;
          const remembered = store.member(member.root.id, targetMember)?.pendingForm;

          // What this call means is decided by `planTurn`, a pure function with
          // its own tests: collect / inject / run / error. Everything below is I/O.
          //
          // Why the distinction matters: an injected message can never reach the
          // turn already running (measured — the turn finished with its original
          // answer, mentioning none of the correction), so pretending otherwise
          // would make every later status report a lie.
          const recordedPendingRun = store.pendingRun(member.root.id, targetMember);
          // Ask the daemon what this conversation is actually doing, instead of
          // trusting this bridge's own record. The record is written only when a
          // wait expires, so it is blind to a turn the human started in the Open
          // Design window, to a turn started before a plugin reload, and to any
          // turn whose write was lost. Three observations are reconciled first;
          // `reconcileWatch` owns that decision and has its own tests.
          let pendingRunStatus;
          if (recordedPendingRun?.runId !== undefined) {
            pendingRunStatus = await od.getRun(recordedPendingRun.runId).catch(() => undefined);
            // Only a DEFINITE terminal status clears the record. A failed lookup
            // is not evidence of settlement: while a long turn streams, this
            // daemon can time out on `GET /api/runs/:id`, and dropping the record
            // then loses the only pointer to a live run.
            if (pendingRunStatus !== undefined && isSettledRun(pendingRunStatus)) {
              store.clearPendingRun(member.root.id, targetMember);
            }
          }
          const conversationRun = await findLiveRun(od, ensured.project.projectId, binding.conversationId, [
            recordedPendingRun?.runId,
          ]).catch(() => undefined);
          const projectRun = await liveProjectRun(od, ensured.project.projectId).catch(() => undefined);
          const watch = reconcileWatch({
            pendingRun: recordedPendingRun,
            pendingRunStatus,
            conversationRun,
            projectRun,
            activeRunCount: await od.activeRunCount(),
          });
          // `pendingRunActive` is what the planner needs: true / false / unknown.
          const pendingRunActive = recordedPendingRun?.runId === undefined
            ? undefined
            : (pendingRunStatus === undefined
              ? undefined
              : !isSettledRun(pendingRunStatus));
          const plan = planTurn({
            runId: args.run_id,
            inject: args.inject,
            prompt: answers !== undefined
              ? composeFormAnswers(
                args.form_id ?? remembered?.id ?? 'form',
                answers.map((answer) => ({
                  id: answer?.id,
                  label: answer?.label,
                  value: answer?.value,
                })),
              )
              : args.prompt,
            hasFormAnswers: answers !== undefined,
            pendingRun: recordedPendingRun,
            pendingRunActive,
          });

          // ── interrupt: stop the live turn, then run the text as the next ──
          //
          // This mirrors Open Design's own 「引导对话」, measured on 2026-10-25:
          // pressing it with a turn running produced a new run while the old one
          // was still working, wrote NO user message for the typed text, and left
          // the old run with `cancel_origin: user_stop`.
          //
          // The cost is real and is reported rather than hidden: the stopped turn
          // loses whatever it had not finished. `interrupted.answerSoFar` carries
          // the prose it had produced, so the caller can see what was traded.
          let interrupted;
          if (plan.interruptRunId !== undefined) {
            // Read the turn's partial output BEFORE cancelling: after the run
            // settles the daemon keeps the assistant message, but reporting what
            // was lost is only honest if it is captured from what actually
            // existed at the moment of the stop.
            const partial = await od.getRun(plan.interruptRunId)
              .then((run) => (run?.projectId && run?.conversationId && run?.assistantMessageId
                ? od.listMessages(run.projectId, run.conversationId)
                  .then((messages) => messages.find((message) => message?.id === run.assistantMessageId))
                  .catch(() => undefined)
                : undefined))
              .catch(() => undefined);
            const partialText = typeof partial?.content === 'string' ? partial.content : '';

            const before = await od.getRun(plan.interruptRunId).catch(() => undefined);
            if (before !== undefined && !isTerminalRun(before)) {
              await od.cancelRun(plan.interruptRunId).catch(() => undefined);
              // Wait for the cancel to land before starting the replacement:
              // two live runs in one conversation interleave their history, and
              // the daemon does not gate ordinary chat turns against that.
              for (let i = 0; i < 40; i += 1) {
                const now = await od.getRun(plan.interruptRunId).catch(() => undefined);
                if (now === undefined || isTerminalRun(now)) break;
                await new Promise((resolve) => setTimeout(resolve, config.pollMs));
              }
            }
            const settled = await od.getRun(plan.interruptRunId).catch(() => undefined);
            const capped = truncateUtf8(partialText, MAX_ANSWER_BYTES);
            interrupted = {
              runId: plan.interruptRunId,
              // The daemon's own verdict on how the run ended, so "was it really
              // stopped?" is answered by the daemon rather than by this bridge.
              status: typeof settled?.status === 'string' ? settled.status : 'unknown',
              cancelOrigin: typeof settled?.cancelOrigin === 'string' ? settled.cancelOrigin : null,
              /** What the stopped turn had produced before it was cut off. */
              answerSoFar: capped.text,
              answerTruncated: capped.truncated,
            };
            store.clearPendingRun(member.root.id, targetMember);
          }

          // ── collect: a READ of an existing run, sending nothing ───────────
          if (plan.kind === 'collect') {
            const resumeRunId = plan.runId;
            const collected = await awaitRun(od, resumeRunId, {
              pollMs: config.pollMs,
              timeoutMs: budget,
              signal: exec.signal ?? new AbortController().signal,
            });
            if (collected.stillRunning === true) {
              return {
                member: targetMember,
                conversationId: binding.conversationId,
                model: 'default',
                status: collected.status,
                answer: '',
                questionForm: '',
                truncated: false,
                runId: resumeRunId,
                durationMs: collected.settledAt - collected.startedAt,
                stillRunning: true,
              };
            }
            store.clearPendingRun(member.root.id, targetMember);
            const resumed = truncateUtf8(collected.text, MAX_ANSWER_BYTES);
            if (collected.questionForm !== null) {
              store.setPendingForm(member.root.id, targetMember, {
                id: collected.questionForm.id,
                title: collected.questionForm.title,
                questions: collected.questionForm.questions,
                runId: resumeRunId,
              });
            } else {
              store.clearPendingForm(member.root.id, targetMember);
            }
            return {
              member: targetMember,
              conversationId: binding.conversationId,
              model: 'default',
              status: collected.status ?? 'unknown',
              answer: resumed.text.length > 0
                ? resumed.text
                : (collected.questionForm !== null ? '(this turn asked a question instead of answering; see questionForm)' : ''),
              questionForm: collected.questionForm === null ? '' : renderQuestionForm(collected.questionForm),
              truncated: resumed.truncated,
              runId: resumeRunId,
              durationMs: collected.settledAt - collected.startedAt,
              stillRunning: false,
            };
          }

          if (plan.kind === 'error') {
            const pending = remembered === undefined
              ? ''
              : ` Open Design is still waiting for answers to "${remembered.title ?? remembered.id}" (form_id ${remembered.id}).`;
            throw new Error(`opendesign_ask has nothing to do: ${plan.reason}.${pending}`);
          }

          const prompt = plan.prompt;

          // Guard the conversation before adding a run to it.
          //
          // This is the check that used to be missing. Open Design does not gate
          // ordinary chat turns (`ordinary chat turns are never gated by this` in
          // `handleRunCreate`), and the strategy-task path that DOES answer 409
          // only covers projects created with a strategy task. So a turn started
          // outside this bridge — by the human in the Open Design window, or by a
          // bridge process whose record was lost — was invisible here, and this
          // call would start a second one over it.
          //
          // `watch` has already reconciled every source. When it says a turn is
          // live, that turn wins: report it and how to collect it instead of
          // starting another.
          //
          // EXCEPT when this call carries FORM ANSWERS. Those are not a new
          // request: they are the reply to a question Open Design is blocked on,
          // and dropping them strands the conversation. `watch.busy` can also be
          // a false positive — an unreadable recorded run counts as busy by
          // design — so a guard that refused to deliver answers would turn a
          // conservative guess into a lost reply. Measured: after the guard was
          // added, form answers never reached Open Design at all, and the same
          // form came back on the next turn.
          if (watch.busy === true && plan.answersReply !== true) {
            return {
              member: targetMember,
              conversationId: binding.conversationId,
              model: 'default',
              status: watch.status,
              answer: '',
              questionForm: '',
              truncated: false,
              runId: watch.runId,
              durationMs: 0,
              stillRunning: true,
              // Nothing new was started; this is the turn already in progress.
              adopted: {
                runId: watch.runId,
                source: watch.source,
                reason: 'a turn is already running in this conversation, and starting a second one would interleave their history',
                collectWith: watch.collectWith,
              },
              ...(watch.note === undefined ? {} : { note: watch.note }),
            };
          }

          // A form answer is a reply to a turn that ended by asking. If a run is
          // somehow still live in the conversation, delivering the answer alongside
          // it would put two runs in one history — so stop the stale one first.
          // Never cancel for a plain prompt: that case is handled by the guard
          // below, which reports instead of destroying work.
          let answeredOverRun;
          if (answers !== undefined && watch.busy === true) {
            await od.cancelRun(watch.runId).catch(() => undefined);
            for (let i = 0; i < 40; i += 1) {
              const now = await od.getRun(watch.runId).catch(() => undefined);
              if (now === undefined || isSettledRun(now)) break;
              await new Promise((resolve) => setTimeout(resolve, config.pollMs));
            }
            const stopped = await od.getRun(watch.runId).catch(() => undefined);
            answeredOverRun = {
              runId: watch.runId,
              status: typeof stopped?.status === 'string' ? stopped.status : 'unknown',
              cancelOrigin: typeof stopped?.cancelOrigin === 'string' ? stopped.cancelOrigin : null,
              note: 'this turn was stopped so the form answers could be delivered as their own turn',
            };
          }

          // Arm the watcher BEFORE the turn starts, so it is watching from the
          // first moment the run exists instead of being something a caller has to
          // remember. It is armed here rather than inside `runTurn` because this is
          // where the job registry and the session owner are both in scope.
          const armedWatcher = armWatcher({
            jobs: typeof ctx.get === 'function' ? ctx.get('jobs') : undefined,
            owner: exec.agent.session.id,
            od,
            projectId: ensured.project.projectId,
            conversationId: binding.conversationId,
            member: targetMember,
            intervalMs: config.watchIntervalMs,
          });

          const settled = await runTurn(od, {
            projectId: ensured.project.projectId,
            conversationId: binding.conversationId,
            prompt,
            sender: `${member.name} (DSH ${member.role})`,
            model: args.model,
            reasoning: args.reasoning,
            sessionMode: config.sessionMode,
            // ONLY the caller's own cancellation stops the run. The wait budget
            // is passed separately as `waitBudgetMs` and can never cancel it:
            // a budget that doubles as a kill switch destroys the very turn the
            // caller is waiting for. This used to be an AbortSignal.timeout, so
            // whichever of the two fired first decided whether Open Design's
            // work survived — a race, and the reason a timed-out turn kept
            // running afterwards with nobody able to collect it.
            signal: exec.signal ?? new AbortController().signal,
            waitBudgetMs: budget,
            // Stamp the run as ours the moment Open Design accepts it, so
            // `opendesign_inbox` can tell this already-answered turn apart from
            // one the human started in the window.
            onRunCreated: (createdRunId) => store.noteBridgeRun(member.root.id, targetMember, createdRunId),
          });
          store.noteTurn(member.root.id, targetMember, {
            event: answers !== undefined ? 'form-answers' : 'ask',
            runId: settled.runId,
            status: settled.status,
          });
          const capped = truncateUtf8(settled.text, MAX_ANSWER_BYTES);
          // Persist an outstanding question so a later turn can answer it
          // without the caller having to remember the form id.
          if (settled.questionForm === null) {
            store.clearPendingForm(member.root.id, targetMember);
          } else {
            store.setPendingForm(member.root.id, targetMember, {
              id: settled.questionForm.id,
              title: settled.questionForm.title,
              questions: settled.questionForm.questions,
              runId: settled.runId,
            });
          }
          // A turn still in progress is neither success nor failure: report it as
          // such, with the run id, so the caller stops blocking and can collect
          // the answer later instead of losing it.
          if (settled.stillRunning === true) {
            store.notePendingRun(member.root.id, targetMember, {
              runId: settled.runId,
              startedAt: settled.startedAt,
            });
            return {
              member: targetMember,
              conversationId: binding.conversationId,
              model: settled.effectiveModel ?? 'default',
              status: settled.status,
              answer: '',
              questionForm: '',
              truncated: false,
              runId: settled.runId,
              durationMs: settled.settledAt - settled.startedAt,
              stillRunning: true,
              ...(interrupted === undefined ? {} : { interrupted }),
              ...(answeredOverRun === undefined ? {} : { answeredOverRun }),
              // Most useful on this path: the caller has stopped waiting, and the
              // watcher is how it finds out the turn finished.
              ...(armedWatcher === undefined ? {} : { watcher: armedWatcher }),
            };
          }
          if (!settled.ok && capped.text.length === 0 && settled.questionForm === null) {
            throw new Error(
              `Open Design turn ${settled.runId} produced no final answer (status ${settled.status}${settled.errorCode ? `, ${settled.errorCode}` : ''}). ${settled.error ?? ''}`.trim(),
            );
          }
          const askedForm = settled.questionForm === null ? '' : renderQuestionForm(settled.questionForm);
          return {
            member: targetMember,
            conversationId: binding.conversationId,
            // The model this turn REALLY ran with, not a stale binding record.
            model: settled.effectiveModel ?? 'default',
            status: settled.status ?? 'unknown',
            // When the turn was a question, the prose is often empty. Say so
            // explicitly instead of returning a blank answer that reads like a
            // silent failure.
            answer: capped.text.length > 0
              ? capped.text
              : (askedForm.length > 0 ? '(this turn asked a question instead of answering; see questionForm)' : ''),
            questionForm: askedForm,
            truncated: capped.truncated,
            runId: settled.runId,
            durationMs: settled.settledAt - settled.startedAt,
            stillRunning: false,
            // Present only when this call stopped a turn to redirect it, so the
            // caller can see exactly what was traded away for the new direction.
            ...(interrupted === undefined ? {} : { interrupted }),
            // Present only when a stale run had to be stopped so form answers
            // could be delivered as their own turn.
            ...(answeredOverRun === undefined ? {} : { answeredOverRun }),
            // The watcher armed for this conversation, so the caller knows where to
            // read status changes after this call returns.
            ...(armedWatcher === undefined ? {} : { watcher: armedWatcher }),
            // What the turn actually DID, from its own journal. A reply that reads
            // like a proposal can be a run that already changed files, and the caller
            // needs that fact rather than an inference from the prose.
            ...(settled.actions === undefined ? {} : {
              actions: {
                ...settled.actions,
                summary: describeActions(settled.actions),
              },
            }),
          };
        },
      })));

      register(scoped.tools.register(defineTool({
        name: 'opendesign_status',
        description:
          'Report the Open Design bridge state cheaply: daemon reachability and version, capability gaps, how many runs Open Design currently has active, every member conversation binding including any run still in progress, workspace alignment, and the model in use. Use it to verify alignment before and after either client upgrades, and to find a run whose answer has not been collected yet. The model catalogue is kept out of this answer because reading it costs Open Design nine seconds; pass include_models for it, or read the settings panel, which caches it.',
        parameters: {
          include_models: {
            type: 'boolean',
            description: 'Include the selected CLI\'s model ids. Off by default: this reads the daemon\'s full model catalogue, which takes seconds and duplicates the cached catalogue the settings panel already holds.',
          },
        },
        output: jsonOutput(STATUS_SCHEMA),
        async execute(args, exec) {
          const member = membership(exec.agent);
          // Read-only: peekTeam never creates a record, and no setter runs here,
          // so inspecting state cannot rewrite the bindings file.
          store.reload();
          const team = store.peekTeam(member.root.id) ?? { project: null, members: {} };
          let daemon;
          let activeCli;
          try {
            const od = await client();
            // `agents` is ALWAYS skipped here, for two different reasons that
            // happen to agree:
            //   - off (default): it costs 9–11 s against a 60 KB response, and
            //     every ALIGNMENT rule tells members to call this tool before UI
            //     work. A status call that blocks that long makes alignment the
            //     slowest step of the task it was meant to unblock.
            //   - on: the enumeration is about to be done by `catalogue(force)`
            //     below, and asking twice is precisely the duplicate that made the
            //     old status call nineteen seconds instead of nine. Measured after
            //     the first attempt at this fix: probe + listAgents = 18.1 s on the
            //     opt-in path, because both still ran.
            const report = await od.probe({
              skip: ['agents'],
              capture: ['appConfig', 'activeRunCount'],
            });
            // Report the CLI Open Design has selected right now, which is what a
            // turn would drive — not a pinned id from config. Reads the same
            // `app-config` body the probe just captured.
            const cli = await currentCli(od, report.features.appConfig?.value?.config);
            activeCli = cli.agentId;
            // Availability and the model list come from the per-CLI catalogue
            // that is already cached on disk (7-day TTL), so this path normally
            // costs no daemon call at all. A cold cache reports "unknown" rather
            // than a false "unavailable".
            const cached = cachedCatalogue(activeCli, Date.now());
            const odModel = odSelection(cli.appConfig, activeCli);
            const activeRunCount = report.features.activeRunCount?.value?.activeRunCount;
            daemon = {
              reachable: true,
              baseUrl: report.baseUrl,
              version: report.version,
              degraded: report.degraded,
              /** Runs Open Design is executing right now, across every client. */
              activeRunCount: Number.isFinite(activeRunCount) ? activeRunCount : null,
              agentAvailable: cached === undefined ? null : cached.data.agentAvailable === true,
              // What Open Design itself stores for this CLI, so a divergence from
              // this side's settings is visible here too.
              odModel: odModel?.model ?? null,
              odReasoning: odModel?.reasoning ?? null,
              /** When the cached catalogue was probed, or null when none is on hand. */
              catalogueAt: cached === undefined ? null : new Date(cached.at).toISOString(),
            };
            if (args.include_models === true) {
              // Explicitly asked for: pay for the real enumeration. `force` beats
              // the cache so the answer reflects the daemon as it is now.
              //
              // A failure here is reported as this ONE field, never by turning the
              // whole report into "unreachable": the daemon just answered five
              // cheap routes, so claiming it is down because its most expensive
              // route timed out would send the caller looking for the wrong
              // problem. That is also what a busy single-threaded daemon looks
              // like mid-turn, which is exactly when a member checks on it.
              try {
                const fresh = await catalogue(od, { agentId: activeCli, force: true });
                daemon.agentAvailable = fresh.agentAvailable;
                daemon.agentName = fresh.agentName;
                daemon.modelCount = fresh.entries.length;
                daemon.models = fresh.entries.map((entry) => entry.id).slice(0, 40);
                daemon.catalogueAt = new Date().toISOString();
              } catch (error) {
                daemon.modelsError = error instanceof Error ? error.message : String(error);
              }
            }
          } catch (error) {
            daemon = { reachable: false, error: error instanceof Error ? error.message : String(error) };
          }
          const workspace = ctx.workingDirectory.get(exec.agent.session);
          // A run this member left in progress. Reported at top level rather than
          // under `daemon`, because it is this Team's bookkeeping, not daemon state:
          // it is what makes such a run collectable after the caller lost its id.
          const pendingRun = team.members?.[member.name]?.pendingRun;
          // What Open Design is ACTUALLY doing in this member's conversation,
          // reconciled from the recorded run, the conversation, and the project's
          // own status. This is the field that answers "is it working, or did my
          // turn die?" without guessing from `pendingRun`, which is only written
          // when a wait expires and is therefore blind to runs this bridge did not
          // start.
          const watched = await (async () => {
            const od = await client().catch(() => undefined);
            if (od === undefined) {
              return {
                state: 'unknown',
                busy: null,
                note: 'the daemon is not reachable, so what it is doing cannot be observed',
              };
            }
            const memberConversation = team.members?.[member.name]?.conversationId;
            const projectId = team.project?.projectId;
            const conversationRun = projectId && memberConversation
              ? await findLiveRun(od, projectId, memberConversation, [pendingRun?.runId]).catch(() => undefined)
              : undefined;
            return reconcileWatch({
              pendingRun,
              pendingRunStatus: pendingRun?.runId === undefined
                ? undefined
                : await od.getRun(pendingRun.runId).catch(() => undefined),
              conversationRun,
              projectRun: projectId ? await liveProjectRun(od, projectId).catch(() => undefined) : undefined,
              activeRunCount: Number.isFinite(daemon.activeRunCount) ? daemon.activeRunCount : undefined,
            });
          })();
          return {
            member: member.name,
            role: member.role,
            daemon,
            project: team.project ?? {},
            members: Object.values(team.members),
            /**
             * The live verdict: `state` is `busy` or `idle`, and a busy verdict
             * carries the run id plus `collectWith`. Replaces guessing from
             * `pendingRun` alone.
             */
            watch: watched,
            pendingRun: pendingRun === undefined
              ? null
              : {
                runId: pendingRun.runId,
                startedAt: pendingRun.startedAt,
                notedAt: pendingRun.at,
                // Collected with the same call shape that started it. Spelled out
                // because "there is a pending run" is useless without the key.
                collectWith: pendingRun.runId === undefined
                  ? null
                  : `opendesign_ask({ run_id: "${pendingRun.runId}" })`,
              },
            /**
             * Whether this CLI can take a message mid-turn. `null` means not yet
             * known (cold catalogue cache). Informational: redirecting a turn does
             * not depend on it, because the measured behaviour here is
             * cancel-and-restart rather than mid-turn input.
             */
            steering: activeCli === undefined ? null : await steeringCapabilityFromCache(activeCli),
            workspace,
            configuredModel: settings.current().model || config.model || 'runtime default',
            configuredAgentId: activeCli ?? (config.agentId || 'Open Design current CLI'),
            alignments: {
              workspaceMatchesProject:
                team.project?.baseDir === undefined ? null : team.project.baseDir === workspace,
              strategy: team.project?.strategy ?? null,
            },
          };
        },
      })));

      register(scoped.tools.register(defineTool({
        name: 'opendesign_watch',
        description:
          'Start a LONG-LIVED background watcher on this member\'s Open Design conversation, and report its job id. It keeps running after this tool call returns and after the calling turn ends, polling the run status and appending a line to its job output every time that status CHANGES — queued, running, succeeded, failed, canceled. Read the lines with job_output. Stop it with job_kill. This is how you find out that a turn you stopped waiting for has finished: the job outlives the call that started it, which a per-call wait cannot.',
        parameters: {
          member: {
            type: 'string',
            description: 'Watch this Team member\'s conversation instead of your own.',
          },
          interval_ms: {
            type: 'integer',
            description: 'How often to poll Open Design, in milliseconds. Defaults to the configured watch interval (5s). Slower is cheaper; faster only shortens the delay before a change is noticed.',
          },
          stop_when_idle: {
            type: 'boolean',
            description: 'When true, the watcher stops itself once the conversation has had no live run for one full interval after having seen one. Default false: it keeps watching so a turn started later is still noticed.',
          },
        },
        output: jsonOutput(WATCH_SCHEMA),
        async execute(args, exec) {
          const member = membership(exec.agent);
          const targetMember = typeof args.member === 'string' && args.member.length > 0
            ? args.member
            : member.name;
          const intervalMs = typeof args.interval_ms === 'number' && args.interval_ms >= 500
            ? args.interval_ms
            : config.watchIntervalMs;

          // `jobs` is optional: a composition without a background registry still
          // gets a usable answer instead of a crash, and the note says what to do.
          const jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
          if (jobs === undefined) {
            throw new Error(
              'background watching needs the jobs service, which this composition does not provide. '
              + 'Poll with opendesign_status instead, or collect the run directly with opendesign_ask({ run_id }).',
            );
          }

          const workspace = ctx.workingDirectory.get(exec.agent.session);
          const owner = exec.agent.session.id;
          // The conversation is resolved ONCE, from disk when possible, so the job
          // can start immediately. Doing `client()` + `ensureProject()` +
          // `ensureConversation()` first — all daemon round-trips, and `client()`
          // alone scans every port while Open Design is cold or down — meant the
          // watcher appeared to start late or not at all: the very moment it is
          // most needed is the moment those calls are slowest.
          // Resolved from disk so this call never waits for the daemon. An
          // unbound conversation is not an error here: the job reports it and
          // keeps trying, which is what a watcher should do.
          const recorded = store.member(member.root.id, targetMember);
          const projectId = recorded?.projectId;
          const conversationId = recorded?.conversationId;

          // The one and only watcher implementation, shared with `opendesign_ask`
          // so both share a single idempotency rule: one live job per
          // conversation, and a remembered-but-dead job is restarted rather than
          // reported as running.
          const armedWatcher = armWatcher({
            jobs,
            owner: exec.agent.session.id,
            od: await client(),
            projectId,
            conversationId,
            member: targetMember,
            intervalMs,
          });

          return {
            member: targetMember,
            // Empty when the member has no bound conversation yet.
            conversationId: conversationId ?? '',
            jobId: armedWatcher.jobId,
            intervalMs,
            watch: `long-lived: read its lines with job_output({ job_id: "${armedWatcher.jobId}" }), stop it with job_kill({ job_id: "${armedWatcher.jobId}" })`,
            note: armedWatcher.reused
              ? 'A watcher was already running for this conversation and is reused — one job per conversation, so its output has no duplicated lines.'
              : 'The job is running now and keeps polling after this call returns. It only READS Open Design, so a restarted daemon costs a retry rather than a provisioning wait. Every run-status change is appended to its output.',
          };
        },
      })));
      register(scoped.tools.register(defineTool({
        name: 'opendesign_inbox',
        description:
          'Read what arrived in this member\'s Open Design window since it was last read. Returns two separate things: `messages` — what the human typed there, which is ordinary team input; and `odReplies` — what Open Design answered on its own, when the human paused or redirected it from the window and this bridge did not start that turn. Answers this bridge already returned are excluded, so nothing arrives twice. Outbound prompts this bridge sent are filtered out, so you never read your own request back.',
        parameters: {
          member: {
            type: 'string',
            description: 'Read this Team member\'s window instead of your own.',
          },
          peek: {
            type: 'boolean',
            description: 'When true, report the messages without consuming them, so a later read sees them again.',
          },
        },
        output: jsonOutput(INBOX_SCHEMA),
        async execute(args, exec) {
          const member = membership(exec.agent);
          const od = await client();
          const workspace = ctx.workingDirectory.get(exec.agent.session);
          const ensured = await ensureProject(od, member.root.id, workspace);
          const targetMember = typeof args.member === 'string' && args.member.length > 0
            ? args.member
            : member.name;
          const { binding } = await ensureConversation(od, member.root.id, targetMember, ensured.project);
          const cursor = store.cursor(member.root.id, targetMember);
          const inbound = await readInbound(od, {
            projectId: ensured.project.projectId,
            conversationId: binding.conversationId,
            cursorId: cursor?.id,
            cursorAt: cursor?.createdAt,
            memberName: targetMember,
            // Runs this bridge started already had their answer returned by
            // `opendesign_ask`; replaying them here would read as new arrivals.
            bridgeRuns: store.bridgeRuns(member.root.id, targetMember),
          });
          const consume = args.peek !== true;
          if (consume && inbound.nextCursor !== null) {
            store.setCursor(member.root.id, targetMember, inbound.nextCursor);
          }
          const total = inbound.messages.length + inbound.odReplies.length;
          return {
            member: targetMember,
            conversationId: binding.conversationId,
            messages: inbound.messages.map((message) => ({
              id: message.id,
              text: message.text,
              createdAt: message.createdAt,
            })),
            odReplies: inbound.odReplies.map((reply) => ({
              id: reply.id,
              text: reply.text,
              runId: reply.runId,
              runStatus: reply.runStatus,
              model: reply.model,
              createdAt: reply.createdAt,
            })),
            delivered: consume ? total : 0,
            pending: consume ? 0 : total,
          };
        },
      })));
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }

    return () => {
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  const installed = new Map();
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return;
    if (ctx.agentTeams.tryMembership(agent) === undefined) return;
    installed.set(agent, install(agent));
  };
  for (const agent of ctx.agents.list()) maybeInstall(agent);
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.();
    installed.delete(agent);
  });
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose();
    installed.clear();
  }, 'opendesign-member.scopedTools()');

  // Team-wide guidance, installed once: the Lead and every teammate read the
  // same alignment rules from the same place.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'opendesign:policy',
    order: config.policyOrder,
    text: alignmentPolicy(config),
  }), 'opendesign-member.policy()');

  // The Plugin Manager page's data path. Optional by design: without a web
  // server the plugin still works, and the page reports the failure instead of
  // showing values it does not have.
  installSettingsRoute();
}
