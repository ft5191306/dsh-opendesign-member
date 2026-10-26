/**
 * Source-level wiring tests for 方案 F's two halves.
 *
 * F is cross-boundary work — a browser tab, a Host route, and a discovery
 * function — and neither half is reachable from a unit test (the client runs in
 * the page; the route needs a Cordis connection service). What IS testable is
 * the set of properties whose absence would make the feature quietly wrong, so
 * these assertions pin exactly those:
 *
 *   - the tab type and its body register under the same key, or the tab would
 *     render the owner's "nothing can view this" notice;
 *   - the iframe is rendered only when the Host proved the page is embeddable,
 *     otherwise a reason is shown — no silent blank frame;
 *   - the panel route is read-only: looking at a panel must never provision a
 *     project, conversation, or run (the "write-only field" failure this
 *     project keeps guarding against);
 *   - the panel route is GET-only and rides the authenticated connection Fetch
 *     channel, matching the settings route's security rationale.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const client = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const index = await readFile(new URL('../index.js', import.meta.url), 'utf8');

/** Slice one function/const body by a stable start marker and the next marker. */
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

/** Assert `source` contains `needle`, naming the property being pinned. */
function contains(source, needle, why) {
  assert.equal(source.includes(needle), true, `expected source to contain ${needle} (${why})`);
}

test('F client: registers a right-bar tab type whose body key matches its id', () => {
  // The registry identity and the seat key must be the SAME string: the tab is
  // dispatched by the type id, and a body registered under any other key would
  // leave the pane empty.
  contains(client, "const TAB_KIND = 'opendesign'", 'the tab kind is declared once');
  contains(client, 'const TAB_ID = PACKAGE_NAME', 'the type id is the package name');

  const register = slice(client, 'tabs.register({', "}), 'opendesign-member: right-bar tab type'");
  contains(register, 'id: TAB_ID,', 'type registration uses TAB_ID');
  contains(register, 'kind: TAB_KIND,', 'type registration uses TAB_KIND');
  contains(register, "title: () => t('tab.title')", 'the chip title comes from the locale service');
  contains(register, 'guide: [{', 'a guide entry is how a human opens the tab');
  contains(register, 'order: 40,', 'guide entries are ordered explicitly');

  const body = slice(client, "name: 'sidebar.right.pane.tab',", "'opendesign-member: right-bar tab body'");
  contains(body, 'key: TAB_ID,', 'the body registers under the SAME key the type dispatches');
  contains(body, 'h(PanelBody, { ...props, t })', 'the body component receives the translate function');
});

test('F client: the tab registers through an optional capability, not a hard dependency', () => {
  // A composition without the right Sidebar must cost the panel, never the whole
  // browser half (the plugin detail page keeps working).
  contains(client, "ctx.inject(['sidebarRight', 'sidebarRightTabs']", 'the tab is registered behind a conditional inject');
  contains(client, "typeof tabs?.register !== 'function'", 'a missing registry is tolerated');
  // And the Settings-page button has to explain a refusal rather than do nothing.
  contains(client, "typeof sidebarRight?.openTab !== 'function'", 'openPanel checks the controller');
  contains(client, "return t('panel.unavailable')", 'openPanel returns a visible reason');
});

test('F client: an iframe is rendered only when the Host proved embeddability', () => {
  contains(
    client,
    'if (src === undefined || value.web?.embeddable !== true)',
    'the blank-frame guard is the honesty contract of this feature',
  );
  contains(client, 'value.web.reason', 'the Host reason reaches the user');
  contains(client, "t('panel.bridgeHint')", 'the fallback says the bridge still works');
  contains(client, "h('iframe', {", 'the embeddable path actually renders an iframe');
  contains(client, 'panelFrameStyle', 'the iframe fills the pane');
  contains(client, 'setInterval(() => { void load(false); }, 2_000)', 'a short poll auto-retries and picks up Host revisions');
});

test('F client: the sidebar refreshes itself when the background watcher sees activity', () => {
  // Requirement: "后台监视到 od 有动作时自动刷新侧边栏". The Host bumps a revision
  // counter from the watcher's real change events; the panel reloads its frame
  // when that counter moves. No manual click, and no Open Design poll from the
  // browser itself.
  contains(client, 'const revisionRef = React.useRef(undefined)', 'the panel remembers the revision it rendered');
  contains(client, 'value.revision !== previousRevision', 'a moved revision triggers a reload');
  contains(client, 'setNonce((current) => current + 1)', 'the reload remounts the frame');
  contains(client, "t('panel.stale')", 'a reused-but-stale web origin is labelled, not hidden');
  contains(client, "t('panel.retrying')", 'a failed read says it retries automatically');

  // Host side: the counter is bumped only from REAL changes — the watcher's
  // changed branch, a newly accepted run, and a successful collect.
  const watcher = slice(index, 'function armWatcher(', '\n  /**\n   * Run one Open Design turn');
  assert.match(watcher, /if \(report\.changed\) \{/, 'the watcher change gate must exist');
  const changedAt = watcher.indexOf('if (report.changed) {');
  const changedBlock = watcher.slice(changedAt, watcher.indexOf('previous = observation;', changedAt));
  assert.match(changedBlock, /bumpPanelRevision\(\)/, 'the watcher must wake the sidebar on a real change');
  contains(index, 'bumpPanelRevision();', 'runs and collects bump the same counter');
});

test('F host: the panel route is GET-only and registered on the authenticated channel', () => {
  const route = slice(index, 'path: PANEL_ROUTE,', "}), 'opendesign-member.panelRoute()'");
  contains(route, "methods: ['GET']", 'the panel route must not accept writes');
  contains(index, "const PANEL_ROUTE = '/api/opendesign-member/panel'", 'the route path is declared once');
  // Same rationale as the settings route: it must ride the authenticated /api
  // channel, not `webServer.register` (which is matched before the auth prefix).
  contains(index, 'function installSettingsRoute()', 'the panel is installed beside the settings route');
});

test('F host: panelSnapshot is read-only — looking at a panel provisions nothing', () => {
  const snapshot = slice(index, 'async function panelSnapshot(', '  /**\n   * Find a run that is still live');
  for (const forbidden of [
    'ensureProject',
    'ensureConversation',
    'createProject',
    'createConversation',
    'createRun',
    'store.setMember',
    'store.setCursor',
    'store.noteTurn',
    'store.flush',
  ]) {
    assert.equal(
      snapshot.includes(forbidden),
      false,
      `panelSnapshot must stay read-only, found "${forbidden}"`,
    );
  }
  // It must still report the member's coordinates, which is the read-only part.
  contains(snapshot, 'store.peekTeam(', 'coordinates come from existing bindings, not a new binding');
  contains(snapshot, 'ctx.agentTeams.tryMembership(', 'the member comes from the calling Session');
});

test('F host: web UI discovery asks the daemon first and honours an explicit override', () => {
  const snapshot = slice(index, 'async function panelSnapshot(', '  /**\n   * Find a run that is still live');
  contains(snapshot, 'discoverWebUiShared(', 'the panel uses the shared discovery function');
  contains(snapshot, 'daemonUrl: daemonBaseUrl', 'the daemon is asked where its own web UI lives');
  contains(index, 'config.webUrl.length > 0 ? { baseUrl: config.webUrl }', 'an explicit webUrl is passed through');

  // The web app reads its initial route from the pathname; the panel must hand
  // the browser a conversation deep link, or the frame always lands on home.
  contains(snapshot, '/projects/${encodeURIComponent(projectId)}', 'the deep link names the project');
  contains(snapshot, 'conversations/${encodeURIComponent(conversationId)}', 'and the conversation when bound');

  // The config field exists in both places a field must exist to be reachable.
  contains(index, "webUrl: '',", 'DEFAULTS declares webUrl');
  contains(index, "webUrl: text('webUrl').trim(),", 'resolveConfig coerces webUrl');
});

test('F host: status and the panel share one discovery result (no independent port hunting)', () => {
  // Requirement: "侧边栏会找不到端口挂掉，让他复用 lead 的 status 工具的结果".
  // One discovery result lives in `lastKnown`; status reports it, the panel
  // reuses it, and a fallback keeps a working frame during a restart.
  contains(index, 'const lastKnown = {', 'the shared last-known coordinates must exist');
  contains(index, 'lastKnown.daemonUrl = found.baseUrl;', 'a confirmed connection feeds the shared state');
  contains(index, 'function rememberWeb(result)', 'web origins are remembered for both callers');
  contains(index, 'lastKnown.web ?? null', 'status reports the shared web result');
  contains(index, 'discoverWebUiShared(', 'status and panel use the same discovery wrapper');
  contains(index, 'daemonBaseUrl = lastKnown.daemonUrl;', 'the panel reuses a proven daemon address on a failed re-discovery');
  contains(index, "stale: true,", 'a reused origin is marked stale rather than presented as fresh');
  contains(index, 'revision: panelRevision,', 'the panel route carries the watcher revision');
});

test('F client: a non-embeddable panel still offers the page as a normal tab', () => {
  // An explanation alone would leave the user stuck; if the origin is known,
  // offer the same page outside the frame.
  contains(client, "t('panel.openExternal')", 'a blocked frame has an escape hatch');
  contains(client, 'window.open(externalUrl,', 'the escape hatch opens the real page');
});

test('F host: discovery reports framing refusals with the header that caused them', async () => {
  const { frameBlocker } = await import('../lib/od-client.js');
  const blocked = frameBlocker(new Headers({ 'x-frame-options': 'DENY' }));
  assert.deepEqual(blocked, { blocked: true, header: 'x-frame-options', value: 'DENY' });
});
