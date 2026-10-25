// A code-editing employee runs the project's tests on its own edits (v1.0 item 22). It edits staged copies
// under changes/, not a repository, so it cannot run the tests itself: it runs a small client script the
// controller allows (scripts/studio-tests.mjs), and the controller copies the story's source from the
// attempt's worktree, applies the staged edits, and runs the project's test command on the copy where
// candidate tests run (the attempt's recorded test sandbox). The request carries a token that exists only
// while the editor runs, and nothing but the test command can be run; the candidate is tested again after.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subscriptionEnvironment, command as nativeCommand } from '../adapters/process.mjs';
import { candidateTestCommand, sandboxLabel } from '../adapters/source-test-sandbox.mjs';
import { copySource, sourcePlan, sourceTestArgs, testPhaseEvidence } from './source-checks.mjs';
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

function run(executable, args, { cwd, environment, timeoutMs, tests }) {
  return new Promise(resolve => {
    const [bin, argv] = nativeCommand(executable, args);
    const child = spawn(bin, argv, { cwd, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    tests.child = child;
    let stdout = '',
      stderr = '',
      timedOut = false;
    const keep = (text, chunk, limit) => (text + chunk).slice(-limit * 3);
    child.stdout.on('data', chunk => (stdout = keep(stdout, chunk, outputLimit)));
    child.stderr.on('data', chunk => (stderr = keep(stderr, chunk, errorLimit)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', error => (stderr += `\n${error.message}`));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      tests.child = null;
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
      command = runtime.sourceCheckCommand || candidateTestCommand(runtime.codexBinary, focused, a.configuration);
    const started = new Date().toISOString(),
      result = await run(command.executable, command.args, {
        cwd: directory,
        environment,
        timeoutMs: testTimeoutMs,
        tests,
      });
    const { totals, failedTests } = testPhaseEvidence(result.stdout),
      where = runtime.sourceCheckCommand ? 'as a protocol fixture' : sandboxLabel(a.configuration),
      summary = result.timedOut
        ? `The tests ran past their ${testTimeoutMs / 60000}-minute limit and were stopped.`
        : totals
          ? `${totals.pass}/${totals.tests} tests passed${totals.fail ? `, ${totals.fail} failed` : ''} on your edits, ${where}.`
          : `The tests stopped with exit code ${result.code} before reporting totals, ${where}.`;
    (a.employeeTestRuns ||= []).push({
      startedAt: started,
      finishedAt: new Date().toISOString(),
      files: wanted,
      exitCode: result.code,
      totals,
    });
    if (a.employeeTestRuns.length > MAX_RUNS) a.employeeTestRuns.shift();
    runtime.store.updateAttempt(a);
    runtime.store.event('employee_tests', a.taskId, a.id, `The employee ran the tests on its edits: ${summary}`);
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
