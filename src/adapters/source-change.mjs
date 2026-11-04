import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../git.mjs';
import { subscriptionEnvironment } from './process.mjs';
import { artifactPath, validateProtectedFiles } from '../core/artifacts.mjs';
import { hash } from '../core/contracts.mjs';
import { adapterText, modelAdapter, modelMode } from '../core/execution.mjs';
import {
  sourcePlan,
  studioSourceRoot,
  verifyCopy,
  checkReport,
  failedTests,
  testOutput,
  testOutputLimit,
  testPhaseEvidence,
} from '../connectors/source-checks.mjs';
import {
  checkScopeRequest,
  scopeDocument,
  scopeRequest,
  stagedChanges,
  sourceChangesConnector,
} from '../connectors/source-changes.mjs';
import { sourceRoot } from '../connectors/source-projects.mjs';
import { sourceDiff, sourceDiffFormat, sourceDiffLimit, sourceDiffStat } from '../connectors/source-diff.mjs';
import { TEXT_DELIVERY_FILES } from './text-delivery.mjs';
import {
  commitCandidate,
  leftoverWorktrees,
  removeSourceWorktree,
  sourceWorktreeRoot,
  worktreeName,
} from '../connectors/source-worktrees.mjs';
import { runSourceSetup } from '../connectors/source-setup.mjs';
import { candidateTestCommand, chosenTestSandbox, sandboxLabel, sandboxRecord } from './source-test-sandbox.mjs';
import { builtInSandboxCommand, builtInSandboxReady, noBuiltInSandbox } from './built-in-sandbox.mjs';
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
import { releaseTestTurn, releaseTurn, takeTestTurn, takeTurn, visualTurnResource } from '../core/test-turn.mjs';
import { notRunRecord, visualPlan } from '../connectors/visual-check.mjs';
import { startCommand } from '../connectors/try-copy.mjs';
import { fileURLToPath } from 'node:url';

// The visual check's capture, as a process of its own (1.2 step 8).
const visualCaptureRunner = fileURLToPath(new URL('./visual-capture-run.mjs', import.meta.url));

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
  // Its attempts record their setup as phases (prepareSourceJob), after the scope the controller measured before the
  // attempt existed (setup.scope), so a slow step shows in the attempt's record.
  setupPhases: true,
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
    runtime.sourceSetupHold = options.sourceSetupHold; // trusted model-free test seam, never exposed by HTTP
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
    prepareSourceJob(runtime, entry, job => {
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
    });
  },
  recordEvent: (runtime, entry, data) => entry.model?.recordEvent?.(runtime, entry, data),
  // An attempt that waited for the test turn when the controller stopped no longer waits.
  recover: (runtime, a) => {
    delete a.testTurn;
  },
};

// Sets up a story's attempt, then calls `edit` with its folders. The working copy, its snapshot check and the copies
// run in a process of their own (source-setup.mjs), so the controller keeps answering meanwhile; earlier work and the
// scope file follow here once it succeeds.
function prepareSourceJob(runtime, entry, edit) {
  const a = entry.attempt,
    scope = a.sourceChange,
    baseline = path.join(entry.job, 'source');
  if (!scope.base?.commit) throw new Error('This source scope has no base commit. Start a new attempt.');
  // The candidate is built in its own git worktree of the story's repository (the root its scope
  // measured), from the story's base commit (MP-016), and removed when the attempt finishes. Worktrees left by settled
  // attempts are listed before this one is recorded; its path and removal are recorded before the setup process
  // starts, so a stop or failure during setup still removes it.
  const repository = scope.source.root,
    parent = sourceWorktreeRoot(runtime),
    leftovers = leftoverWorktrees(runtime, parent);
  fs.mkdirSync(parent, { recursive: true });
  const candidate = path.join(fs.realpathSync(parent), worktreeName(a.id));
  a.sourceWorktree = { path: candidate, baseCommit: scope.base.commit };
  runtime.store.updateAttempt(a);
  entry.cleanup.push(() => removeSourceWorktree(repository, candidate));
  const request = {
    repository,
    parent,
    name: worktreeName(a.id),
    commit: scope.base.commit,
    profile: profileOf(scope.source),
    snapshot: scope.source,
    source: baseline,
    changes: path.join(entry.output, 'changes'),
    allowedFiles: scope.allowedFiles,
    newFiles: scope.newFiles || [],
    // The git work of removing them runs there too, when there is any.
    leftovers: leftovers.worktrees.length ? leftovers : null,
    hold: runtime.sourceSetupHold || null,
  };
  runSourceSetup(runtime, entry, request, () => edit(finishSourceJob(runtime, entry, baseline, candidate)));
}
// The rest of a story's setup, in the controller once the setup process succeeded: its earlier work, its scope file and
// its continuation record.
function finishSourceJob(runtime, entry, baseline, candidate) {
  const a = entry.attempt,
    scope = a.sourceChange;
  // A story continues from the verified work of its latest stopped attempt (continueFrom), applied
  // over the seeded source copies; the candidate stays the whole change against this base. Work
  // whose source was committed since is merged onto this base by git (October 27). The attempt records the files set
  // aside with why, outside its approved scope and hashes (mergeSetAside), so its page names them. A story with
  // neither earlier work nor a merge has nothing to apply, and records no phase for it.
  const carried = scope.continueFrom;
  if (carried?.merge || carried?.files?.length || carried?.setAside?.length || scope.merge)
    setupPhase(runtime, entry, 'setup.earlier', () => {
      const previous = carried && runtime.store.attempt(carried.attemptId),
        setAside = merged => {
          if (!merged.setAside.length) return;
          runtime.store.event(
            'merge_set_aside',
            a.taskId,
            a.id,
            `Git could not apply the earlier change to ${merged.setAside.map(item => item.path).join(', ')}: a file deleted on one side and changed on the other. merge-set-aside.json tells the editor why for each.`,
          );
          a.mergeSetAside = [...(a.mergeSetAside || []), ...merged.setAside];
          runtime.store.updateAttempt(a);
        };
      if (carried?.merge) setAside(mergeContinuedWork(runtime.store, previous, carried, candidate, entry.output));
      else
        for (const item of carried?.files || [])
          fs.writeFileSync(
            path.join(entry.output, 'changes', item.path),
            continuationFile(runtime.store, previous, 'changes/' + item.path, item.hash),
          );
      // Earlier edits to a file the source deleted since are set aside for the editor.
      if (carried?.setAside?.length) {
        const kept = carried.setAside.map(item => ({
          path: item.path,
          reason: deletedReason(item.path),
          content: continuationFile(runtime.store, previous, 'changes/' + item.path, item.hash),
        }));
        setAsideFiles(entry.output, kept);
        setAside({ setAside: kept.map(item => ({ path: item.path, reason: item.reason })) });
      }
      // A story merged onto the current source (1.1 step 3) starts from its earlier change
      // applied to this base by git.
      if (scope.merge) setAside(mergeEarlierChange(scope.merge, candidate, entry.output));
    });
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
// Runs one step of a story's setup as a phase of its attempt, which finishes failed with the step's error when it
// throws, and returns what the step returned.
function setupPhase(runtime, entry, phaseId, step) {
  const phase = runtime.startPhase(entry, phaseId);
  try {
    const value = step();
    runtime.store.finishPhase(phase, 'succeeded');
    return value;
  } catch (error) {
    runtime.store.finishPhase(phase, 'failed', { error: error.message });
    throw error;
  }
}

// Applies a story's earlier change to the candidate worktree's base with git, as integration applies it, copies the
// merged files it changed into changes/ (the parts git could not combine marked in them) and resets the worktree, which
// the candidate is built in. A file git cannot mark, deleted on one side and changed on the other, is set aside for the
// editor rather than stopping the story (October 27): merge-set-aside.json says why for each, and the change's version
// of a file the current source deleted is under merge-set-aside/ for reference. Returns the marked files, and the
// set-aside files with their reasons.
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
      setAside: setAside.map(item => ({ path: item.path, reason: item.reason })),
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
  return runGit(cwd, args, {
    input,
    env: {
      ...process.env,
      ...(index ? { GIT_INDEX_FILE: index } : {}),
      GIT_AUTHOR_NAME: 'Studio desk',
      GIT_AUTHOR_EMAIL: 'studio-desk@localhost',
      GIT_COMMITTER_NAME: 'Studio desk',
      GIT_COMMITTER_EMAIL: 'studio-desk@localhost',
    },
  });
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
      // The edit approving it is checked as Allow and continue would send it, and its refusal recorded as the problem.
      if (request)
        try {
          const task = runtime.store.task(a.taskId);
          a.scopeRequest = checkScopeRequest(runtime.store, task, request, sourceRoot(runtime.store, task, runtime));
        } catch (error) {
          a.scopeRequest = request.problem ? request : { ...request, problem: error.message };
        }
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
    // The runner is kept from the controller's own data folder, named to it, wherever the candidate is.
    const data = runtime.store.directory;
    a.sourceCandidate.command = candidateTestCommand({ ...a.sourceCandidate, data }, a.configuration);
    // The project's build, when its settings name one, runs before the tests and is wrapped as they are (1.1).
    const build = buildCommand(profileOf(scope.source));
    if (build)
      a.sourceCandidate.build = candidateTestCommand(
        { root: a.sourceCandidate.root, data, command: build },
        a.configuration,
      );
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
    // them no time (v1.0 tally row 7). The reservations stay held throughout. The limit starts again when the test
    // run takes the computer's test turn, so waiting for it never counts.
    const limitMs = runtime.candidateTimeoutMs ?? installTimeoutMs + (build ? buildTimeoutMs : 0) + testTimeoutMs;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      runtime.stop(a.id);
    }, limitMs);
    runtime.store.event(
      'candidate_checks',
      a.taskId,
      a.id,
      `${editor} stopped. Controller testing the isolated candidate; its reservations remain held.`,
    );
    const command = runtime.sourceCheckCommand || a.sourceCandidate.command,
      environment = subscriptionEnvironment();
    for (const key of Object.keys(environment)) if (/^STUDIO_/i.test(key)) delete environment[key];
    // Only the copied test harness consumes this marker. Controller runtime
    // code never selects a termination policy from an environment variable.
    environment.STUDIO_MODEL_FREE_LEAF_FIXTURES = '1';
    // The candidate waits for the computer's test turn, then, holding it, gets its installed packages (MP-026), its
    // build (1.1) and its tests: the packages are installed for one lockfile at a time in the data folder, so another
    // line's install never replaces them under a suite that is running (C-10's interim, November 2026).
    const tests = () => runTests();
    const runTests = () => {
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
          // The test run has ended; a stop or a failed start releases the turn with the attempt's other leases.
          releaseTestTurn(runtime.store, a.id);
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
        { cwd: candidate, environment, resultOnFailure: true, onComplete: result => visualStep(result, environment) },
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
    // The visual check (1.2 step 8), once the candidate's build and tests passed and the story names pages its project
    // checks: the capture runs as the next step's own process, and its images join the candidate's result.
    const visualStep = (result, environment) => {
      const plan = visualPlan(runtime.store, runtime.store.task(a.taskId), runtime);
      if (!plan || result.checks.some(check => check.status === 'fail')) return runtime.finish(entry, result, null);
      if (plan.notRun) {
        const record = notRunRecord(plan, plan.notRun);
        fs.writeFileSync(path.join(entry.output, 'visual-check.json'), JSON.stringify(record, null, 2));
        return runtime.finish(entry, withVisual(entry, result, record), null);
      }
      const planFile = path.join(entry.job, 'visual-plan.json');
      fs.writeFileSync(
        planFile,
        JSON.stringify({
          root: candidate,
          start: plan.start,
          command: builtInSandboxCommand({
            root: candidate,
            data: runtime.store.directory,
            command: startCommand(plan.start),
          }),
          place: 'built-in',
          environment,
          address: plan.address,
          browser: plan.browser,
          widths: plan.widths,
          themes: plan.themes,
          pages: plan.pages,
          out: entry.output,
          startTimeoutMs: runtime.visualStartTimeoutMs ?? 60000,
          settleMs: runtime.visualSettleMs ?? 600,
        }),
      );
      const limitMs = runtime.visualTimeoutMs ?? visualTimeoutMs;
      // One app is photographed at a time on this computer (core/test-turn.mjs); waiting for the turn does not count
      // against the capture's time.
      const capture = () => {
        const phase = runtime.startPhase(entry, 'visual');
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timedOut = true;
          runtime.stop(a.id);
        }, limitMs);
        runtime.store.event(
          'visual_check',
          a.taskId,
          a.id,
          `Capturing ${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} at ${plan.widths.join(' and ')} px in ${plan.themes.join(' and ')}, with ${plan.browser}.`,
        );
        const command = runtime.visualCaptureCommand || { executable: process.execPath, args: [visualCaptureRunner] };
        runtime.runNative(
          entry,
          command.executable,
          [...command.args, planFile],
          '',
          () => readVisualRecord(entry, plan),
          {
            cwd: entry.output,
            environment,
            resultOnFailure: true,
            onComplete: record => {
              runtime.store.finishPhase(phase, record.state === 'captured' ? 'succeeded' : 'failed', {
                images: record.images.length,
                reason: record.reason || null,
              });
              // The app has stopped with the capture; a stop or a failure releases the turn with the other leases.
              releaseTurn(runtime.store, visualTurnResource, a.id);
              runtime.finish(entry, withVisual(entry, result, record), null);
            },
          },
        );
      };
      takeTurn(runtime, entry, { resource: visualTurnResource, limitMs, start: capture });
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
    takeTestTurn(runtime, entry, {
      limitMs,
      start: () =>
        runInstallStep(runtime, entry, candidate, installsPackages(profileOf(scope.source)), environment, buildStep),
    });
  };
}

// How long the visual check's capture may take: starting the candidate, then each page at each width and theme.
const visualTimeoutMs = 10 * 60 * 1000;
// The capture's record: what it wrote, or a failed record when it wrote nothing.
function readVisualRecord(entry, plan) {
  try {
    return JSON.parse(fs.readFileSync(path.join(entry.output, 'visual-check.json'), 'utf8'));
  } catch {
    const record = { ...notRunRecord(plan, 'the capture ended without its record'), state: 'failed' };
    fs.writeFileSync(path.join(entry.output, 'visual-check.json'), JSON.stringify(record, null, 2));
    return record;
  }
}
// The candidate's result with the visual check's record, its images and a check the review and the story read. A check
// that did not run is not run, never a failure of the candidate: the reviewer judges what the images show.
function withVisual(entry, result, record) {
  const images = (record.images || []).filter(image => fs.existsSync(path.join(entry.output, image.path)));
  const problems = images.filter(image => image.problem).length;
  return {
    ...result,
    artifacts: [
      ...result.artifacts,
      { path: 'visual-check.json', kind: 'visual-check' },
      ...images.map(image => ({ path: image.path, kind: 'visual-capture' })),
    ],
    checks: [
      ...result.checks,
      {
        name: 'Visual check',
        status: record.state === 'captured' && images.length ? 'pass' : 'not-run',
        evidence:
          record.state === 'captured' && images.length
            ? `${images.length} image${images.length === 1 ? '' : 's'} with ${path.basename(record.browser || 'the browser')} at ${record.address}${problems ? `; ${problems} with a step or page problem, named in visual-check.json` : ''}.`
            : `The visual check did not run: ${record.reason || 'nothing was captured'}.${record.note ? ` ${record.note}` : ''}`,
      },
    ],
  };
}
