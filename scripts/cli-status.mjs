// Read-only preflight; never print credential files or account identity fields.
import { spawnSync } from 'node:child_process';
import { locateCodex, subscriptionEnvironment } from '../src/runner.mjs';
import { locateClaude } from '../src/adapters/claude.mjs';

for (const [provider, binary] of [
  ['codex', locateCodex()],
  ['claude', locateClaude()],
]) {
  if (!binary) {
    console.log(JSON.stringify({ provider, found: false }));
    continue;
  }
  const run = (args, env = subscriptionEnvironment(provider)) =>
    spawnSync(/\.m?js$/.test(binary) ? process.execPath : binary, /\.m?js$/.test(binary) ? [binary, ...args] : args, {
      env,
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 20000,
    });
  const version = run(['--version']);
  const auth = run(
    provider === 'codex' ? ['login', 'status'] : ['--safe-mode', '--setting-sources', '', 'auth', 'status'],
  );
  let status;
  if (provider === 'claude') {
    try {
      const data = JSON.parse(auth.stdout);
      status = Object.fromEntries(
        ['loggedIn', 'authMethod', 'apiProvider', 'subscriptionType'].map(key => [key, data[key]]),
      );
    } catch {}
  } else status = { chatgpt: /logged in using chatgpt/i.test((auth.stdout || '') + (auth.stderr || '')) };
  console.log(
    JSON.stringify(
      {
        provider,
        binary,
        version: version.stdout?.trim(),
        authExitCode: auth.status,
        status,
        processError: auth.error?.code,
        diagnostic: auth.status !== 0 ? auth.stderr?.slice(0, 2000) : undefined,
      },
      null,
      2,
    ),
  );
}
