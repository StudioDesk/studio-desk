// An attempt's processes kept together on Windows (C-07, src/adapters/process-job.mjs and windows-job.ps1): the command
// line is quoted as Windows programs read it, the wrapper's inputs travel in the environment, its report is read once,
// and on a computer where the wrapper runs, a process the main process left behind, detached, is ended and counted while
// the main process's output and exit code pass through. Model-free; the tree is a Node fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  jobbedCommand,
  processJobsWork,
  quoteWindowsArgument,
  readJobReport,
  windowsCommandLine,
  windowsJobScript,
  windowsPowerShell,
} from '../src/adapters/process-job.mjs';

const tree = fileURLToPath(new URL('./fixture-process-tree.mjs', import.meta.url));

test('a command line is quoted as Windows programs read it', () => {
  assert.equal(quoteWindowsArgument(''), '""');
  assert.equal(quoteWindowsArgument('plain'), 'plain');
  assert.equal(quoteWindowsArgument('C:\\a\\b'), 'C:\\a\\b');
  assert.equal(quoteWindowsArgument('two words'), '"two words"');
  assert.equal(quoteWindowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(quoteWindowsArgument('ends\\ here\\'), '"ends\\ here\\\\"');
  assert.equal(windowsCommandLine('C:\\Program Files\\node.exe', ['-e', '1']), '"C:\\Program Files\\node.exe" -e 1');
  if (process.platform !== 'win32') return;
  // The real reader agrees: Node on Windows reads back exactly the arguments the line was made from.
  const args = ['', 'a b', 'quote " inside', 'trailing\\', 'back\\\\"slash', '{"json": ["schema", 1]}', 'é ü'];
  // cmd /s /c runs the line as given, so Node starts from exactly the command line the wrapper would hand Windows.
  const direct = spawnSync(
    process.env.ComSpec || 'cmd.exe',
    [
      '/d',
      '/s',
      '/c',
      `"${windowsCommandLine(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args])}"`,
    ],
    {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      windowsHide: true,
    },
  );
  assert.deepEqual(JSON.parse(direct.stdout), args);
});

test("the wrapper's inputs travel in the environment, and its report is read once", t => {
  const plain = jobbedCommand('node.exe', ['-v'], { KEEP: 'me' }, { enabled: false });
  assert.deepEqual(plain, { file: 'node.exe', args: ['-v'], environment: { KEEP: 'me' } });
  const wrapped = jobbedCommand(
    'C:\\Tools\\cli.exe',
    ['--json-schema', '{"a": "b"}'],
    { KEEP: 'me' },
    { report: 'r.json', keep: true },
  );
  assert.equal(wrapped.file, windowsPowerShell);
  assert.deepEqual(wrapped.args.slice(-2), ['-File', windowsJobScript]);
  assert.equal(wrapped.environment.KEEP, 'me');
  assert.equal(wrapped.environment.STUDIO_JOB_COMMAND_LINE, 'C:\\Tools\\cli.exe --json-schema "{\\"a\\": \\"b\\"}"');
  assert.equal(wrapped.environment.STUDIO_JOB_REPORT, 'r.json');
  assert.equal(wrapped.environment.STUDIO_JOB_KEEP, '1');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-job-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'report.json');
  fs.writeFileSync(report, '{"exitCode":3,"leftovers":2}');
  assert.deepEqual(readJobReport(report), { exitCode: 3, leftovers: 2 });
  assert.equal(fs.existsSync(report), false, 'read once');
  fs.writeFileSync(report, 'not json');
  assert.equal(readJobReport(report), null);
  assert.equal(readJobReport(path.join(directory, 'missing.json')), null);
  assert.equal(processJobsWork({ platform: 'linux' }), false);
});

test('on Windows a process the main process left running is ended and counted; its output and exit code pass through', async t => {
  if (process.platform !== 'win32' || !processJobsWork())
    return t.skip(
      'the job wrapper does not run here (not Windows, or inside a job that allows no breakaway, such as the built-in sandbox)',
    );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-job-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const report = path.join(directory, 'report.json'),
    command = jobbedCommand(process.execPath, [tree, 'main', directory, '7'], process.env, { report });
  const child = spawn(command.file, command.args, {
    env: command.environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 7);
  assert.equal(output.trim(), 'main done');
  const job = readJobReport(report);
  assert.equal(job.exitCode, 7);
  assert.ok(job.leftovers >= 1, JSON.stringify(job));
  const sleeper = Number(fs.readFileSync(path.join(directory, 'sleeper.pid'), 'utf8'));
  assert.throws(() => process.kill(sleeper, 0), { code: 'ESRCH' }, 'the detached sleeper was ended with the job');
});
