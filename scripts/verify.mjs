// Tests a commit exactly as the pipeline will, so one run here stands for the pipeline's own (npm run verify).
// It uses the controller's own steps in a data folder of its own beside the code (.studio-verify, which git
// ignores): the commit checked out in a worktree, the packages installed from its lockfile as the pipeline
// installs them, and the plan's fixed test command in a candidate's environment. It makes no model call.
//   --as candidate (the default): as candidate tests and the check before merging run, in a worktree and in
//     the test sandbox that Settings → Candidate tests names (--sandbox codex, the default, or none).
//   --as checks: as an idea's first checks run, on a copy of the commit at a job's depth, with no sandbox.
// Usage: npm run verify -- [--as candidate|checks] [--sandbox codex|none] [commit]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// The runner first: the adapters reach each other through it.
import { locateCodex, subscriptionEnvironment } from '../src/runner.mjs';
import { command as nativeCommand } from '../src/adapters/process.mjs';
import { candidateTestCommand, sandboxLabel, testSandboxes } from '../src/adapters/source-test-sandbox.mjs';
import { sourcePlan, studioSourceRoot, testPhaseEvidence, verifyCopy } from '../src/connectors/source-checks.mjs';
import { git, installTimeoutMs, testTimeoutMs } from '../src/connectors/source-integration.mjs';
import { installsPackages, snapshotPaths, studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { installStep, packageBoundary } from '../src/connectors/package-installs.mjs';
import { createSourceWorktree, removeSourceWorktree, worktreeName } from '../src/connectors/source-worktrees.mjs';
import { snapshotCommit } from '../src/adapters/source-snapshot.mjs';

const usage = 'Usage: npm run verify -- [--as candidate|checks] [--sandbox codex|none] [commit]';
const options = { as: 'candidate', sandbox: 'codex', commit: 'HEAD' };
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === '--as' || argument === '--sandbox') options[argument.slice(2)] = process.argv[++i];
  else if (argument.startsWith('-')) fail(usage);
  else options.commit = argument;
}
if (!['candidate', 'checks'].includes(options.as) || !testSandboxes.includes(options.sandbox)) fail(usage);

const root = studioSourceRoot,
  profile = studioDeskProfile,
  data = path.join(root, '.studio-verify'),
  id = 'attempt-' + randomUUID();
let commit;
try {
  commit = git(root, ['rev-parse', '--verify', `${options.commit}^{commit}`]);
} catch {
  fail(`${options.commit} is not a commit in ${root}.`);
}
if (git(root, ['status', '--porcelain', '--', ...snapshotPaths(profile)]))
  console.log(`Testing commit ${commit.slice(0, 8)}; uncommitted changes are not part of it.`);

// Where the tests run, as the pipeline records it on an attempt.
const configuration =
  options.as === 'checks'
    ? { testSandbox: 'none' }
    : {
        testSandbox: options.sandbox,
        ...(options.sandbox === 'codex' && process.platform === 'win32'
          ? { windowsSandbox: process.env.STUDIO_CODEX_WINDOWS_SANDBOX ?? 'mxc' }
          : {}),
      };
const codex = configuration.testSandbox === 'codex' ? locateCodex() : null;
if (configuration.testSandbox === 'codex' && !codex)
  fail('Codex CLI was not found. Install it, or add --sandbox none if Settings → Candidate tests is No sandbox.');

fs.mkdirSync(data, { recursive: true });
packageBoundary(data);
const environment = subscriptionEnvironment();
for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];

let copy, plan, cleanup;
if (options.as === 'checks') {
  // An idea's checks measure the commit in a worktree, test a copy of it in the job folder, and set no marker.
  copy = path.join(data, 'projects', 'project-studio-desk', 'jobs', id, 'source');
  plan = snapshotCommit(root, path.join(data, 'wt'), 'c-' + worktreeName(id), { commit }, copy, undefined, profile);
  cleanup = () => fs.rmSync(path.join(data, 'projects'), { recursive: true, force: true });
} else {
  // A candidate and the check before merging test a worktree, and only the copied test harness reads the marker.
  copy = createSourceWorktree(root, path.join(data, 'wt'), 'v-' + worktreeName(id), commit, profile);
  plan = sourcePlan(copy, profile);
  environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
  cleanup = () => removeSourceWorktree(root, copy);
}

let child = null;
process.on('SIGINT', () => {
  child?.kill();
  process.exitCode = 130;
});
try {
  const install = installStep({ store: { directory: data } }, copy, installsPackages(profile));
  if (install && (await run(install.executable, install.args, installTimeoutMs, false)).code !== 0)
    throw new Error('Installing the packages failed, so no tests ran.');
  const test = options.as === 'checks' ? plan.command : candidateTestCommand(codex, plan, configuration),
    where =
      options.as === 'checks'
        ? "without a sandbox, as an idea's checks run"
        : `${sandboxLabel(configuration)}, as candidate tests run`,
    started = Date.now();
  console.log(`Testing ${commit.slice(0, 8)} ${where}.`);
  const result = await run(test.executable, test.args, testTimeoutMs, true);
  fs.writeFileSync(path.join(data, 'last-run.tap'), result.stdout);
  fs.writeFileSync(path.join(data, 'last-run-errors.txt'), result.stderr);
  if (options.as === 'checks') verifyCopy(plan, copy);
  else if (sourcePlan(copy, profile).sourceHash !== plan.sourceHash)
    throw new Error('A test changed the tested source.');
  const { totals, failedTests } = testPhaseEvidence(result.stdout),
    minutes = ((Date.now() - started) / 60000).toFixed(1);
  // Passing is what integration verification counts as passing.
  const passed =
    !!totals &&
    result.code === 0 &&
    !result.timedOut &&
    totals.fail + totals.cancelled + totals.skipped + totals.todo === 0 &&
    totals.pass === totals.tests;
  for (const failed of failedTests)
    console.log(`  failed: ${failed.name} (${failed.file})${failed.error ? `: ${failed.error}` : ''}`);
  console.log(
    result.timedOut
      ? `The tests ran past their ${testTimeoutMs / 60000}-minute limit and were stopped.`
      : totals
        ? `${totals.pass} of ${totals.tests} passed${totals.fail ? `, ${totals.fail} failed` : ''}${totals.cancelled ? `, ${totals.cancelled} cancelled` : ''} in ${minutes} minutes.`
        : `The tests stopped with exit code ${result.code} before reporting totals.`,
  );
  if (!passed) console.log(`The whole report is in ${path.join(data, 'last-run.tap')}.`);
  process.exitCode ||= passed ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode ||= 1;
} finally {
  try {
    cleanup();
  } catch (error) {
    console.error(`The tested copy could not be removed: ${error.message}`);
  }
}

// Runs one step in the tested copy. The install prints its own lines; the tests' TAP is kept, with each
// failure shown as it comes and the count once a minute.
function run(executable, args, timeoutMs, report) {
  return new Promise(resolve => {
    const [bin, argv] = nativeCommand(executable, args);
    child = spawn(bin, argv, {
      cwd: copy,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', report ? 'pipe' : 'inherit', report ? 'pipe' : 'inherit'],
    });
    let stdout = '',
      stderr = '',
      partial = '',
      count = 0,
      timedOut = false;
    const progress = report && setInterval(() => console.log(`  ${count} tests reported`), 60000);
    child.stdout?.on('data', chunk => {
      stdout += chunk;
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        if (/^(?:not )?ok \d+ - /.test(line)) count++;
        if (/^not ok \d+ - /.test(line)) console.log(`  ${line}`);
      }
    });
    child.stderr?.on('data', chunk => (stderr += chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', error => (stderr += `\n${error.message}`));
    child.on('close', code => {
      clearTimeout(timer);
      clearInterval(progress);
      child = null;
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
