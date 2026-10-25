// The new dashboard's checks run inside the controller suite (Decision MP-026, v1.0 item 19b), so source
// checks, candidate tests and integration verification all typecheck, lint, test and build it with no
// change to the test command. The tools come from installed packages, found as Node finds them, in the
// nearest node_modules up from this copy: `npm ci` here, or the pipeline's install in its data folder. Every
// tool writes outside the snapshot's folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Inside the candidate sandbox, temporary folders must live in the writable workspace.
import './model-free-studio.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function tool(relative) {
  for (let directory = root; ; directory = path.dirname(directory)) {
    const file = path.join(directory, 'node_modules', ...relative.split('/'));
    if (fs.existsSync(file)) return file;
    if (path.dirname(directory) === directory) return null;
  }
}

function run(name, script, args) {
  const file = tool(script);
  if (!file)
    assert.fail(
      `The dashboard's ${name} is not installed: run \`npm ci\` in ${root} (the pipeline installs its own in its data folder).`,
    );
  const environment = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
  // A nested runner would otherwise report into this test's own stream.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    timeout: 110000,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  assert.equal(result.status, 0, `The dashboard's ${name} failed:\n${output.slice(-4000) || result.error?.message}`);
  return output;
}

test('the dashboard typechecks', () => {
  run('typecheck', 'typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json']);
});

test("the dashboard passes its lint rules, including React's rules of hooks", () => {
  run('lint', 'eslint/bin/eslint.js', ['--max-warnings', '0', 'dashboard']);
});

test("the dashboard's own tests pass in a simulated page", () => {
  const output = run('tests', 'vitest/vitest.mjs', ['run', '--configLoader', 'native', '--reporter', 'dot']);
  assert.match(output, /Tests\s+\d+ passed/);
});

test('the dashboard builds', t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dashboard-build-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  run('build', 'vite/bin/vite.js', [
    'build',
    '--configLoader',
    'native',
    '--outDir',
    out,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ]);
  const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(page, /name="studio-token" content="%STUDIO_TOKEN%"/, 'The controller fills in the request token.');
  // The page's security policy allows scripts from the controller only: every script names its file.
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.match(page, /<script src="\/theme\.js"><\/script>/);
  // Fonts and other files load from the controller only (default-src 'self'), so no stylesheet inlines one as a
  // data: URL. On October 22 a 2.9 KB font subset was inlined and the browser refused it on every page.
  const assets = path.join(out, 'assets'),
    styles = fs.readdirSync(assets).filter(name => name.endsWith('.css'));
  assert.ok(styles.length, 'The build has a stylesheet.');
  for (const name of styles)
    assert.doesNotMatch(fs.readFileSync(path.join(assets, name), 'utf8'), /url\(\s*['"]?data:/, name);
});
