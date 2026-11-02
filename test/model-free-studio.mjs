import { createStudio as createController } from '../src/server.mjs';
import { directorAccess } from '../src/director-access.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';

// fetch parses responses with undici's WebAssembly HTTP parser, which V8 recompiles on a background
// thread. When --test-force-exit ends a file's process during that recompile, Node on Windows aborts
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c"), so a file whose last
// test POSTs to the controller failed every time in the plan's unsandboxed source checks (October 22,
// 2026). Keep the parser on its first tier; it is set before any test's first fetch compiles it.
v8.setFlagsFromString('--no-wasm-dynamic-tiering');

// In the test sandbox the copy is the only folder the tests may write, and the built-in
// sandbox hands them no temp folder of their own (Codex's MXC, before 1.0.1, redirected it).
// Put disposable fixtures inside the copied-source workspace so permissions match the tested target.
// Keep the name short: fixtures nest job folders and git repositories under it, and
// process working folders and git stop at 260-character Windows paths.
if (process.env.STUDIO_MODEL_FREE_LEAF_FIXTURES === '1') {
  const fixtureTemporaryDirectory = path.resolve('.tmp');
  fs.mkdirSync(fixtureTemporaryDirectory, { recursive: true });
  process.env.TEMP = fixtureTemporaryDirectory;
  process.env.TMP = fixtureTemporaryDirectory;
  process.env.TMPDIR = fixtureTemporaryDirectory;
}
// The tests' git identity, never the computer's: one with no global user.name and email (a fresh Mac or Linux
// install) refuses to add a project, and one with settings of its own (signing, hooks) changes what git does.
// The built-in sandbox already gives its runs a neutral identity, which is kept.
process.env.GIT_CONFIG_GLOBAL ||= fileURLToPath(new URL('./fixture-gitconfig', import.meta.url));

// Protocol fixtures are single Node processes. Terminate their known leaf
// directly so model-free tests can run inside a test sandbox, which need not offer taskkill (MXC had none).
// Real controllers/CLIs retain process-tree termination and conservative leases.
// Installing packages for a tested copy (MP-026) uses a stand-in for npm, so no test reaches the network.
export const fixtureNpm = {
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fixture-npm.mjs', import.meta.url))],
};
// The built-in sandbox as the suite's studios see it (1.0.1), never this computer's own setup: set up while a
// protocol fixture stands in for the tests, so candidate tests and an idea's checks are recorded as running in it
// without the suite ever running it, and otherwise not available, so a test that measures a real suite stops
// unless it chooses No sandbox. A test of the sandbox's own states passes its own.
export const readyBuiltInSandbox = { status: () => ({ state: 'ready' }), setup: () => false };
// The data folders whose secrets an elevated Codex attempt asked to have denied to Codex's sandbox.
export const codexSecretDenies = [];
const fixtureBuiltInSandbox = runner => ({
  status: () => ({ state: runner()?.sourceCheckCommand ? 'ready' : 'unsupported' }),
  setup: () => false,
});
// Every request needs the director's session or key (C-01, src/director-access.mjs). The suite's requests act as
// the director: fetch sends a started studio's credentials to that studio's own address, so every test still
// passes through the check. A command (any method but GET or HEAD), or a request that carries the page's request
// token, acts as the dashboard does, signed in by the session cookie, so the token is still weighed on every command
// the suite sends, refusals included; a read acts as a local tool does, with the key. A test of a command sent with
// the key sends the header itself. A test of the check itself sends a request without either with
// `{ directorKey: false }`, or reaches the address with node:http.
const studioKeys = new Map(),
  plainFetch = globalThis.fetch;
const sessionCookie = key => directorAccess(key).sessionCookie.split(';')[0];
const asDashboard = (method, hasToken) => hasToken || !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
// The same choice for a request a test hands the server some other way.
export const directorCredentials = (key, headers = {}, method = 'GET') =>
  asDashboard(
    method,
    Object.keys(headers).some(name => name.toLowerCase() === 'x-studio-token'),
  )
    ? { cookie: sessionCookie(key) }
    : { 'x-studio-key': key };
globalThis.fetch = (input, init = {}) => {
  const { directorKey: sendKey = true, ...rest } = init,
    url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    key = sendKey ? [...studioKeys].find(([origin]) => url === origin || url.startsWith(origin + '/'))?.[1] : null;
  if (!key) return plainFetch(input, rest);
  const headers = new Headers(rest.headers ?? (input instanceof Request ? input.headers : undefined)),
    method = rest.method ?? (input instanceof Request ? input.method : 'GET');
  const signedIn = headers.has('x-studio-key') || headers.has('cookie');
  if (!signedIn && asDashboard(method, headers.has('x-studio-token'))) headers.set('cookie', sessionCookie(key));
  else if (!signedIn) headers.set('x-studio-key', key);
  return plainFetch(input, { ...rest, headers });
};
// The key header for a request a test sends some other way (node:http, or straight to the server): empty for an
// address no started studio of this file listens on.
export const directorHeaders = url => {
  const key = [...studioKeys].find(([origin]) => url === origin || url.startsWith(origin + '/'))?.[1];
  return key ? { 'x-studio-key': key } : {};
};
export function createStudio(options = {}) {
  const fixtureOptions =
    process.env.STUDIO_MODEL_FREE_LEAF_FIXTURES === '1'
      ? { fixtureProcessTermination: (entry, force) => entry.child.kill(force ? 'SIGKILL' : 'SIGTERM') }
      : {};
  let app = null;
  app = createController({
    // The suite's studios start from the game organization and its starter tasks unless a test chooses.
    bootstrap: { organizationPreset: 'game-studio', workflowPresets: ['game-production'] },
    ...options,
    runnerOptions: {
      packageInstallCommand: fixtureNpm,
      builtInSandbox: fixtureBuiltInSandbox(() => app?.runner),
      // Codex's elevated Windows sandbox as the suite sees it, never this computer's: set up, and its deny of the
      // director's secrets recorded rather than made (C-42; test/agent-secrets.test.mjs covers the deny itself).
      codexElevatedReady: () => true,
      denyCodexSecrets: directory => (codexSecretDenies.push(directory), []),
      // The suite's protocol fixtures start directly; test/process-job.test.mjs runs the Windows job wrapper itself (C-07).
      processJobs: false,
      ...fixtureOptions,
      ...options.runnerOptions,
    },
  });
  const start = app.start,
    close = app.close;
  let origin = null;
  app.start = async function () {
    origin = await start.call(this);
    studioKeys.set(origin, app.directorKey);
    return origin;
  };
  app.close = function () {
    if (origin) studioKeys.delete(origin);
    return close.call(this);
  };
  return app;
}
