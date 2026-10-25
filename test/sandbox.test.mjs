import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCodexSandbox } from '../scripts/check-codex-sandbox.mjs';

const binary = fileURLToPath(new URL('./fixture-sandbox.mjs', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));
test('model-free sandbox diagnostics require real files, expected denials and unmodified inputs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sandbox-test-'));
  const previous = Object.fromEntries(
    ['STUDIO_SANDBOX_FIXTURE_CASE', 'OPENAI_API_KEY', 'CODEX_API_KEY'].map(key => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  process.env.OPENAI_API_KEY = 'fixture-must-be-scrubbed';
  process.env.CODEX_API_KEY = 'fixture-must-be-scrubbed';
  const run = (implementation = 'mxc', timeoutMs = 2000) =>
    checkCodexSandbox({ binary, implementation, parentDirectory: directory, timeoutMs });
  process.env.STUDIO_SANDBOX_FIXTURE_CASE = 'pass';
  for (const implementation of ['mxc', 'elevated']) {
    const passed = run(implementation);
    assert.equal(passed.passed, true);
    assert.equal(passed.implementation, implementation);
    assert.equal(passed.insideMatches, true);
    assert.equal(passed.outsideExists, false);
    assert.equal(passed.inputUnchanged, true);
  }
  const count = fs.readdirSync(directory).length;
  for (const invalid of ['unelevated', 'danger-full-access', 'mxc"; unsafe'])
    assert.throws(() => run(invalid), /must be elevated or mxc/);
  assert.equal(fs.readdirSync(directory).length, count);
  for (const mode of [
    'outside-write',
    'input-write',
    'wrong-error',
    'misleading-report',
    'missing-inside',
    'invalid-report',
    'failure',
    'timeout',
  ]) {
    process.env.STUDIO_SANDBOX_FIXTURE_CASE = mode;
    const rejected = run('mxc', mode === 'timeout' ? 150 : 2000);
    assert.equal(rejected.passed, false, mode);
    if (mode === 'outside-write' || mode === 'misleading-report') assert.equal(rejected.outsideExists, true);
    if (mode === 'input-write') assert.equal(rejected.inputUnchanged, false);
    if (mode === 'timeout') assert.equal(rejected.error, 'ETIMEDOUT');
  }
});

test('live Codex verification stops before controller creation or model work when isolation fails', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-cli.mjs', 'codex'], {
    cwd: root,
    env: { ...process.env, STUDIO_CODEX_BINARY: binary, STUDIO_SANDBOX_FIXTURE_CASE: 'failure' },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  const evidence = JSON.parse(result.stdout).sandboxPreflight;
  try {
    assert.equal(result.status, 1);
    assert.equal(evidence.passed, false);
    assert.match(result.stderr, /No model assignment started/);
    assert.doesNotMatch(result.stdout, /Temporary records|Started codex/);
  } finally {
    assert.ok(path.resolve(evidence.directory).startsWith(path.join(root, '.studio-sandbox-')));
    fs.rmSync(evidence.directory, { recursive: true, force: true });
  }
});
