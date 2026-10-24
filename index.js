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
  discoverDaemon, OdClient, awaitRun, readInbound, splitQuestionForm,
  renderQuestionForm, composeFormAnswers, OdError,
} from './lib/od-client.js';
import { mintImportToken } from './lib/sidecar-token.js';
import { BindingStore } from './lib/bindings.js';
import { SettingsStore, resolveSelection, DEFAULT_MODEL } from './lib/settings.js';

/** Cordis plugin name. */
export const name = 'opendesign-member';

/** Services required before this plugin can activate. */
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
  instructions: '',
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
- Only a cancellation from the human stops the turn. Never kill a design turn because it is slow.`;
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
    workspace: { type: 'string' },
    configuredModel: { type: 'string' },
    configuredAgentId: { type: 'string' },
    alignments: { type: 'object', additionalProperties: true },
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
   * @returns `{ agentId, appConfig }`.
   */
  async function currentCli(od) {
    const appConfig = await od.appConfig();
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
   * @returns `{ providers, entries, agentId, agentName, agentAvailable }`.
   */
  async function catalogue(od, input) {
    const { agentId } = input;
    const now = Date.now();
    // Memory first, then disk: the disk copy is what makes a ten-second probe a
    // once-per-CLI cost instead of a once-per-restart cost.
    if (input.force !== true) {
      if (catalogueCache !== undefined
        && catalogueCache.agentId === agentId
        && now - catalogueCache.at < CATALOGUE_TTL_MS) {
        return catalogueCache.data;
      }
      const saved = readCatalogueCache(agentId, now);
      if (saved !== undefined) {
        catalogueCache = { at: saved.at, agentId, data: saved.data };
        return saved.data;
      }
    }
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

    const report = await od.probe();
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
    const accepted = await od.createRun({
      projectId: input.projectId,
      conversationId: input.conversationId,
      agentId,
      message: `[${input.sender}]\n\n${input.prompt}`,
      model,
      ...(reasoning ? { reasoning } : {}),
      clientRequestId: `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
    });
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
          'Ask Open Design one question and return ONLY that turn\'s final answer. This is how you consult the Team\'s frontend/UI specialist. Intermediate streaming output is never returned. Runs in the caller\'s own Open Design window unless `member` selects another member\'s window. Brief it in two parts: describe the need subjectively (intent, audience, tone, impression) and constrain with objective facts (stack, file layout, component/API interfaces, data schemas, formats).',
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

          // Resuming a run that outlived our wait is a READ, not a new turn:
          // Open Design is already producing the answer, so sending anything here
          // would start a second turn on top of it.
          const resumeRunId = typeof args.run_id === 'string' && args.run_id.length > 0
            ? args.run_id
            : undefined;
          if (resumeRunId !== undefined) {
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

          // Submitting form answers is a distinct shape: Open Design only treats
          // the message as authoritative when it opens with the exact
          // `[form answers — id]` header its designer prompt defines.
          const answers = Array.isArray(args.form_answers) && args.form_answers.length > 0
            ? args.form_answers
            : undefined;
          const remembered = store.member(member.root.id, targetMember)?.pendingForm;
          const prompt = answers !== undefined
            ? composeFormAnswers(
              args.form_id ?? remembered?.id ?? 'form',
              answers.map((answer) => ({
                id: answer?.id,
                label: answer?.label,
                value: answer?.value,
              })),
            )
            : args.prompt;

          if (typeof prompt !== 'string' || prompt.trim().length === 0) {
            const pending = remembered === undefined
              ? 'no question form is outstanding for this member'
              : `Open Design is waiting for answers to "${remembered.title ?? remembered.id}" (form_id ${remembered.id})`;
            throw new Error(`opendesign_ask needs prompt or form_answers: ${pending}.`);
          }

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
          };
        },
      })));

      register(scoped.tools.register(defineTool({
        name: 'opendesign_status',
        description:
          'Report the Open Design bridge state: daemon reachability and version, capability gaps, every member conversation binding, workspace alignment, and the model in use. Use it to verify alignment before and after either client upgrades.',
        parameters: {},
        output: jsonOutput(STATUS_SCHEMA),
        async execute(_args, exec) {
          const member = membership(exec.agent);
          // Read-only: peekTeam never creates a record, and no setter runs here,
          // so inspecting state cannot rewrite the bindings file.
          store.reload();
          const team = store.peekTeam(member.root.id) ?? { project: null, members: {} };
          let daemon;
          let activeCli;
          try {
            const od = await client();
            const report = await od.probe();
            // Report the CLI Open Design has selected right now, which is what a
            // turn would drive — not a pinned id from config.
            const cli = await currentCli(od);
            activeCli = cli.agentId;
            const agents = await od.listAgents().catch(() => []);
            const agentDef = agents.find((entry) => entry.id === activeCli);
            const odModel = odSelection(cli.appConfig, activeCli);
            daemon = {
              reachable: true,
              baseUrl: report.baseUrl,
              version: report.version,
              degraded: report.degraded,
              agentAvailable: agentDef?.available === true,
              agentVersion: agentDef?.version ?? null,
              // What Open Design itself stores for this CLI, so a divergence from
              // this side's settings is visible here too.
              odModel: odModel?.model ?? null,
              odReasoning: odModel?.reasoning ?? null,
              models: (agentDef?.models ?? []).map((entry) => entry.id).slice(0, 40),
            };
          } catch (error) {
            daemon = { reachable: false, error: error instanceof Error ? error.message : String(error) };
          }
          const workspace = ctx.workingDirectory.get(exec.agent.session);
          return {
            member: member.name,
            role: member.role,
            daemon,
            project: team.project ?? {},
            members: Object.values(team.members),
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
