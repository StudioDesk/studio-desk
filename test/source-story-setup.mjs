// The Studio desk source-story fixture: a disposable git repository, seeded measured checks, a
// review proposal and breakdown helpers, with model-free CLI and test fixtures. Shared by
// test/source-changes.test.mjs and test/story-edits.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { sourcePlan, sourceContext, checkReport } from '../src/connectors/source-checks.mjs';
import { hash } from '../src/core/contracts.mjs';
import { stageProposedWork, approveWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { measuredSourceEvidence } from '../src/connectors/source-changes.mjs';
import { git, commitIntegration } from '../src/connectors/source-integration.mjs';
import { waitFor, waitForTask } from './wait-for.mjs';

const cli = fileURLToPath(new URL('./fixture-source-edit.mjs', import.meta.url)),
  tests = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url)),
  formatter = fileURLToPath(new URL('./fixture-format.mjs', import.meta.url));

export async function setup(
  t,
  checkMode = 'pass',
  allowedFiles = ['src/core/workflows.mjs'],
  runnerOptions = {},
  backendOnly = false,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-source-edit-')),
    root = path.join(directory, 'repository');
  fs.mkdirSync(root);
  for (const folder of ['src/core', 'public', 'test', 'scripts', 'docs'])
    fs.mkdirSync(path.join(root, folder), { recursive: true });
  for (const file of [
    'package.json',
    'AGENTS.md',
    'HANDOFF.md',
    'README.md',
    'start-studio.cmd',
    'start-studio.sh',
    'package-lock.json',
    'tsconfig.json',
    'vite.config.mjs',
    'eslint.config.js',
    'docs/module-contracts.md',
    'src/core/workflows.mjs',
    'src/core/projects.mjs',
    'test/bounded.test.mjs',
  ])
    fs.writeFileSync(path.join(root, file), file === 'package.json' ? '{}' : '// Fixture source: ' + file + '\n');
  // The proposal lists files to edit, or { files, newFiles, deleteFiles }; listed existing files are created.
  const paths = Array.isArray(allowedFiles) ? { files: allowedFiles } : allowedFiles;
  for (const file of [...paths.files, ...(paths.deleteFiles || [])])
    if (!fs.existsSync(path.join(root, file))) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '// Fixture source: ' + file + '\n');
    }
  // Candidates are built in worktrees from a commit and integration commits to the live
  // repository, so the fixture source is a real local git repository.
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture baseline']);
  const options = {
    directory: path.join(directory, 'records'),
    port: 0,
    runnerOptions: {
      codexBinary: cli,
      sourceChangeRoot: root,
      sourceChangeFixture: true,
      sourceReviewSandbox: () => ({ passed: true, implementation: 'protocol-fixture' }),
      sourceCheckCommand: { executable: process.execPath, args: [tests, checkMode] },
      sourceFormatCommand: { executable: process.execPath, args: [formatter, 'pass'] },
      ...runnerOptions,
    },
  };
  const c = { directory, root, options, app: createStudio(options) };
  // Every step runs on its employee's own model CLI (here the Codex protocol fixture).
  const org = c.app.store.organization();
  for (const worker of org.workers) if (worker.provider === 'mock') worker.provider = 'codex';
  c.app.store.setOrganization(org);
  t.after(async () => {
    await c.app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  c.connect = async () => {
    c.origin = await c.app.start();
    c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  };
  if (!backendOnly) await c.connect();
  c.request = async (route, data = {}) => {
    if (backendOnly) {
      try {
        const id = route.split('/')[3];
        if (route.endsWith('/accept')) {
          const result = acceptAttempt(c.app.store, c.app.runner.registries, c.app.store.task(id));
          c.app.runner.autonomy.accepted(id);
          return { status: 200, data: result };
        }
        return { status: 200, data: approveWork(c.app.store, c.app.runner.registries, c.app.store.task(id)) };
      } catch (error) {
        return { status: 400, data: { error: error.message } };
      }
    }
    const result = await fetch(c.origin + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: result.status, data: await result.json() };
  };
  c.wait = async (id, status = 'review') => waitForTask(c.app.store, id, status);
  c.accept = async id => {
    const result = await c.request(`/api/tasks/${id}/accept`);
    assert.equal(result.status, 200, JSON.stringify(result.data));
  };
  const store = c.app.store,
    plan = sourcePlan(root);
  // Seed exact accepted reports to exercise provenance with no model request.
  // These records are protocol fixtures in a disposable database only.
  const checked = {
    id: 'checked-attempt',
    taskId: 'checked-task',
    projectId: 'project-legacy',
    workerId: 'W-06',
    status: 'accepted',
    assignment: { kind: 'studio-development:checks' },
    sourceCheck: plan,
    checkExecution: { exitCode: 0, signal: null, fixture: false },
    artifacts: [],
    result: {
      taskId: 'checked-task',
      outcome: 'completed',
      summary: 'Seeded fixture evidence.',
      artifacts: [],
      checks: [],
      issues: [],
      handoff: 'Fixture',
    },
  };
  const report = checkReport(
    plan,
    checked.checkExecution,
    'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    '',
  );
  const seed = (attempt, data, name, kind) => {
    const output = path.join(store.directory, 'jobs', attempt.id, 'output');
    fs.mkdirSync(output, { recursive: true });
    const bytes = Buffer.from(JSON.stringify(data));
    fs.writeFileSync(path.join(output, name), bytes);
    attempt.outputFolder = output;
    attempt.artifacts = [{ path: name, kind, hash: hash(bytes), bytes: bytes.length }];
    attempt.result.artifacts = [{ path: name, kind }];
    store.putTask({
      id: attempt.taskId,
      projectId: 'project-legacy',
      kind: attempt.assignment.kind,
      workerId: attempt.workerId,
      team: store.organization().workers.find(worker => worker.id === attempt.workerId).team,
      status: 'done',
      acceptedAttemptId: attempt.id,
      lastAttemptId: attempt.id,
      dependencies: [],
      resources: [],
      title: 'Fixture evidence',
      maxSeconds: 30,
      maxAttempts: 2,
    });
    store.insertAttempt(attempt, { text: 'Fixture instructions', hash: hash('Fixture instructions') });
  };
  seed(checked, report, 'check-report.json', 'source-check-report');
  const review = {
    id: 'review-attempt',
    taskId: 'review-task',
    projectId: 'project-legacy',
    workerId: 'W-07',
    status: 'accepted',
    assignment: { kind: 'studio-development:review' },
    contracts: { task: { kind: 'studio-development:review', version: 'source-review-v2' } },
    sourceReview: {
      taskId: checked.taskId,
      attemptId: checked.id,
      path: 'check-report.json',
      hash: checked.artifacts[0].hash,
      sourceHash: plan.sourceHash,
      passed: true,
      files: plan.files.map(item => item.path),
    },
    result: {
      taskId: 'review-task',
      outcome: 'completed',
      summary: 'Seeded proposal fixture.',
      artifacts: [],
      checks: [],
      issues: [],
      handoff: 'Fixture',
    },
  };
  const proposal = {
    schemaVersion: 'source-review-v1',
    source: {
      taskId: checked.taskId,
      attemptId: checked.id,
      path: 'check-report.json',
      hash: checked.artifacts[0].hash,
      sourceHash: plan.sourceHash,
    },
    verdict: 'pass',
    summary: 'Propose one bounded fixture change.',
    findings: ['Fixture-only finding.'],
    proposal: {
      complexity: 1,
      title: 'Improve bounded workflow fixture',
      reason: 'Exercise isolated source changes.',
      ...paths,
      scope: 'Add one fixture comment.',
      acceptance: 'Preserve source boundaries and measured evidence.',
    },
    unperformedChecks: ['Browser layout', 'Engine integration', 'Playtest'],
  };
  seed(review, proposal, 'source-review.json', 'source-review');
  const ids = stageProposedWork(store, c.app.runner.registries, store.task(review.taskId), store.attempt(review.id));
  c.taskId = ids[0];
  assert.equal(store.task(c.taskId).complexity, 1);
  assert.equal(store.task(c.taskId).maxSeconds, 600);
  assert.equal(store.task(c.taskId).maxAttempts, 2);
  assert.equal((await c.request(`/api/tasks/${c.taskId}/approve-work`)).status, 200);
  c.start = async mode => {
    if (mode) {
      const task = store.task(c.taskId);
      task.direction = mode;
      store.putTask(task);
    }
    const result = await c.request(`/api/tasks/${c.taskId}/start`);
    assert.equal(result.status, 202, JSON.stringify(result.data));
    return result;
  };
  c.measuredFixture = attempt => {
    // Trusted protocol seam, analogous to projects.test.mjs. It exercises the
    // measured-only review/integration gates without claiming native evidence.
    attempt = store.attempt(attempt.id);
    attempt.checkExecution.fixture = false;
    attempt.sourceEditExecution.fixture = false;
    const reportFile = path.join(attempt.outputFolder, 'check-report.json'),
      report = JSON.parse(fs.readFileSync(reportFile));
    report.execution.fixture = false;
    fs.writeFileSync(reportFile, JSON.stringify(report));
    attempt.artifacts.find(item => item.path === 'check-report.json').hash = hash(fs.readFileSync(reportFile));
    store.updateAttempt(attempt);
    return attempt;
  };
  c.review = async (attempt, mode = '') => {
    c.measuredFixture(attempt);
    const org = store.organization(),
      paused = org.paused;
    org.paused = true;
    store.setOrganization(org);
    await c.accept(c.taskId);
    const story = store.task(c.taskId);
    story.sourceStage.reviewDirection = mode;
    store.putTask(story);
    const resumed = store.organization();
    resumed.paused = paused;
    store.setOrganization(resumed);
    c.app.runner.schedule();
    return c.wait(
      c.taskId,
      mode === 'wrong-review' || (checkMode === 'fail' && mode !== 'negative-review') ? 'failed' : 'review',
    );
  };
  c.integration = review =>
    c.request(`/api/tasks/${review.taskId}/integrate-source`, {
      attemptId: review.id,
      reviewHash: c.app.store.attempt(review.id).artifacts[0].hash,
    });
  // Integration verifies in the background; wait for its journal to settle.
  c.settled = async (review, states = ['integrated', 'rejected', 'needs-reconciliation']) =>
    waitFor(
      () => {
        const journal = c.app.store.attempt(review.id).sourceIntegration;
        return states.includes(journal?.state) && !c.app.runner.sourceIntegrationRun && journal;
      },
      `the integration of ${review.id} to settle as ${states.join(', ')}`,
      {
        detail: () =>
          `its journal is ${JSON.stringify(c.app.store.attempt(review.id).sourceIntegration)}` +
          (c.app.runner.sourceIntegrationRun ? ' and an integration is still running' : ''),
      },
    );
  // Records an integration as the controller does: one path and its contents, or several.
  c.integrated = (storyId, review, path_, contents) => {
    const files = typeof path_ === 'string' ? { [path_]: contents } : path_;
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    commitIntegration(root, Object.keys(files), `Integrated ${storyId}`, directory);
    const attempt = store.attempt(review.id);
    attempt.sourceIntegration = {
      id: 'source-integration:' + review.id,
      method: 'merge',
      state: 'integrated',
      root: c.app.runner.sourceChangeRoot,
      changes: Object.entries(files).map(([file, text]) => ({ path: file, integratedHash: hash(text) })),
    };
    store.updateAttempt(attempt);
    const story = store.task(storyId);
    Object.assign(story.sourceStage, {
      phase: 'integration',
      current: 'integrated',
      integration: { attemptId: review.id, state: 'integrated' },
    });
    store.putTask(story);
  };
  // Runs a story's edit and independent review to its accepted, passing review.
  c.toReview = async id => {
    const edit = await c.wait(id);
    c.measuredFixture(edit);
    acceptAttempt(store, c.app.runner.registries, store.task(id));
    c.app.runner.autonomy.accepted(id);
    const review = await c.wait(id);
    acceptAttempt(store, c.app.runner.registries, store.task(id));
    return { edit, review };
  };
  // A later breakdown takes another name for its planning task and attempt, and reuses the evidence.
  c.breakdown = async (
    shape = [
      { files: ['src/core/workflows.mjs'], dependencies: [] },
      { files: ['src/core/projects.mjs'], dependencies: ['workflow'] },
    ],
    name = 'breakdown',
  ) => {
    const checkedAttempt = store.attempt(checked.id),
      stdout = 'TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
    for (const [file, kind, data] of [
      ['source-context.json', 'source-context', JSON.stringify(sourceContext(plan, root))],
      ['test-output.txt', 'test-log', stdout],
      ['test-errors.txt', 'test-log', ''],
    ])
      if (!checkedAttempt.artifacts.some(item => item.path === file)) {
        fs.writeFileSync(path.join(checkedAttempt.outputFolder, file), data);
        checkedAttempt.artifacts.push({ path: file, kind, hash: hash(data), bytes: Buffer.byteLength(data) });
        checkedAttempt.result.artifacts.push({ path: file, kind });
      }
    store.updateAttempt(checkedAttempt);
    const evidence = measuredSourceEvidence(store, checked.taskId, checked.id, 'project-legacy'),
      { files, profile, ...identity } = evidence,
      data = {
        schemaVersion: 'source-breakdown-v1',
        source: identity,
        summary: 'Linked disjoint source stories.',
        stories: [
          {
            key: 'workflow',
            kind: 'studio-development:change',
            workerId: 'W-02',
            title: 'Refine workflow fixture',
            scope: 'Add a bounded comment.',
            acceptance: 'Measured candidate checks pass.',
            complexity: 1,
            ...shape[0],
          },
          {
            key: 'project',
            kind: 'studio-development:change',
            workerId: 'W-02',
            title: 'Refine project fixture',
            scope: 'Add a separate bounded comment using the accepted prerequisite.',
            acceptance: 'Scope remains isolated.',
            complexity: 1,
            ...shape[1],
          },
        ],
      },
      planning = {
        id: `${name}-attempt`,
        taskId: `${name}-task`,
        workerId: 'W-01',
        status: 'accepted',
        assignment: { kind: 'studio-development:breakdown', dependencies: [checked.taskId] },
        sourceBreakdown: evidence,
        result: { ...review.result, taskId: `${name}-task` },
      };
    seed(planning, data, 'source-breakdown.json', 'source-breakdown');
    const planned = store.task(planning.taskId);
    planned.dependencies = [checked.taskId];
    store.putTask(planned);
    const ids = stageProposedWork(store, c.app.runner.registries, planned, store.attempt(planning.id));
    return { ids, planning: store.attempt(planning.id), data, checked: checkedAttempt };
  };
  return c;
}
