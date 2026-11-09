import { createStudio as createController } from '../src/server.mjs';
import { directorAccess } from '../src/director-access.mjs';
import fs from 'node:fs';
import os from 'node:os';
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
// The suite with its temporary folder reached through a link (STUDIO_TEST_LINKED_TEMP=1, November 9, 2026), as a
// computer whose temporary folder is a junction or a symbolic link (macOS's /var) reaches it: a fresh folder and a
// link to it (a junction on Windows, a symbolic link elsewhere), made inside the temporary folder in use (the copy's
// own with STUDIO_MODEL_FREE_LEAF_FIXTURES=1), with TEMP, TMP and TMPDIR pointed at the link before any fixture is
// made. A program this one starts keeps the link it inherits; this process removes the link, then its folder, when it
// exits. Where links cannot be made the setting stops the run rather than leave the suite on a plain folder.
export const linkedTemporaryFolder = process.env.STUDIO_TEST_LINKED_TEMP === '1' ? linkTemporaryFolder() : null;
function linkTemporaryFolder() {
  const given = os.tmpdir(),
    inherited = process.env.STUDIO_TEST_LINKED_TEMP_LINK;
  if (inherited && path.resolve(inherited) === path.resolve(given) && fs.lstatSync(given).isSymbolicLink())
    return { link: given, real: fs.realpathSync.native(given), made: false };
  // Short names: fixtures nest job folders and git repositories under it (see above).
  const holder = fs.mkdtempSync(path.join(given, 'sl-')),
    real = path.join(holder, 'r'),
    link = path.join(holder, 'l');
  fs.mkdirSync(real);
  try {
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    fs.rmSync(holder, { recursive: true, force: true });
    throw new Error(`STUDIO_TEST_LINKED_TEMP=1 could not link a temporary folder here (${error.code}).`, {
      cause: error,
    });
  }
  process.env.TEMP = link;
  process.env.TMP = link;
  process.env.TMPDIR = link;
  process.env.STUDIO_TEST_LINKED_TEMP_LINK = link;
  // The link goes first, so removing its folder never follows it.
  process.on('exit', () => {
    try {
      fs.unlinkSync(link);
      fs.rmSync(holder, { recursive: true, force: true });
    } catch {
      // A file a test left open stays until the computer's own temporary-folder cleanup.
    }
  });
  return { link, real: fs.realpathSync.native(real), made: true };
}
// The tests' git identity, never the computer's: one with no global user.name and email (a fresh Mac or Linux
// install) refuses to add a project, and one with settings of its own (signing, hooks) changes what git does.
// The built-in sandbox already gives its runs a neutral identity, which is kept.
process.env.GIT_CONFIG_GLOBAL ||= fileURLToPath(new URL('./fixture-gitconfig', import.meta.url));
// The tests' line endings, never the computer's: Git for Windows sets core.autocrlf=true in its system settings, which
// the fixture's global settings leave in effect, so every copy git checked out came back with CRLF and differed from
// the files the tests wrote. Pinned as git's own command settings (GIT_CONFIG_COUNT), which hold whichever global
// settings are used, the built-in sandbox's included, and which every git the suite starts inherits. Entries already
// there are kept. They outrank a repository's own settings too, so a test of a repository set to its own line endings
// takes them out of the environment it gives git.
export const pinnedGitSettings = [
  ['core.autocrlf', 'false'],
  ['core.eol', 'lf'],
];
export function pinGitSettings(environment, settings = pinnedGitSettings) {
  const counted = Number.parseInt(environment.GIT_CONFIG_COUNT ?? '', 10);
  let count = Number.isInteger(counted) && counted > 0 ? counted : 0;
  for (const [key, value] of settings) {
    let index = 0;
    while (index < count && environment[`GIT_CONFIG_KEY_${index}`] !== key) index++;
    if (index === count) environment[`GIT_CONFIG_KEY_${count++}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  environment.GIT_CONFIG_COUNT = String(count);
  return environment;
}
pinGitSettings(process.env);

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
// The tools' credential store as the suite's studios see it (1.4, tools), never this computer's own protected storage,
// Keychain or Secret Service: it keeps keys in memory and records every call it gets, as [operation, tool ID], never
// the key. Each studio gets its own unless a test passes its own `toolKeys`.
export function standInToolKeys() {
  const held = new Map(),
    calls = [];
  const call = (operation, id, act) => {
    calls.push([operation, id]);
    return act();
  };
  return {
    kind: 'stand-in',
    lessSafe: false,
    held,
    calls,
    put: (id, key) => call('put', id, () => void held.set(id, key)),
    remove: id => call('remove', id, () => void held.delete(id)),
    read: id => call('read', id, () => (held.has(id) ? held.get(id) : null)),
    has: id => call('has', id, () => held.has(id)),
  };
}
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
    toolKeys: options.toolKeys ?? standInToolKeys(),
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
