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

import { followRun } from './od-events.js';
import { readTurnActions } from './turn-actions.js';

/**
 * Every daemon endpoint this bridge depends on, in one table.
 * Verify with `opendesign_status` after either client upgrades.
 */
export const ROUTES = {
  health: ['GET', '/api/health'],
  version: ['GET', '/api/version'],
  agents: ['GET', '/api/agents'],
  appConfig: ['GET', '/api/app-config'],
  /**
   * Machine-readable install coordinates. The panel uses its `webBaseUrl` as the
   * AUTHORITATIVE address of the web UI: the web sidecar's port is ephemeral, and
   * the process table alone cannot tell the public UI apart from Open Design's
   * internal Next backend (both are served by one Open Design process).
   */
  mcpInstallInfo: ['GET', '/api/mcp/install-info'],
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
  /**
   * The authoritative answer to "is anything running in this conversation?".
   *
   * `GET /api/runs?conversationId=X&status=active`. The daemon filters on
   * `!TERMINAL_RUN_STATUSES.has(run.status)` server-side, so this is one cheap
   * request replacing a message scan plus up to five per-run lookups. Verified
   * against the live 0.26.1 daemon on 2026-10-26: it answers
   * `{ runs: [], awaitingInputProjectIds: [] }` for an idle conversation and
   * accepts `conversationId` / `projectId` / `status` as query filters.
   */
  runs: ['GET', '/api/runs'],
  /**
   * The run's own event stream (SSE). Present in Open Design 0.26.1; absent, or
   * re-framed, in older versions and behind body-rewriting proxies — which is why
   * `awaitRun` treats it as an optimization and keeps polling as the fallback.
   */
  runEvents: ['GET', '/api/runs/:runId/events'],
  activeRunCount: ['GET', '/api/runs/active-count'],
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

  /**
   * Repair a healthy-but-wrong candidate to the REAL daemon origin.
   *
   * The web sidecar proxies `/api/health`, so `discoverDaemon` can legitimately
   * confirm it as "the daemon" when its port sorts first (measured after an Open
   * Design restart: web 59278 < daemon 59959). Talking through the proxy works,
   * but reporting a web origin as `daemon.baseUrl` confuses every later step, and
   * the panel then treats its own UI origin as excluded. One cheap `/` probe tells
   * the two apart (the daemon answers 404/JSON there, the UI answers HTML), and
   * the daemon's own `install-info` names the real origin.
   */
  const preferRealDaemon = async (base, health) => {
    try {
      const root = await fetchImpl(`${base}/`, {
        signal: AbortSignal.timeout(1_500),
        headers: { accept: 'text/html' },
      });
      const type = String(root.headers?.get?.('content-type') ?? '').toLowerCase();
      await discardBody(root);
      if (!type.includes('text/html')) return { baseUrl: base, health };
      const response = await fetchImpl(`${base}${ROUTES.mcpInstallInfo[1]}`, {
        signal: AbortSignal.timeout(1_500),
        headers: { accept: 'application/json' },
      });
      const payload = response.ok ? await response.json().catch(() => undefined) : undefined;
      await discardBody(response);
      const reported = typeof payload?.daemonUrl === 'string' && payload.daemonUrl.length > 0
        ? payload.daemonUrl.replace(/\/+$/, '')
        : undefined;
      if (reported === undefined || reported === base) return { baseUrl: base, health };
      const inner = await confirm(reported, 2_000);
      return inner === undefined ? { baseUrl: base, health } : { baseUrl: reported, health: inner };
    } catch {
      return { baseUrl: base, health };
    }
  };

  const failures = [];
  let busyCandidate;
  for (const { base, port } of candidates) {
    try {
      const health = await confirm(base, timeoutMs);
      if (health !== undefined) {
        const preferred = await preferRealDaemon(base, health);
        return {
          baseUrl: preferred.baseUrl,
          health: preferred.health,
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
 * How long a confirmed web-UI origin is reused before it is rediscovered.
 *
 * The sidecar's port is ephemeral, exactly like the daemon's, so a restart must
 * heal within a poll or two rather than for the life of the Host process. Kept
 * short on purpose: one failed probe is far cheaper than an iframe pointed at a
 * port that now belongs to something else.
 */
const WEB_UI_CACHE_MS = 15_000;

/** Last confirmed discovery result: `{ at, value }`, or undefined before first use. */
let webUiCache;

/**
 * Decide whether response headers forbid this page from being framed by a
 * DIFFERENT origin. The DSH Web UI runs on its own port, so every Open Design
 * origin is cross-origin to it.
 *
 * Conservative by design: a directive this function cannot prove permissive is
 * reported as blocking. An iframe that silently renders nothing is exactly the
 * "quiet downgrade" this plugin refuses to ship.
 *
 * @param headers - Headers-like object exposing `get(name)`.
 * @returns `{ blocked, header?, value? }`.
 */
export function frameBlocker(headers) {
  const get = (name) => (typeof headers?.get === 'function' ? headers.get(name) : undefined);
  const xfo = get('x-frame-options');
  if (typeof xfo === 'string' && xfo.trim().length > 0) {
    return { blocked: true, header: 'x-frame-options', value: xfo.trim() };
  }
  const csp = get('content-security-policy');
  if (typeof csp === 'string') {
    const directive = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => /^frame-ancestors\s/i.test(part));
    if (directive !== undefined && !directive.split(/\s+/).slice(1).includes('*')) {
      return { blocked: true, header: 'content-security-policy', value: directive };
    }
  }
  return { blocked: false };
}

/** Release an unread response body, so a probe does not pin a socket. */
async function discardBody(response) {
  try {
    await response.body?.cancel?.();
  } catch {
    /* an absent or already-consumed body needs no release */
  }
}

/**
 * Probe one candidate origin for the Open Design WEB app.
 *
 * Two independent discriminators are required, and both are load-bearing:
 *
 *   1. `/` must be an HTML document — the daemon answers 404 there, so a JSON
 *      service is never mistaken for the UI.
 *   2. `/api/health` must be JSON. Open Design ALSO binds an internal Next
 *      backend (a sibling port owned by the same process) that serves the same
 *      HTML shell but answers `/api/*` with HTML instead of proxying the daemon.
 *      Measured on 0.26.1: embedding that port yields a shell whose every API
 *      call fails. Only the real web sidecar proxies the daemon's JSON.
 *
 * @param base - candidate origin, no trailing slash.
 * @param fetchImpl - fetch implementation.
 * @param timeoutMs - per-request probe deadline.
 * @returns `{ ok: true, frame }` or `{ ok: false, reason }`.
 */
async function probeWebUi(base, fetchImpl, timeoutMs) {
  const page = await fetchImpl(`${base}/`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/html' },
  });
  const pageType = String(page.headers?.get?.('content-type') ?? '').toLowerCase();
  if (!page.ok) {
    await discardBody(page);
    return { ok: false, reason: `GET ${base}/ answered HTTP ${page.status}` };
  }
  if (!pageType.includes('text/html')) {
    await discardBody(page);
    return { ok: false, reason: `GET ${base}/ served "${pageType || 'no content-type'}", not an HTML document` };
  }
  const frame = frameBlocker(page.headers);
  await discardBody(page);

  let api;
  try {
    api = await fetchImpl(`${base}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    return {
      ok: false,
      reason: `${base} serves HTML at / but /api/health could not be read (${error instanceof Error ? error.message : String(error)}); a web UI whose API does not answer is not embeddable`,
    };
  }
  const apiType = String(api.headers?.get?.('content-type') ?? '').toLowerCase();
  const apiJson = api.ok && apiType.includes('application/json');
  await discardBody(api);
  if (!apiJson) {
    return {
      ok: false,
      reason: `${base} serves HTML at / but /api/health is "${apiType || 'no content-type'}", so it is an internal backend rather than the web UI (its API calls would never reach the daemon)`,
    };
  }
  return { ok: true, frame };
}

/**
 * Ask the daemon where its web UI is.
 *
 * `GET /api/mcp/install-info` reports `webBaseUrl`, the one address that cannot
 * be guessed wrong: the sidecar's port is random, and several sibling ports on
 * the same process serve HTML-looking shells. A missing field or a failed call
 * is not fatal — discovery falls back to scanning — but a reported address is
 * still validated before it is trusted.
 *
 * @param daemonUrl - confirmed daemon origin, no trailing slash.
 * @param fetchImpl - fetch implementation.
 * @param timeoutMs - deadline.
 * @returns the reported web origin, or undefined when the daemon does not say.
 */
async function webUiUrlFromInstallInfo(daemonUrl, fetchImpl, timeoutMs) {
  const response = await fetchImpl(`${daemonUrl}/api/mcp/install-info`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    await discardBody(response);
    return undefined;
  }
  const payload = await response.json().catch(() => undefined);
  const reported = typeof payload?.webBaseUrl === 'string' && payload.webBaseUrl.length > 0
    ? payload.webBaseUrl
    : undefined;
  return reported === undefined ? undefined : reported.replace(/\/+$/, '');
}

/** One discovery result for a candidate that served HTML but may block framing. */
function frameVerdict(base, discoveredBy, frame, checkedAt) {
  if (!frame.blocked) {
    return { baseUrl: base, embeddable: true, discoveredBy, checkedAt };
  }
  return {
    baseUrl: base,
    embeddable: false,
    discoveredBy,
    checkedAt,
    reason: `the web UI at ${base} sends ${frame.header}: ${frame.value}, so the browser refuses to frame it`,
    blockedBy: { header: frame.header, value: frame.value },
  };
}

/**
 * Locate the Open Design WEB app (the Next.js sidecar), and decide whether a
 * browser may frame it.
 *
 * Why this exists: the daemon answers JSON only. "The Open Design window" a
 * human sees is an Electron view on the `od://` scheme, which no browser can
 * load. Open Design 0.26.1 also runs a web sidecar that serves the SAME product
 * UI over plain HTTP — that page is the only surface a right-bar iframe can
 * show, so embedding stands or falls on finding it.
 *
 * Discovery order:
 *   1. an explicitly configured origin — validated, never trusted;
 *   2. the address the daemon itself reports (`/api/mcp/install-info` →
 *      `webBaseUrl`) — the only source that knows which of several HTML-looking
 *      ports is the public UI;
 *   3. origins the caller already knows (`candidates`);
 *   4. ports owned by Open Design processes (ephemeral, so scanned each time the
 *      short cache expires), skipping the daemon's own origin.
 *
 * Every path ends in the same two-part validation, so a shell that cannot reach
 * the daemon is reported as a refusal instead of framed as a broken page.
 *
 * @param options - explicit `baseUrl`, `daemonUrl` for install-info, extra
 *   `candidates`, `exclude` origins, fetch/timeout overrides, `now` for tests,
 *   `cache: false` to bypass the TTL.
 * @returns `{ baseUrl?, embeddable, reason?, discoveredBy?, blockedBy?, checkedAt }`.
 */
export async function discoverWebUi(options = {}) {
  const now = options.now ?? Date.now();
  const timeoutMs = options.timeoutMs ?? 2_500;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const checkedAt = new Date(now).toISOString();
  const explicit = typeof options.baseUrl === 'string' && options.baseUrl.length > 0
    ? options.baseUrl.replace(/\/+$/, '')
    : undefined;

  // An explicit origin is a deliberate override: report its real state instead
  // of quietly substituting a discovered one, which would make a misconfiguration
  // look like it worked.
  if (explicit !== undefined) {
    try {
      const found = await probeWebUi(explicit, fetchImpl, timeoutMs);
      return found.ok
        ? frameVerdict(explicit, 'config', found.frame, checkedAt)
        : { baseUrl: explicit, embeddable: false, discoveredBy: 'config', reason: found.reason, checkedAt };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        baseUrl: explicit,
        embeddable: false,
        discoveredBy: 'config',
        reason: `the configured webUrl ${explicit} is not reachable: ${detail}`,
        checkedAt,
      };
    }
  }

  if (options.cache !== false) {
    if (webUiCache !== undefined && now - webUiCache.at < WEB_UI_CACHE_MS) return webUiCache.value;
  }

  const normalize = (value) => String(value).replace(/\/+$/, '');
  const daemonUrl = typeof options.daemonUrl === 'string' && options.daemonUrl.length > 0
    ? normalize(options.daemonUrl)
    : undefined;
  const excluded = new Set([
    ...(Array.isArray(options.exclude) ? options.exclude : []),
    ...(typeof options.exclude === 'string' ? [options.exclude] : []),
    ...(daemonUrl === undefined ? [] : [daemonUrl]),
  ].filter((value) => typeof value === 'string' && value.length > 0).map(normalize));

  const failures = [];

  // The daemon's own answer first: it names the one address that cannot be
  // guessed wrong. Validation still applies — a stale report must be reported,
  // not framed.
  //
  // The report is accepted even when it EQUALS `daemonUrl`: the daemon and the
  // web UI can be the same origin on this product (measured: `discoverDaemon`
  // legitimately picks the web sidecar, because it proxies `/api/health`). The
  // exclusion set exists to keep the port SCAN from treating the JSON service as
  // the UI — it must never veto an authoritative `install-info` answer, or a
  // restart where the daemon origin happens to be the web origin makes the
  // sidebar report "no web UI found" forever.
  if (daemonUrl !== undefined) {
    try {
      const reported = await webUiUrlFromInstallInfo(daemonUrl, fetchImpl, Math.min(timeoutMs, 2_000));
      if (reported === undefined) {
        failures.push(`install-info on ${daemonUrl} reported no webBaseUrl`);
      } else {
        const normalized = normalize(reported);
        const found = await probeWebUi(normalized, fetchImpl, timeoutMs);
        if (found.ok) {
          const verdict = frameVerdict(normalized, 'install-info', found.frame, checkedAt);
          if (options.cache !== false) webUiCache = { at: now, value: verdict };
          return verdict;
        }
        failures.push(`install-info reported ${reported}, but ${found.reason}`);
      }
    } catch (error) {
      failures.push(`install-info on ${daemonUrl} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const configured = Array.isArray(options.candidates) ? options.candidates : [];
  const extra = Array.isArray(options.ports) ? options.ports.map((port) => `http://127.0.0.1:${port}`) : [];
  // A caller that names candidates is treated as authoritative for this probe:
  // that keeps a test (or a caller that already knows the port) from scanning
  // the process table for an answer it does not need.
  const owned = configured.length > 0 || extra.length > 0 ? [] : await ownedPorts().catch(() => []);
  const discovered = owned.map((port) => `http://127.0.0.1:${port}`);
  const targets = [...new Set([...configured, ...extra, ...discovered].map(normalize))]
    .filter((base) => !excluded.has(base));

  for (const base of targets) {
    try {
      const found = await probeWebUi(base, fetchImpl, Math.min(timeoutMs, 1_500));
      if (!found.ok) {
        failures.push(found.reason);
        continue;
      }
      const verdict = frameVerdict(base, owned.includes(Number(new URL(base).port)) ? 'process-ports' : 'candidate', found.frame, checkedAt);
      if (options.cache !== false) webUiCache = { at: now, value: verdict };
      return verdict;
    } catch (error) {
      failures.push(`${base} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const value = {
    baseUrl: null,
    embeddable: false,
    checkedAt,
    reason: failures.length > 0
      ? `no usable Open Design web UI was found (candidates: ${targets.join(', ') || 'none'}; ${failures.join('; ')}). The web sidecar may not be running — the daemon cannot serve the UI by itself.`
      : 'no Open Design process is listening on a port this Host can see, so the web UI cannot be located; start Open Design, or set webUrl in this plugin\'s config',
    candidates: targets,
  };
  if (options.cache !== false) webUiCache = { at: now, value };
  return value;
}

/** Forget the cached web-UI origin; the next discovery probes again. */
export function resetWebUiCache() {
  webUiCache = undefined;
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
   * Two options exist because the checks are not equally priced, and a caller
   * that only wants "is the daemon there, and how busy is it" must not pay for a
   * model enumeration:
   *   - `skip` omits named checks entirely. A skipped feature reports
   *     `{ ok: null, skipped: true }` and is NOT counted as degraded, because
   *     "not asked" is not "broken".
   *   - `capture` keeps the response payload of named checks in
   *     `features[name].value`, so a caller reading a value does not issue the
   *     same request a second time.
   *
   * `agents` is the expensive one: Open Design re-probes every runtime on each
   * call with no server-side cache, measured at 9–11 s on this host against a
   * 60 KB response. Anything that ALSO enumerates models — `listAgents`, or a
   * catalogue refresh — must `skip: ['agents']`, or the same 60 KB gets fetched
   * twice and the second fetch doubles an already slow call.
   *
   * @param options - `skip` and `capture` feature-name lists.
   * @returns a capability report with per-feature state and a `degraded` list.
   */
  async probe(options = {}) {
    const skip = new Set(Array.isArray(options.skip) ? options.skip : []);
    const capture = new Set(Array.isArray(options.capture) ? options.capture : []);
    const features = {};
    const checks = [
      ['health', ...ROUTES.health, undefined, 10_000],
      ['version', ...ROUTES.version, undefined, 10_000],
      ['agents', ...ROUTES.agents, undefined, 60_000],
      ['appConfig', ...ROUTES.appConfig, undefined, 30_000],
      ['projects', ...ROUTES.projects, undefined, 30_000],
      ['activeRunCount', ...ROUTES.activeRunCount, undefined, 5_000],
    ];
    for (const [feature, method, route, , timeout] of checks) {
      if (skip.has(feature)) {
        features[feature] = { ok: null, skipped: true };
        continue;
      }
      try {
        const payload = await this.request(method, route, undefined, timeout);
        // `version` is always kept: the report below is built from its body, and
        // asking for it again after this loop is the duplicate-fetch bug this
        // method exists to avoid.
        features[feature] = capture.has(feature) || feature === 'version'
          ? { ok: true, value: payload }
          : { ok: true };
      } catch (error) {
        features[feature] = {
          ok: false,
          code: error instanceof OdError ? error.code : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    // Read from the check that already ran, rather than asking `/api/version` a
    // second time for the same body.
    const versionPayload = features.version?.ok === true ? features.version.value : undefined;
    const report = {
      baseUrl: this.baseUrl,
      version: versionPayload?.version?.version ?? null,
      channel: versionPayload?.version?.channel ?? null,
      features,
      // Only a check that ran and failed counts. Skipped is unknown, not broken.
      degraded: Object.entries(features)
        .filter(([, value]) => value.ok === false)
        .map(([key]) => key),
    };
    this.capabilities = report;
    return report;
  }

  /** List runtimes Open Design can drive, with their selectable models. */
  async listAgents() {
    const payload = await this.request('GET', ROUTES.agents[1], undefined, 90_000);
    return Array.isArray(payload.agents) ? payload.agents : [];
  }

  /**
   * How many runs the daemon is executing right now, across every client.
   *
   * The cheapest honest signal that Open Design is working: 2–4 ms, no model
   * enumeration, and it does not depend on this bridge holding any run id. That
   * is what makes it usable to answer "is it actually busy, or did my turn die?"
   *
   * @returns the count, or undefined when the daemon could not answer.
   */
  async activeRunCount() {
    const payload = await this.request('GET', ROUTES.activeRunCount[1], undefined, 5_000)
      .catch(() => undefined);
    return Number.isFinite(payload?.activeRunCount) ? payload.activeRunCount : undefined;
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
   * List runs, filtered by the daemon rather than by this bridge.
   *
   * ⚠️ NOT usable as an observation source for this bridge's own projects.
   * Measured against 0.26.1 on 2026-10-26, with a run genuinely `running`: every
   * filter combination (`conversationId`, `projectId`, both, `workspaceId`)
   * answered `200 {"runs":[]}`, while `GET /api/runs/:id` for that same run
   * answered `running` on every poll. Omitting `projectId` on a Workspace-bound
   * project answers `400 PROJECT_SCOPE_REQUIRED`; adding it only turns that into
   * an empty list. An empty list is indistinguishable from "nothing is running",
   * which is why a watcher built on this route reported nothing for entire tasks.
   *
   * The dependency-free discovery path is therefore the conversation's message
   * rows (`listMessages` → `latestUnfinishedRunId`) confirmed by `getRun`. Keep
   * this method for callers that genuinely want the daemon's list (and for the
   * `409 RUN_IN_PROGRESS` path), but do not decide "is it busy?" from it —
   * `test/authoritative-watch.test.js` pins that.
   *
   * @param filter.conversationId - restrict to one member's conversation.
   * @param filter.projectId - the Team's project; REQUIRED for a bound project.
   * @param filter.status - `'active'` for live runs.
   * @returns the run payloads the daemon reports, or throws.
   */
  async listRuns(filter = {}) {
    const query = new URLSearchParams();
    if (typeof filter.projectId === 'string' && filter.projectId.length > 0) {
      query.set('projectId', filter.projectId);
    }
    if (typeof filter.conversationId === 'string' && filter.conversationId.length > 0) {
      query.set('conversationId', filter.conversationId);
    }
    if (typeof filter.status === 'string' && filter.status.length > 0) {
      query.set('status', filter.status);
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const payload = await this.request('GET', `${ROUTES.runs[1]}${suffix}`, undefined, 30_000);
    return Array.isArray(payload.runs) ? payload.runs : [];
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
      // Consume an EXISTING user message row instead of letting the daemon seed a
      // new one. Verified against the live daemon: with `userMessageId` the run
      // adopts that row (its content is overwritten with `message`), so the
      // conversation holds one copy of the sentence rather than an inserted copy
      // plus the prompt that repeats it.
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
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
 * Read the run record once after a stream timeout, bounded, so the `stillRunning`
 * answer can still carry `projectId` / `conversationId` / `assistantMessageId`.
 *
 * Bounded on purpose. At this point the caller has explicitly stopped waiting,
 * and `GET /api/runs/:id` on a busy single-threaded daemon is the call that
 * measured 9–11 s and gave rise to the "permanent lease" watch defect. A long
 * read here would hand control back later than the caller asked, so it gets a
 * short leash and reports its absence instead of blocking. Failure is never
 * fatal: `runId` is the one coordinate a later `opendesign_ask({ run_id })`
 * truly needs.
 *
 * @param client - client for the confirmed daemon.
 * @param runId - the run that is still going.
 * @param ms - upper bound on the read.
 */
async function readRunBriefly(client, runId, ms = 2_000) {
  let timer;
  try {
    return await Promise.race([
      client.getRun(runId),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Wait for one run by polling `GET /api/runs/:id` once per `pollMs`.
 *
 * This is now the FALLBACK, kept intact because it is the only wait mechanism
 * that works against every Open Design version this bridge supports. It is also
 * the honest answer to "the event stream is not available": same semantics, just
 * one request per second instead of one connection.
 *
 * Two invariants, both measured failures if broken:
 *   - Only an explicit cancellation stops the run itself. A wait budget running
 *     out is NOT a cancellation: at that moment Open Design is still working, so
 *     killing it would discard exactly the output the caller is waiting for.
 *     Measured 2026-10-25: conflating the two left a timed-out turn executing for
 *     another 36 minutes and 12.8 MB of events, with the answer unrecoverable.
 *   - `isTerminalRun` decides settled-ness, never `exitCode`.
 *
 * @param client - client for the confirmed daemon.
 * @param runId - run to await.
 * @param options - poll cadence, absolute deadline, cancellation, and start time.
 * @returns `{ kind: 'settled', run }` or `{ kind: 'timeout', run }`.
 */
async function pollRun(client, runId, options = {}) {
  const pollMs = options.pollMs ?? 1_000;
  const deadlineAt = options.deadlineAt;
  const signal = options.signal;
  for (;;) {
    if (signal?.aborted) {
      await client.cancelRun(runId).catch(() => undefined);
      throw new OdError('waiting for the Open Design turn was cancelled', 'cancelled', { runId });
    }
    const run = await client.getRun(runId);
    if (isTerminalRun(run)) return { kind: 'settled', run };
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) return { kind: 'timeout', run };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Build the `stillRunning` answer: the wait budget expired, the run did not.
 *
 * Every field here is either read from the last known run record or honestly
 * null. `lastEventId` is the improvement over the polling era: the daemon replays
 * from its own journal cursor, so a later re-attach does not have to re-read the
 * conversation's message list to find out where it was.
 *
 * @param input - run id, last known record, start time, and the stream cursor.
 */
function stillRunningResult(input) {
  const run = input.run;
  return {
    runId: input.runId,
    status: typeof run?.status === 'string'
      ? run.status
      : (typeof input.statusFallback === 'string' ? input.statusFallback : 'running'),
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
    waitedMs: Date.now() - input.startedAt,
    startedAt: input.startedAt,
    settledAt: Date.now(),
    /** Resume point for the next `awaitRun`/`followRun`; null when unknown. */
    lastEventId: input.lastEventId ?? null,
    /** Loud list of every reason this wait did not use the plain event stream. */
    degraded: input.degraded ?? [],
  };
}

/**
 * Turn one terminal run record into the product's answer shape.
 *
 * The contract the product requires: intermediate streamed frames (`text_delta`,
 * diagnostics, tool chatter) are never surfaced or accumulated. The final text is
 * read once, from the assistant message the daemon recorded for this exact run,
 * keyed by `assistantMessageId` so concurrent or retried runs cannot cross wires.
 *
 * @param client - client for the confirmed daemon.
 * @param runId - the run that settled.
 * @param input - run record, start time, degradation notes, and stream cursor.
 */
async function settleRun(client, runId, input) {
  const run = input.run;
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
  // What the turn DID, from its own journal. A reply can read as a plan with
  // assumptions while the run has already been editing files — measured
  // 2026-10-26, where a turn whose prose looked like a proposal had called
  // Read/Bash/TodoWrite and the next began a `Write`. Reading the journal makes
  // that an observable fact instead of an inference from the prose.
  const actions = await readTurnActions(run?.eventsLogPath);
  return {
    runId,
    status: run?.status ?? (typeof input.statusFallback === 'string' ? input.statusFallback : null),
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
    startedAt: input.startedAt,
    settledAt: Date.now(),
    // `{ toolCalls, tools, wrote, read }`. Reported only when the journal could be
    // read, so "unknown" never masquerades as "it did nothing".
    actions,
    /** Loud list of every reason this wait did not use the plain event stream. */
    degraded: input.degraded ?? [],
    /** Journal cursor reached, when the wait was driven by the stream. */
    lastEventId: input.lastEventId ?? null,
  };
}

/**
 * Wait for one run to settle, then resolve ONLY that turn's final assistant text.
 *
 * Two transports, in this order, and the difference between them is the whole
 * point of this function:
 *
 *   1. `GET /api/runs/:id/events` (SSE) — one long connection that pushes frames
 *      and ends with a terminal `end` event. Against Open Design 0.26.1 this turns
 *      a default 10-minute turn from ~600 `GET /api/runs/:id` requests into one
 *      connection. It is an OPTIMIZATION, never a precondition.
 *   2. The polling loop above, used whenever the stream is missing, mis-typed, or
 *      breaks for good. The fallback is LOUD: the returned value carries a
 *      `degraded` array naming the reason. A silent fallback would hide the one
 *      thing that has to be visible — that the daemon (or a proxy) cannot stream —
 *      and SSE-through-proxy truncation is unverified on this host.
 *
 * Running out of WAIT budget aborts the CONNECTION and nothing else. The returned
 * value carries `stillRunning: true`, the run id, and — when the stream was used —
 * `lastEventId`. It never calls `cancelRun`: Open Design is still working, and the
 * answer stays collectable through `opendesign_ask({ run_id })`. Only the caller's
 * own signal may stop the run.
 *
 * The signature is deliberately unchanged: `index.js` and the tests call
 * `awaitRun(client, runId, { pollMs, timeoutMs, signal })`. Two ADDITIVE optional
 * options exist and neither is required:
 *   - `onEvent(record)` — incremental progress (`id`/`event`/`data`); the answer is
 *     still read once from the settled record, never accumulated from frames.
 *   - `projectId` / `conversationId` — used only if the run record cannot be read
 *     after a confirmed `end`, so the answer remains collectable from the
 *     coordinates the caller already holds.
 *
 * @param client - client for the confirmed daemon.
 * @param runId - run to await.
 * @param options - poll cadence, wait budget, cancellation, and optional progress hook.
 * @returns terminal run plus the single final assistant text, or a
 *   `stillRunning` marker when the wait budget expired first.
 */
export async function awaitRun(client, runId, options = {}) {
  const pollMs = options.pollMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  const signal = options.signal;
  const startedAt = Date.now();
  // `0` and negatives mean "no deadline", not "fail now" — the previous loop's
  // semantics, pinned by a test and relied on by `opendesign_ask` callers that
  // want to wait for a long turn without a ceiling.
  const deadlineAt = timeoutMs > 0 ? startedAt + timeoutMs : undefined;

  // ── 1) the event stream ─────────────────────────────────────────────────────
  const stream = await followRun(client, runId, {
    path: fillRoute(ROUTES.runEvents[1], { runId }),
    deadlineAt,
    signal,
    onEvent: options.onEvent,
  });
  const degraded = Array.isArray(stream.degraded) ? [...stream.degraded] : [];

  if (stream.kind === 'cancelled') {
    // The caller's own abort. This is the ONLY branch allowed to stop the run.
    await client.cancelRun(runId).catch(() => undefined);
    throw new OdError('waiting for the Open Design turn was cancelled', 'cancelled', { runId });
  }

  if (stream.kind === 'timeout') {
    // The connection was aborted; the RUN was not touched. Read the coordinates
    // on a short leash so the caller can re-attach, and say so if even that read
    // did not come back in time.
    const run = await readRunBriefly(client, runId);
    if (run === undefined) {
      degraded.push(
        'run-events: the run record could not be read after the wait budget expired, so projectId/conversationId are unknown',
      );
    }
    return stillRunningResult({
      runId,
      run,
      startedAt,
      lastEventId: stream.lastEventId,
      statusFallback: stream.status,
      degraded,
    });
  }

  if (stream.kind === 'ended') {
    // `end` carries the verdict (status, retryable, failure fields) but NOT the
    // conversation coordinates or the assistant message id, so one record read
    // still happens — 1 request instead of ~600. Deliberately NOT extracting
    // `endedWithUnfinishedWork` / `failureAction` as the reason for this change:
    // `GET /api/runs/:id` carries them too, so the win here is request count and
    // incremental progress, not new fields.
    let run = await client.getRun(runId).catch(() => undefined);
    if (run === undefined) {
      // The stream proved the run finished, and it is the one moment where losing
      // the answer to a single failed read is worst. Retry once, then fall back to
      // coordinates the caller supplied — enough to read the messages and settle
      // with the status the `end` event already carried.
      run = await client.getRun(runId).catch(() => undefined);
    }
    if (run === undefined && typeof options.projectId === 'string'
      && typeof options.conversationId === 'string') {
      run = {
        projectId: options.projectId,
        conversationId: options.conversationId,
        assistantMessageId: null,
        status: stream.status ?? undefined,
      };
      degraded.push(
        'run-events: the run record could not be read after the end event; settled from the end event plus the coordinates the caller supplied',
      );
    } else if (run === undefined) {
      degraded.push(
        'run-events: the run record could not be read after the end event; the answer text is unavailable',
      );
    }
    return await settleRun(client, runId, {
      run,
      statusFallback: stream.status,
      startedAt,
      degraded,
      lastEventId: stream.lastEventId,
    });
  }

  // ── 2) loud polling fallback ────────────────────────────────────────────────
  // Reached for: no route (old Open Design), a non-`text/event-stream` response
  // (proxy rewrite), a transport failure, or a stream that closed twice without
  // `end`. All four are named in `stream.degraded`; none of them is silent.
  const polled = await pollRun(client, runId, { pollMs, deadlineAt, signal });
  if (polled.kind === 'timeout') {
    return stillRunningResult({
      runId,
      run: polled.run,
      startedAt,
      lastEventId: stream.lastEventId,
      statusFallback: stream.status,
      degraded,
    });
  }
  return await settleRun(client, runId, {
    run: polled.run,
    startedAt,
    degraded,
    lastEventId: stream.lastEventId,
  });
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
