/**
 * Minimal test helpers for this plugin.
 *
 * Deliberately dependency-free and built on `node:test` + `node:assert`, because
 * the plugin itself installs as a symlink and cannot resolve peer packages from
 * the profile's `node_modules`. A test runner that needed an install would be the
 * one thing guaranteed to break here.
 *
 * @module @local/dsh-opendesign-member/test/helpers
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The directory throwaway test state is created in.
 *
 * Defaults to `os.tmpdir()`, which is correct everywhere the tests are supposed to
 * run. `DSH_TEST_TMP` exists because some hosts — measured on the Windows box this
 * plugin was developed on — deny `Node` any write inside `%TEMP%` while allowing a
 * normal user process to write there. The failure is an `EPERM` from `mkdtemp`, and
 * it arrives as seventeen unrelated-looking test failures, which is exactly the
 * shape a real regression would also take.
 *
 * The override is deliberately OPT-IN and has no fallback: silently retrying in a
 * second location would turn "this host cannot write temp" into a permanent blind
 * spot, and a guard that can pass when it should not is worse than none.
 */
export function tempRoot() {
  const override = process.env.DSH_TEST_TMP;
  return typeof override === 'string' && override.trim().length > 0
    ? override.trim()
    : os.tmpdir();
}

/**
 * Run one body against a throwaway directory, removing it afterwards.
 *
 * Every persistence helper in this plugin takes an absolute file path, so tests
 * point them at a temp dir instead of the real `$DSH_HOME`. Without this, a test
 * run would rewrite the user's live bindings and settings.
 *
 * @param body - receives the directory path and a function to build paths inside it.
 */
export async function withTempDir(body) {
  const dir = fs.mkdtempSync(path.join(tempRoot(), 'odm-test-'));
  try {
    return await body({
      dir,
      file: (...parts) => path.join(dir, ...parts),
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Build a fake daemon client that satisfies only the methods a given test needs.
 *
 * The exported functions are deliberately plain (`client` in, value out) so the
 * whole bridge can be exercised without Cordis, without a browser, and without a
 * running Open Design — which is the only way a regression like "a timeout
 * silently cancels the run" can be caught cheaply.
 *
 * @param overrides - method implementations to use.
 */
export function fakeClient(overrides = {}) {
  return {
    async getRun() {
      throw new Error('getRun not stubbed');
    },
    async cancelRun() {
      return { ok: true };
    },
    async listMessages() {
      return [];
    },
    ...overrides,
  };
}

/**
 * A run record shaped like `GET /api/runs/:id`, with only the fields the bridge
 * reads. Keeping this in one place means a test asserting on `clientType` and a
 * test asserting on `clientRequestId` cannot drift apart.
 *
 * @param overrides - field overrides.
 */
export function runRecord(overrides = {}) {
  return {
    id: 'run-1',
    status: 'running',
    projectId: 'proj-1',
    conversationId: 'conv-1',
    assistantMessageId: null,
    clientRequestId: 'dsh-1700000000000-abcdefgh',
    ...overrides,
  };
}

/**
 * One message as `GET /api/projects/:id/conversations/:cid/messages` returns it.
 *
 * @param overrides - field overrides.
 */
export function message(overrides = {}) {
  return {
    id: 'msg-1',
    role: 'user',
    content: '',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Count calls to a stubbed method, so "did not cancel" is assertable. */
export function counting(implementation) {
  const state = { calls: 0, args: [] };
  state.fn = async (...args) => {
    state.calls += 1;
    state.args.push(args);
    return await implementation(...args);
  };
  return state;
}
