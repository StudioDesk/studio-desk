// The suite with its temporary folder reached through a link (November 9, 2026): STUDIO_TEST_LINKED_TEMP=1 in the
// suite's harness links a fresh temporary folder (a junction on Windows, a symbolic link elsewhere) and points TEMP,
// TMP and TMPDIR at the link, as a computer whose temporary folder is reached that way does (macOS's /var). GitHub's
// runs add a leg with it on. Model-free: child node processes, temporary folders and git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)),
  harness = new URL('./model-free-studio.mjs', import.meta.url).href;

// A child with the setting on, and a link of its own: one the run inherits is not handed on. It is a run of its own,
// not part of this file's (node:test marks its files' processes with NODE_TEST_CONTEXT).
const linkedEnvironment = () => {
  const environment = { ...process.env, STUDIO_TEST_LINKED_TEMP: '1' };
  delete environment.STUDIO_TEST_LINKED_TEMP_LINK;
  delete environment.NODE_TEST_CONTEXT;
  return environment;
};
// A module program that loads the suite's harness first, as every test file that imports it does.
const withHarness = body => ['--input-type=module', '-e', `await import(${JSON.stringify(harness)});\n${body}`];

test("with the setting on, a test process's temporary folder is a link to another folder, removed when it exits", () => {
  const run = spawnSync(
    process.execPath,
    withHarness(`
const fs = await import('node:fs'), os = await import('node:os');
const folder = os.tmpdir();
console.log(JSON.stringify({
  folder,
  link: fs.lstatSync(folder).isSymbolicLink(),
  real: fs.realpathSync.native(folder),
  temp: [process.env.TEMP, process.env.TMP, process.env.TMPDIR],
}));`),
    { cwd: root, env: linkedEnvironment(), encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(run.status, 0, run.stderr);
  const seen = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(seen.link, true, `${seen.folder} is a link.`);
  assert.notEqual(seen.real, seen.folder, 'Its real path is another spelling.');
  assert.notEqual(path.relative(seen.folder, seen.real), '', 'It leads to another folder.');
  assert.deepEqual(seen.temp, [seen.folder, seen.folder, seen.folder], 'TEMP, TMP and TMPDIR all name the link.');
  assert.ok(!fs.existsSync(seen.folder), 'The link is gone once the process exits.');
  assert.ok(!fs.existsSync(seen.real), 'So is the folder it led to.');
});

// The checks a second spelling of a folder breaks: programs started through a link, one folder by two spellings, and
// the sample studio. They run as the suite does, each file in its own process, under a link made before the runner
// starts, so the runner and every file inherit it.
const linkedChecks = ['test/entry-point.test.mjs', 'test/folder-spellings.test.mjs', 'test/sample-studio.test.mjs'];

test('the entry-point, folder-spelling and sample-studio checks pass with the temporary folder reached through a link', async () => {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      withHarness(`
const { spawnSync } = await import('node:child_process'), os = await import('node:os'), fs = await import('node:fs');
if (!fs.lstatSync(os.tmpdir()).isSymbolicLink()) throw new Error('The temporary folder is not a link.');
const run = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', ...${JSON.stringify(linkedChecks)}], { stdio: 'inherit' });
process.exitCode = run.status ?? 1;`),
      { cwd: root, env: linkedEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let text = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (text += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (text += chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, text }));
  });
  const count = name => Number(output.text.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1]);
  assert.equal(output.status, 0, output.text.slice(-6000));
  for (const name of ['fail', 'cancelled', 'skipped', 'todo']) assert.equal(count(name), 0, output.text.slice(-6000));
  assert.ok(count('pass') >= linkedChecks.length, `Every file's checks ran:\n${output.text.slice(-2000)}`);
});
