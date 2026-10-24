/**
 * Mint a desktop import token from the Open Design daemon sidecar.
 *
 * Why this exists: `POST /api/import/folder` and
 * `POST /api/projects/:id/working-dir` are the only two supported ways to make
 * an Open Design project's agent `cwd` a directory we already own. Both require
 * `x-od-desktop-import-token`, a short-lived HMAC bound to that exact baseDir.
 * The Open Design CLI mints it over the daemon sidecar's named pipe, so this is
 * the same supported in-process channel Open Design uses for itself.
 *
 * Upgrade strategy: the pipe name is derived from documented stamp fields, and
 * every step tolerates absence — when the pipe cannot be found the caller falls
 * back to a non-token binding path instead of failing the team.
 *
 * @module @local/dsh-opendesign-member/lib/sidecar-token
 */

import net from 'node:net';
import { createHash } from 'node:crypto';
import os from 'node:os';

/** Stamp fields the sidecar folds into its pipe name, in this order. */
const STAMP_FIELDS = [
  ['channel', 'stable'],
  ['namespace', 'release-stable-win'],
  ['source', 'packaged'],
  ['mode', 'runtime'],
  ['app', 'daemon'],
];

/**
 * Build the stamp string used for the pipe-name digest.
 *
 * @param overrides - field values to replace, keyed by stamp field name.
 */
function stampOf(overrides = {}) {
  return STAMP_FIELDS.map(([key, fallback]) => `${key}=${overrides[key] ?? fallback}`).join('\n');
}

/**
 * Compute the Windows named-pipe path for one stamp.
 *
 * @param stamp - the folded stamp string.
 * @param principal - OS username; defaults to the current user.
 */
export function pipeNameFor(stamp, principal = os.userInfo().username) {
  const digest = createHash('sha256')
    .update(`${principal}\n${stamp}`)
    .digest('hex')
    .slice(0, 32);
  return `\\\\.\\pipe\\open-design-sidecar-${digest}`;
}

/**
 * Send one request frame over a named pipe and read one response line.
 *
 * @param pipePath - absolute pipe path.
 * @param frame - request object.
 * @param timeoutMs - connect and read deadline.
 * @returns the decoded response object.
 */
function invokePipe(pipePath, frame, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath);
    let settled = false;
    let buffer = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`sidecar pipe timed out after ${timeoutMs}ms`)));
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineAt = buffer.indexOf('\n');
      if (newlineAt < 0) return;
      const line = buffer.slice(0, newlineAt).trim();
      if (line.length === 0) return;
      try {
        finish(undefined, JSON.parse(line));
      } catch (error) {
        finish(new Error(`sidecar pipe returned a non-JSON frame: ${error.message}`));
      }
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(frame)}\n`);
    });
  });
}

/**
 * Mint one baseDir-bound desktop import token.
 *
 * Candidate pipes are tried in order: an explicit path, the stamped names for
 * common channel/namespace combinations, then a bare-name probe. The token is
 * single-use and expires in about a minute, so callers mint immediately before
 * the call that needs it.
 *
 * @param baseDir - absolute directory the token authorizes.
 * @param options - explicit pipe path, stamp overrides, candidate namespaces.
 * @returns `{ token, expiresAt }`.
 * @throws when no sidecar answers.
 */
export async function mintImportToken(baseDir, options = {}) {
  if (typeof baseDir !== 'string' || baseDir.trim().length === 0) {
    throw new Error('mintImportToken requires an absolute baseDir');
  }
  const timeoutMs = options.timeoutMs ?? 3_000;
  const candidates = [];
  if (typeof options.pipePath === 'string' && options.pipePath.length > 0) {
    candidates.push(options.pipePath);
  }
  const namespaces = Array.isArray(options.namespaces) && options.namespaces.length > 0
    ? options.namespaces
    : ['release-stable-win', 'release-stable', 'release-beta-win', 'release-nightly-win'];
  const channels = Array.isArray(options.channels) && options.channels.length > 0
    ? options.channels
    : ['stable'];
  const sources = ['packaged', 'development'];
  const modes = ['runtime'];

  for (const namespace of namespaces) {
    for (const channel of channels) {
      for (const source of sources) {
        for (const mode of modes) {
          const stamp = stampOf({ namespace, channel, source, mode });
          const name = pipeNameFor(stamp, options.principal);
          if (!candidates.includes(name)) candidates.push(name);
        }
      }
    }
  }

  const frame = {
    type: 'sidecar:invoke',
    app: 'daemon',
    action: 'mint-import-token',
    input: { baseDir },
  };

  const failures = [];
  for (const candidate of candidates) {
    try {
      const response = await invokePipe(candidate, frame, timeoutMs);
      if (response?.ok === true && typeof response.result?.token === 'string') {
        return {
          token: response.result.token,
          expiresAt: response.result.expiresAt ?? null,
          pipePath: candidate,
        };
      }
      const code = response?.result?.code ?? response?.error?.code ?? 'unknown';
      failures.push(`${candidate} -> ${code}`);
      // A DNS/AUTH answer means we found the real sidecar; other stamps will not help.
      if (code === 'DESKTOP_AUTH_INACTIVE' || code === 'DESKTOP_AUTH_PENDING') {
        throw new Error(`Open Design desktop auth gate answered ${code}; folder-backed binding is unavailable`);
      }
    } catch (error) {
      if (error instanceof Error && /desktop auth gate answered/.test(error.message)) throw error;
      failures.push(`${candidate} -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `No Open Design daemon sidecar answered the import-token request. Tried ${candidates.length} pipe name(s): ${failures.slice(0, 3).join('; ')}`,
  );
}
