/**
 * Regression tests for `OdClient.probe` — the capability check behind
 * `opendesign_status`.
 *
 * The cost this guards against, measured on this host on 2026-10-25:
 *
 *   `GET /api/agents` takes 9.1–9.5 s and returns 60 KB, because Open Design
 *   re-runs every runtime's model enumeration on each call with no server-side
 *   cache. `opendesign_status` called it twice — once inside `probe()` and once
 *   directly — so one status call cost 19 s. The alignment policy tells every
 *   member to call that tool before UI work, which put nineteen seconds on the
 *   critical path of every task.
 *
 * Four invariants follow:
 *   1. A skipped check issues no request at all.
 *   2. A skipped check is NOT reported as degraded — "not asked" is not "broken".
 *   3. A captured check keeps its body, so the caller does not re-fetch it.
 *   4. The version body is read from the check that already ran, never re-fetched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { OdClient } from '../lib/od-client.js';
import { counting } from './helpers.js';

/**
 * A fake `fetch` that answers the daemon's JSON routes and records every call.
 *
 * @param overrides - per-route handlers, keyed by pathname.
 */
function fakeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init?.method ?? 'GET' });
    const handler = overrides[path];
    // Await the handler: a stubbed route is often a `counting()` wrapper, which
    // is async. Serialising a promise would silently yield `{}` and make a test
    // pass or fail for the wrong reason.
    const body = handler === undefined ? { ok: true } : await handler();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

/**
 * Build a client over the fake transport.
 *
 * @param overrides - per-route handlers.
 */
function client(overrides = {}) {
  const transport = fakeFetch(overrides);
  const od = new OdClient({ baseUrl: 'http://127.0.0.1:9999', fetch: transport.fetchImpl });
  return { od, transport };
}

test('probe: a skipped check issues no request', async () => {
  const { od, transport } = client({
    '/api/version': () => ({ version: { version: '0.26.0', channel: 'stable' } }),
  });

  await od.probe({ skip: ['agents'] });

  assert.equal(transport.calls.filter((call) => call.path === '/api/agents').length, 0);
  // Everything else still runs, so "skip one" does not mean "skip detection".
  assert.ok(transport.calls.some((call) => call.path === '/api/health'));
  assert.ok(transport.calls.some((call) => call.path === '/api/app-config'));
});

test('probe: a skipped check is not degraded', async () => {
  const { od } = client({
    '/api/version': () => ({ version: { version: '0.26.0', channel: 'stable' } }),
  });

  const report = await od.probe({ skip: ['agents'] });

  assert.deepEqual(report.degraded, []);
  assert.equal(report.features.agents.skipped, true);
  assert.equal(report.features.agents.ok, null);
});

test('probe: version is read from the check that already ran, not re-fetched', async () => {
  const version = counting(() => ({ version: { version: '9.9.9', channel: 'beta' } }));
  const { od } = client({ '/api/version': version.fn });

  const report = await od.probe({ skip: ['agents'] });

  assert.equal(report.version, '9.9.9');
  assert.equal(report.channel, 'beta');
  // One call for the check, zero more for the report. This is the duplicate the
  // 19-second status call was made of.
  assert.equal(version.calls, 1);
});

test('probe: capture keeps the body so the caller need not ask again', async () => {
  const { od, transport } = client({
    '/api/version': () => ({ version: { version: '0.26.0' } }),
    '/api/app-config': () => ({ config: { agentId: 'amr' } }),
    '/api/runs/active-count': () => ({ activeRunCount: 3 }),
  });

  const report = await od.probe({ skip: ['agents'], capture: ['appConfig', 'activeRunCount'] });

  assert.equal(report.features.appConfig.value.config.agentId, 'amr');
  assert.equal(report.features.activeRunCount.value.activeRunCount, 3);
  // Not captured: the body is dropped rather than retained for nobody.
  assert.equal(report.features.health.value, undefined);
  assert.equal(transport.calls.filter((call) => call.path === '/api/app-config').length, 1);
});

test('probe: skipping agents while enumerating models does not double-fetch', async () => {
  // The exact shape `opendesign_status({ include_models: true })` uses. Before
  // this, `probe()` fetched `/api/agents` and the following `listAgents()` fetched
  // it again: measured 18.1 s for one status call that needed the list once.
  const agents = counting(() => ({ agents: [{ id: 'amr', models: [{ id: 'm-1' }] }] }));
  const { od, transport } = client({
    '/api/version': () => ({ version: { version: '0.26.0' } }),
    '/api/agents': agents.fn,
  });

  const report = await od.probe({ skip: ['agents'], capture: ['appConfig'] });
  const listed = await od.listAgents();

  assert.equal(report.features.agents.skipped, true);
  assert.deepEqual(report.degraded, []);
  assert.equal(listed.length, 1);
  assert.equal(agents.calls, 1, 'the enumeration must happen exactly once');
  assert.equal(transport.calls.filter((call) => call.path === '/api/agents').length, 1);
});

test('probe: a failing check is still reported as degraded', async () => {
  const { od } = client({});
  // Make one route fail at the transport layer for real, with no rediscovery
  // hook available, so the failure path is exercised rather than assumed.
  od.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/api/projects') throw new Error('socket hang up');
    return new Response(JSON.stringify({ ok: true, version: { version: '0.26.0' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const report = await od.probe({ skip: ['agents'] });

  assert.deepEqual(report.degraded, ['projects']);
  assert.equal(report.features.projects.ok, false);
});
