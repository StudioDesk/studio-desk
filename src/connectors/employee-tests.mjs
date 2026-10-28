// A code-editing employee runs the project's tests on its own edits (v1.0 item 22). It edits staged copies
// under changes/, not a repository, so it cannot run the tests itself: it runs a small client script the
// controller allows (scripts/studio-tests.mjs), and the controller copies the story's source from the
// attempt's worktree, applies the staged edits, and runs the project's test command on the copy where
// candidate tests run (the attempt's recorded test sandbox). The request carries a token that exists only
// while the editor runs, and nothing but the test command can be run; the candidate is tested again after.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { subscriptionEnvironment, command as nativeCommand } from '../adapters/process.mjs';
import { jobDirectory } from '../core/projects.mjs';
import { candidateTestCommand, sandboxLabel } from '../adapters/source-test-sandbox.mjs';
import { copySource, failedTestReader, sourcePlan, sourceTestArgs, testPhaseEvidence } from './source-checks.mjs';
import { installsPackages, profileOf } from './source-profile.mjs';
import { installStep } from './package-installs.mjs';
import { installTimeoutMs, testTimeoutMs } from './source-integration.mjs';

const script = fileURLToPath(new URL('../../scripts/studio-tests.mjs', import.meta.url))
  .split(path.sep)
  .join('/');
// The exact command the employee is told to run, which its CLI allows alone or with test file arguments.
export const employeeTestsCommand = `node ${/\s/.test(script) ? JSON.stringify(script) : script}`;
const outputLimit = 64 * 1024,
  errorLimit = 16 * 1024,
  MAX_FILES = 50,
  MAX_RUNS = 20;

// Opens the attempt's test endpoint while its editor runs; returns the variables its CLI passes to commands.
export function openEmployeeTests(runtime, entry) {
  const token = randomBytes(32).toString('base64url');
  entry.employeeTests = { token, child: null };
  return {
    STUDIO_TESTS_URL: `${runtime.controllerOrigin?.() || ''}/api/attempts/${entry.attempt.id}/tests`,
    STUDIO_TESTS_TOKEN: token,
  };
}

// Closes it when the editor stops, stopping a run still in progress.
export function closeEmployeeTests(entry) {
  const tests = entry.employeeTests;
  if (!tests) return;
  delete entry.employeeTests;
  tests.child?.kill();
}

export function employeeTestsAllowed(entry, token) {
  const expected = Buffer.from(entry?.employeeTests?.token || ''),
    given = Buffer.from(typeof token === 'string' ? token : '');
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(expected, given);
}

// The story's source with the staged edits applied: approved files and new files as they are under changes/,
// deleted files removed unless the employee kept them. Only plain files are read.
function composeCopy(runtime, a, output, directory) {
  const scope = a.sourceChange,
    worktree = fs.realpathSync(a.sourceWorktree.path);
  copySource({ ...scope.source, root: worktree }, directory);
  for (const file of [...scope.allowedFiles, ...(scope.newFiles || []), ...(scope.deleteFiles || [])]) {
    const staged = path.join(output, 'changes', file),
      target = path.join(directory, file);
    let stat = null;
    try {
      stat = fs.lstatSync(staged);
    } catch {}
    if (stat && !stat.isFile()) throw new Error(`changes/${file} is not a plain file.`);
    if (stat) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(staged, target);
    } else if ((scope.deleteFiles || []).includes(file)) fs.rmSync(target, { force: true });
  }
  return sourcePlan(directory, profileOf(scope.source));
}

// Each test run's whole output and errors are saved in the attempt's job folder, outside output/, so the editor
// does not change them and they are not staged: test-runs/<number>-output.txt and <number>-errors.txt.
const SAVED = ['output', 'errors'];
const runFolder = (store, attempt) => path.join(jobDirectory(store, attempt), 'test-runs'),
  // Runs recorded before runs were saved have no number.
  runNumber = run => (Number.isSafeInteger(run.number) && run.number > 0 ? run.number : null);
function runFile(store, attempt, number, name) {
  if (!runNumber({ number }) || !SAVED.includes(name)) throw new Error('Invalid test run file.');
  return path.join(runFolder(store, attempt), `${number}-${name}.txt`);
}

// Writes one stream of a run to its file as it arrives, counting its bytes and SHA-256, so nothing but the
// reply's tail is held. A file that cannot be written is dropped, and the run is recorded without it.
function savedStream(file) {
  const digest = createHash('sha256');
  let fd = null,
    bytes = 0;
  const drop = () => {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.rmSync(file, { force: true });
    } catch {}
    fd = null;
  };
  try {
    // Created anew, never through a link left in its place.
    fs.rmSync(file, { force: true });
    fd = fs.openSync(file, 'wx');
  } catch {}
  return {
    write(chunk) {
      if (fd === null) return;
      try {
        for (let offset = 0; offset < chunk.length; ) offset += fs.writeSync(fd, chunk, offset);
      } catch {
        return drop();
      }
      bytes += chunk.length;
      digest.update(chunk);
    },
    close() {
      if (fd === null) return undefined;
      try {
        fs.closeSync(fd);
      } catch {
        return drop();
      }
      fd = null;
      return { bytes, hash: digest.digest('hex') };
    },
  };
}

function saveRun(store, attempt, number) {
  const folder = runFolder(store, attempt);
  let plain = false;
  try {
    fs.mkdirSync(folder, { recursive: true });
    plain = fs.lstatSync(folder).isDirectory();
  } catch {}
  const [output, errors] = SAVED.map(name =>
    plain ? savedStream(runFile(store, attempt, number, name)) : { write() {}, close() {} },
  );
  return { output, errors, close: () => ({ output: output.close(), errors: errors.close() }) };
}

function removeSavedRun(store, attempt, run) {
  if (!runNumber(run)) return;
  for (const name of SAVED)
    try {
      fs.rmSync(runFile(store, attempt, run.number, name), { force: true });
    } catch {}
}

// The saved output or errors of one of the attempt's test runs, as a plain file whose bytes still match its
// record; the server streams it. 404 when no run has the number or it was recorded without the file.
export async function savedTestRun(store, attempt, number, name) {
  const run = (attempt.employeeTestRuns || []).find(item => item.number === number),
    saved = SAVED.includes(name) ? run?.[name] : null;
  if (typeof saved?.hash !== 'string')
    throw Object.assign(new Error('This test run has no saved file of that name.'), { status: 404 });
  const file = runFile(store, attempt, number, name),
    digest = createHash('sha256');
  let matches = false;
  try {
    if (fs.lstatSync(runFolder(store, attempt)).isDirectory() && fs.lstatSync(file).isFile()) {
      for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
      matches = digest.digest('hex') === saved.hash;
    }
  } catch {}
  if (!matches)
    throw Object.assign(new Error('The saved test run was changed after its run was recorded.'), { status: 409 });
  return file;
}

function run(executable, args, { cwd, environment, timeoutMs, tests, reader, saved }) {
  return new Promise(resolve => {
    const [bin, argv] = nativeCommand(executable, args);
    const child = spawn(bin, argv, { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    tests.child = child;
    let stdout = '',
      stderr = '',
      timedOut = false;
    const keep = (text, chunk, limit) => (text + chunk).slice(-limit * 3),
      decoder = new StringDecoder('utf8'),
      read = text => {
        stdout = keep(stdout, text, outputLimit);
        reader?.push(text);
      };
    // Only the tail is kept, so the failed tests are read from every chunk as it arrives, and a saved run's
    // bytes are written to disk as they arrive.
    child.stdout.on('data', chunk => {
      saved?.output.write(chunk);
      read(decoder.write(chunk));
    });
    child.stderr.on('data', chunk => {
      saved?.errors.write(chunk);
      stderr = keep(stderr, chunk, errorLimit);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', error => {
      saved?.errors.write(Buffer.from(`\n${error.message}`));
      stderr += `\n${error.message}`;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      tests.child = null;
      const rest = decoder.end();
      if (rest) read(rest);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

// One run: install the packages the copy needs, as candidate tests do, then the test command, the whole
// suite or the named test files. Returns what the client prints.
export async function runEmployeeTests(runtime, entry, { files = [] } = {}) {
  const tests = entry.employeeTests,
    a = entry.attempt;
  if (!tests) throw Object.assign(new Error('This attempt cannot run tests now.'), { status: 403 });
  if (tests.child || tests.busy)
    throw Object.assign(new Error('A test run is already in progress for this attempt.'), { status: 409 });
  if (!Array.isArray(files) || files.length > MAX_FILES || files.some(file => typeof file !== 'string'))
    throw Object.assign(new Error(`Name at most ${MAX_FILES} test files, or none for the whole suite.`), {
      status: 400,
    });
  tests.busy = true;
  const directory = path.join(runtime.store.directory, 'tests', a.id.slice(-8));
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    const plan = composeCopy(runtime, a, entry.output, directory),
      suite = plan.command.args.slice(sourceTestArgs([]).length),
      wanted = files.map(file => file.trim().replaceAll('\\', '/').replace(/^\.\//, ''));
    const unknown = wanted.filter(file => !suite.includes(file));
    if (unknown.length)
      throw Object.assign(
        new Error(
          `Not test files of this project: ${unknown.join(', ')}. Test files: ${suite.slice(0, 20).join(', ')}.`,
        ),
        { status: 400 },
      );
    const environment = subscriptionEnvironment();
    for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
    // As for candidate tests: only the copied test harness reads this marker.
    environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
    const install = installStep(runtime, directory, installsPackages(profileOf(a.sourceChange.source)));
    if (install) {
      const installed = await run(install.executable, install.args, {
        cwd: directory,
        environment,
        timeoutMs: installTimeoutMs,
        tests,
      });
      if (installed.code !== 0)
        return {
          exitCode: installed.code ?? 1,
          summary: 'Installing the packages failed, so no tests ran.',
          output: '',
          errors: installed.stderr.slice(-errorLimit),
        };
    }
    const focused = { ...plan, command: { ...plan.command, args: sourceTestArgs(wanted.length ? wanted : suite) } },
      command = runtime.sourceCheckCommand || candidateTestCommand(focused, a.configuration);
    // A run's number increases across the attempt and stays its own when the oldest runs are dropped.
    const reader = failedTestReader(),
      started = new Date().toISOString(),
      number = Math.max(0, ...(a.employeeTestRuns || []).map(run => runNumber(run) || 0)) + 1,
      saved = saveRun(runtime.store, a, number);
    let result, kept;
    try {
      result = await run(command.executable, command.args, {
        cwd: directory,
        environment,
        timeoutMs: testTimeoutMs,
        tests,
        reader,
        saved,
      });
    } finally {
      // A run stopped early (its time limit, the editor stopping, the client leaving) keeps what it printed.
      kept = saved.close();
    }
    // The TAP totals are at the end, in the kept tail; an early failure in a long run is only in what the reader read.
    const { totals } = testPhaseEvidence(result.stdout),
      failedTests = reader.finish(),
      where = runtime.sourceCheckCommand ? 'as a protocol fixture' : sandboxLabel(a.configuration),
      summary = result.timedOut
        ? `The tests ran past their ${testTimeoutMs / 60000}-minute limit and were stopped.`
        : totals
          ? `${totals.pass}/${totals.tests} tests passed${totals.fail ? `, ${totals.fail} failed` : ''} on your edits, ${where}.`
          : `The tests stopped with exit code ${result.code} before reporting totals, ${where}.`;
    (a.employeeTestRuns ||= []).push({
      number,
      startedAt: started,
      finishedAt: new Date().toISOString(),
      files: wanted,
      exitCode: result.code,
      totals,
      failedTests,
      ...(kept.output ? { output: kept.output } : {}),
      ...(kept.errors ? { errors: kept.errors } : {}),
    });
    const dropped = a.employeeTestRuns.splice(0, Math.max(0, a.employeeTestRuns.length - MAX_RUNS));
    runtime.store.updateAttempt(a);
    // A dropped run's saved files go once its record no longer names them.
    for (const old of dropped) removeSavedRun(runtime.store, a, old);
    const first = failedTests.length ? ` First failed: ${failedTests[0].name}` : '';
    runtime.store.event(
      'employee_tests',
      a.taskId,
      a.id,
      `The employee ran the tests on its edits: ${summary}${first}`,
    );
    return {
      exitCode: result.timedOut ? 1 : result.code,
      summary,
      totals,
      failedTests,
      output: result.stdout.slice(-outputLimit),
      errors: result.stderr.slice(-errorLimit),
    };
  } finally {
    tests.busy = false;
    // A stopped run's files may still be held for a moment on Windows; the next run clears them first.
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {}
  }
}
