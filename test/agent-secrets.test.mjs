// The director's secrets kept from the agents' own CLIs (C-42, src/adapters/agent-secrets.mjs): Claude's deny rules
// in the form Claude Code matches, Codex's elevated Windows sandbox group denied each secret, its setup checked and
// named plainly when missing, and MXC said to read them. Model-free: no CLI runs, and the Windows commands are recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The controller's modules load in the order the controller loads them (the adapters' registry before an adapter).
import '../src/runner.mjs';
import {
  agentSecrets,
  claudePath,
  claudeSecretRules,
  codexElevatedMissing,
  codexElevatedReady,
  codexMxcWarning,
  denyCodexPaths,
  denyCodexSecrets,
} from '../src/adapters/agent-secrets.mjs';
import { codexAdapter } from '../src/adapters/codex.mjs';

function dataFolder(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-secrets-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  return data;
}

test("the data folder's secrets are the key, the launch link and the tools' keys that exist", t => {
  const data = dataFolder(t);
  assert.deepEqual(agentSecrets(data), []);
  assert.deepEqual(agentSecrets(null), []);
  fs.writeFileSync(path.join(data, 'director-key'), 'a'.repeat(64));
  fs.mkdirSync(path.join(data, 'tool-keys'));
  assert.deepEqual(agentSecrets(data), [path.join(data, 'director-key'), path.join(data, 'tool-keys')]);
  fs.writeFileSync(path.join(data, 'launch-url'), 'http://127.0.0.1:4317/launch/x');
  assert.deepEqual(
    agentSecrets(data),
    ['director-key', 'launch-url', 'tool-keys'].map(name => path.join(data, name)),
  );
});

test('Claude is denied each secret by an absolute rule in the form it matches, a folder with what is in it', t => {
  // Claude Code matches Windows paths in POSIX form, the drive as /c (its permissions documentation).
  assert.equal(claudePath('C:\\Users\\Ada\\data\\director-key', 'win32'), '/c/Users/Ada/data/director-key');
  assert.equal(claudePath('/home/ada/data/director-key', 'linux'), '/home/ada/data/director-key');
  // A glob character in the path is taken literally.
  assert.equal(claudePath('/srv/data[1]/key*', 'linux'), '/srv/data\\[1\\]/key\\*');
  const data = dataFolder(t);
  fs.writeFileSync(path.join(data, 'director-key'), 'a'.repeat(64));
  fs.mkdirSync(path.join(data, 'tool-keys'));
  const rules = claudeSecretRules(data);
  assert.deepEqual(rules, [
    `Read(/${claudePath(path.join(data, 'director-key'))})`,
    `Read(/${claudePath(path.join(data, 'tool-keys'))}/**)`,
  ]);
  for (const rule of rules) assert.match(rule, /^Read\(\/\/[^/]/, 'anchored at the filesystem root');
  assert.deepEqual(claudeSecretRules(null), []);
});

test("Codex's elevated sandbox group is denied each secret, a folder with what is in it, or the attempt stops", t => {
  const data = dataFolder(t);
  fs.writeFileSync(path.join(data, 'director-key'), 'a'.repeat(64));
  fs.mkdirSync(path.join(data, 'tool-keys'));
  const calls = [],
    run = (program, args) => (calls.push([program, args]), { status: 0 });
  assert.deepEqual(denyCodexSecrets(data, run), [path.join(data, 'director-key'), path.join(data, 'tool-keys')]);
  assert.deepEqual(calls, [
    ['icacls', [path.join(data, 'director-key'), '/deny', 'CodexSandboxUsers:(R)']],
    ['icacls', [path.join(data, 'tool-keys'), '/deny', 'CodexSandboxUsers:(OI)(CI)(R)']],
  ]);
  assert.throws(
    () =>
      denyCodexPaths([path.join(data, 'director-key')], () => ({
        status: 1332,
        stderr: 'No mapping between account names',
      })),
    /Codex's sandbox could not be kept from the director's secret .*No mapping/,
  );
});

test("a computer without Codex's elevated sandbox is told plainly what to run; MXC is said to read the secrets", t => {
  assert.equal(
    codexElevatedReady(() => ({ status: 0 })),
    true,
  );
  assert.equal(
    codexElevatedReady(() => ({ status: 2 })),
    false,
  );
  assert.match(codexElevatedMissing, /administrator/);
  assert.match(codexElevatedMissing, /codex -c windows\.sandbox="elevated"/);
  assert.match(codexElevatedMissing, /STUDIO_CODEX_WINDOWS_SANDBOX=mxc/);
  assert.match(codexMxcWarning, /can read the director's key and the tools' keys/);
  if (process.platform !== 'win32') return;
  let asked = 0;
  const runtime = { codexWindowsSandbox: 'elevated', codexBinary: 'codex', codexElevatedReady: () => (asked++, false) };
  assert.equal(codexAdapter.blockReason(runtime, false), codexElevatedMissing);
  assert.equal(codexAdapter.blockReason(runtime, false), codexElevatedMissing);
  assert.equal(asked, 1, 'asked once per start of the controller');
  const ready = { codexWindowsSandbox: 'elevated', codexBinary: 'codex', codexElevatedReady: () => true };
  assert.equal(codexAdapter.blockReason(ready, false), '');
  const mxc = { codexWindowsSandbox: 'mxc', codexBinary: 'codex', codexElevatedReady: () => false };
  assert.equal(codexAdapter.blockReason(mxc, false), '', 'MXC needs no elevated setup');
  assert.equal(codexAdapter.status(mxc).warning, codexMxcWarning);
  assert.equal(codexAdapter.status(ready).warning, undefined);
});
