// 1.0 step 5a: work that is not code. An idea goes to a project's planner through the general intake
// route; its plan becomes the project's own task types, staffed by role; each step receives the files
// and summary of the step before it; an independent review sends work back once; the director
// accepts the results. The same task types run in two organizations of different shapes.
// Model-free: Simulator employees only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { artifactPath } from '../src/core/artifacts.mjs';
import { hash } from '../src/core/contracts.mjs';
import { buildAttemptHistory } from '../src/core/attempt-history.mjs';
import { expandRun } from '../src/core/graph.mjs';
import { generalWorkPack, maxWorkFileBytes, validateWorkReview } from '../src/packs/general-work/index.mjs';

const kinds = ['general:plan', 'general:work', 'general:review'];
const shapes = {
  // Few people: one plans and works, the other works and reviews.
  pair: { 'W-03': ['planner', 'worker'], 'W-04': ['worker', 'reviewer'] },
  // A bench of specialists.
  bench: { 'W-02': ['planner'], 'W-03': ['worker'], 'W-05': ['reviewer'], 'W-06': ['reviewer'] },
};

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-general-')),
    registries = createRegistries(),
    delay = process.env.STUDIO_MOCK_DELAY_MS;
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  const c = { registries, app: createStudio({ directory, port: 0, runnerOptions: { registries } }) };
  c.origin = await c.app.start();
  c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  t.after(async () => {
    await c.app.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
  });
  c.store = c.app.store;
  c.request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(c.origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  c.until = (check, label) =>
    waitFor(check, label, { interval: 10, detail: () => JSON.stringify(c.store.tasks().slice(-3)) });
  c.project = async (name, roles, taskKinds = kinds) => {
    const created = await c.request('/api/projects', { name });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const saved = await c.request(
      `/api/projects/${created.data.id}/organization`,
      {
        projectId: created.data.id,
        expectedRevision: c.store.setting('project-organization:' + created.data.id).revision,
        teams: [{ id: 'team', name: 'Team', purpose: 'Bounded work that is not code.' }],
        members: Object.entries(roles).map(([workerId, memberRoles]) => ({
          workerId,
          teamId: 'team',
          role: 'Contributor',
          responsibility: 'Bounded work that is not code.',
          roles: memberRoles,
        })),
        taskKinds: ['general', ...taskKinds],
        kindOwners: {},
      },
      'PATCH',
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return created.data.id;
  };
  // The director accepts a result once it is in Review; returns the accepted attempt (the next
  // stage may start before the response arrives).
  c.accept = async (projectId, id) => {
    await c.until(() => c.store.task(id).status === 'review', `${id} in review`);
    const attemptId = c.store.task(id).lastAttemptId,
      accepted = await c.request(`/api/tasks/${id}/accept`, { projectId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    return c.store.attempt(attemptId);
  };
  c.read = (attempt, item) => fs.readFileSync(artifactPath(c.store, attempt, item.path), 'utf8');
  return c;
}

test('a work review is graded: findings ask for changes and notes do not', () => {
  const review = { schemaVersion: 'work-review-v1', verdict: 'pass', summary: 'Fine.', findings: [], notes: ['Tone.'] };
  assert.equal(validateWorkReview(review), review);
  assert.equal(
    validateWorkReview({ ...review, verdict: 'needs-work', findings: ['Missing a source.'] }).verdict,
    'needs-work',
  );
  assert.throws(
    () => validateWorkReview({ ...review, verdict: 'needs-work' }),
    /needs-work exactly when findings is not empty/,
  );
  assert.throws(() => validateWorkReview({ ...review, findings: ['A blocking problem.'] }), /needs-work exactly when/);
  assert.throws(
    () => validateWorkReview({ ...review, extra: true, schemaVersion: 'v0' }),
    /remove extra; schemaVersion/,
  );
});

test("an independent review is judged by its verdict; only the controller's checks of it retry it", () => {
  const definition = generalWorkPack.tasks.find(task => task.kind === 'general:review'),
    reported = { name: 'Every species is listed', status: 'fail', evidence: 'The heron is missing.' },
    recorded = { name: 'Independent review recorded', status: 'pass', evidence: 'Verdict needs-work.' },
    needsWork = {
      schemaVersion: 'work-review-v1',
      verdict: 'needs-work',
      summary: 'The species list is incomplete.',
      findings: ['Add the heron.'],
      notes: [],
    },
    pass = { ...needsWork, verdict: 'pass', summary: 'The list is complete.', findings: [] },
    // The arguments evaluateAttempt passes: `failed` holds the reviewer's checks and the controller's.
    judge = (review, checks, controllerChecks) =>
      definition.autonomy.evaluate({
        task: { id: 'T-work' },
        attempt: { result: { checks }, controllerChecks },
        readArtifact: () => JSON.stringify(review),
        failed: [...checks, ...controllerChecks].filter(check => check.status === 'fail'),
      });
  // A reviewer that also recorded the problem it found as a failed check still sends the work back
  // with its summary and findings, and the review is not retried.
  assert.deepEqual(judge(needsWork, [reported], [recorded]), {
    ok: false,
    reason: 'Independent review asked for changes. The species list is incomplete.\n- Add the heron.',
    retryUpstream: { taskId: 'T-work', reason: 'The species list is incomplete.\n- Add the heron.' },
  });
  // A failed check of the controller's retries the review itself.
  assert.deepEqual(judge(needsWork, [reported], [{ ...recorded, status: 'fail' }]), {
    ok: false,
    retry: true,
    reason: 'Failed checks: Independent review recorded',
  });
  // A pass is accepted, even with a failed check of the reviewer's own (the brief's reading).
  for (const checks of [[], [reported]])
    assert.deepEqual(judge(pass, checks, [recorded]), { ok: true, reason: 'Independent review passed.' });
  // Such a review can be accepted, but a failed check of the controller's still fails the attempt.
  assert.equal(definition.acceptFailedChecks, true);
  assert.throws(
    () =>
      definition.validateOutput({
        attempt: { artifacts: [{ path: 'review.json', kind: 'work-review' }] },
        readArtifact: () => JSON.stringify(pass),
        checks: [{ name: 'Produced data format work-review-v1', status: 'fail', evidence: 'Refused.' }],
      }),
    /The controller's checks of the review failed: Produced data format work-review-v1\./,
  );
  // The contract says what checks and findings are for.
  assert.match(
    definition.instructions().layers[0].text,
    /checks record what you verified; put a problem you found in the work in findings, which set the verdict, not in a failed check\./,
  );
});

test('the planner is told a work step returns text files only, within the size the work step states', () => {
  const registries = createRegistries(),
    org = { taskKinds: kinds, workers: [{ id: 'W-03', enabled: true, roles: ['planner', 'worker'] }] },
    layer = (kind, title) =>
      generalWorkPack.tasks
        .find(definition => definition.kind === kind)
        .instructions({ org, registries })
        .layers.find(item => item.title === title).text;
  const planning = layer('general:plan', 'Planning contract'),
    work = layer('general:work', 'Work contract'),
    size = `${maxWorkFileBytes / 1024 / 1024} MiB`;
  // Both contracts state the one limit the work step's file check enforces.
  assert.ok(work.includes(`at most ${size}`), work);
  assert.ok(
    planning.includes(
      `A Do the work task returns text files only (for example Markdown, plain text, CSV or JSON), each at most ${size},`,
    ),
    planning,
  );
  // A plan never asks for a binary file; it asks for the text source and says the binary is not made.
  assert.match(planning, /never plan a task that returns a PDF, an image or another binary file\./);
  assert.match(
    planning,
    /When the idea asks for one, plan its text source instead \(for example Markdown laid out for one page\) and say in that task's brief that the binary file is not made\./,
  );
  // The contract still opens with its JSON line and closes with what to return.
  assert.doesNotThrow(() => JSON.parse(planning.split('\n')[0]));
  assert.match(
    planning,
    /Return only plan\.json with artifact kind graph-proposal, in this shape \(replace the example tasks\)\.$/,
  );
});

for (const [shape, roles] of Object.entries(shapes))
  test(`an idea is planned, done step by step, sent back once by review and accepted (${shape})`, async t => {
    const c = await setup(t),
      projectId = await c.project(`Field guide (${shape})`, roles),
      idea =
        'Write a short field guide to the birds of the park.\n- Gather the species list\n- REWORK the field guide draft';
    // The general intake starts the project's planner, staffed by role, with the idea as its brief.
    const intake = await c.request('/api/intake', { projectId, idea });
    assert.equal(intake.status, 201, JSON.stringify(intake.data));
    assert.equal(intake.data.taskIds.length, 1);
    const planId = intake.data.taskIds[0],
      plan = c.store.task(planId);
    assert.equal(plan.kind, 'general:plan');
    assert.ok(roles[plan.workerId].includes('planner'));
    assert.equal(plan.workflowReference.brief, idea);
    // The planner reads the project's catalog of task types and roles.
    const planAttempt = await c.accept(projectId, planId);
    const contract = planAttempt.instructions.text;
    assert.match(contract, /"kind":"general:work"/);
    assert.doesNotMatch(contract, /"kind":"general:plan"|"kind":"general:review"/);
    // Its plan is Planned work of the project's task types, each staffed by role, awaiting approval.
    const steps = c.store.task(planId).proposedTaskIds.map(id => c.store.task(id));
    assert.deepEqual(
      steps.map(step => [step.kind, step.title, step.approval.status, step.staffing?.role]),
      [
        ['general:work', 'Gather the species list', 'pending', 'worker'],
        ['general:work', 'REWORK the field guide draft', 'pending', 'worker'],
      ],
    );
    assert.ok(steps[1].dependencies.includes(steps[0].id), 'The second step builds on the first.');
    for (const step of steps) {
      assert.equal((await c.request(`/api/tasks/${step.id}/approve-work`, { projectId })).status, 200);
      assert.equal((await c.request(`/api/tasks/${step.id}/start`, { projectId })).status, 202);
    }
    // Step 1: the work, then an independent review by someone else.
    const firstWork = await c.accept(projectId, steps[0].id),
      firstReview = await c.accept(projectId, steps[0].id);
    assert.equal(firstReview.assignment.kind, 'general:review');
    assert.notEqual(firstReview.workerId, firstWork.workerId, 'Separation of duties.');
    assert.ok(roles[firstReview.workerId].includes('reviewer'));
    assert.equal(firstReview.workReviewVerdict, 'pass');
    let first = c.store.task(steps[0].id);
    assert.equal(first.status, 'done');
    assert.equal(first.acceptedAttemptId, firstWork.id, "The task's result is the accepted work, not its review.");
    // Step 2 receives step 1's accepted files and summary.
    const secondWork = await c.accept(projectId, steps[1].id),
      handed = secondWork.inputReferences.find(ref => ref.taskId === steps[0].id);
    assert.equal(handed.attemptId, firstWork.id);
    assert.equal(handed.summary, firstWork.result.summary);
    assert.match(c.read(secondWork, secondWork.artifacts[0]), /Revision 1\.[^]*Inputs: \.\.\/inputs\//);
    // Its review reads the work first, then the accepted files and summaries the work was given, as
    // its author read them: step 1's result and the plan.
    const rejected = await c.accept(projectId, steps[1].id),
      given = attempt => attempt.inputReferences.map(ref => [ref.taskId, ref.attemptId]);
    assert.deepEqual(given(rejected), [[steps[1].id, secondWork.id], ...given(secondWork)]);
    assert.deepEqual(
      given(secondWork)
        .map(([taskId]) => taskId)
        .sort(),
      [planId, steps[0].id].sort(),
    );
    const read = rejected.inputReferences.find(ref => ref.taskId === steps[0].id);
    assert.equal(read.summary, firstWork.result.summary);
    for (const item of read.artifacts)
      assert.equal(hash(fs.readFileSync(path.resolve(rejected.outputFolder, item.path))), item.hash);
    // It asks for changes, which sends the work back with the review's summary.
    assert.equal(rejected.workReviewVerdict, 'needs-work');
    assert.deepEqual(rejected.workReviewFindings, ['Simulated finding: revise once.']);
    // The dashboard's compact record keeps the verdict, so the review reads as asking for changes, not as a pass.
    const compact = await (await fetch(`${c.origin}/api/state?mode=dashboard&projectId=${projectId}`)).json(),
      summary = compact.attempts.find(attempt => attempt.id === rejected.id);
    assert.equal(summary.workReviewVerdict, 'needs-work');
    assert.deepEqual(summary.workReviewFindings, ['Simulated finding: revise once.']);
    let second = c.store.task(steps[1].id);
    assert.equal(second.status, 'blocked');
    assert.match(second.reason, /Independent review sent this back: .* Start it to run Work again\./);
    assert.match(second.direction, /Independent review sent this back/);
    // The director starts it again; the second revision passes review and is accepted.
    assert.equal((await c.request(`/api/tasks/${steps[1].id}/start`, { projectId })).status, 202);
    const revised = await c.accept(projectId, steps[1].id),
      passed = await c.accept(projectId, steps[1].id);
    assert.match(c.read(revised, revised.artifacts[0]), /Revision 2\./);
    assert.equal(passed.workReviewVerdict, 'pass');
    assert.deepEqual(given(passed), [[steps[1].id, revised.id], ...given(revised)]);
    second = c.store.task(steps[1].id);
    assert.equal(second.status, 'done');
    assert.equal(second.acceptedAttemptId, revised.id);
    assert.deepEqual(
      second.stageState.history.map(entry => [entry.key, entry.outcome]),
      [
        ['work', 'accepted'],
        ['review', 'sent-back'],
        ['work', 'accepted'],
        ['review', 'accepted'],
      ],
    );
    first = c.store.task(steps[0].id);
    assert.equal(first.stageState.complete !== undefined, true);
    // Step 2's reviews read step 1's result as context; step 1's history does not count them as its reviews.
    assert.equal(buildAttemptHistory(c.store, first).attempts, 2);
  });

test('the general intake refuses a project with no intake and keeps the Studio desk route as it was', async t => {
  const c = await setup(t),
    none = await c.project('Nothing to plan', { 'W-03': ['worker'] }, ['general:work', 'general:review']);
  const refused = await c.request('/api/intake', { projectId: none, idea: 'Plan something.' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /This project has no idea intake/);
  // No planner holds the role: staffing says who must be assigned.
  const unstaffed = await c.project('No planner', { 'W-03': ['worker'], 'W-04': ['reviewer'] });
  const noPlanner = await c.request('/api/intake', { projectId: unstaffed, idea: 'Plan something.' });
  assert.equal(noPlanner.status, 400);
  assert.match(noPlanner.data.error, /Plan the work/);
  // The Studio desk route still requires its own source workflow.
  const studio = await c.request('/api/studio-development/intake', { projectId: unstaffed, idea: 'Plan something.' });
  assert.equal(studio.status, 400);
  assert.match(studio.data.error, /studio-development:checks/);
  assert.equal(c.store.tasks().filter(task => [none, unstaffed].includes(task.projectId)).length, 0);
});

test('an idea sent with auto mode starts its plan and every step planned from it that way, unless a step chose', async t => {
  const c = await setup(t),
    projectId = await c.project('Auto guide', shapes.bench),
    idea = 'Write a short guide.\n- Gather the notes\n- Draft the guide';
  const refused = await c.request('/api/intake', { projectId, idea, autoMode: 'yes' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Auto mode must be true, false or null/);
  const intake = await c.request('/api/intake', { projectId, idea, autoMode: true });
  assert.equal(intake.status, 201, JSON.stringify(intake.data));
  const planId = intake.data.taskIds[0],
    runId = c.store.task(planId).workflowReference.runId;
  assert.equal(c.store.run(runId).autoMode, true);
  assert.equal(c.store.task(planId).autoMode, true);
  await c.accept(projectId, planId);
  const steps = c.store.task(planId).proposedTaskIds.map(id => c.store.task(id));
  assert.equal(steps.length, 2);
  assert.ok(steps.every(step => step.autoMode === true && step.runReference.runId === runId));
  // Sent without auto mode, an idea leaves it to the Settings, as before.
  const plain = await c.request('/api/intake', { projectId, idea: 'Write another guide.\n- Draft it' }),
    plainPlan = c.store.task(plain.data.taskIds[0]);
  assert.equal(Object.hasOwn(c.store.run(plainPlan.workflowReference.runId), 'autoMode'), false);
  assert.equal(Object.hasOwn(plainPlan, 'autoMode'), false);
  // Work that already chose keeps its own setting when it joins the run.
  const chosen = { id: 'T-chosen', autoMode: false, dependencies: [], kind: 'general:work', title: 'Chosen' };
  expandRun(c.store, runId, { reason: 'Test.', source: planId, tasks: [chosen] });
  assert.equal(chosen.autoMode, false);
});

test('a project made with the recommended house rules, as Add a project sends, starts on them; one without waits for the director', async t => {
  const c = await setup(t),
    policy = id => c.store.setting('project-autonomy:' + id),
    before = c.store.projects().length;
  const refused = await c.request('/api/projects', { name: 'Sometimes', houseRules: 'sometimes' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /House rules are 'recommended' or 'off'/);
  assert.equal(c.store.projects().length, before);
  for (const houseRules of [undefined, 'off']) {
    const plain = await c.request('/api/projects', { name: `Plain ${houseRules}`, houseRules });
    assert.equal(plain.status, 201, JSON.stringify(plain.data));
    assert.equal(policy(plain.data.id), null);
  }
  const created = await c.request('/api/projects', { name: 'Recommended guide', houseRules: 'recommended' }),
    projectId = created.data.id;
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const saved = policy(projectId);
  assert.deepEqual(
    {
      revision: saved.revision,
      enabled: saved.enabled,
      retries: saved.retries,
      kinds: saved.kinds,
      cycle: saved.cycle,
    },
    {
      revision: 1,
      enabled: true,
      retries: 1,
      kinds: {
        'general:plan': { approve: 'director', accept: 'auto' },
        'general:work': { approve: 'director', accept: 'auto' },
        'general:review': { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    },
  );
  assert.equal(c.store.events(null, { logs: false }).filter(event => event.kind === 'autonomy_updated').length, 1);
  // The plan is accepted by the policy; the work it proposes waits for the director's approval.
  const intake = await c.request('/api/intake', { projectId, idea: 'Write a guide.\n- Draft the guide' });
  assert.equal(intake.status, 201, JSON.stringify(intake.data));
  const [stepId] = await c.until(
    () => c.store.task(intake.data.taskIds[0]).proposedTaskIds,
    'the plan to propose work',
  );
  assert.equal(c.store.task(stepId).approval.status, 'pending');
});

test("with autonomy on, only approving the plan's work is the director's; a review that asks for changes retries the work once", async t => {
  const c = await setup(t);
  for (const retries of [1, 0]) {
    const projectId = await c.project(`Autonomous guide ${retries}`, shapes.bench),
      policy = await c.request(`/api/projects/${projectId}/autonomy`, {
        projectId,
        expectedRevision: 0,
        enabled: true,
        retries,
        kinds: {
          'general:plan': { approve: 'director', accept: 'auto' },
          'general:work': { approve: 'director', accept: 'auto' },
          'general:review': { approve: 'auto', accept: 'auto' },
        },
        cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
      });
    assert.equal(policy.status, 200, JSON.stringify(policy.data));
    const intake = await c.request('/api/intake', { projectId, idea: 'Write a guide.\n- REWORK the guide draft' }),
      planId = intake.data.taskIds[0];
    // The plan is accepted automatically; its proposed work waits for the director's approval.
    const [stepId] = await c.until(() => c.store.task(planId).proposedTaskIds, 'the plan to propose work');
    assert.equal(c.store.task(stepId).approval.status, 'pending');
    assert.equal((await c.request(`/api/tasks/${stepId}/approve-work`, { projectId })).status, 200);
    if (retries) {
      // Work, a review that asks for changes, the automatic retry, and a passing review, all accepted
      // by the policy.
      const step = await c.until(
        () => c.store.task(stepId).status === 'done' && c.store.task(stepId),
        'the step to finish',
      );
      assert.deepEqual(
        step.stageState.history.map(entry => [entry.key, entry.outcome]),
        [
          ['work', 'accepted'],
          ['review', 'sent-back'],
          ['work', 'accepted'],
          ['review', 'accepted'],
        ],
      );
      assert.equal(step.autoRetries, 1);
      // (An approved task still carries its old approval note; the stop-explanation idea clears notes that no longer apply.)
      assert.doesNotMatch(step.autonomyNote || '', /Retry limit|Waiting/);
      assert.match(
        step.direction,
        /Automatic retry 1: the previous attempt did not pass\. Independent review requested changes\. Simulated review/,
      );
      const attempts = c.store.attempts(stepId);
      assert.ok(attempts.every(attempt => attempt.acceptedBy?.type === 'policy'));
      assert.match(c.read(attempts.at(-2), attempts.at(-2).artifacts[0]), /Revision 2\./);
    } else {
      // No retry left: the review is recorded, the work is sent back and waits for the director.
      const step = await c.until(
        () => /^Retry limit/.test(c.store.task(stepId).autonomyNote || '') && c.store.task(stepId),
        'the director fallback',
      );
      assert.equal(step.status, 'blocked');
      assert.match(step.autonomyNote, /^Retry limit reached for/);
      assert.match(step.reason, /Independent review sent this back: .* Start it to run Work again\./);
    }
  }
});

// The chat box, October 30: under house rules that accept a plan by themselves, the director's reply comes after the
// plan was accepted, while its steps wait for approval.
test('a reply to a plan the house rules accepted sets its waiting steps aside and plans again with the reply', async t => {
  const c = await setup(t),
    projectId = await c.project('Replanned guide', shapes.bench),
    policy = await c.request(`/api/projects/${projectId}/autonomy`, {
      projectId,
      expectedRevision: 0,
      enabled: true,
      retries: 0,
      kinds: {
        'general:plan': { approve: 'director', accept: 'auto' },
        'general:work': { approve: 'director', accept: 'auto' },
        'general:review': { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    });
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  const intake = await c.request('/api/intake', { projectId, idea: 'Write a guide.' }),
    planId = intake.data.taskIds[0],
    [stepId] = await c.until(() => c.store.task(planId).proposedTaskIds, 'the plan to propose work'),
    first = c.store.task(planId).acceptedAttemptId;
  assert.equal(c.store.task(stepId).approval.status, 'pending');
  // Only its words.
  assert.equal((await c.request(`/api/tasks/${planId}/replan`, { projectId, direction: '' })).status, 400);
  const replied = await c.request(`/api/tasks/${planId}/replan`, { projectId, direction: 'Make it a one-page guide.' });
  assert.equal(replied.status, 202, JSON.stringify(replied.data));
  assert.deepEqual(replied.data.setAside, [stepId]);
  const setAside = c.store.task(stepId);
  assert.equal(setAside.status, 'denied');
  assert.equal(setAside.approval.reason, 'Planned again with your reply: Make it a one-page guide.');
  assert.equal(c.store.attempt(first).status, 'accepted', 'The first plan stays recorded.');
  assert.equal(c.store.attempt(first).replannedBy.reason, 'Make it a one-page guide.');
  // The plan runs again with the reply and proposes its new step, waiting for the director as before.
  const replanned = await c.until(() => {
    const plan = c.store.task(planId);
    return plan.status === 'done' && plan.acceptedAttemptId && plan.acceptedAttemptId !== first && plan;
  }, 'the plan to run again');
  assert.match(c.store.attempt(replanned.acceptedAttemptId).assignment.direction, /Make it a one-page guide\./);
  const fresh = replanned.proposedTaskIds.filter(id => id !== stepId);
  assert.ok(fresh.length);
  for (const id of fresh) assert.equal(c.store.task(id).approval.status, 'pending');
  // Once one of its steps has started, the plan is no longer planned again; nothing changes.
  assert.equal((await c.request(`/api/tasks/${fresh[0]}/approve-work`, { projectId })).status, 200);
  await c.until(() => c.store.attempts(fresh[0]).length, 'the new step to start');
  const refused = await c.request(`/api/tasks/${planId}/replan`, { projectId, direction: 'Shorter still.' });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /have started/);
  assert.equal(c.store.task(planId).acceptedAttemptId, replanned.acceptedAttemptId);
});

// The Simulator review of a step titled REWORK ... FAILED CHECK asks for changes and also reports a
// failed check of its own, as a reviewer may when it records the problem it found both ways.
const checkedIdea = 'Write a guide.\n- REWORK the guide draft with a FAILED CHECK';

test('with house rules, a review that asks for changes and fails a check of its own sends the work back once and is not retried', async t => {
  const c = await setup(t),
    projectId = await c.project('Checked guide', shapes.bench),
    policy = await c.request(`/api/projects/${projectId}/autonomy`, {
      projectId,
      expectedRevision: 0,
      enabled: true,
      retries: 1,
      kinds: {
        'general:plan': { approve: 'director', accept: 'auto' },
        'general:work': { approve: 'director', accept: 'auto' },
        'general:review': { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    });
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  const intake = await c.request('/api/intake', { projectId, idea: checkedIdea }),
    [stepId] = await c.until(() => c.store.task(intake.data.taskIds[0]).proposedTaskIds, 'the plan to propose work');
  assert.equal((await c.request(`/api/tasks/${stepId}/approve-work`, { projectId })).status, 200);
  const step = await c.until(
    () => c.store.task(stepId).status === 'done' && c.store.task(stepId),
    'the step to finish',
  );
  assert.deepEqual(
    step.stageState.history.map(entry => [entry.key, entry.outcome]),
    [
      ['work', 'accepted'],
      ['review', 'sent-back'],
      ['work', 'accepted'],
      ['review', 'accepted'],
    ],
  );
  const attempts = c.store.attempts(stepId),
    works = attempts.filter(attempt => attempt.assignment.kind === 'general:work'),
    reviews = attempts.filter(attempt => attempt.assignment.kind === 'general:review'),
    rejected = reviews[0];
  // The policy recorded the review that asked for changes, its own failed check included, as evidence.
  assert.equal(rejected.workReviewVerdict, 'needs-work');
  assert.deepEqual(
    rejected.result.checks.map(check => [check.name, check.status]),
    [['Simulated reviewer check', 'fail']],
  );
  assert.equal(rejected.status, 'accepted');
  assert.equal(rejected.acceptedBy.type, 'policy');
  // One review of each revision of the work: the unchanged first revision was not reviewed again.
  assert.deepEqual(
    reviews.map(review => review.inputReferences[0].attemptId),
    works.map(work => work.id),
  );
  // The work ran again with the review's summary and findings; no retry named the failed check.
  assert.equal(step.autoRetries, 1);
  assert.equal(step.stageRetries, undefined);
  assert.match(
    step.direction,
    /Automatic retry 1: the previous attempt did not pass\. Independent review requested changes\. Simulated review: the first revision needs another pass\.\n- Simulated finding: revise once\./,
  );
  for (const direction of [step.direction, step.stageState.direction, ...attempts.map(a => a.assignment.direction)])
    assert.doesNotMatch(direction || '', /Failed checks/);
});

test("the director's accept of a review that asks for changes and fails a check of its own sends the work back", async t => {
  const c = await setup(t),
    projectId = await c.project('Directed guide', shapes.bench),
    intake = await c.request('/api/intake', { projectId, idea: checkedIdea }),
    planId = intake.data.taskIds[0];
  await c.accept(projectId, planId);
  const [stepId] = c.store.task(planId).proposedTaskIds;
  assert.equal((await c.request(`/api/tasks/${stepId}/approve-work`, { projectId })).status, 200);
  assert.equal((await c.request(`/api/tasks/${stepId}/start`, { projectId })).status, 202);
  await c.accept(projectId, stepId);
  // c.accept requires the accept to succeed, where it used to refuse: 'The worker reported a failed check'.
  const rejected = await c.accept(projectId, stepId);
  assert.equal(rejected.assignment.kind, 'general:review');
  assert.equal(rejected.workReviewVerdict, 'needs-work');
  assert.ok(rejected.result.checks.some(check => check.status === 'fail'));
  assert.equal(rejected.contracts.task.acceptFailedChecks, true);
  assert.deepEqual([rejected.status, rejected.acceptedBy.type], ['accepted', 'director']);
  const step = c.store.task(stepId);
  assert.equal(step.status, 'blocked');
  assert.match(step.reason, /Independent review sent this back: .* Start it to run Work again\./);
  assert.deepEqual(
    step.stageState.history.map(entry => [entry.key, entry.outcome]),
    [
      ['work', 'accepted'],
      ['review', 'sent-back'],
    ],
  );
});

test('an idea sent with library files left out does without them from its first step, and records what it left out', async t => {
  const c = await setup(t),
    projectId = await c.project('Library guide', shapes.bench),
    add = async (name, text) =>
      (
        await c.request(`/api/projects/${projectId}/library`, {
          projectId,
          name,
          purpose: `The ${name.toLowerCase()}.`,
          file: { name: 'file.md', data: Buffer.from(text).toString('base64') },
        })
      ).data;
  const style = await add('Style', '# Style\n'),
    old = await add('Old style', '# Old\n');
  const intake = await c.request('/api/intake', {
    projectId,
    idea: 'Write a short welcome page.',
    libraryLeftOut: [old.id],
  });
  assert.equal(intake.status, 201, JSON.stringify(intake.data));
  assert.deepEqual(c.store.run(intake.data.runId).libraryLeftOut, [old.id]);
  // The idea as the dashboard reads it carries what it left out: in the live set and on its own.
  const live = await (await fetch(`${c.origin}/api/projects/${projectId}/live?projectId=${projectId}`)).json(),
    one = await (
      await fetch(`${c.origin}/api/projects/${projectId}/runs/${intake.data.runId}?projectId=${projectId}`)
    ).json();
  assert.deepEqual(live.runs.find(run => run.id === intake.data.runId).libraryLeftOut, [old.id]);
  assert.deepEqual((one.run ?? one).libraryLeftOut, [old.id]);
  const planId = intake.data.taskIds[0];
  await c.until(() => c.store.task(planId).lastAttemptId, 'the planner starts');
  const attempt = c.store.attempt(c.store.task(planId).lastAttemptId);
  assert.deepEqual(
    attempt.libraryReferences.map(item => item.entryId),
    [style.id],
  );
  assert.deepEqual(attempt.libraryLeftOut, [{ entryId: old.id, name: 'Old style' }]);
  const unknown = await c.request('/api/intake', {
    projectId,
    idea: 'Another page.',
    libraryLeftOut: ['lib-00000000-0000-4000-8000-000000000000'],
  });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Leave out only entries of this project's library/);
});
