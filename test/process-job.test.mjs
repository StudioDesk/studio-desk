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

test("the wrapper's test-only pause is set only by the option, never by a value the controller inherited", () => {
  const inherited = { KEEP: 'me', STUDIO_JOB_TEST_PAUSE: 'C:\\inherited\\created.pid' };
  assert.equal(jobbedCommand('node.exe', ['-v'], inherited).environment.STUDIO_JOB_TEST_PAUSE, '');
  assert.equal(
    jobbedCommand('node.exe', ['-v'], inherited, { testPause: 'p.pid' }).environment.STUDIO_JOB_TEST_PAUSE,
    'p.pid',
  );
  assert.equal(inherited.STUDIO_JOB_TEST_PAUSE, 'C:\\inherited\\created.pid', "the caller's environment is unchanged");
});

// The job wrapper exists only on Windows, so on macOS and Linux this test is not registered at all. A skip there
// counted against every verification, which accepts no skipped test, so Studio desk's own verify could not pass on
// Linux (found in the 1.2 release proof, November 4, 2026). On Windows, a job that allows no breakaway still shows
// as a skip.
if (process.platform === 'win32')
  test('on Windows a process the main process left running is ended and counted; its output and exit code pass through', async t => {
    if (!processJobsWork())
      return t.skip(
        'the job wrapper does not run here (inside a job that allows no breakaway, such as the built-in sandbox)',
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

// RF-007: the command is created already inside the wrapper's job, never suspended outside it waiting to be put there,
// so ending the wrapper at any moment ends the command too. The test-only pause holds the wrapper between creating the
// command and letting it run; the wrapper is ended there.
if (process.platform === 'win32')
  test('on Windows a command is in its job from the moment it is created, so ending the wrapper first ends it', async t => {
    if (!processJobsWork())
      return t.skip(
        'the job wrapper does not run here (inside a job that allows no breakaway, such as the built-in sandbox)',
      );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-job-pause-'));
    const pause = path.join(directory, 'created.pid');
    let commandPid = 0,
      wrapper = null;
    t.after(() => {
      // A failing run leaves nothing behind: the wrapper, if it still runs, and the suspended command are ended here
      // if the wrapper's end did not end them, even when no PID was read.
      try {
        if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill();
      } catch {}
      try {
        if (commandPid) process.kill(commandPid);
      } catch {}
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const command = jobbedCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], process.env, {
      testPause: pause,
    });
    wrapper = spawn(command.file, command.args, {
      env: command.environment,
      windowsHide: true,
      stdio: 'ignore',
    });
    const wrapperEnded = new Promise(resolve => wrapper.on('exit', (code, signal) => resolve(signal)));
    for (const until = Date.now() + 30000; !commandPid && Date.now() < until; ) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const text = fs.existsSync(pause) ? fs.readFileSync(pause, 'utf8').trim() : '';
      if (/^\d+$/.test(text)) commandPid = Number(text);
    }
    assert.ok(commandPid > 0, 'the wrapper created the command and paused');
    process.kill(commandPid, 0); // created and waiting, suspended
    // The wrapper's process alone is ended (TerminateProcess, as taskkill /F does), as Node's job ends it when the
    // controller ends; taskkill /T would also find the command by its parent's PID and end it, which a crashed
    // controller cannot do, so today's two-step creation would pass.
    assert.ok(wrapper.kill(), 'the wrapper was ended');
    let timer;
    const ended = await Promise.race([
      wrapperEnded,
      new Promise(resolve => (timer = setTimeout(resolve, 10000, 'still running'))),
    ]);
    clearTimeout(timer);
    assert.equal(ended, 'SIGTERM', 'the wrapper was ended while paused, not after it let the command run');
    let alive = true;
    for (const until = Date.now() + 10000; alive && Date.now() < until; ) {
      try {
        process.kill(commandPid, 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        alive = false;
      }
    }
    assert.equal(alive, false, 'the command created before the wrapper was ended did not outlive it');
  });

// A pause file in the controller's own environment does not reach the wrapper: it writes nothing there and lets the
// command run at once rather than holding it for 30 seconds.
if (process.platform === 'win32')
  test('on Windows an inherited test-only pause does not hold the wrapper', t => {
    if (!processJobsWork())
      return t.skip(
        'the job wrapper does not run here (inside a job that allows no breakaway, such as the built-in sandbox)',
      );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'process-job-inherited-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const pause = path.join(directory, 'created.pid');
    const command = jobbedCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'exit 37'], {
      ...process.env,
      STUDIO_JOB_TEST_PAUSE: pause,
    });
    const started = Date.now();
    const result = spawnSync(command.file, command.args, {
      env: command.environment,
      windowsHide: true,
      timeout: 25000,
      stdio: 'ignore',
    });
    assert.equal(result.status, 37, 'the command ran and its exit code passed through');
    assert.ok(Date.now() - started < 25000, 'the wrapper did not wait');
    assert.equal(fs.existsSync(pause), false, 'the wrapper wrote no PID file');
  });
