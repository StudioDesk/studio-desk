import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { subscriptionEnvironment } from './process.mjs';
import { artifactPath, validateProtectedFiles } from '../core/artifacts.mjs';
import { hash } from '../core/contracts.mjs';
import { adapterText, modelAdapter, modelMode } from '../core/execution.mjs';
import {
  copySource,
  sourcePlan,
  studioSourceRoot,
  verifyCopy,
  checkReport,
  failedTests,
  testOutput,
  testOutputLimit,
  testPhaseEvidence,
} from '../connectors/source-checks.mjs';
import { scopeDocument, scopeRequest, stagedChanges, sourceChangesConnector } from '../connectors/source-changes.mjs';
import { sourceDiff, sourceDiffFormat, sourceDiffLimit, sourceDiffStat } from '../connectors/source-diff.mjs';
import { TEXT_DELIVERY_FILES } from './text-delivery.mjs';
import {
  cleanSourceWorktrees,
  commitCandidate,
  createSourceWorktree,
  removeSourceWorktree,
  sourceWorktreeRoot,
  worktreeName,
} from '../connectors/source-worktrees.mjs';
import { candidateTestCommand, chosenTestSandbox, sandboxLabel, sandboxRecord } from './source-test-sandbox.mjs';
import { builtInSandboxReady, noBuiltInSandbox } from './built-in-sandbox.mjs';
import { installsPackages, profileOf } from '../connectors/source-profile.mjs';
import { runInstallStep } from '../connectors/package-installs.mjs';
import { git, installTimeoutMs, testTimeoutMs } from '../connectors/source-integration.mjs';
import {
  buildCommand,
  buildOutputBytes,
  buildPassed,
  buildTail,
  buildText,
  buildTimeoutMs,
  changedByBuild,
} from '../connectors/source-build.mjs';
import { continuationFile, prepareSourceContinuation } from '../core/attempt-continuation.mjs';
import { closeEmployeeTests, employeeTestsCommand, openEmployeeTests } from '../connectors/employee-tests.mjs';

const SCOPE =
  'Edit only the approved files under changes/, and create only the approved new files there. The controller owns source snapshots, candidate tests and integration. Live source, runtime records and editor tools are outside this attempt scope.';

// An isolated source change made by whichever model the employee uses. The model
// edits approved copies under changes/ through the model contract (workspace or
// text delivery); the controller then builds and measures a candidate in the test
// sandbox the director chose (the built-in sandbox once it is set up), with no model call.
export const sourceChangeAdapter = {
  id: 'source-change',
  version: 'source-change-adapter-v2',
  name: 'Isolated source change',
  workerSelectable: false,
  subscription: true,
  capabilities: ['source-change'],
  modelFor: (runtime, worker) => modelAdapter(runtime.adapters, worker),
  quotaKey: worker => worker.provider,
  initialize(runtime, options) {
    runtime.sourceChangeRoot = fs.realpathSync(options.sourceChangeRoot || studioSourceRoot);
    // When the controller develops its own installed source, integrations need a restart.
    runtime.selfHosted = runtime.sourceChangeRoot === fs.realpathSync(studioSourceRoot);
    runtime.sourceChangeFixture = !!options.sourceChangeFixture;
    runtime.sourceFormatCommand = options.sourceFormatCommand; // trusted model-free test seam, never exposed by HTTP
    runtime.packageInstallCommand = options.packageInstallCommand; // trusted model-free stand-in for npm ci, never exposed by HTTP
    runtime.sourceWorktreeRoot = options.sourceWorktreeRoot; // defaults to <data>/wt, a short path
    runtime.builtInSandbox = options.builtInSandbox || noBuiltInSandbox; // the controller's start probes this computer
  },
  status: () => ({ available: true, label: 'Isolated source edit by the employee’s model; measured candidate tests' }),
  blockReason(runtime, verifyAuth, task, worker) {
    let model;
    try {
      model = modelAdapter(runtime.adapters, worker);
    } catch (error) {
      return error.message;
    }
    // Candidate tests need no other CLI: the built-in sandbox needs only its one-time setup, and without a
    // sandbox, by the director's choice, they need nothing.
    if (chosenTestSandbox(runtime.store.organization()) === 'built-in' && !builtInSandboxReady(runtime))
      return "Candidate tests run in the built-in sandbox, and it isn't set up on this computer. Set it up under Settings → Candidate tests, or choose No sandbox there.";
    return model.blockReason(runtime, verifyAuth, task, worker);
  },
  configuration(runtime, worker, task) {
    const model = modelAdapter(runtime.adapters, worker),
      testSandbox = chosenTestSandbox(runtime.store.organization()),
      editor = model.configuration(runtime, worker, task);
    return {
      ...editor,
      // An editor with command permissions (Claude in workspace mode) may run the project's tests on its
      // edits through the controller (v1.0 item 22, connectors/employee-tests.mjs).
      ...(editor.permissions ? { permissions: { ...editor.permissions, tools: [employeeTestsCommand] } } : {}),
      testSandbox,
      executionAdapter: 'source-change',
      model: model.id,
      mode: modelMode(model, worker),
      connector: sourceChangesConnector,
    };
  },
  requestedModel: (worker, runtime) => modelAdapter(runtime.adapters, worker).requestedModel(worker),
  delivery: (worker, runtime) => adapterText(modelAdapter(runtime.adapters, worker), 'delivery', worker, runtime),
  deliveryScope: (worker, runtime) =>
    `${adapterText(modelAdapter(runtime.adapters, worker), 'deliveryScope', worker, runtime)} ${SCOPE}`,
  start(runtime, entry, worker) {
    const model = modelAdapter(runtime.adapters, worker),
      mode = modelMode(model, worker),
      scope = entry.attempt.sourceChange,
      writable = scope.allowedFiles.length + (scope.newFiles?.length || 0);
    // Text delivery returns a bounded number of files; workspace delivery has no such limit.
    if (mode === 'text' && writable > TEXT_DELIVERY_FILES)
      throw new Error(
        `This story lists ${writable} files to edit or create, and text delivery returns at most ${TEXT_DELIVERY_FILES}. Use workspace delivery for this employee or task.`,
      );
    const job = prepareSourceJob(runtime, entry);
    if (entry.attempt.configuration.permissions?.tools?.length) {
      entry.toolEnvironment = openEmployeeTests(runtime, entry);
      entry.cleanup.push(() => closeEmployeeTests(entry));
    }
    entry.model = model;
    entry.editPhase = runtime.startPhase(entry, 'source.edit');
    model.run(runtime, entry, worker, {
      mode,
      // Carried new files already exist under changes/, so they are offered for editing too.
      editable: [
        ...new Set([
          ...entry.attempt.sourceChange.allowedFiles,
          ...(entry.attempt.sourceChange.continueFrom?.files || []).map(item => item.path),
        ]),
      ].map(file => 'changes/' + file),
      context: ['source-scope.json'],
      onComplete: candidatePhase(runtime, entry, job, model.name),
    });
  },
  recordEvent: (runtime, entry, data) => entry.model?.recordEvent?.(runtime, entry, data),
};

function prepareSourceJob(runtime, entry) {
  const a = entry.attempt,
    scope = a.sourceChange,
    baseline = path.join(entry.job, 'source');
  if (!scope.base?.commit) throw new Error('This source scope has no base commit. Start a new attempt.');
  // The candidate is built in its own git worktree of the story's repository (the root its scope
  // measured), from the story's base commit (MP-016), and removed when the attempt finishes.
  cleanSourceWorktrees(runtime, sourceWorktreeRoot(runtime));
  const repository = scope.source.root,
    candidate = createSourceWorktree(
      repository,
      sourceWorktreeRoot(runtime),
      worktreeName(a.id),
      scope.base.commit,
      profileOf(scope.source),
    );
  a.sourceWorktree = { path: candidate, baseCommit: scope.base.commit };
  runtime.store.updateAttempt(a);
  entry.cleanup.push(() => removeSourceWorktree(repository, candidate));
  // The base commit holds exactly the snapshot this scope approved.
  try {
    verifyCopy(scope.source, candidate);
  } catch {
    throw new Error('The base commit does not match the approved source snapshot. Start a new attempt.');
  }
  // The read-only context copy the employee reads at ../source, from that commit: the story's line
  // may be a branch the project's folder does not have checked out (1.1 step 1).
  copySource({ ...scope.source, root: candidate }, baseline);
  for (const file of scope.allowedFiles) {
    const destination = path.join(entry.output, 'changes', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(baseline, file), destination);
  }
  // New files are written at changes/<path>; files listed for deletion are not staged.
  for (const file of scope.newFiles || [])
    fs.mkdirSync(path.dirname(path.join(entry.output, 'changes', file)), { recursive: true });
  // A story continues from the verified work of its latest stopped attempt (continueFrom), applied
  // over the seeded source copies; the candidate stays the whole change against this base. Work
  // whose source was committed since is merged onto this base by git (October 27).
  const previous = scope.continueFrom && runtime.store.attempt(scope.continueFrom.attemptId),
    setAside = merged => {
      if (merged.setAside.length)
        runtime.store.event(
          'merge_set_aside',
          a.taskId,
          a.id,
          `Git could not apply the earlier change to ${merged.setAside.join(', ')}: a file deleted on one side and changed on the other. merge-set-aside.json tells the editor why for each.`,
        );
    };
  if (scope.continueFrom?.merge)
    setAside(mergeContinuedWork(runtime.store, previous, scope.continueFrom, candidate, entry.output));
  else
    for (const item of scope.continueFrom?.files || [])
      fs.writeFileSync(
        path.join(entry.output, 'changes', item.path),
        continuationFile(runtime.store, previous, 'changes/' + item.path, item.hash),
      );
  // Earlier edits to a file the source deleted since are set aside for the editor.
  if (scope.continueFrom?.setAside?.length) {
    const kept = scope.continueFrom.setAside.map(item => ({
      path: item.path,
      reason: deletedReason(item.path),
      content: continuationFile(runtime.store, previous, 'changes/' + item.path, item.hash),
    }));
    setAsideFiles(entry.output, kept);
    setAside({ setAside: kept.map(item => item.path) });
  }
  // A story merged onto the current source (1.1 step 3) starts from its earlier change applied to this base by git.
  if (scope.merge) setAside(mergeEarlierChange(scope.merge, candidate, entry.output));
  // Neither development AGENTS.md nor the full source tree is placed inside
  // the employee's writable workspace. Retain the job-local instruction scope.
  const scopeFile = path.join(entry.output, 'source-scope.json'),
    scopeText = JSON.stringify(scopeDocument(scope), null, 2);
  fs.writeFileSync(scopeFile, scopeText);
  entry.protectedFiles.set(scopeFile, hash(scopeText));
  // Recovery metadata is controller-owned and never a deliverable or permission.
  // An unavailable checkpoint must not prevent an otherwise valid dispatch.
  try {
    prepareSourceContinuation(runtime.store, a);
  } catch (error) {
    runtime.store.event(
      'continuation_checkpoint',
      a.taskId,
      a.id,
      JSON.stringify({ status: 'unavailable', issues: [error.message] }),
    );
  }
  return { baseline, candidate, startedAt: new Date().toISOString() };
}

// Applies a story's earlier change to the candidate worktree's base with git, as integration applies it, copies the
// merged files it changed into changes/ (the parts git could not combine marked in them) and resets the worktree, which
// the candidate is built in. A file git cannot mark, deleted on one side and changed on the other, is set aside for the
// editor rather than stopping the story (October 27): merge-set-aside.json says why for each, and the change's version
// of a file the current source deleted is under merge-set-aside/ for reference. Returns the marked and set-aside files.
function mergeEarlierChange(merge, worktree, output) {
  try {
    try {
      git(worktree, ['cherry-pick', '--no-commit', merge.candidateCommit]);
    } catch {}
    const unmerged = git(worktree, ['status', '--porcelain', '-z', '--untracked-files=no'], { raw: true })
        .split('\0')
        .filter(entry => /^(DD|AU|UD|UA|DU|AA|UU) /.test(entry))
        .map(entry => ({ state: entry.slice(0, 2), file: entry.slice(3) })),
      setAside = [];
    for (const { state, file } of unmerged)
      if (['DU', 'UA'].includes(state))
        setAside.push({
          path: file,
          reason: deletedReason(file),
          content: git(worktree, ['show', `:3:${file}`], { raw: true }),
        });
      else if (['UD', 'AU'].includes(state))
        setAside.push({
          path: file,
          reason: `${file} changed on the current source since your change deleted it, and stays deleted. Read ../source/${file} for what changed there, and carry anything still needed into the approved files.`,
        });
    const away = new Set(setAside.map(item => item.path));
    for (const file of merge.files) {
      const source = path.join(worktree, file),
        target = path.join(output, 'changes', file);
      if (away.has(file) || !fs.existsSync(source)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
    setAsideFiles(output, setAside);
    return {
      conflicts: unmerged.filter(item => ['UU', 'AA'].includes(item.state)).map(item => item.file),
      setAside: [...away],
    };
  } finally {
    git(worktree, ['reset', '--hard', '--quiet']);
  }
}
// Why a file the current source deleted since is set aside, and what the editor does with it.
const deletedReason = file =>
  `The current source deleted ${file} since; your change to it is under merge-set-aside/${file} for reference. Carry what is still needed into the approved files, or leave it out.`;
// Lists files git could not apply earlier work to in merge-set-aside.json, after any listed already, and keeps the
// change's version of a deleted file under merge-set-aside/.
function setAsideFiles(output, entries) {
  if (!entries.length) return;
  const list = path.join(output, 'merge-set-aside.json'),
    listed = fs.existsSync(list) ? JSON.parse(fs.readFileSync(list, 'utf8')) : [];
  for (const entry of entries)
    if (entry.content !== undefined) {
      const target = path.join(output, 'merge-set-aside', entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.content);
    }
  fs.writeFileSync(
    list,
    JSON.stringify([...listed, ...entries.map(entry => ({ path: entry.path, reason: entry.reason }))], null, 2),
  );
}
// Earlier work whose source was committed since (continueFrom.merge, October 27) is applied to this base as a change
// merged onto the current source is: its files on that attempt's own base make a commit, outside any working tree and
// with an index of its own, which mergeEarlierChange applies here.
function mergeContinuedWork(store, previous, carried, worktree, output) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-continue-')),
    index = path.join(folder, 'index'),
    base = carried.merge.base;
  try {
    plumbing(worktree, ['read-tree', base], { index });
    for (const item of carried.files) {
      const blob = plumbing(worktree, ['hash-object', '-w', '--stdin'], {
          input: continuationFile(store, previous, 'changes/' + item.path, item.hash),
        }),
        mode = plumbing(worktree, ['ls-tree', base, '--', item.path]).split(/\s/)[0] || '100644';
      plumbing(worktree, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${item.path}`], { index });
    }
    const tree = plumbing(worktree, ['write-tree'], { index }),
      commit = plumbing(worktree, ['commit-tree', tree, '-p', base, '-m', `Earlier work of ${previous.id}`]);
    return mergeEarlierChange(
      { candidateCommit: commit, files: carried.files.map(item => item.path) },
      worktree,
      output,
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
// git for building that commit: an index file of its own when given, input on stdin, and a fixed identity, since the
// commit is never on a branch.
function plumbing(cwd, args, { index, input } = {}) {
  const result = spawnSync('git', ['--literal-pathspecs', '-c', 'core.longpaths=true', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {
      ...process.env,
      ...(index ? { GIT_INDEX_FILE: index } : {}),
      GIT_AUTHOR_NAME: 'Studio desk',
      GIT_AUTHOR_EMAIL: 'studio-desk@localhost',
      GIT_COMMITTER_NAME: 'Studio desk',
      GIT_COMMITTER_EMAIL: 'studio-desk@localhost',
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || '').trim().slice(0, 500)}`);
  return result.stdout.trim();
}
// The lines git writes around a part it could not combine.
const conflictMarkers = /^(<{7}|>{7})( |$)/m;

// Carried work stays part of the change even when the editor does not return it, unless the
// editor restored the file to its source bytes or removed a carried new file. A merged change's
// files are carried the same way.
function withCarriedWork(scope, result, output, baseline) {
  const returned = new Set(result.artifacts.map(item => item.path)),
    carried = [
      ...(scope.continueFrom?.files || []),
      ...(scope.merge?.files || []).map(file => ({ path: file })),
    ].filter(({ path: file }) => {
      const staged = path.join(output, 'changes', file),
        original = path.join(baseline, file);
      return (
        !returned.has('changes/' + file) &&
        fs.existsSync(staged) &&
        (!fs.existsSync(original) || !fs.readFileSync(staged).equals(fs.readFileSync(original)))
      );
    });
  return carried.length
    ? {
        ...result,
        artifacts: [
          ...result.artifacts,
          ...carried.map(item => ({ path: 'changes/' + item.path, kind: 'source-file' })),
        ],
      }
    : result;
}

// After the editing CLI stops: apply the edits to the attempt's worktree, commit them as the
// candidate and measure the fixed test suite there in its recorded test sandbox, under the same reservations.
function candidatePhase(runtime, entry, { baseline, candidate, startedAt }, editor) {
  const a = entry.attempt,
    scope = a.sourceChange;
  return function (result, exitCode, signal) {
    closeEmployeeTests(entry);
    runtime.store.finishPhase(entry.editPhase, result?.outcome === 'completed' ? 'succeeded' : 'blocked');
    // A blocked attempt keeps its carried work too, so a later edit can continue from it.
    if (['completed', 'blocked'].includes(result?.outcome) && Array.isArray(result.artifacts))
      result = withCarriedWork(scope, result, entry.output, baseline);
    if (result?.outcome !== 'completed') {
      // A blocked editor may name the paths it needs; the director decides (MP-021).
      const request =
        result?.outcome === 'blocked' &&
        Array.isArray(result.artifacts) &&
        scopeRequest(scope, result, name => fs.readFileSync(artifactPath(runtime.store, a, name)));
      if (request) a.scopeRequest = request;
      runtime.finish(entry, result);
      return;
    }
    if (result.taskId !== a.taskId) throw new Error('Source edit belongs to another assignment.');
    validateProtectedFiles(entry);
    const changes = stagedChanges(scope, result, name => fs.readFileSync(artifactPath(runtime.store, a, name)));
    // A merged change goes no further while any part git could not combine is still marked (1.1 step 3), nor does
    // earlier work git merged onto the current source (October 27).
    if (scope.merge || scope.continueFrom?.merge) {
      const marked = changes.filter(
        item =>
          item.afterHash !== null &&
          conflictMarkers.test(fs.readFileSync(artifactPath(runtime.store, a, item.artifact), 'utf8')),
      );
      if (marked.length)
        throw new Error(
          `Conflict markers remain in ${marked.map(item => item.path).join(', ')}. Resolve every conflict between the current source and the earlier change, remove the markers and return the files.`,
        );
    }
    a.sourceEditExecution = {
      taskId: a.taskId,
      attemptId: a.id,
      pid: a.pid,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      signal,
      fixture: runtime.sourceChangeFixture,
    };
    // Neither the read-only context nor the worktree may have changed; never a second live-source read.
    verifyCopy(scope.source, baseline);
    verifyCopy(scope.source, candidate);
    // The change is bounded by its diff, which is what the independent reviewer reads (MP-016 slice 2).
    const staged = item => fs.readFileSync(artifactPath(runtime.store, a, item.artifact), 'utf8'),
      diff = sourceDiff(
        changes.map(item => ({
          path: item.path,
          before: item.beforeHash === null ? null : fs.readFileSync(path.join(baseline, item.path), 'utf8'),
          after: item.afterHash === null ? null : staged(item),
        })),
      ),
      diffBytes = Buffer.byteLength(diff);
    if (diffBytes > sourceDiffLimit)
      throw new Error(
        `The change's diff is ${Math.ceil(diffBytes / 1024)} KiB; a candidate review reads at most ${sourceDiffLimit / 1024} KiB. Split the story into smaller stories.`,
      );
    const commitPhase = runtime.startPhase(entry, 'candidate.commit');
    for (const item of changes) {
      const target = path.join(candidate, item.path);
      if (item.afterHash === null) fs.rmSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(artifactPath(runtime.store, a, item.artifact), target);
      }
    }
    const commit = commitCandidate(
      candidate,
      changes.map(item => item.path),
      a.id,
      runtime.store.task(a.taskId).title,
    );
    runtime.store.finishPhase(commitPhase, 'succeeded', { commit });
    a.sourceCandidate = { ...sourcePlan(candidate, profileOf(scope.source)), commit, diffStat: sourceDiffStat(diff) };
    a.sourceCandidate.command = candidateTestCommand(a.sourceCandidate, a.configuration);
    // The project's build, when its settings name one, runs before the tests and is wrapped as they are (1.1).
    const build = buildCommand(profileOf(scope.source));
    if (build)
      a.sourceCandidate.build = candidateTestCommand({ root: a.sourceCandidate.root, command: build }, a.configuration);
    a.sourceCandidate.sandbox = sandboxRecord(a.configuration);
    runtime.store.updateAttempt(a);
    const manifest = {
      schemaVersion: 'source-change-v1',
      proposal: scope.proposalReference,
      baseHash: scope.source.sourceHash,
      candidateHash: a.sourceCandidate.sourceHash,
      changes,
      diffFormat: sourceDiffFormat,
    };
    fs.writeFileSync(path.join(entry.output, 'source-change.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(entry.output, 'change.diff'), diff);
    // The story's time limit bounds the editor and ends when it stops. The controller's install and
    // candidate tests then get the limits integration verification uses, so a long edit never leaves
    // them no time (v1.0 tally row 7). The reservations stay held throughout.
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => {
        entry.timedOut = true;
        runtime.stop(a.id);
      },
      runtime.candidateTimeoutMs ?? installTimeoutMs + (build ? buildTimeoutMs : 0) + testTimeoutMs,
    );
    runtime.store.event(
      'candidate_checks',
      a.taskId,
      a.id,
      `${editor} stopped. Controller testing the isolated candidate; employee and source reservations remain held.`,
    );
    const command = runtime.sourceCheckCommand || a.sourceCandidate.command,
      environment = subscriptionEnvironment();
    for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
    // Only the copied test harness consumes this marker. Controller runtime
    // code never selects a termination policy from an environment variable.
    environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
    // The candidate gets its installed packages first (MP-026), then its build (1.1), then the tests run on it.
    const tests = () => {
      let stdout = '',
        stderr = '';
      const testPhase = runtime.startPhase(entry, 'test', () => {
        a.testEvidence = testPhaseEvidence(stdout);
        a.failedTests = a.testEvidence.failedTests;
        fs.writeFileSync(path.join(entry.output, 'test-output.txt'), stdout);
        fs.writeFileSync(path.join(entry.output, 'test-errors.txt'), stderr);
        return a.testEvidence;
      });
      const checkStarted = new Date().toISOString();
      runtime.runNative(
        entry,
        command.executable,
        command.args,
        '',
        (code, checkSignal) => {
          verifyCopy(a.sourceCandidate, candidate);
          if (Buffer.byteLength(stdout + stderr) > 192 * 1024)
            throw new Error('Candidate test evidence exceeds 192 KB.');
          a.checkExecution = {
            taskId: a.taskId,
            attemptId: a.id,
            pid: a.pid,
            startedAt: checkStarted,
            finishedAt: new Date().toISOString(),
            exitCode: code,
            signal: checkSignal,
            fixture: !!runtime.sourceCheckCommand,
          };
          const report = checkReport(a.sourceCandidate, a.checkExecution, stdout, stderr, built),
            { totals } = report,
            testsPassed =
              code === 0 && !checkSignal && !totals.fail && !totals.cancelled && !totals.skipped && !totals.todo,
            buildSentence = report.build
              ? report.build.passed
                ? 'the build passed; '
                : `the build failed (${built.execution.timedOut ? 'time limit reached' : `exit ${built.execution.exitCode ?? built.execution.signal}`}); `
              : '';
          runtime.store.finishPhase(testPhase, testsPassed ? 'succeeded' : 'failed', testPhaseEvidence(stdout));
          a.failedTests = failedTests(stdout);
          fs.writeFileSync(path.join(entry.output, 'test-output.txt'), stdout);
          fs.writeFileSync(path.join(entry.output, 'test-errors.txt'), stderr);
          fs.writeFileSync(path.join(entry.output, 'check-report.json'), JSON.stringify(report, null, 2));
          return {
            ...result,
            summary:
              `${report.passed ? 'Passing' : 'Negative'} isolated source candidate: ${buildSentence}${totals.pass}/${totals.tests} tests passed. ${result.summary}`.slice(
                0,
                4000,
              ),
            artifacts: [
              ...result.artifacts,
              { path: 'source-change.json', kind: 'source-change' },
              // The approved proposal, so the independent reviewer can compare the edits with it.
              { path: 'source-scope.json', kind: 'source-scope' },
              // The reviewer reads this diff instead of the staged copies (MP-016 slice 2).
              { path: 'change.diff', kind: 'source-change-diff' },
              { path: 'check-report.json', kind: 'source-check-report' },
              { path: 'test-output.txt', kind: 'test-log' },
              { path: 'test-errors.txt', kind: 'test-log' },
              ...(report.build ? [{ path: 'build-output.txt', kind: 'build-log' }] : []),
            ],
            checks: [
              ...result.checks,
              // A failing build's last lines, so its editor's next try reads why (1.1).
              ...(report.build
                ? [
                    {
                      name: 'Candidate build',
                      status: report.build.passed ? 'pass' : 'fail',
                      evidence: `${buildText(profileOf(scope.source))}, ${sandboxLabel(a.configuration)}: ${buildSentence.slice(0, -2)}.${report.build.passed ? '' : `\n${buildTail(built.output)}`}`,
                    },
                  ]
                : []),
              {
                name: 'Candidate Node test suite',
                status: testsPassed ? 'pass' : 'fail',
                evidence: `${a.checkExecution.fixture ? 'Protocol fixture' : `Measured candidate tests ${sandboxLabel(a.configuration)}`}: ${JSON.stringify(totals)}${totals.tests ? '' : '; no tests ran (the repository has none yet)'}`,
              },
            ],
            handoff:
              'Accept this candidate as evidence, then approve its independent review. Integration requires passing measured checks, accepted review and a separate director action.',
          };
        },
        { cwd: candidate, environment, resultOnFailure: true },
      );
      // Every byte goes to test-output-full.txt as it arrives; the reports and reviews read the bounded text
      // (testOutput), so a growing suite still reports its totals.
      const output = testOutput(testOutputLimit, path.join(entry.output, 'test-output-full.txt'));
      entry.child.stdout.on('data', chunk => {
        output.add(chunk);
        stdout = output.text();
      });
      entry.child.stderr.on('data', chunk => {
        stderr += chunk;
      });
    };
    // The build, when the settings name one, as its own phase. A failing build still lets the tests run, so the
    // editor reads both at once; a build that changes the files the settings cover stops the attempt.
    let built = null;
    const buildStep = () => {
      if (!a.sourceCandidate.build) return tests();
      const phase = runtime.startPhase(entry, 'build'),
        startedAt = new Date().toISOString();
      let output = '';
      runtime.runNative(entry, a.sourceCandidate.build.executable, a.sourceCandidate.build.args, '', () => null, {
        cwd: candidate,
        environment,
        resultOnFailure: true,
        onComplete: (outcome, code, signal) => {
          const execution = {
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: code,
            signal: signal ?? null,
            timedOut: false,
          };
          built = { execution, output };
          a.buildExecution = execution;
          runtime.store.updateAttempt(a);
          fs.writeFileSync(path.join(entry.output, 'build-output.txt'), output);
          runtime.store.finishPhase(phase, buildPassed(execution) ? 'succeeded' : 'failed');
          try {
            verifyCopy(a.sourceCandidate, candidate);
          } catch {
            throw new Error(changedByBuild);
          }
          tests();
        },
      });
      for (const channel of ['stdout', 'stderr'])
        entry.child[channel].on('data', chunk => {
          output = (output + chunk).slice(-buildOutputBytes);
        });
    };
    runInstallStep(runtime, entry, candidate, installsPackages(profileOf(scope.source)), environment, buildStep);
  };
}
