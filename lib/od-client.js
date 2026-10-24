/**
 * Open Design daemon client: the single seam between DSH and the local
 * Open Design app.
 *
 * Upgrade strategy: nothing here asserts a version number. Every capability is
 * discovered by asking the live daemon and tolerating absence, and every route
 * is named in one place (`ROUTES`) so a renamed endpoint is a one-line fix.
 * A removed route surfaces as `capability-missing` carrying that route name, so
 * an Open Design upgrade degrades loudly instead of crashing the Host.
 *
 * @module @local/dsh-opendesign-member/lib/od-client
 */

/**
 * Every daemon endpoint this bridge depends on, in one table.
 * Verify with `opendesign_status` after either client upgrades.
 */
export const ROUTES = {
  health: ['GET', '/api/health'],
  version: ['GET', '/api/version'],
  agents: ['GET', '/api/agents'],
  appConfig: ['GET', '/api/app-config'],
  projects: ['GET', '/api/projects'],
  createProject: ['POST', '/api/projects'],
  project: ['GET', '/api/projects/:projectId'],
  importFolder: ['POST', '/api/import/folder'],
  workingDir: ['POST', '/api/projects/:projectId/working-dir'],
  conversations: ['GET', '/api/projects/:projectId/conversations'],
  createConversation: ['POST', '/api/projects/:projectId/conversations'],
  messages: ['GET', '/api/projects/:projectId/conversations/:conversationId/messages'],
  putMessage: ['PUT', '/api/projects/:projectId/conversations/:conversationId/messages/:messageId'],
  createRun: ['POST', '/api/runs'],
  run: ['GET', '/api/runs/:runId'],
  cancelRun: ['POST', '/api/runs/:runId/cancel'],
  steerRun: ['POST', '/api/runs/:runId/steer'],
};

/** Default daemon location. Open Design picks a free port, so discovery matters. */
const DEFAULT_PORTS = [8620, 8621, 8622, 8630, 8631, 8632];

/** How long one HTTP call may take before it is treated as a transport failure. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Run statuses the daemon treats as settled. */
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'error', 'timeout']);

export class OdError extends Error {
  /**
   * @param message - human-readable failure.
   * @param code - stable machine code for callers.
   * @param details - optional structured context (route, status, body).
   */
  constructor(message, code, details = undefined) {
    super(message);
    this.name = 'OdError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Fill route placeholders from one parameter bag.
 *
 * @param template - route template containing `:name` placeholders.
 * @param params - replacement values.
 */
function fillRoute(template, params = {}) {
  return template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key) => {
    const value = params[key];
    if (value === undefined || value === null) throw new Error(`missing route parameter "${key}"`);
    return encodeURIComponent(String(value));
  });
}

/**
 * Find the Open Design daemon's port without spawning a shell.
 *
 * Open Design binds an ephemeral port per launch (8620 is only a default), so a
 * fixed scan list goes stale as soon as the app restarts. Two discovery layers:
 *
 *   1. Ask the OS which ports the Open Design processes own. This is done with
 *      `netstat -ano`, a plain executable invocation: spawning PowerShell fails
 *      under some sandboxes (its stdio pipes are restricted), and a swallowed
 *      failure there would silently downgrade discovery to the default list.
 *   2. Fall back to the conventional ports.
 *
 * Both layers only produce candidates; `discoverDaemon` still confirms each one
 * with GET /api/health.
 *
 * @returns listening ports owned by an Open Design process, most likely first.
 */
async function ownedPorts() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);

  // Match by process image name so a renamed install directory still counts.
  let processIds = new Set();
  try {
    const { stdout } = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes('Open Design')) continue;
      const columns = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
      const pid = Number.parseInt(columns[1], 10);
      if (Number.isInteger(pid) && pid > 0) processIds.add(pid);
    }
  } catch {
    return [];
  }
  if (processIds.size === 0) return [];

  try {
    const { stdout } = await run('netstat.exe', ['-ano', '-p', 'TCP'], {
      timeout: 8_000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const ports = new Set();
    for (const line of stdout.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      // proto  local        foreign      state       pid
      if (columns.length < 5 || columns[0] !== 'TCP') continue;
      if (columns[3] !== 'LISTENING') continue;
      const pid = Number.parseInt(columns[4], 10);
      if (!processIds.has(pid)) continue;
      const local = columns[1];
      const port = Number.parseInt(local.slice(local.lastIndexOf(':') + 1), 10);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    }
    // Loopback-only ports first: the daemon binds 127.0.0.1, while an ephemeral
    // dev server may bind wider and serve an unrelated page.
    return [...ports].sort((left, right) => left - right);
  } catch {
    return [];
  }
}

/**
 * Probe whether something accepts TCP connections on one loopback port.
 *
 * This is the cheap discriminator. It matters because Open Design's daemon is
 * single-threaded: while one long agent turn is streaming, `/api/health` can
 * take many seconds even though the socket is accepting fine. Treating such a
 * timeout as "not the daemon" would make the bridge claim Open Design is down
 * exactly when the user is watching it work.
 *
 * @param port - loopback port.
 * @param timeoutMs - connect deadline.
 * @returns whether the port accepted a connection.
 */
async function portAccepts(port, timeoutMs) {
  const net = await import('node:net');
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Locate a live Open Design daemon.
 *
 * Candidates, in order: an explicit configured URL, the ports the Open Design
 * processes currently own, then the conventional defaults.
 *
 * Each candidate is resolved in two stages so a busy daemon is never mistaken
 * for an absent one:
 *   1. `/api/health` with a short deadline — the normal, authoritative path.
 *   2. When that times out, a TCP connect check plus a longer health retry. A
 *      port the Open Design processes own that accepts connections IS the
 *      daemon; it is merely busy, and callers should learn that instead of
 *      being told the app is not running.
 *
 * @param options - explicit base URL, extra ports, and a fetch override.
 * @returns the confirmed base URL plus the health payload and its freshness.
 */
export async function discoverDaemon(options = {}) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const explicit = typeof options.baseUrl === 'string' && options.baseUrl.length > 0
    ? options.baseUrl.replace(/\/+$/, '')
    : undefined;

  const confirm = async (base, deadline) => {
    const response = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(deadline) });
    if (!response.ok) return undefined;
    const health = await response.json().catch(() => ({}));
    // The daemon answers with `ok`; the desktop renderer serves HTML on its own
    // port, so requiring the JSON shape keeps the two apart.
    return health?.ok === true ? health : undefined;
  };

  if (explicit) {
    try {
      const health = await confirm(explicit, timeoutMs);
      if (health !== undefined) return { baseUrl: explicit, health, discoveredBy: 'config', busy: false };
    } catch {
      /* fall through to discovery */
    }
  }

  const owned = await ownedPorts();
  const extra = Array.isArray(options.ports) ? options.ports : [];
  const ports = [...new Set([...owned, ...extra, ...DEFAULT_PORTS])];
  const candidates = ports.map((port) => ({ base: `http://127.0.0.1:${port}`, port }));

  const failures = [];
  let busyCandidate;
  for (const { base, port } of candidates) {
    try {
      const health = await confirm(base, timeoutMs);
      if (health !== undefined) {
        return {
          baseUrl: base,
          health,
          discoveredBy: owned.includes(port) ? 'process-ports' : 'default-ports',
          busy: false,
        };
      }
      failures.push(`${base} -> not the daemon`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${base} -> ${message}`);
      // A timeout on a port Open Design owns means "busy", not "absent".
      if (!owned.includes(port)) continue;
      if (!busyCandidate && await portAccepts(port, 2_000)) {
        busyCandidate = { base, port };
      }
    }
  }

  if (busyCandidate !== undefined) {
    // One slower retry: the turn may have finished while we probed.
    const health = await confirm(busyCandidate.base, 20_000).catch(() => undefined);
    return {
      baseUrl: busyCandidate.base,
      health: health ?? { ok: true, busy: true },
      discoveredBy: 'process-ports',
      busy: true,
    };
  }

  // Distinguish "the app is not running" from "the app is running but its
  // daemon has died" — the remedies differ, and a single "not reachable" sends
  // the user looking in the wrong place.
  const appRunning = (await ownedPorts()).length > 0;
  throw new OdError(
    appRunning
      ? `Open Design is running but its daemon is not answering on any port (tried: ${failures.join('; ') || '(no candidates)'}). Restart the Open Design app; the bridge reconnects automatically.`
      : `Open Design daemon is not reachable. Tried: ${failures.join('; ') || '(no candidates)'}. Start the Open Design app, or set baseUrl in this plugin's config.`,
    appRunning ? 'daemon-down' : 'daemon-unreachable',
    { failures, appRunning },
  );
}

/**
 * HTTP client for one confirmed daemon base URL.
 */
export class OdClient {
  /**
   * @param options - base URL, fetch override, per-call timeout, and an optional
   *   rediscovery hook (see {@link OdClient#request}).
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8620').replace(/\/+$/, '');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /**
     * Optional `async () => string | undefined`. Open Design binds a fresh port
     * on every launch, so a base URL captured once goes stale as soon as the app
     * restarts. When a request fails at the transport layer, this hook is asked
     * for a newly discovered base URL and the request is retried exactly once
     * against it. Without this, the first tool call after a restart would fail
     * for the whole life of the connection object.
     */
    this.rediscover = options.rediscover;
    this.capabilities = undefined;
  }

  /**
   * Perform one JSON call. Non-2xx responses become OdError carrying the
   * daemon's own error code, which is what makes route-level drift legible.
   *
   * Transport failures (the port moved, the daemon restarted) trigger one
   * rediscovery-and-retry, so a cached client survives an Open Design restart.
   *
   * @param method - HTTP verb.
   * @param route - path built from `ROUTES`, including any query string.
   * @param body - optional JSON body.
   * @param timeoutMs - per-call override.
   * @param extraHeaders - additional request headers.
   */
  async request(method, route, body = undefined, timeoutMs = this.timeoutMs, extraHeaders = undefined) {
    /** One attempt; the abort signal must be fresh per try, not shared. */
    const attempt = async () => {
      const init = {
        method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', ...(extraHeaders ?? {}) },
      };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      return await this.fetch(`${this.baseUrl}${route}`, init);
    };

    let response;
    try {
      response = await attempt();
    } catch (error) {
      const moved = await this.reconnect().catch(() => undefined);
      if (moved === undefined) {
        throw new OdError(
          `Open Design call ${method} ${route} failed in transport: ${error instanceof Error ? error.message : String(error)}`,
          'transport-failed',
          { route },
        );
      }
      try {
        response = await attempt();
      } catch (retryError) {
        throw new OdError(
          `Open Design call ${method} ${route} failed in transport after rediscovering ${this.baseUrl}: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          'transport-failed',
          { route, baseUrl: this.baseUrl },
        );
      }
    }
    const text = await response.text();
    let payload;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text.slice(0, 2_000) };
      }
    }
    if (!response.ok) {
      const code = payload?.error?.code ?? `http-${response.status}`;
      const message = payload?.error?.message ?? `${method} ${route} -> HTTP ${response.status}`;
      throw new OdError(String(message), String(code), {
        route,
        status: response.status,
        payload,
        reason: payload?.error?.details?.reason,
      });
    }
    return payload ?? {};
  }

  /**
   * Ask the discovery hook for the daemon's current location and adopt it.
   *
   * @returns the new base URL, or undefined when rediscovery is unavailable.
   */
  async reconnect() {
    if (typeof this.rediscover !== 'function') return undefined;
    const found = await this.rediscover();
    if (typeof found !== 'string' || found.length === 0) return undefined;
    this.baseUrl = found.replace(/\/+$/, '');
    return this.baseUrl;
  }

  /** Read the daemon version and capability block. */
  async version() {
    return await this.request('GET', ROUTES.version[1], undefined, 10_000);
  }

  /**
   * Feature-detect every route this bridge depends on and report gaps by name.
   *
   * @returns a capability report with per-feature state and a `degraded` list.
   */
  async probe() {
    const features = {};
    const checks = [
      ['health', ...ROUTES.health, undefined, 10_000],
      ['version', ...ROUTES.version, undefined, 10_000],
      ['agents', ...ROUTES.agents, undefined, 60_000],
      ['appConfig', ...ROUTES.appConfig, undefined, 30_000],
      ['projects', ...ROUTES.projects, undefined, 30_000],
    ];
    for (const [feature, method, route, , timeout] of checks) {
      try {
        await this.request(method, route, undefined, timeout);
        features[feature] = { ok: true };
      } catch (error) {
        features[feature] = {
          ok: false,
          code: error instanceof OdError ? error.code : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const versionPayload = features.version?.ok ? await this.version().catch(() => undefined) : undefined;
    const report = {
      baseUrl: this.baseUrl,
      version: versionPayload?.version?.version ?? null,
      channel: versionPayload?.version?.channel ?? null,
      features,
      degraded: Object.entries(features).filter(([, value]) => !value.ok).map(([key]) => key),
    };
    this.capabilities = report;
    return report;
  }

  /** List runtimes Open Design can drive, with their selectable models. */
  async listAgents() {
    const payload = await this.request('GET', ROUTES.agents[1], undefined, 90_000);
    return Array.isArray(payload.agents) ? payload.agents : [];
  }

  /** Read the daemon application config, including per-agent model defaults. */
  async appConfig() {
    const payload = await this.request('GET', ROUTES.appConfig[1], undefined, 30_000);
    return payload?.config ?? {};
  }

  /** List projects. */
  async listProjects() {
    const payload = await this.request('GET', ROUTES.projects[1], undefined, 30_000);
    return Array.isArray(payload.projects) ? payload.projects : [];
  }

  /**
   * Create a project WITHOUT importing a folder.
   *
   * This is the token-free fallback when `importFolder` is unavailable: the
   * project's agent keeps the daemon-owned cwd, and `linkedDirs` only grants it
   * read access to the Team workspace, so consultation works at reduced
   * fidelity. The daemon answers with the created project and, usually, a
   * ready-made conversation id.
   *
   * @param input - id, name, design system, linked directories, instructions.
   */
  async createProject(input) {
    const body = {
      ...(input.id ? { id: input.id } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.designSystemId ? { designSystemId: input.designSystemId } : {}),
      ...(Array.isArray(input.linkedDirs) && input.linkedDirs.length > 0
        ? { linkedDirs: input.linkedDirs }
        : {}),
      ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    };
    return await this.request('POST', ROUTES.createProject[1], body, 60_000);
  }

  /**
   * Read one project plus the directory the daemon resolves for it.
   *
   * @param projectId - Open Design project id.
   */
  async getProject(projectId) {
    return await this.request('GET', fillRoute(ROUTES.project[1], { projectId }), undefined, 30_000);
  }

  /**
   * Import a local directory as a project. This is the supported way to make the
   * project's agent `cwd` that directory; it requires a baseDir-bound desktop
   * import token.
   *
   * @param input - baseDir, name, design system, custom instructions, token.
   */
  async importFolder(input) {
    const body = {
      baseDir: input.baseDir,
      ...(input.name ? { name: input.name } : {}),
      ...(input.designSystemId ? { designSystemId: input.designSystemId } : {}),
      ...(input.skillId ? { skillId: input.skillId } : {}),
    };
    return await this.request(
      'POST',
      ROUTES.importFolder[1],
      body,
      120_000,
      input.token ? { 'x-od-desktop-import-token': input.token } : undefined,
    );
  }

  /**
   * Re-point an existing project at a local directory.
   *
   * @param projectId - project to re-point.
   * @param input - baseDir and the token authorizing it.
   */
  async rebindWorkingDir(projectId, input) {
    return await this.request(
      'POST',
      fillRoute(ROUTES.workingDir[1], { projectId }),
      { baseDir: input.baseDir },
      120_000,
      input.token ? { 'x-od-desktop-import-token': input.token } : undefined,
    );
  }

  /**
   * Update project-level custom instructions, which is how extra standing
   * guidance reaches the Open Design agent (there is no per-run system prompt).
   *
   * @param projectId - project to update.
   * @param customInstructions - instructions, or null to clear.
   */
  async setCustomInstructions(projectId, customInstructions) {
    return await this.request(
      'PATCH',
      fillRoute(ROUTES.project[1], { projectId }),
      { customInstructions },
      30_000,
    );
  }

  /** List a project's conversations. */
  async listConversations(projectId) {
    const payload = await this.request(
      'GET',
      fillRoute(ROUTES.conversations[1], { projectId }),
      undefined,
      30_000,
    );
    return Array.isArray(payload.conversations) ? payload.conversations : [];
  }

  /**
   * Create a conversation: the real chat window a member's Open Design pane shows.
   *
   * @param projectId - owning project.
   * @param input - title, session mode, optional seed source.
   */
  async createConversation(projectId, input = {}) {
    const body = {
      ...(input.title ? { title: input.title } : {}),
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
      ...(input.seedFromConversationId ? { seedFromConversationId: input.seedFromConversationId } : {}),
    };
    return await this.request(
      'POST',
      fillRoute(ROUTES.createConversation[1], { projectId }),
      body,
      60_000,
    );
  }

  /** List one conversation's messages in display order. */
  async listMessages(projectId, conversationId) {
    const payload = await this.request(
      'GET',
      fillRoute(ROUTES.messages[1], { projectId, conversationId }),
      undefined,
      60_000,
    );
    return Array.isArray(payload.messages) ? payload.messages : [];
  }

  /**
   * Write one message into a real conversation. `createOnly` keeps replaying the
   * same message id idempotent.
   *
   * @param projectId - owning project.
   * @param conversationId - target conversation.
   * @param message - role, content, and optional run bookkeeping.
   */
  async putMessage(projectId, conversationId, message) {
    const body = {
      id: message.id,
      role: message.role,
      content: message.content,
      startedAt: message.startedAt,
      endedAt: message.endedAt,
      ...(message.runStatus ? { runStatus: message.runStatus } : {}),
      ...(message.runId ? { runId: message.runId } : {}),
      ...(message.createOnly ? { createOnly: true } : {}),
    };
    const payload = await this.request(
      'PUT',
      fillRoute(ROUTES.putMessage[1], { projectId, conversationId, messageId: message.id }),
      body,
      60_000,
    );
    return payload?.message ?? payload;
  }

  /**
   * Start one agent turn inside a conversation.
   *
   * Note the daemon's actual field names: the model is the top-level `model`
   * id, and the reasoning tier is `reasoning` (not `reasoningEffort`). There is
   * deliberately no per-run system prompt; standing guidance goes on the project.
   *
   * `x-od-client: desktop` is what makes Open Design present the run as a
   * desktop-client turn. The daemon resolves the run's client type from that
   * header and falls back to a user-agent sniff (`Electron/` → desktop), so this
   * bridge — a plain Node process — was otherwise filed as a `web` client. A
   * `web` turn runs correctly but is not the turn the desktop window is showing,
   * which is why the conversation did not appear in the Open Design UI.
   *
   * @param input - project, conversation, agent, model, reasoning, and prompt.
   */
  async createRun(input) {
    const body = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      message: input.message,
      ...(input.model && input.model !== 'default' ? { model: input.model } : {}),
      ...(typeof input.reasoning === 'string' && input.reasoning.length > 0 ? { reasoning: input.reasoning } : {}),
      ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
    };
    return await this.request(
      'POST',
      ROUTES.createRun[1],
      body,
      120_000,
      { 'x-od-client': 'desktop' },
    );
  }

  /** Read one run's status and terminal fields. */
  async getRun(runId) {
    return await this.request('GET', fillRoute(ROUTES.run[1], { runId }), undefined, 60_000);
  }

  /** Cancel one run, tolerating an already-terminal run. */
  async cancelRun(runId) {
    try {
      return await this.request('POST', fillRoute(ROUTES.cancelRun[1], { runId }), {}, 30_000);
    } catch (error) {
      if (error instanceof OdError && error.details?.status === 409) {
        return { ok: false, alreadyTerminal: true };
      }
      throw error;
    }
  }

  /**
   * Steer a run that is still mid-turn, which is how a correction reaches an
   * agent that has not finished.
   *
   * @param runId - live run.
   * @param text - correction text.
   */
  async steerRun(runId, text) {
    return await this.request('POST', fillRoute(ROUTES.steerRun[1], { runId }), { text }, 30_000);
  }
}

/**
 * Whether one run payload is terminal. Tolerant by construction: an unknown
 * status carrying a terminal timestamp also counts as settled. Never judge a run
 * by `code`/`exitCode` — a successful run can still report a nonzero code.
 *
 * @param run - run payload from GET /api/runs/:id.
 */
export function isTerminalRun(run) {
  if (!run || typeof run !== 'object') return false;
  if (typeof run.status === 'string' && TERMINAL_RUN_STATUSES.has(run.status)) return true;
  return typeof run.terminalAt === 'number';
}

/**
 * Poll one run to its terminal state, then resolve ONLY that turn's final
 * assistant text.
 *
 * This is the contract the product requires: intermediate streamed frames
 * (`text_delta`, diagnostics, tool chatter) are never surfaced or accumulated.
 * The final text is read once, from the assistant message the daemon recorded
 * for this exact run, keyed by `assistantMessageId` so concurrent or retried
 * runs cannot cross wires.
 *
 * Running out of WAIT budget is reported, not enforced: the returned value then
 * carries `stillRunning: true` plus the coordinates needed to collect the answer
 * later. Cancelling the run at that point would throw away the work in progress,
 * which is the one thing a caller waiting for a long design turn must not lose.
 *
 * @param client - client for the confirmed daemon.
 * @param runId - run to await.
 * @param options - conversation coordinates, poll cadence, and cancellation.
 * @returns terminal run plus the single final assistant text, or a
 *   `stillRunning` marker when the wait budget expired first.
 */
export async function awaitRun(client, runId, options = {}) {
  const pollMs = options.pollMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const signal = options.signal;
  const startedAt = Date.now();
  let run;
  for (;;) {
    // Only an explicit cancellation stops the run itself. A wait budget running
    // out is NOT a cancellation: at that moment Open Design is still working, so
    // killing it would discard exactly the output the caller is waiting for.
    // It is handed back as `stillRunning` with the run id instead, so the caller
    // regains control and can re-attach later. Measured failure from conflating
    // the two: a timed-out turn left its run executing for another 25 minutes
    // with 11 MB of events, writing into the workspace, while the caller had been
    // told the call failed.
    if (signal?.aborted) {
      await client.cancelRun(runId).catch(() => undefined);
      throw new OdError('waiting for the Open Design turn was cancelled', 'cancelled', { runId });
    }
    run = await client.getRun(runId);
    if (isTerminalRun(run)) break;
    if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
      return {
        runId,
        status: typeof run?.status === 'string' ? run.status : 'running',
        ok: false,
        stillRunning: true,
        text: '',
        questionForm: null,
        assistantMessageId: run?.assistantMessageId ?? null,
        projectId: run?.projectId ?? null,
        conversationId: run?.conversationId ?? null,
        error: null,
        errorCode: null,
        retryable: true,
        waitedMs: Date.now() - startedAt,
        startedAt,
        settledAt: Date.now(),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  let assistantMessage;
  if (run?.projectId && run?.conversationId) {
    const messages = await client.listMessages(run.projectId, run.conversationId);
    const exact = run.assistantMessageId
      ? messages.find((message) => message?.id === run.assistantMessageId)
      : undefined;
    assistantMessage = exact
      ?? [...messages].reverse().find(
        (message) => message?.role === 'assistant'
          && typeof message?.content === 'string'
          && message.content.length > 0,
      );
  }

  const rawText = typeof assistantMessage?.content === 'string' ? assistantMessage.content : '';
  const parsed = splitQuestionForm(rawText);
  return {
    runId,
    status: run?.status ?? null,
    ok: run?.status === 'succeeded' || (rawText.length > 0 && !run?.error),
    stillRunning: false,
    // Only the prose is the answer. A form is a question, not a reply, so the
    // caller never quotes markup back as if Open Design had answered.
    text: parsed.prose,
    questionForm: parsed.form,
    assistantMessageId: assistantMessage?.id ?? null,
    projectId: run?.projectId ?? null,
    conversationId: run?.conversationId ?? null,
    error: typeof run?.error === 'string' ? run.error : null,
    errorCode: typeof run?.errorCode === 'string' ? run.errorCode : null,
    retryable: run?.retryable === true,
    startedAt,
    settledAt: Date.now(),
  };
}

/**
 * Split one Open Design assistant message into prose and an optional
 * `<question-form>` block.
 *
 * Open Design's designer prompt tells the model to emit a `<question-form>`
 * block and stop, so the host can render a Questions UI and send the choice back
 * as a `[form answers — id]` message. That protocol is plain assistant text, not
 * a tool call — which is exactly why a stdio-driven Harness run can appear to
 * "hang": the turn SUCCEEDS, leaving markup nobody rendered as its answer.
 * Recognizing the block here is what turns it into a question the Lead can
 * actually answer instead of a wall of tags.
 *
 * @param text - the assistant message content.
 * @returns prose without the block, plus the parsed form when present.
 */
export function splitQuestionForm(text) {
  if (typeof text !== 'string' || !text.includes('<question-form')) {
    return { prose: typeof text === 'string' ? text : '', form: null };
  }
  const match = /<question-form([^>]*)>([\s\S]*?)<\/question-form>/i.exec(text);
  if (!match) {
    // An unterminated block still means "this turn is a question".
    return { prose: text.replace(/<question-form[\s\S]*$/i, '').trim(), form: null };
  }
  const attributes = match[1] ?? '';
  const idMatch = /\bid\s*=\s*"([^"]*)"/i.exec(attributes);
  const titleMatch = /\btitle\s*=\s*"([^"]*)"/i.exec(attributes);
  let body = null;
  let parseError;
  try {
    body = JSON.parse(match[2].trim());
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const prose = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  // Open Design usually carries the title (and sometimes the id) inside the JSON
  // body rather than on the opening tag, so read both places before falling back.
  const bodyId = typeof body?.id === 'string' && body.id.length > 0 ? body.id : undefined;
  const bodyTitle = typeof body?.title === 'string' && body.title.length > 0 ? body.title : undefined;
  return {
    prose,
    form: {
      id: idMatch?.[1] ?? bodyId ?? 'form',
      title: titleMatch?.[1] ?? bodyTitle ?? null,
      questions: collectQuestions(body),
      ...(parseError ? { parseError } : {}),
      raw: match[0],
    },
  };
}

/**
 * Normalize the several question shapes Open Design actually emits.
 *
 * Observed variants for the JSON inside `<question-form>`:
 *   - `{ title, questions: [...] }`   — the documented discovery form;
 *   - one bare question object        — a single-question form;
 *   - a bare array of questions.
 * Accepting all three keeps a protocol tidy-up on either side from silently
 * dropping the very questions the Lead needs to answer.
 *
 * @param body - parsed JSON body, of any of those shapes.
 * @returns the question list, always an array.
 */
function collectQuestions(body) {
  if (Array.isArray(body)) return body.filter((entry) => entry && typeof entry === 'object');
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.questions)) {
    return body.questions.filter((entry) => entry && typeof entry === 'object');
  }
  // A bare question carries its own prompt/options rather than a questions list.
  const looksLikeQuestion = typeof body.label === 'string'
    || typeof body.question === 'string'
    || Array.isArray(body.options);
  return looksLikeQuestion ? [body] : [];
}

/**
 * Render one parsed question form as compact text a Team member can act on.
 *
 * @param form - the parsed form.
 * @param indent - prefix for nested lines.
 */
export function renderQuestionForm(form, indent = '') {
  const lines = [];
  const heading = form.title ?? form.id;
  lines.push(`${indent}[Open Design is asking: ${heading}]`);
  form.questions.forEach((question, index) => {
    const label = question?.label ?? question?.id ?? `question ${index + 1}`;
    const type = question?.type ?? 'text';
    const required = question?.required === true ? ' (required)' : '';
    lines.push(`${indent}${index + 1}. ${label} — ${type}${required} [id: ${question?.id ?? `q${index + 1}`}]`);
    const options = Array.isArray(question?.options) ? question.options : [];
    for (const option of options) {
      if (typeof option === 'string') {
        lines.push(`${indent}   - ${option}`);
      } else {
        const value = option?.value ?? option?.label;
        const description = option?.description ? ` — ${option.description}` : '';
        lines.push(`${indent}   - ${option?.label ?? value} [value: ${value}]${description}`);
      }
    }
    if (typeof question?.placeholder === 'string' && question.placeholder.length > 0) {
      lines.push(`${indent}   placeholder: ${question.placeholder}`);
    }
  });
  lines.push(`${indent}Answer by passing answers to opendesign_ask (form_id and answers), or tell Open Design to proceed with its defaults.`);
  return lines.join('\n');
}

/**
 * Compose the reply Open Design expects for one submitted form.
 *
 * The designer prompt treats a message starting with `[form answers — <id>]` as
 * authoritative and forbids re-asking, so this exact header is what makes an
 * answered form stick.
 *
 * @param formId - the form's id attribute.
 * @param answers - ordered answer lines, e.g. `humor: human-rider`.
 */
export function composeFormAnswers(formId, answers) {
  const id = typeof formId === 'string' && formId.length > 0 ? formId : 'form';
  const lines = [`[form answers — ${id}]`];
  for (const answer of answers) {
    const label = typeof answer?.label === 'string' && answer.label.length > 0
      ? answer.label
      : (answer?.id ?? 'answer');
    const value = Array.isArray(answer?.value)
      ? answer.value.join(', ')
      : (answer?.value ?? '');
    lines.push(`- ${label}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * Whether one run was started by this bridge, judged from the run record itself.
 *
 * The authoritative marker is `clientRequestId`: this bridge always submits a
 * `dsh-…` id, while a turn the human starts in the Open Design window carries a
 * plain UUID. That makes the distinction reconstructable at any time, including
 * for runs created before the bridge started recording them — a list of known
 * ids alone would misreport every older turn as a new arrival.
 *
 * Results are memoised for the duration of one read so a conversation with many
 * replies costs one request per distinct run.
 *
 * @param client - client for the confirmed daemon.
 * @param cache - per-read memo of runId → boolean.
 */
function bridgeRunProbe(client, cache) {
  return async (runId) => {
    if (typeof runId !== 'string' || runId.length === 0) return false;
    if (cache.has(runId)) return cache.get(runId);
    let owned = false;
    try {
      const run = await client.getRun(runId);
      owned = typeof run?.clientRequestId === 'string' && run.clientRequestId.startsWith('dsh-');
    } catch {
      // Unreadable run: treat it as NOT ours, so a human-started reply is never
      // silently dropped. A duplicate is a smaller failure than a lost message.
      owned = false;
    }
    cache.set(runId, owned);
    return owned;
  };
}

/**
 * Read what arrived in one member's Open Design conversation since it was last
 * consumed.
 *
 * This is the inbound half of the two-way bridge, and it carries TWO different
 * kinds of arrival, kept apart on purpose:
 *
 *   1. `messages` — what the HUMAN typed in the Open Design window. Ordinary
 *      team input. Messages this bridge itself submitted carry a `[name (DSH
 *      role)]` prefix and are filtered out, so a member never reads its own
 *      outbound prompt back as if a human had said it.
 *
 *   2. `odReplies` — what Open Design ITSELF answered, when that answer was not
 *      produced by this bridge. The human can pause, correct, or redirect the
 *      conversation from the Open Design window; Open Design then runs a turn and
 *      writes an assistant message that no `opendesign_ask` call ever returned.
 *      Without this, a member sees the human's two-word instruction ("暂停") and
 *      nothing else — it never learns that Open Design actually reported back.
 *      Answers to this bridge's own runs are excluded, because `opendesign_ask`
 *      already returned them and repeating them would read as a new arrival.
 *
 * @param client - client for the confirmed daemon.
 * @param input - project, conversation, the member's cursor, its own name, and
 *   the run ids this bridge created on its behalf.
 * @returns unread human messages, unread Open Design replies, and the cursor to
 *   persist.
 */
export async function readInbound(client, input) {
  const messages = await client.listMessages(input.projectId, input.conversationId);
  const cursorId = typeof input.cursorId === 'string' ? input.cursorId : undefined;
  const cursorAt = typeof input.cursorAt === 'number' ? input.cursorAt : undefined;
  const remembered = new Set(Array.isArray(input.bridgeRuns) ? input.bridgeRuns : []);
  const cache = new Map();
  const fromBridge = bridgeRunProbe(client, cache);

  // Prefer the cursor's exact position. When it has vanished (the conversation
  // was forked, cleared, or the store was reset) fall back to its timestamp:
  // redelivering a member's whole history as if the human had just typed it is
  // the one failure mode worth engineering against.
  let start = 0;
  if (cursorId !== undefined) {
    const at = messages.findIndex((message) => message?.id === cursorId);
    if (at >= 0) {
      start = at + 1;
    } else if (cursorAt !== undefined) {
      const firstNewer = messages.findIndex(
        (message) => typeof message?.createdAt === 'number' && message.createdAt > cursorAt,
      );
      start = firstNewer >= 0 ? firstNewer : messages.length;
    }
  }

  const selfPrefix = new RegExp(`^\\[${escapeRegExp(input.memberName)} \\(DSH `);
  const fresh = [];
  const replies = [];
  const unread = messages.slice(start);
  for (let index = 0; index < unread.length; index += 1) {
    const message = unread[index];
    const content = typeof message?.content === 'string' ? message.content.trim() : '';
    if (content.length === 0) continue;

    if (message?.role === 'assistant') {
      // A run that has not finished has not answered yet; reporting its empty
      // or partial text would read as a reply that never happened.
      if (typeof message.runStatus === 'string'
        && message.runStatus !== 'succeeded'
        && message.runStatus !== 'failed') continue;
      // An answer this bridge already delivered is not an arrival. Three signals,
      // strongest first: the recorded list (fast), the run's own submitter id
      // (durable, and the only one that works for runs older than the record),
      // and the prompt it answered (durable even for runs created before this
      // bridge stamped a submitter id at all — that generation left
      // `clientRequestId` empty, and without this its answers would be replayed
      // as if Open Design had spoken unprompted).
      const runId = typeof message.runId === 'string' ? message.runId : null;
      const prompt = unread[index - 1];
      const answeredOwnPrompt = prompt?.role === 'user'
        && typeof prompt?.content === 'string'
        && selfPrefix.test(prompt.content.trim());
      if (runId !== null && remembered.has(runId)) continue;
      if (answeredOwnPrompt) continue;
      if (runId !== null && await fromBridge(runId)) continue;
      replies.push({
        id: message.id,
        text: content,
        runId,
        runStatus: typeof message.runStatus === 'string' ? message.runStatus : null,
        model: typeof message.agentName === 'string' ? message.agentName : null,
        createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
      });
      continue;
    }

    if (message?.role !== 'user') continue;
    if (selfPrefix.test(content)) continue;
    // Anything still running was not authored by the human waiting on it.
    if (typeof message?.runStatus === 'string' && message.runStatus === 'queued') continue;
    fresh.push({
      id: message.id,
      text: content,
      createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
    });
  }

  const lastSeen = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return {
    messages: fresh,
    odReplies: replies,
    nextCursor: lastSeen && typeof lastSeen.id === 'string'
      ? { id: lastSeen.id, createdAt: typeof lastSeen.createdAt === 'number' ? lastSeen.createdAt : Date.now() }
      : null,
  };
}

/** Escape one literal string for use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
