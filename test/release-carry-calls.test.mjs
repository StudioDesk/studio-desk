// A project's calls (GET /api/projects/:id/calls, src/core/director-calls.mjs) list the two stops only the director
// moves on that the shared rules do not: a milestone's release that stopped, with Release again, and a story whose next
// carry or bring-back was turned down or stopped part-way, with the story's own Carry again and Not needed. Neither is
// listed while it still holds the test turn, nor while it is ready, waiting or running. Model-free: the source story
// fixture's protocol CLI, with the stopped release and carry records written as the controller leaves them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './source-story-setup.mjs';
import { waitFor } from './wait-for.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { projectMilestones } from '../src/connectors/source-milestones.mjs';
import { testTurnResource } from '../src/core/test-turn.mjs';
// Read as a namespace, so this file also loads against a module that has no Release again action yet and fails on
// the missing calls rather than on the import.
import * as directorCallsModule from '../src/core/director-calls.mjs';

const { directorCallsComputed } = directorCallsModule;

const project = 'project-legacy';

// A director read with the director's key.
const get = async (c, route) => {
  const res = await fetch(c.origin + route, { headers: { 'x-studio-key': c.app.directorKey } });
  const data = await res.json();
  assert.equal(res.status, 200, `${route}: ${JSON.stringify(data)}`);
  return data;
};
// Everything a read could change: the store's version, every task with its attempts, the settings the milestones are
// kept in, the leases and the event log.
const recorded = store =>
  JSON.stringify({
    version: store.version,
    tasks: store.tasks().map(task => [task, store.attempts(task.id)]),
    milestones: projectMilestones(store, project),
    leases: store.leases(),
    events: store.events(null),
  });
// The scheduler at rest, so nothing it records lands while a read is answered.
const settled = async c => {
  const { store, runner } = c.app;
  let version = null,
    quiet = 0;
  await waitFor(() => {
    if (runner.scheduled || runner.dispatching || runner.measuringSources || store.version !== version) {
      version = store.version;
      quiet = 0;
      return false;
    }
    return ++quiet >= 3;
  }, 'the scheduler to settle');
};
// The list, read once; reading it changes no record.
const calls = async c => {
  await settled(c);
  const before = recorded(c.app.store),
    answer = await get(c, `/api/projects/${project}/calls`);
  assert.equal(recorded(c.app.store), before, 'Reading the list changed no record.');
  assert.equal(answer.count, answer.items.length);
  assert.equal(answer.version, c.app.store.version);
  return answer;
};
const ofType = (answer, type) => answer.items.filter(item => item.type === type);
const carryActions = ['carry', 'carry-skip'];
// Sends a call's action as the dashboard would: its method and path, with its fields' values.
const send = (c, action, values = {}) => {
  assert.equal(action.method, 'POST');
  return c.request(action.path, {
    ...Object.fromEntries(action.fields.filter(field => 'value' in field).map(field => [field.name, field.value])),
    ...values,
  });
};

// A project with release/1.0 and main, a fix integrated on release/1.0 whose carry to main waits for the director, and
// the project paused so nothing it is handed starts on its own.
async function fixed(t) {
  const c = await setup(t);
  git(c.root, ['branch', 'release/1.0']);
  const added = await c.request(`/api/projects/${project}/lines`, { projectId: project, branch: 'release/1.0' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  c.taskId = await c.propose('fix', { branch: 'release/1.0' });
  await c.start();
  const review = await c.review(await c.wait(c.taskId));
  await c.accept(review.taskId);
  assert.equal((await c.integration(review)).status, 200);
  await c.settled(review, ['integrated']);
  assert.equal((await c.request('/api/pipeline', { projectId: project, action: 'pause' })).status, 200);
  const store = c.app.store;
  assert.deepEqual(
    store.attempt(review.id).sourceCarries.map(item => [item.line, item.state]),
    [['main', 'waiting']],
  );
  // The carry's record as the controller saves it.
  const setCarry = fields => {
    const attempt = store.attempt(review.id);
    Object.assign(attempt.sourceCarries[0], fields);
    for (const [key, value] of Object.entries(fields)) if (value === undefined) delete attempt.sourceCarries[0][key];
    store.updateAttempt(attempt);
    return attempt.sourceCarries[0];
  };
  return { c, store, review, setCarry };
}

const releaseId = id => `source-release:${project}:${id}`;
const milestone = (id, version, release) => ({
  id,
  version,
  goal: '',
  line: 'release/1.0',
  state: 'open',
  release: release && { id: releaseId(id), ...release },
});

test('the calls list a stopped release and a turned-down carry, each once with the action that moves it on, and lose them once acted on', async t => {
  const { c, store, review, setCarry } = await fixed(t),
    story = c.taskId;
  const before = await calls(c);
  assert.deepEqual([ofType(before, 'release'), ofType(before, 'carry')], [[], []], 'A waiting carry is not a call.');

  // Releases in every state; only the stopped one that gave its test turn back is a call.
  const stoppedError = 'The controller stopped while this release moved its line.';
  store.putSetting(`milestones:${project}`, [
    milestone('m-none', '1.0.1'),
    milestone('m-drafting', '1.0.2', { state: 'drafting' }),
    milestone('m-ready', '1.0.3', { state: 'ready' }),
    milestone('m-verifying', '1.0.4', { state: 'verifying' }),
    milestone('m-committing', '1.0.5', { state: 'committing' }),
    milestone('m-released', '1.0.6', { state: 'released' }),
    milestone('m-held', '1.0.7', { state: 'rejected', error: 'Its tests failed.' }),
    milestone('m-stopped', '1.0.8', {
      state: 'needs-reconciliation',
      error: stoppedError,
      root: c.root,
      changes: [{ path: 'package.json' }],
      notesTaskId: 'T-notes',
    }),
  ]);
  store.claim([testTurnResource], releaseId('m-held'));
  // The carry to main was turned down when its carry story was closed.
  const carryError = 'Its carry story, T-closed, was closed: The conflict needs a different approach.';
  const carry = setCarry({ state: 'rejected', error: carryError });

  const listed = await calls(c);
  const releases = ofType(listed, 'release'),
    carries = ofType(listed, 'carry');
  assert.deepEqual(
    [releases.length, carries.length],
    [1, 1],
    `One stopped release and one turned-down carry are calls: ${JSON.stringify(listed.items)}`,
  );
  assert.deepEqual(
    listed.items.slice(-2),
    [releases[0], carries[0]],
    'Releases come after the shared calls, then carries.',
  );
  const action = {
    key: 'release-again',
    label: 'Release again',
    emphasis: 'primary',
    closing: false,
    method: 'POST',
    path: `/api/projects/${project}/milestones/m-stopped/release/again`,
    fields: [{ name: 'projectId', required: true, kind: 'id', value: project }],
  };
  assert.equal(typeof directorCallsModule.releaseAgainAction, 'function', 'Release again is exported beside resume.');
  assert.deepEqual(directorCallsModule.releaseAgainAction(project, 'm-stopped'), action);
  assert.deepEqual(releases[0], {
    type: 'release',
    projectId: project,
    milestoneId: 'm-stopped',
    version: '1.0.8',
    state: 'needs-reconciliation',
    taskIds: ['T-notes'],
    runId: null,
    kind: 'release-stopped',
    reason: `The release of 1.0.8 stopped part-way: ${stoppedError}`,
    next: "Restore or commit any of the release's files left changed in the project's folder, then release it again; it is tagged once.",
    action: 'Release again',
    details: [stoppedError],
    actions: [action],
  });
  // The carry call holds the story's own Carry again and Not needed, exactly as its task read serves them.
  const read = await get(c, `/api/tasks/${story}?projectId=${project}`),
    served = read.actions.filter(item => ['carry', 'carry-skip'].includes(item.key));
  assert.deepEqual(
    served.map(item => item.label),
    ['Carry to main again', 'Not needed on main…'],
  );
  assert.deepEqual(carries[0], {
    type: 'carry',
    projectId: project,
    taskId: story,
    taskIds: [story],
    title: store.task(story).title,
    line: 'main',
    back: false,
    state: 'rejected',
    runId: null,
    kind: 'carry-stopped',
    reason: `Carrying this fix to main was turned down: ${carryError}`,
    next: 'Carry it again, or say it is not needed there.',
    action: 'Carry to main again',
    details: [carryError],
    actions: served,
  });
  for (const item of [releases[0], carries[0]])
    assert.doesNotMatch(
      `${item.reason} ${item.next}`,
      /\.mjs|\.json|sourceCarries|needs-reconciliation|source-release/,
    );

  // Release again, sent as the call says: the release is ready again (held by the paused project) and leaves the list.
  const again = await send(c, releases[0].actions[0]);
  assert.equal(again.status, 202, JSON.stringify(again.data));
  assert.equal(again.data.state, 'ready');
  assert.equal(projectMilestones(store, project).find(item => item.id === 'm-stopped').release.state, 'ready');
  assert.deepEqual(
    ofType(await calls(c), 'release'),
    [],
    'A ready release, held for the project to resume, is not a call.',
  );

  // A turned-down carry that still holds the test turn waits for it; given back, it is a call again.
  // (The turn has one holder, so the held release hands it over while the carry holds it.)
  store.tx(() => {
    store.releaseResource(testTurnResource, releaseId('m-held'));
    store.claim([testTurnResource], carry.id);
  });
  assert.deepEqual(ofType(await calls(c), 'carry'), []);
  store.tx(() => {
    store.releaseResource(testTurnResource, carry.id);
    store.claim([testTurnResource], releaseId('m-held'));
  });
  assert.deepEqual(ofType(await calls(c), 'carry'), carries);
  assert.deepEqual(ofType(await calls(c), 'release'), []);

  // Carry again, sent as the call says: the carry waits again, approved, and leaves the list.
  const carried = await send(c, carries[0].actions[0]);
  assert.equal(carried.status, 202, JSON.stringify(carried.data));
  assert.equal(store.attempt(review.id).sourceCarries[0].state, 'waiting');
  assert.equal(store.attempt(review.id).sourceCarries[0].approvedBy.type, 'director');
  assert.deepEqual(ofType(await calls(c), 'carry'), []);

  // With no story's actions reading git on it, the list is kept while nothing moves. Giving the held turn back moves
  // the store's version, so the next read works the list out afresh and lists that release; releasing it again does
  // the same and takes it off.
  const kept = await calls(c);
  let computed = directorCallsComputed();
  assert.deepEqual(await calls(c), kept);
  assert.equal(directorCallsComputed(), computed, 'Nothing moved, so the kept list was answered.');
  store.releaseResource(testTurnResource, releaseId('m-held'));
  const freed = await calls(c);
  assert.equal(directorCallsComputed(), computed + 1, 'The turn given back works the list out afresh.');
  assert.deepEqual(
    ofType(freed, 'release').map(item => [item.milestoneId, item.state, item.reason, item.next, item.taskIds]),
    [
      [
        'm-held',
        'rejected',
        'The release of 1.0.7 stopped: Its tests failed.',
        'Release it again; it is tagged once.',
        [],
      ],
    ],
  );
  assert.equal((await send(c, ofType(freed, 'release')[0].actions[0])).status, 202);
  computed = directorCallsComputed();
  assert.deepEqual(ofType(await calls(c), 'release'), []);
  assert.equal(directorCallsComputed(), computed + 1, 'Releasing again works the list out afresh.');

  // Waiting, merging, verifying and committing carries are not calls.
  for (const state of ['merging', 'verifying', 'committing']) {
    setCarry({ state });
    assert.deepEqual(ofType(await calls(c), 'carry'), [], state);
  }

  // A bring-back that was turned down is listed the same way, worded as bringing back; one stopped part-way offers
  // only Bring back again.
  setCarry({
    state: 'rejected',
    back: true,
    error: 'Its story bringing the fix back, T-closed, was closed: Not this way.',
  });
  const [back] = ofType(await calls(c), 'carry');
  assert.deepEqual(
    [back.back, back.reason, back.next, back.action, back.actions.map(item => item.label)],
    [
      true,
      'Bringing this fix back to main was turned down: Its story bringing the fix back, T-closed, was closed: Not this way.',
      'Bring it back again, or say it is not needed there.',
      'Bring back to main again',
      ['Bring back to main again', 'Not needed on main…'],
    ],
  );
  setCarry({ state: 'needs-reconciliation', error: 'The controller stopped while this carry moved its line.' });
  const [partWay] = ofType(await calls(c), 'carry');
  assert.deepEqual(
    [partWay.state, partWay.reason, partWay.actions.map(item => item.key)],
    [
      'needs-reconciliation',
      'Bringing this fix back to main stopped part-way: The controller stopped while this carry moved its line.',
      ['carry'],
    ],
  );

  // A story with a call of its own from the shared rules is listed once, by that call. With only its turned-down carry
  // it is listed by the carry call alone.
  setCarry({ state: 'rejected', back: undefined, error: carryError });
  const ofStory = answer =>
    answer.items.filter(item => item.taskId === story || item.taskIds?.includes(story)).map(item => item.type);
  const alone = await calls(c);
  assert.deepEqual(ofStory(alone), ['carry']);
  // The integrated story is finished, so the shared rules read it only as a direct prerequisite of open work: other
  // open work comes to wait on it, and it is still listed by its carry call alone.
  const waiting = store.task(alone.items.find(item => item.type === 'task' && item.taskId !== story).taskId);
  store.putTask({ ...waiting, dependencies: [...(waiting.dependencies || []), story] });
  assert.deepEqual(ofStory(await calls(c)), ['carry']);
  // An earlier attempt on the story left interrupted and not yet reconciled, as a controller stop leaves one: the
  // shared rules now give the story its own call (Reconcile interrupted attempt), while its task read still serves
  // Carry again and Not needed, so a carry call would be listed beside it were the story not already on the list.
  const earlier = store.attempts(story).find(attempt => attempt.id !== review.id);
  assert.ok(earlier, 'The story has an attempt before its review.');
  store.updateAttempt({ ...earlier, status: 'interrupted', reconciledAt: undefined });
  const own = await calls(c);
  const shared = own.items.filter(item => item.type === 'task' && item.taskId === story);
  assert.deepEqual(
    shared.map(item => [item.kind, item.action]),
    [['interrupted', 'Reconcile interrupted attempt']],
    JSON.stringify(own.items),
  );
  assert.deepEqual(
    shared[0].actions.filter(item => carryActions.includes(item.key)).map(item => item.label),
    ['Carry to main again', 'Not needed on main…'],
    'The story still offers to move its carry on.',
  );
  assert.deepEqual(ofStory(own), ['task'], JSON.stringify(own.items));
  assert.deepEqual(ofType(own, 'carry'), []);
  assert.equal(own.count, own.items.length);
});
