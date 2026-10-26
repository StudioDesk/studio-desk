import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { describeTask, waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { hash } from '../src/core/contracts.mjs';
import { jobDirectory } from '../src/core/projects.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { ensureSourceDirectories, sourcePlan } from '../src/connectors/source-checks.mjs';
import { textPrompt } from '../src/adapters/text-delivery.mjs';

const codex = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url)),
  claude = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  implementation = 'export const project = "A";\n',
  behaviorTest =
    'import test from "node:test"; import assert from "node:assert/strict"; import { project } from "../src/core/projects.mjs"; test("pins project A", () => assert.equal(project, "A"));\n// source-test-context-marker\n';

async function setup(t, { provider = 'codex', mode = '', execution, registries = createRegistries() } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bd-'))),
    root = path.join(directory, 'r');
  ensureSourceDirectories(root);
  const files = {
    'package.json': '{}',
    'AGENTS.md': 'Fixture source instructions, not employee authority.',
    'HANDOFF.md': 'Measured fixture.',
    'README.md': 'Disposable source.',
    'start-studio.cmd': '@echo off',
    'start-studio.sh': '#!/bin/sh',
    'package-lock.json': '{}',
    'tsconfig.json': '{}',
    'vite.config.mjs': 'export default {};',
    'eslint.config.js': 'export default [];',
    'docs/module-contracts.md': 'Fixture contracts.',
    'src/core/projects.mjs': implementation,
    'src/core/workflows.mjs': 'export const workflow = "A";\n',
    'test/behavior.test.mjs': behaviorTest,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/excluded.json'), '{"fixture":true}');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'Not source context.');
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Measured A']);
  const options = {
    directory: path.join(directory, 'd'),
    port: 0,
    runnerOptions: {
      registries,
      codexBinary: codex,
      claudeBinary: claude,
      sourceChangeRoot: root,
      sourceReviewSandbox: () => ({ passed: true, implementation: 'model-free fixture' }),
      // Only protocol fixture leaf processes are launched by these tests.
      fixtureProcessTermination: (entry, force) => entry.child.kill(force ? 'SIGKILL' : 'SIGTERM'),
    },
  };
  const c = { directory, root, options, app: createStudio(options) },
    { store, runner } = c.app,
    org = store.organization();
  for (const worker of org.workers) if (worker.provider === 'mock') worker.provider = 'codex';
  // A measured suite runs without a sandbox, as an idea's checks did before 1.0.1: the suite never runs the real
  // built-in sandbox, which the test studios only report as set up.
  org.testSandbox = 'none';
  const planner = org.workers.find(worker => worker.id === 'W-01');
  Object.assign(planner, { provider, mode, model: '', effort: '' });
  org.workers.find(worker => worker.id === 'W-02').roles = ['engineer'];
  store.setOrganization(org);
  t.after(async () => {
    await c.app.close();
    assert.ok(directory.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const task = (id, kind, workerId, dependencies = []) => ({
    id,
    projectId: 'project-legacy',
    kind: 'studio-development:' + kind,
    workerId,
    team: org.workers.find(worker => worker.id === workerId).team,
    title: 'Verified planning fixture',
    brief: 'Plan a bounded change with its behavior test.',
    acceptance: 'Measured provenance and planning context.',
    status: 'ready',
    dependencies,
    resources: [],
    maxSeconds: 30,
    maxAttempts: 2,
  });
  c.wait = async id => {
    const task = await waitFor(
      () => {
        const task = store.task(id);
        return task.lastAttemptId && !['running', 'stopping'].includes(task.status) && task;
      },
      `task ${id} to stop running`,
      {
        detail: () => {
          const task = store.task(id);
          return describeTask(task, task.lastAttemptId && store.attempt(task.lastAttemptId));
        },
      },
    );
    return store.attempt(task.lastAttemptId);
  };
  store.putTask(task('checks', 'checks', 'W-06'));
  // A real, tiny fixed Node suite, independent of the outer reporter protocol.
  const testContext = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    runner.start('checks');
  } finally {
    if (testContext !== undefined) process.env.NODE_TEST_CONTEXT = testContext;
  }
  c.checked = await c.wait('checks');
  assert.equal(c.checked.status, 'review', c.checked.error);
  assert.equal(c.checked.checkExecution.fixture, false);
  assert.equal(c.checked.result.checks.find(check => check.name === 'Node test suite').status, 'pass');
  acceptAttempt(store, registries, store.task('checks'));
  c.report = JSON.parse(fs.readFileSync(path.join(c.checked.outputFolder, 'check-report.json')));
  c.task = { ...task('breakdown', 'breakdown', planner.id, ['checks']), ...(execution ? { execution } : {}) };
  store.putTask(c.task);
  c.start = title => {
    if (title) {
      c.task.title = title;
      store.putTask(c.task);
    }
    return runner.start(c.task.id);
  };
  c.observed = a => JSON.parse(fs.readFileSync(path.join(a.outputFolder, '..', 'fixture-breakdown.json')));
  c.reference = a => path.join(jobDirectory(store, a), 'source');
  return c;
}

for (const provider of ['codex', 'claude'])
  test(`${provider} workspace sees the full verified A source and behavior test before starting, after HEAD advances`, async t => {
    const c = await setup(t, { provider });
    fs.writeFileSync(path.join(c.root, 'src/core/projects.mjs'), 'export const project = "B";\n');
    git(c.root, ['add', 'src/core/projects.mjs']);
    git(c.root, ['commit', '--quiet', '-m', 'Later B']);
    fs.writeFileSync(path.join(c.root, 'src/uncommitted.mjs'), 'Uncommitted source is not context.');
    c.start();
    const a = await c.wait('breakdown'),
      observed = c.observed(a);
    assert.equal(a.status, 'review', a.error);
    assert.equal(a.provider, 'source-breakdown');
    assert.equal(a.configuration.model, provider);
    assert.equal(a.sourceBreakdownContext.commit, c.report.source.commit);
    assert.notEqual(a.sourceBreakdownContext.commit, git(c.root, ['rev-parse', 'HEAD']));
    assert.equal(a.sourceBreakdownContext.path, '../source');
    assert.deepEqual(observed.files, c.report.source.files);
    assert.equal(observed.sourceHash, c.report.source.hash);
    assert.equal(observed.implementation, implementation);
    assert.equal(observed.test, behaviorTest);
    assert.ok(!observed.files.some(file => /^(data|\.git|outside|src\/uncommitted)/.test(file.path)));
    assert.match(a.instructions.text, /read and search.*\.\.\/source/);
    assert.match(
      a.instructions.text,
      /implementations, their callers and the tests asserting each behavior or message/,
    );
    assert.match(a.instructions.text, /grants no source editing authority/);
    assert.deepEqual(
      a.artifacts.map(({ path, kind }) => ({ path, kind })),
      [{ path: 'source-breakdown.json', kind: 'source-breakdown' }],
    );
    assert.equal(fs.existsSync(c.reference(a)), false, 'Settled success removes the reference.');
    assert.deepEqual(c.app.store.leases(), []);
    for (const id of c.app.store.task('breakdown').proposedTaskIds) {
      const story = c.app.store.task(id);
      assert.equal(story.approval.status, 'pending');
      assert.equal(story.status, 'backlog');
      assert.equal(c.app.store.attempts(id).length, 0);
    }
    assert.equal((git(c.root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) || []).length, 1);
  });

for (const settings of [
  { provider: 'claude', mode: 'text' },
  { provider: 'codex', execution: { provider: 'claude', mode: 'text' } },
  { provider: 'claude', mode: 'text', execution: { mode: 'workspace' } },
])
  test(`breakdown uses effective delivery overrides: ${JSON.stringify(settings)}`, async t => {
    const c = await setup(t, settings),
      text = settings.execution?.mode === 'workspace' ? false : true;
    if (text) {
      // Text requires accepted evidence, not availability of the measured Git object.
      c.app.runner.sourceReviewSandbox = () => {
        throw new Error('Text must not probe filesystem isolation.');
      };
      fs.renameSync(path.join(c.root, '.git'), path.join(c.root, 'saved-git'));
    }
    c.start();
    const a = await c.wait('breakdown'),
      observed = c.observed(a);
    assert.equal(a.status, 'review', a.error);
    assert.equal(a.configuration.mode, text ? 'text' : 'workspace');
    assert.equal(observed.mode, text ? 'text' : 'workspace');
    if (text) {
      assert.deepEqual(a.sourceBreakdownContext, { mode: 'text' });
      assert.match(observed.prompt, /Plan from the supplied measured file list and source-context documents/);
      assert.ok(!observed.prompt.includes('Before planning, read and search'));
      assert.ok(!observed.prompt.includes('source-test-context-marker'), 'No full repository text payload.');
      assert.ok(observed.prompt.includes('test/behavior.test.mjs'), 'The measured file list is supplied.');
    }
    assert.equal(fs.existsSync(c.reference(a)), false);
  });

for (const problem of ['mismatched manifest', 'unavailable commit'])
  test(`preparation rejects ${problem} with no model invocation or fallback`, async t => {
    const c = await setup(t),
      { store } = c.app,
      checked = store.attempt(c.checked.id),
      reportFile = path.join(checked.outputFolder, 'check-report.json'),
      report = JSON.parse(fs.readFileSync(reportFile));
    if (problem === 'mismatched manifest') {
      checked.sourceCheck.files.find(item => item.path === 'test/behavior.test.mjs').hash = '0'.repeat(64);
      checked.sourceCheck.sourceHash = hash(JSON.stringify(checked.sourceCheck.files));
      report.source.files = checked.sourceCheck.files;
      report.source.hash = checked.sourceCheck.sourceHash;
      const contextFile = path.join(checked.outputFolder, 'source-context.json'),
        context = JSON.parse(fs.readFileSync(contextFile));
      context.sourceHash = checked.sourceCheck.sourceHash;
      fs.writeFileSync(contextFile, JSON.stringify(context));
      const item = checked.artifacts.find(item => item.path === 'source-context.json');
      item.hash = hash(fs.readFileSync(contextFile));
      item.bytes = fs.statSync(contextFile).size;
    } else {
      checked.sourceCheck.base.commit = '0'.repeat(40);
      report.source.commit = '0'.repeat(40);
    }
    fs.writeFileSync(reportFile, JSON.stringify(report));
    const item = checked.artifacts.find(item => item.path === 'check-report.json');
    item.hash = hash(fs.readFileSync(reportFile));
    item.bytes = fs.statSync(reportFile).size;
    store.updateAttempt(checked);
    c.start();
    const a = await c.wait('breakdown');
    assert.equal(a.status, 'failed');
    assert.match(a.error, /Breakdown source reference preparation failed:.*No employee model was started/);
    assert.match(a.error, problem === 'mismatched manifest' ? /integrity failure/ : /git worktree failed/);
    assert.equal(a.pid, null);
    assert.equal(fs.existsSync(path.join(a.outputFolder, '..', 'fixture-args.json')), false);
    assert.equal(fs.existsSync(c.reference(a)), false);
    assert.deepEqual(store.leases(), []);
  });

for (const [title, reason] of [
  ['Modify reference', /Source snapshot integrity failure/],
  ['Wrong source', /source.contextHash/],
  ['Unmeasured path', /unrecorded source file/],
  ['Protected path', /protected|allowed|path/i],
  ['Traversing path', /path|allowed/i],
  ['Existing new file', /already exists/],
  ['Invalid new file', /new files go under src, public, test, scripts, docs or dashboard/],
  ['Tamper', /Protected.*modified/],
  ['Quota', /code 1|limit/i],
])
  test(`workspace ${title} cannot authorize a story and removes its settled reference`, async t => {
    const c = await setup(t);
    c.start(title);
    const a = await c.wait('breakdown');
    assert.ok(['failed', 'blocked'].includes(a.status), a.error);
    assert.match(a.error, reason);
    assert.equal(c.observed(a).sourceHash, c.report.source.hash, 'Reference existed before the fixture ran.');
    assert.equal(fs.existsSync(c.reference(a)), false);
    assert.deepEqual(c.app.store.leases(), []);
    assert.equal(c.app.store.task('breakdown').proposedTaskIds, undefined);
    if (title === 'Quota') {
      assert.equal(c.app.store.organization().quota.codex, true);
      assert.equal(c.app.store.organization().quota['source-breakdown'], undefined);
    }
  });

test('cancellation retains the reference and reservations until the employee closes', async t => {
  const c = await setup(t);
  c.start('Hang');
  const a = c.app.store.attempt(c.app.store.task('breakdown').lastAttemptId);
  await waitFor(
    () => fs.existsSync(path.join(a.outputFolder, '..', 'fixture-breakdown.json')),
    'the employee fixture to record what it observed',
    { interval: 10 },
  );
  assert.equal(c.observed(a).sourceHash, c.report.source.hash);
  const entry = c.app.runner.active.get(a.id),
    terminate = c.app.runner.fixtureProcessTermination;
  c.app.runner.fixtureProcessTermination = () => {};
  c.app.runner.stop(a.id);
  assert.equal(c.app.store.attempt(a.id).status, 'stopping');
  assert.equal(fs.existsSync(c.reference(a)), true);
  assert.ok(c.app.store.leases().some(lease => lease.attemptId === a.id));
  c.app.runner.fixtureProcessTermination = terminate;
  terminate(entry, true);
  assert.equal((await c.wait('breakdown')).status, 'cancelled');
  assert.equal(fs.existsSync(c.reference(a)), false);
  assert.deepEqual(c.app.store.leases(), []);
});

test('restart and quarantined ownership retain references until explicit stopped-process reconciliation', async t => {
  for (const status of ['running', 'quarantined']) {
    const c = await setup(t),
      { store, runner } = c.app,
      a = {
        id: 'attempt-retained',
        projectId: 'project-legacy',
        taskId: 'breakdown',
        workerId: 'W-01',
        provider: 'source-breakdown',
        status,
        pid: process.pid,
        contracts: { adapter: { id: 'source-breakdown' } },
        sourceBreakdownContext: { mode: 'workspace', path: '../source' },
      },
      reference = c.reference(a);
    fs.mkdirSync(reference, { recursive: true });
    fs.writeFileSync(path.join(reference, 'sentinel'), 'Retained while uncertain.');
    store.insertAttempt(a, { text: 'Recorded fixture instructions.' });
    store.claim(['employee:W-01'], a.id);
    const task = store.task('breakdown');
    task.status = status === 'running' ? 'running' : 'blocked';
    task.lastAttemptId = a.id;
    store.putTask(task);
    await c.app.close();
    c.app = createStudio(c.options);
    const recovered = c.app.store.attempt(a.id);
    assert.equal(recovered.status, status === 'running' ? 'interrupted' : 'quarantined');
    assert.equal(fs.existsSync(reference), true);
    assert.throws(() => c.app.runner.reconcile('breakdown'), /still has a live process/);
    assert.equal(fs.existsSync(reference), true);
    assert.ok(c.app.store.leases().some(lease => lease.attemptId === a.id));
    recovered.pid = null;
    c.app.store.updateAttempt(recovered);
    c.app.runner.reconcile('breakdown');
    assert.equal(fs.existsSync(reference), false);
    assert.deepEqual(c.app.store.leases(), []);
    assert.ok(c.app.store.attempt(a.id).reconciledAt);
    assert.equal(c.app.store.task('breakdown').status, 'ready');
    assert.equal(runner.active.size, 0);
  }
});

test('workspace isolation and subscription checks follow the effective model, not the wrapper', async t => {
  const c = await setup(t),
    { runner, store } = c.app;
  runner.sourceReviewSandbox = () => ({ passed: false, stderr: 'Fixture denied.' });
  assert.throws(() => c.start(), /workspace isolation did not pass/);
  assert.equal(store.attempts('breakdown').length, 0);
  runner.sourceReviewSandbox = () => ({ passed: true });
  const org = store.organization();
  org.quota.codex = true;
  store.setOrganization(org);
  assert.throws(() => c.start(), /subscription hold/);
  assert.equal(store.attempts('breakdown').length, 0);
  c.task.execution = { provider: 'claude', mode: 'text' };
  store.putTask(c.task);
  c.start();
  assert.equal((await c.wait('breakdown')).status, 'review');
});

test('a third model runs both breakdown delivery modes through the same contract', async t => {
  for (const mode of ['workspace', 'text']) {
    const registries = createRegistries(),
      observed = [];
    registries.adapters.register({
      id: 'planning-fixture',
      version: 'planning-fixture-v1',
      name: 'Third model fixture',
      workerSelectable: true,
      subscription: true,
      capabilities: ['text-output'],
      modes: ['workspace', 'text'],
      status: () => ({ available: true, label: 'Model-free' }),
      blockReason: () => '',
      configuration: (runtime, worker) => ({ mode: worker.mode }),
      requestedModel: () => 'Fixture',
      delivery: 'Model-free contract fixture.',
      deliveryScope: 'Only staged planning output.',
      start() {
        throw new Error('The wrapper must call run, not start.');
      },
      run(runtime, entry, worker, request) {
        assert.equal(request.mode, mode);
        assert.deepEqual(request.editable, []);
        assert.deepEqual(request.context, []);
        const exists = fs.existsSync(path.join(entry.job, 'source'));
        observed.push({ exists, mode });
        assert.equal(exists, mode === 'workspace');
        if (exists)
          assert.deepEqual(sourcePlan(path.join(entry.job, 'source')).files, entry.attempt.sourceBreakdown.files);
        else assert.match(textPrompt(entry, { name: 'Third model' }), /Plan from the supplied measured file list/);
        const { files, profile, ...source } = entry.attempt.sourceBreakdown;
        fs.writeFileSync(
          path.join(entry.output, 'source-breakdown.json'),
          JSON.stringify({
            schemaVersion: 'source-breakdown-v1',
            source,
            summary: 'Third-model planning fixture.',
            stories: [
              {
                key: 'test',
                kind: 'studio-development:change',
                role: 'engineer',
                title: 'Pin the behavior',
                scope: 'Implement a bounded change with its test.',
                acceptance: 'Measured behavior.',
                complexity: 1,
                dependencies: [],
                files: ['src/core/projects.mjs', 'test/behavior.test.mjs'],
              },
            ],
          }),
        );
        request.onComplete({
          taskId: entry.attempt.taskId,
          outcome: 'completed',
          summary: 'Protocol fixture.',
          artifacts: [{ path: 'source-breakdown.json', kind: 'source-breakdown' }],
          checks: [],
          issues: [],
          handoff: 'Review.',
        });
      },
    });
    const c = await setup(t, { provider: 'planning-fixture', mode, registries });
    c.start();
    const a = await c.wait('breakdown');
    assert.equal(a.status, 'review', a.error);
    assert.deepEqual(observed, [{ exists: mode === 'workspace', mode }]);
    assert.equal(a.configuration.model, 'planning-fixture');
    assert.equal(fs.existsSync(c.reference(a)), false);
  }
});
