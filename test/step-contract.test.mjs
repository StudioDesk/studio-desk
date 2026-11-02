// The step contract (1.2's graph engine, step 1a, November 2, 2026): every task type says which of a short catalog of
// kinds its steps are and what they receive and may propose, and core reads that instead of guessing from the kind's
// name. Library delivery asked whether a name held "review" or "check"; the library-proposal layer whether it started
// with "studio-development:" or held either word. Nothing an agent does changes: every agent's step resolves to what
// its name used to imply. The steps the studio runs itself (operations) no longer carry the proposal layer, which only
// an agent could use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistries } from '../src/registry.mjs';
import { STEP_KINDS, stepContract, validateStep } from '../src/core/step-contract.mjs';

test("every task type declares its step, and each agent's step resolves to what its kind's name used to imply", () => {
  const kinds = createRegistries().workflows.list();
  assert.ok(kinds.length >= 18);
  const changed = [];
  for (const definition of kinds) {
    const name = definition.kind,
      contract = stepContract(definition);
    assert.ok(definition.step, `${name} declares its step`);
    assert.ok(STEP_KINDS.includes(contract.kind), `${name}'s kind is in the catalog`);
    const libraryFromInputs = /review|check/i.test(name),
      proposals = !/^studio-development:|review|check/i.test(name);
    if (contract.kind === 'operation') {
      // The studio runs these itself: no agent reads a library or proposes files there.
      assert.equal(contract.proposes.library, false, `${name} proposes nothing`);
      if (proposals) changed.push(name);
      continue;
    }
    assert.equal(contract.receives.library === 'same-as-inputs', libraryFromInputs, `${name} library`);
    assert.equal(contract.proposes.library, proposals, `${name} library proposals`);
  }
  // The only steps whose instructions change: the studio's own operations, which were offered the layer by their names.
  assert.deepEqual(changed.sort(), [
    'architecture-fixture:handoff',
    'architecture-fixture:prepare',
    'game-fixture:handoff',
    'game-fixture:prepare',
    'unreal-integration',
  ]);
});

test('a contract takes only a kind from the catalog and the fields it overrides', () => {
  assert.deepEqual(stepContract({ step: { kind: 'review' } }), {
    kind: 'review',
    receives: { library: 'same-as-inputs' },
    proposes: { library: false },
    acceptance: { acceptOver: true },
  });
  assert.deepEqual(stepContract({ step: { kind: 'gate' } }).acceptance, { acceptOver: false });
  assert.deepEqual(stepContract({ step: { kind: 'work', proposes: { library: false } } }).proposes, { library: false });
  // A task type that declares none is work.
  assert.equal(stepContract({}).kind, 'work');
  for (const [step, message] of [
    [{ kind: 'critique' }, /kind is one of/],
    [{ kind: 'work', owner: 'W-1' }, /takes only kind, receives, proposes, acceptance/],
    [{ kind: 'work', receives: { library: 'some' } }, /receives the library as one of/],
    [{ kind: 'work', receives: { files: true } }, /receives takes only library/],
    [{ kind: 'work', proposes: { library: 'yes' } }, /true or false/],
    [null, /takes only/],
  ])
    assert.throws(() => validateStep(step), message);
  // The registry checks each task type's contract when its pack registers.
  const { workflows } = createRegistries(),
    general = workflows.find('general:work');
  const pack = {
    id: 'contract-fixture',
    version: 'contract-fixture-v1',
    tasks: [{ ...general, kind: 'contract-fixture:design-pass', step: { kind: 'critique' } }],
  };
  assert.throws(() => workflows.register(pack), /contract-fixture:design-pass's step's kind is one of/);
});

test('the library-proposal layer follows the step contract, not the name', async t => {
  const { setup } = await import('./studio-setup.mjs');
  const c = await setup(t),
    { runner, store } = c.app;
  // An agent on Claude Code, which every one of these steps can run on.
  const saved = store.organization();
  saved.workers.find(item => item.enabled).provider = 'claude';
  store.setOrganization(saved);
  const org = store.organization(),
    worker = org.workers.find(item => item.enabled && item.provider === 'claude'),
    base = { id: 'T-contract', projectId: 'project-legacy', title: 'A step', brief: 'Do it.', dependencies: [] };
  const titles = kind =>
    runner
      .compileInstructions(org, worker, { ...base, kind, team: worker.team, workerId: worker.id }, 'attempt-c', '.', [])
      .layers.map(layer => layer.title);
  assert.ok(titles('general:work').includes('Proposing a library file'));
  assert.ok(titles('general:plan').includes('Proposing a library file'));
  assert.ok(!titles('general:review').includes('Proposing a library file'));
  assert.ok(!titles('studio-development:change').includes('Proposing a library file'));
});

test("the director accepts over a failed check with a reason, where the step's contract allows it", async t => {
  const { setup } = await import('./studio-setup.mjs');
  const c = await setup(t),
    { store } = c.app,
    worker = store.organization().workers.find(item => item.enabled);
  const reviewed = (id, checks) => {
    store.putTask({
      id,
      projectId: 'project-legacy',
      kind: 'general',
      title: 'A guide',
      status: 'review',
      lastAttemptId: `attempt-${id}`,
      workerId: worker.id,
      team: worker.team,
      dependencies: [],
      resources: [],
    });
    store.insertAttempt(
      {
        id: `attempt-${id}`,
        taskId: id,
        projectId: 'project-legacy',
        workerId: worker.id,
        status: 'review',
        artifacts: [],
        result: { taskId: id, outcome: 'completed', summary: 'Done.', artifacts: [], checks, issues: [], handoff: '' },
      },
      { layers: [] },
    );
  };
  const refused = { name: 'Primary source read', status: 'fail', evidence: 'The publisher answered 403.' };
  reviewed('T-over', [refused, { name: 'Every figure dated', status: 'pass', evidence: 'All 12.' }]);
  const accept = (id, body = {}) => c.request(`/api/tasks/${id}/accept`, { projectId: 'project-legacy', ...body });
  // Without a reason it is still refused, and the refusal says how to go on.
  let answer = await accept('T-over');
  assert.equal(answer.status, 400);
  assert.match(answer.data.error, /Accept over it with a reason, or request a revision/);
  assert.equal((await accept('T-over', { overReason: '   ' })).status, 400);
  assert.equal((await accept('T-over', { overReason: 'Fine.', note: 'x' })).status, 400);
  // With one, it is accepted, and the reason and the checks it went over are recorded.
  answer = await accept('T-over', { overReason: 'The gap is stated in the file; a retry cannot reach the source.' });
  assert.equal(answer.status, 200);
  const attempt = store.attempt('attempt-T-over');
  assert.equal(attempt.status, 'accepted');
  assert.deepEqual(attempt.acceptedBy, {
    type: 'director',
    over: {
      reason: 'The gap is stated in the file; a retry cannot reach the source.',
      checks: ['Primary source read'],
    },
  });
  assert.equal(store.task('T-over').status, 'done');
  const event = store.events().find(item => item.kind === 'accepted' && item.task_id === 'T-over');
  assert.match(event.message, /over a failed check \(Primary source read\): The gap is stated/);
  // Nothing failed: no reason is taken.
  reviewed('T-clean', [{ name: 'Every figure dated', status: 'pass', evidence: 'All 12.' }]);
  answer = await accept('T-clean', { overReason: 'Just in case.' });
  assert.equal(answer.status, 400);
  assert.match(answer.data.error, /No check failed/);
  assert.equal((await accept('T-clean')).status, 200);
  // A step whose contract does not take it refuses.
  const { acceptAttempt } = await import('../src/core/acceptance.mjs');
  const registries = c.app.runner.registries,
    general = registries.workflows.get('general');
  registries.workflows.register({
    id: 'contract-fixture',
    version: 'contract-fixture-v1',
    tasks: [{ ...general, kind: 'contract-fixture:strict', step: { kind: 'work', acceptance: { acceptOver: false } } }],
  });
  reviewed('T-strict', [refused]);
  store.putTask({ ...store.task('T-strict'), kind: 'contract-fixture:strict' });
  assert.throws(
    () => acceptAttempt(store, registries, store.task('T-strict'), { type: 'director', over: { reason: 'Please.' } }),
    /does not take acceptance over a failed check/,
  );
});
