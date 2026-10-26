import { createStudio as createController } from '../src/server.mjs';
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

// Protocol fixtures are single Node processes. Terminate their known leaf
// directly so model-free tests can run inside a test sandbox, which need not offer taskkill (MXC had none).
// Real controllers/CLIs retain process-tree termination and conservative leases.
// Installing packages for a tested copy (MP-026) uses a stand-in for npm, so no test reaches the network.
export const fixtureNpm = {
  executable: process.execPath,
  args: [fileURLToPath(new URL('./fixture-npm.mjs', import.meta.url))],
};
// The built-in sandbox as set up on this computer, so candidate tests and an idea's checks are recorded as running
// in it (1.0.1). The suite never runs it: the protocol fixtures run the tests, and a test that measures a real
// suite chooses No sandbox. A test of the sandbox's own states passes its own.
export const readyBuiltInSandbox = { status: () => ({ state: 'ready' }), setup: () => false };
export function createStudio(options = {}) {
  const fixtureOptions =
    process.env.STUDIO_MODEL_FREE_LEAF_FIXTURES === '1'
      ? { fixtureProcessTermination: (entry, force) => entry.child.kill(force ? 'SIGKILL' : 'SIGTERM') }
      : {};
  return createController({
    // The suite's studios start from the game organization and its starter tasks unless a test chooses.
    bootstrap: { organizationPreset: 'game-studio', workflowPresets: ['game-production'] },
    ...options,
    runnerOptions: {
      packageInstallCommand: fixtureNpm,
      builtInSandbox: readyBuiltInSandbox,
      ...fixtureOptions,
      ...options.runnerOptions,
    },
  });
}
