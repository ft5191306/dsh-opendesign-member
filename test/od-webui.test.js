/**
 * Tests for locating Open Design's WEB sidecar and deciding whether a browser
 * may frame it (方案 F's host half).
 *
 * The interesting failures here are all quiet ones, so the tests are written
 * against those:
 *
 *   - The daemon answers `/api/health` too, so "a port Open Design owns" is NOT
 *     enough to identify the UI. A port that serves JSON at `/` must be rejected.
 *   - Open Design ALSO binds an internal Next backend that serves the same HTML
 *     shell while answering `/api/*` with HTML (measured on 0.26.1). Framing it
 *     yields a shell whose every request fails, so an HTML-only probe is exactly
 *     the trap this suite must keep closed: `/api/health` must be JSON.
 *   - A page can exist and still refuse framing (X-Frame-Options /
 *     `frame-ancestors`). Reporting "embeddable: true" there would produce the
 *     exact blank frame the feature must never show.
 *   - An explicitly configured URL is a deliberate override: when it is wrong,
 *     the result must say so rather than silently substituting a discovered
 *     origin, or a misconfiguration would look like success.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverWebUi, frameBlocker, resetWebUiCache } from '../lib/od-client.js';

/** A 200 HTML document, optionally with framing-related headers. */
function html(headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers }),
    body: undefined,
  };
}

/** A 200 JSON answer (the daemon-style response). */
function json(payload = { ok: true }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
    json: async () => payload,
    body: undefined,
  };
}

/** A 404, for "this route is not there". */
function notFound() {
  return {
    ok: false,
    status: 404,
    headers: new Headers({ 'content-type': 'text/plain' }),
    body: undefined,
  };
}

/**
 * A fetch double driven by one responder; records every URL it was asked for so
 * "did it even probe that port?" is assertable.
 */
function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    return respond(target);
  };
  return { fetchImpl, calls };
}

/** A healthy web UI: HTML document plus a daemon-proxying JSON health route. */
function healthyWebApp(url) {
  return url.endsWith('/api/health') ? json({ ok: true, version: '0.26.1' }) : html();
}

/** The internal Next backend: HTML everywhere, including under /api. */
function internalBackend() {
  return html();
}

test('frameBlocker: absent headers allow framing', () => {
  assert.deepEqual(frameBlocker(new Headers()), { blocked: false });
  // An unrelated CSP must not be read as a framing veto.
  assert.deepEqual(
    frameBlocker(new Headers({ 'content-security-policy': "default-src 'self'; img-src data:" })),
    { blocked: false },
  );
});

test('frameBlocker: X-Frame-Options blocks regardless of value', () => {
  for (const value of ['DENY', 'SAMEORIGIN', 'sameorigin']) {
    const verdict = frameBlocker(new Headers({ 'x-frame-options': value }));
    assert.equal(verdict.blocked, true, `XFO ${value} must block a cross-origin frame`);
    assert.equal(verdict.header, 'x-frame-options');
    assert.equal(verdict.value, value);
  }
});

test('frameBlocker: frame-ancestors blocks unless it names the wildcard', () => {
  const blocked = frameBlocker(new Headers({ 'content-security-policy': "frame-ancestors 'self'" }));
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.header, 'content-security-policy');

  assert.equal(
    frameBlocker(new Headers({ 'content-security-policy': 'frame-ancestors *' })).blocked,
    false,
    'an explicit wildcard is permission, not a veto',
  );
});

test('discoverWebUi: an explicit origin is validated, never trusted', async () => {
  resetWebUiCache();
  // HTML at / with an HTML /api/health is the internal-backend trap.
  const { fetchImpl } = fakeFetch(internalBackend);
  const found = await discoverWebUi({ baseUrl: 'http://127.0.0.1:7000', fetch: fetchImpl });
  assert.equal(found.embeddable, false);
  assert.equal(found.discoveredBy, 'config');
  assert.equal(found.baseUrl, 'http://127.0.0.1:7000');
  assert.match(found.reason, /internal backend/i);
});

test('discoverWebUi: an explicit origin that serves a working web app is embeddable', async () => {
  resetWebUiCache();
  const { fetchImpl, calls } = fakeFetch(healthyWebApp);
  const found = await discoverWebUi({ baseUrl: 'http://127.0.0.1:7000', fetch: fetchImpl });
  assert.equal(found.embeddable, true);
  assert.equal(found.baseUrl, 'http://127.0.0.1:7000');
  assert.equal(found.discoveredBy, 'config');
  assert.deepEqual(calls, ['http://127.0.0.1:7000/', 'http://127.0.0.1:7000/api/health'],
    'the explicit origin is the only origin probed, with both discriminators');
});

test('discoverWebUi: framing headers turn a reachable page into a named refusal', async () => {
  resetWebUiCache();
  const { fetchImpl } = fakeFetch((url) => (url.endsWith('/') ? html({ 'x-frame-options': 'SAMEORIGIN' }) : json({ ok: true })));
  const found = await discoverWebUi({ baseUrl: 'http://127.0.0.1:7000', fetch: fetchImpl });
  assert.equal(found.embeddable, false);
  assert.equal(found.baseUrl, 'http://127.0.0.1:7000');
  assert.deepEqual(found.blockedBy, { header: 'x-frame-options', value: 'SAMEORIGIN' });
  assert.match(found.reason, /refuses to frame/i);
});

test('discoverWebUi: a configured origin that is down reports why instead of substituting', async () => {
  resetWebUiCache();
  const fetchImpl = async () => { throw new Error('connect ECONNREFUSED'); };
  const found = await discoverWebUi({ baseUrl: 'http://127.0.0.1:7000', fetch: fetchImpl });
  assert.equal(found.embeddable, false);
  assert.equal(found.discoveredBy, 'config');
  assert.match(found.reason, /not reachable/i);
});

test('discoverWebUi: the daemon-reported webBaseUrl wins over an earlier-sorted port', async () => {
  resetWebUiCache();
  // The real trap: the internal backend is 64118, the public UI is 64120, and
  // ascending port order would pick the broken one. install-info must decide.
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url === 'http://127.0.0.1:64112/api/mcp/install-info') return json({ webBaseUrl: 'http://127.0.0.1:64120' });
    if (url.startsWith('http://127.0.0.1:64120')) return healthyWebApp(url);
    if (url.startsWith('http://127.0.0.1:64118')) return internalBackend(url);
    if (url.startsWith('http://127.0.0.1:64112')) return json({ ok: true });
    throw new Error(`unexpected ${url}`);
  });
  const found = await discoverWebUi({
    daemonUrl: 'http://127.0.0.1:64112',
    candidates: ['http://127.0.0.1:64118', 'http://127.0.0.1:64120'],
    fetch: fetchImpl,
  });
  assert.equal(found.embeddable, true);
  assert.equal(found.baseUrl, 'http://127.0.0.1:64120');
  assert.equal(found.discoveredBy, 'install-info');
  assert.equal(calls.some((url) => url.startsWith('http://127.0.0.1:64118')), false,
    'an authoritative report must short-circuit the port scan');
});

test('discoverWebUi: a stale or absent install-info falls back to a validated scan', async () => {
  resetWebUiCache();
  const { fetchImpl } = fakeFetch((url) => {
    if (url === 'http://127.0.0.1:64112/api/mcp/install-info') return notFound();
    if (url.startsWith('http://127.0.0.1:64118')) return internalBackend(url);
    if (url.startsWith('http://127.0.0.1:64120')) return healthyWebApp(url);
    throw new Error(`unexpected ${url}`);
  });
  const found = await discoverWebUi({
    daemonUrl: 'http://127.0.0.1:64112',
    candidates: ['http://127.0.0.1:64118', 'http://127.0.0.1:64120'],
    fetch: fetchImpl,
  });
  assert.equal(found.embeddable, true);
  assert.equal(found.baseUrl, 'http://127.0.0.1:64120', 'the internal backend must be rejected, not framed');
  assert.equal(found.discoveredBy, 'candidate');
});

test('discoverWebUi: an install-info report is accepted even when it EQUALS daemonUrl', async () => {
  resetWebUiCache();
  // Real trap after an Open Design restart: `discoverDaemon` can confirm the WEB
  // sidecar (it proxies /api/health), so the panel's "daemon" hint IS the web
  // origin. Excluding that origin from candidates AND refusing the authoritative
  // install-info report made the sidebar report "no web UI found" forever.
  const { fetchImpl } = fakeFetch((url) => {
    if (url === 'http://127.0.0.1:7000/api/mcp/install-info') return json({ webBaseUrl: 'http://127.0.0.1:7000' });
    if (url.startsWith('http://127.0.0.1:7000')) return healthyWebApp(url);
    throw new Error(`unexpected ${url}`);
  });
  const found = await discoverWebUi({ daemonUrl: 'http://127.0.0.1:7000', fetch: fetchImpl });
  assert.equal(found.embeddable, true);
  assert.equal(found.baseUrl, 'http://127.0.0.1:7000');
  assert.equal(found.discoveredBy, 'install-info');
});

test('discoverWebUi: an install-info report that fails validation is refused, not framed', async () => {
  resetWebUiCache();
  const { fetchImpl } = fakeFetch((url) => {
    if (url === 'http://127.0.0.1:64112/api/mcp/install-info') return json({ webBaseUrl: 'http://127.0.0.1:64118' });
    if (url.startsWith('http://127.0.0.1:64118')) return internalBackend(url);
    throw new Error(`unexpected ${url}`);
  });
  const found = await discoverWebUi({ daemonUrl: 'http://127.0.0.1:64112', fetch: fetchImpl });
  assert.equal(found.embeddable, false);
  assert.equal(found.baseUrl, null);
  assert.match(found.reason, /reported .*but .*internal backend|internal backend/i);
});

test('discoverWebUi: the daemon origin is never asked to be the UI', async () => {
  resetWebUiCache();
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.startsWith('http://127.0.0.1:7002')) return healthyWebApp(url);
    throw new Error(`unexpected ${url}`);
  });
  const found = await discoverWebUi({
    candidates: ['http://127.0.0.1:7001', 'http://127.0.0.1:7002'],
    exclude: ['http://127.0.0.1:7001/'],
    fetch: fetchImpl,
  });
  assert.equal(found.baseUrl, 'http://127.0.0.1:7002');
  assert.equal(calls.some((url) => url.startsWith('http://127.0.0.1:7001')), false);
});

test('discoverWebUi: nothing usable reports the candidates it tried', async () => {
  resetWebUiCache();
  const { fetchImpl } = fakeFetch(() => { throw new Error('offline'); });
  const found = await discoverWebUi({
    candidates: ['http://127.0.0.1:7001', 'http://127.0.0.1:7002'],
    fetch: fetchImpl,
  });
  assert.equal(found.embeddable, false);
  assert.equal(found.baseUrl, null);
  assert.deepEqual(found.candidates, ['http://127.0.0.1:7001', 'http://127.0.0.1:7002']);
  assert.match(found.reason, /web sidecar may not be running/i);
});

test('discoverWebUi: the short cache is reused, and cache:false and time bypass it', async () => {
  resetWebUiCache();
  const { fetchImpl, calls } = fakeFetch(healthyWebApp);
  const options = { candidates: ['http://127.0.0.1:7002'], fetch: fetchImpl, now: 1_000 };

  const first = await discoverWebUi(options);
  assert.equal(first.embeddable, true);
  assert.equal(calls.length, 2, 'one HTML probe plus one API probe');

  // Within the TTL: no new probe, and the same verdict.
  const second = await discoverWebUi({ ...options, now: 1_000 + 5_000 });
  assert.equal(second.embeddable, true);
  assert.equal(calls.length, 2, 'a warm cache must not probe again');

  // After the TTL: rediscovered.
  await discoverWebUi({ ...options, now: 1_000 + 60_000 });
  assert.equal(calls.length, 4);

  // Forced refresh: rediscovered immediately.
  await discoverWebUi({ ...options, now: 1_000 + 60_001, cache: false });
  assert.equal(calls.length, 6);
});
