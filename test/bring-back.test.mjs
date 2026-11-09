// Bringing a fix back (1.1, added October 27): the director brings a fix that landed on a newer line back to an older
// one and every maintained line between, newest first, each with git cherry-pick from the commit the line before it
// got, tested there and committed naming the commit it came from, as a carry forward is. A line that already has the
// fix is passed over, a story that builds on another waits for it, and bringing back an idea brings back each of its
// stories in the order they landed. The policy never brings a fix back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { waitFor, waitLimit } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { carryWaits } from '../src/connectors/source-carries.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { acceptAttempt } from '../src/core/acceptance.mjs';
import { autonomyPolicy, saveAutonomyPolicy } from '../src/core/autonomy.mjs';

const project = 'project-legacy',
  target = 'src/core/workflows.mjs';
// A project with release lines, oldest first, the last the newest (main, which the folder has checked out).
// A slowed step runs the project's tests 1.5 seconds longer each time (test/fixture-source-check.mjs, 'slow').
async function lined(t, releases, checkMode = 'pass') {
  const c = await setup(t, checkMode);
  for (const branch of releases) await addLine(c, branch);
  return c;
}
async function addLine(c, branch) {
  git(c.root, ['branch', branch]);
  const added = await c.request(`/api/projects/${project}/lines`, { projectId: project, branch });
  assert.equal(added.status, 201, JSON.stringify(added.data));
}
// A fix on main, edited, reviewed and integrated at the director's word.
async function landedFix(c, name = 'fix') {
  c.taskId = await c.propose(name);
  await c.start();
  const edit = await c.wait(c.taskId),
    review = await c.review(edit);
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  return { review, integration: await c.settled(review, ['integrated']), storyId: c.taskId };
}
// A commit on a branch the folder does not have checked out.
function commitOn(c, branch, text) {
  const worktree = path.join(c.directory, `w-${branch.replace(/\W/g, '-')}`);
  git(c.root, ['worktree', 'add', '--quiet', worktree, branch]);
  try {
    fs.appendFileSync(path.join(worktree, target), text);
    git(worktree, ['commit', '--quiet', '-am', `A change on ${branch}`]);
  } finally {
    git(c.root, ['worktree', 'remove', '--force', worktree]);
  }
}
const carriesOf = (c, review) => c.app.store.attempt(review.id).sourceCarries;
// A wait that covers several carries in a row (an idea's) is given their time as its limit.
const settledCarry = (c, review, index, { limit = waitLimit } = {}) =>
  waitFor(
    () =>
      ['carried', 'rejected', 'merging', 'needs-reconciliation'].includes(carriesOf(c, review)?.[index]?.state) &&
      !c.app.runner.sourceIntegrationRun &&
      carriesOf(c, review)[index],
    `carry ${index} of ${review.id} to settle`,
    { limit, detail: () => JSON.stringify(carriesOf(c, review)) },
  );
// A read that fails names its route and its network cause: the test runner prints only "fetch failed", which twice on
// November 4, 2026 could not say whether the connection was refused, reset or timed out. The body is read inside the
// same guard, since a connection cut after the headers fails there ("terminated"), not in fetch.
const read = async (c, route) => {
  try {
    const response = await fetch(`${c.origin}${route}?projectId=${project}`);
    return await response.json();
  } catch (error) {
    const cause = error.cause?.code ?? error.cause?.message ?? 'no cause given';
    throw new Error(`Reading ${route}: ${error.message} (${cause})`, { cause: error });
  }
};
test('a read cut off after its headers names its route and network cause', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"lines":');
    setImmediate(() => res.socket.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The reply's headers arrive, so fetch resolves and the body read fails: undici says "terminated" there, and
  // "fetch failed" only when fetch itself rejects. The socket's own code is the cause the runner never printed.
  await assert.rejects(read({ origin }, '/api/cut'), error => {
    assert.equal(error.message, 'Reading /api/cut: terminated (UND_ERR_SOCKET)');
    assert.equal(error.cause?.message, 'terminated', 'The original rejection, from the body read, stays attached.');
    assert.equal(error.cause?.cause?.code, 'UND_ERR_SOCKET');
    return true;
  });
});
const message = (c, ref) => git(c.root, ['log', '-1', '--format=%B', ref]);
const show = (c, ref, file = target) => git(c.root, ['show', `${ref}:${file}`]);

test('the director brings a fix that landed on main back to an older line, which then has it', async t => {
  const c = await lined(t, ['release/1.0']),
    store = c.app.store,
    release10 = git(c.root, ['rev-parse', 'refs/heads/release/1.0']);
  assert.deepEqual(await read(c, `/api/tasks/${c.taskId}/bring-back`), {
    lines: [],
    reason: 'Only a story whose change landed on a line can be brought back.',
  });
  const { review, integration, storyId } = await landedFix(c);
  assert.equal(
    carriesOf(c, review),
    undefined,
    'A fix on the newest line plans nothing; the policy never brings back.',
  );
  assert.deepEqual(await read(c, `/api/tasks/${storyId}/bring-back`), {
    lines: [{ line: 'release/1.0', through: ['release/1.0'] }],
  });
  const act = data => c.request(`/api/tasks/${storyId}/bring-back`, { projectId: project, ...data });
  assert.match((await act({ line: 'release/1.0', note: 'x' })).data.error, /Bring back takes the line/);
  assert.match((await act({})).data.error, /Name the line to bring the fix back to/);
  assert.match(
    (await act({ line: 'main' })).data.error,
    /main is not a maintained line older than main, where it landed/,
  );
  const brought = await act({ line: 'release/1.0' });
  assert.equal(brought.status, 202, JSON.stringify(brought.data));
  assert.deepEqual([brought.data.storyId, brought.data.lines], [storyId, ['release/1.0']]);
  const carry = await settledCarry(c, review, 0);
  assert.equal(carry.state, 'carried', JSON.stringify(carry));
  assert.deepEqual(
    {
      line: carry.line,
      back: carry.back,
      fromLine: carry.fromLine,
      fromCommit: carry.fromCommit,
      by: carry.approvedBy.type,
    },
    { line: 'release/1.0', back: carry.id, fromLine: 'main', fromCommit: integration.commit, by: 'director' },
  );
  // release/1.0 moved one commit, which names the commit it came from; main is unchanged.
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), carry.commit);
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0~1']), release10);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), integration.commit);
  assert.match(message(c, 'release/1.0'), /^Bring “Improve fix” back to release\/1\.0\n/);
  assert.match(
    message(c, 'release/1.0'),
    new RegExp(
      `Brought back by Studio desk from main \\(cherry picked from commit ${integration.commit}\\), approved by the director\\.`,
    ),
  );
  assert.match(show(c, 'release/1.0'), /Bounded fixture improvement\./);
  assert.equal(store.leases().length, 0);
  const said = kind => store.events().filter(event => event.kind === kind && event.task_id === storyId);
  assert.deepEqual(
    said('bring_back_planned').map(event => event.message),
    ['The director brings the fix back to release/1.0.'],
  );
  assert.match(said('carry_done')[0].message, /^Brought the fix back to release\/1\.0 as commit /);
  // Its page and the compact state read where it went.
  const summary = store.dashboardAttempts(project, storyId).find(attempt => attempt.id === review.id);
  assert.deepEqual(
    summary.sourceCarries.map(item => [item.line, item.state, item.back]),
    [['release/1.0', 'carried', true]],
  );
  assert.deepEqual(await read(c, `/api/tasks/${storyId}/bring-back`), {
    lines: [{ line: 'release/1.0', reason: 'release/1.0 already has it.' }],
  });
  assert.match((await act({ line: 'release/1.0' })).data.error, /release\/1\.0 already has it/);
});

test('a fix brought back goes through every maintained line between, newest first, each from the line before', async t => {
  const c = await lined(t, ['release/1.0', 'release/1.1']),
    { review, integration, storyId } = await landedFix(c);
  assert.deepEqual(await read(c, `/api/tasks/${storyId}/bring-back`), {
    lines: [
      { line: 'release/1.1', through: ['release/1.1'] },
      { line: 'release/1.0', through: ['release/1.1', 'release/1.0'] },
    ],
  });
  const brought = await c.request(`/api/tasks/${storyId}/bring-back`, { projectId: project, line: 'release/1.0' });
  assert.deepEqual(brought.data.lines, ['release/1.1', 'release/1.0']);
  const last = await settledCarry(c, review, 1),
    [first] = carriesOf(c, review);
  assert.deepEqual(
    [first.state, first.fromLine, first.fromCommit],
    ['carried', 'main', integration.commit],
    'The nearest line gets it from where it landed.',
  );
  assert.deepEqual([last.state, last.fromLine, last.fromCommit], ['carried', 'release/1.1', first.commit]);
  assert.equal(last.back, first.back, 'Both are one bringing back.');
  for (const line of ['release/1.1', 'release/1.0']) assert.match(show(c, line), /Bounded fixture improvement\./);
});

test('a line that already has the fix is passed over: one cut after it landed, or one it was copied to by hand', async t => {
  const c = await lined(t, ['release/1.0']),
    { review, integration, storyId } = await landedFix(c);
  // release/1.1 is cut from main after the fix landed, so its history holds the fix.
  await addLine(c, 'release/1.1');
  assert.deepEqual(await read(c, `/api/tasks/${storyId}/bring-back`), {
    lines: [
      { line: 'release/1.1', reason: 'release/1.1 already has it.' },
      { line: 'release/1.0', through: ['release/1.0'] },
    ],
  });
  // Someone copies the fix to release/1.0 by hand: git sees the same change under another commit.
  const worktree = path.join(c.directory, 'w-by-hand');
  git(c.root, ['worktree', 'add', '--quiet', worktree, 'release/1.0']);
  git(worktree, ['cherry-pick', integration.commit]);
  git(c.root, ['worktree', 'remove', '--force', worktree]);
  assert.deepEqual((await read(c, `/api/tasks/${storyId}/bring-back`)).lines[1], {
    line: 'release/1.0',
    reason: 'release/1.0 already has it.',
  });
  const refused = await c.request(`/api/tasks/${storyId}/bring-back`, { projectId: project, line: 'release/1.0' });
  assert.equal(refused.status, 400);
  assert.equal(carriesOf(c, review), undefined);
});

test('a fix that conflicts on the older line is brought back by a story there, and the line it came from is not carried to again', async t => {
  const c = await lined(t, ['release/1.0']),
    store = c.app.store;
  // release/1.0 changed the same lines before the fix landed on main.
  commitOn(c, 'release/1.0', '\n// A different change on release/1.0.\n');
  const tip = git(c.root, ['rev-parse', 'refs/heads/release/1.0']),
    { review, integration, storyId } = await landedFix(c);
  assert.equal(
    (await c.request(`/api/tasks/${storyId}/bring-back`, { projectId: project, line: 'release/1.0' })).status,
    202,
  );
  const carry = await settledCarry(c, review, 0);
  assert.equal(carry.state, 'merging', JSON.stringify(carry));
  assert.equal(git(c.root, ['rev-parse', 'refs/heads/release/1.0']), tip, 'release/1.0 waits for the story.');
  const story = store.task(carry.storyId);
  assert.equal(story.title, 'Bring back to release/1.0: Improve fix');
  assert.deepEqual(story.carryOf, {
    storyId,
    reviewAttemptId: review.id,
    carryId: carry.id,
    line: 'release/1.0',
    fromCommit: integration.commit,
    back: true,
  });
  assert.match(
    story.direction,
    /^Bring the fix of T-\w+ \(“Improve fix”\), already reviewed and integrated on main, back to release\/1\.0\./,
  );
  c.taskId = story.id;
  const edit = await c.wait(story.id);
  assert.deepEqual(edit.sourceChange.base, { commit: tip, branch: 'release/1.0' });
  const second = await c.review(edit);
  await c.accept(second.taskId);
  assert.equal((await c.integration(second)).status, 200);
  const landed = await c.settled(second, ['integrated']);
  assert.deepEqual([carriesOf(c, review)[0].state, carriesOf(c, review)[0].commit], ['carried', landed.commit]);
  assert.equal(store.attempt(second.id).sourceCarries, undefined, 'main, where the fix came from, is not offered it.');
  assert.ok(
    store
      .events()
      .some(
        event => event.kind === 'carry_done' && /^Brought the fix back to release\/1\.0 through T-/.test(event.message),
      ),
  );
  const final = show(c, 'release/1.0');
  assert.match(final, /A different change on release\/1\.0\./);
  assert.match(final, /Bounded fixture improvement\./);
  assert.equal(git(c.root, ['rev-parse', 'HEAD']), integration.commit);
});

// This test runs eight controller steps one after another: two edits, two reviews, two integrations and two carries.
// Each is waited for by what it records, never by time, and each has a full wait of its own; the test's time bound is
// the sum of those waits. It once had the suite's 120 seconds for all eight while one wait covered a review and its
// integration, so on a busy computer (four of five candidates on November 6, 2026, while several suites ran) it ran out
// of time, or its studio was closed under a request it was still making ("fetch failed"). Its project's tests are
// slowed, so every step takes longer than it needs to and the test still passes; the test after it runs these waits on
// a mocked clock with every step slowed far more, against the earlier budget too.
// The test's waits in the order it makes them, each with the controller steps it covers (an edit is waited for by
// c.wait, whose limit is one waitLimit).
const ideaWaits = [
  { label: 'the first story to be edited', steps: 1 },
  { label: 'the first story to be reviewed and integrated', steps: 2 },
  { label: 'the second story to be edited', steps: 1 },
  { label: 'the second story to be reviewed and integrated', steps: 2 },
  { label: 'both carries to settle', steps: 2 },
];
// A budget: each wait's limit, and the test's own bound.
const ideaBudget = {
  limits: ideaWaits.map(({ steps }) => steps * waitLimit),
  timeout: ideaWaits.reduce((sum, { steps }) => sum + steps, 0) * waitLimit,
};
// The budget it had before: one wait per wait it makes, and the suite's 120 seconds (package.json) for the whole test.
const earlierIdeaBudget = { limits: ideaWaits.map(() => waitLimit), timeout: 120000 };
test(
  'bringing back an idea brings its stories back in the order they landed; a story alone needs what it builds on',
  { timeout: ideaBudget.timeout },
  async t => {
    const c = await lined(t, ['release/1.0'], 'slow'),
      store = c.app.store,
      { runner } = c.app;
    saveAutonomyPolicy(store, runner.registries, project, {
      expectedRevision: autonomyPolicy(store, project).revision,
      enabled: true,
      retries: 0,
      kinds: {
        'studio-development:change': { approve: 'director', accept: 'director', integrate: 'auto' },
        'studio-development:change-review': { approve: 'auto', accept: 'auto' },
      },
      cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
    });
    const { ids } = await c.breakdown(),
      [first, second] = ids,
      planning = store.task('breakdown-task');
    planning.runReference = { runId: 'run-bring-back' };
    store.putTask(planning);
    for (const id of ids) {
      approveWork(store, runner.registries, store.task(id));
      runner.queueStart(id);
    }
    const reviews = [];
    for (const id of ids) {
      const edit = await c.wait(id);
      c.measuredFixture(edit);
      acceptAttempt(store, runner.registries, store.task(id));
      runner.autonomy.accepted(id);
      reviews.push(
        await waitFor(
          () => {
            const review = store.attempts(id).find(attempt => attempt.sourceIntegration?.state === 'integrated');
            return !runner.sourceIntegrationRun && review;
          },
          `${id} to be reviewed and integrated`,
          { limit: ideaBudget.limits[2 * reviews.length + 1] },
        ),
      );
    }
    assert.equal(store.task(second).dependencies.includes(first), true);
    const alone = await read(c, `/api/tasks/${second}/bring-back`);
    assert.match(
      alone.lines[0].reason,
      new RegExp(`builds on ${first} \\(“Refine workflow fixture”\\), which release/1\\.0 does not have`),
    );
    const idea = `/api/projects/${project}/runs/run-bring-back/bring-back`;
    assert.deepEqual(await read(c, idea), { lines: [{ line: 'release/1.0', through: ['release/1.0'] }] });
    const brought = await c.request(idea, { projectId: project, line: 'release/1.0' });
    assert.equal(brought.status, 202, JSON.stringify(brought.data));
    assert.deepEqual(brought.data.stories, [
      { storyId: first, lines: ['release/1.0'] },
      { storyId: second, lines: ['release/1.0'] },
    ]);
    assert.deepEqual(
      carriesOf(c, reviews[1])[0].after,
      [{ reviewAttemptId: reviews[0].id, carryId: carriesOf(c, reviews[0])[0].id, storyId: first }],
      'Its carry waits for the story before it on the same line.',
    );
    await settledCarry(c, reviews[1], 0, { limit: ideaBudget.limits[4] });
    assert.deepEqual(
      reviews.map(review => carriesOf(c, review)[0].state),
      ['carried', 'carried'],
    );
    assert.match(message(c, 'release/1.0~1'), /^Bring “Refine workflow fixture” back to release\/1\.0\n/);
    assert.match(message(c, 'release/1.0'), /^Bring “Refine project fixture” back to release\/1\.0\n/);
    assert.match(show(c, 'release/1.0', 'src/core/projects.mjs'), /Bounded fixture improvement\./);
    assert.match((await read(c, idea)).lines[0].reason, /release\/1\.0 already has every story of this idea/);
  },
);

// Makes the idea test's waits (ideaWaits) with a budget's limits on a mocked clock, against a controller whose steps
// finish one after another, each step ms after the last (its edits may overlap in a real run; one after another is the
// slowest), and says how it ended: 'passed', the wait that ran out, or that the test's own bound ran out first.
async function ideaUnderSlowSteps(t, budget, step) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const start = Date.now(),
      done = () => Math.floor((Date.now() - start) / step);
    let outcome,
      covered = 0;
    (async () => {
      for (const [index, { label, steps }] of ideaWaits.entries()) {
        const needed = (covered += steps);
        await waitFor(() => done() >= needed, label, { limit: budget.limits[index] });
      }
    })().then(
      () => (outcome = 'passed'),
      error => (outcome = error.message),
    );
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (outcome !== undefined) return outcome;
      if (Date.now() - start > budget.timeout) return `still waiting when the test's ${budget.timeout} ms ran out`;
      t.mock.timers.tick(500);
    }
  } finally {
    t.mock.timers.reset();
  }
}

test("the idea test's waits outlast a slowed controller's steps, where its earlier budget ran out", async t => {
  // Twenty seconds a step: every wait fits, but eight steps outlast the suite's 120 seconds for the whole test, which
  // then ends and closes its studio under the request it is making ("fetch failed").
  assert.equal(
    await ideaUnderSlowSteps(t, earlierIdeaBudget, 20000),
    "still waiting when the test's 120000 ms ran out",
  );
  // Forty seconds a step: one wait for a review and its integration runs out.
  assert.equal(
    await ideaUnderSlowSteps(t, earlierIdeaBudget, 40000),
    'Timed out after 60000 ms waiting for the first story to be reviewed and integrated.',
  );
  // Every step may take up to one full wait.
  for (const step of [20000, 40000, waitLimit - 500])
    assert.equal(await ideaUnderSlowSteps(t, ideaBudget, step), 'passed', `${step} ms a step`);
  assert.equal(
    await ideaUnderSlowSteps(t, ideaBudget, waitLimit + 500),
    'Timed out after 60000 ms waiting for the first story to be edited.',
  );
});

test("an idea's carry waits for the story before it on its line until that one is carried or not needed", () => {
  const before = { id: 'source-carry:review-a:0', line: 'release/1.0', state: 'waiting' },
    store = {
      attempt(id) {
        if (id !== 'review-a') throw new Error('Attempt not found.');
        return { id, sourceCarries: [before] };
      },
    },
    carry = {
      id: 'source-carry:review-b:0',
      line: 'release/1.0',
      state: 'waiting',
      after: [{ reviewAttemptId: 'review-a', carryId: before.id, storyId: 'T-a' }],
    };
  assert.equal(carryWaits(store, carry), before);
  for (const state of ['verifying', 'rejected', 'merging']) {
    before.state = state;
    assert.equal(carryWaits(store, carry), before, `${state} still holds it back`);
  }
  for (const state of ['carried', 'skipped']) {
    before.state = state;
    assert.equal(carryWaits(store, carry), null);
  }
  assert.equal(carryWaits(store, { ...carry, after: [{ ...carry.after[0], reviewAttemptId: 'gone' }] }), null);
  assert.equal(carryWaits(store, { line: 'release/1.0', state: 'waiting' }), null);
});
