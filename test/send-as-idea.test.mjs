// Close and send as a new idea (November 3, 2026): a story whose plan the code moved past is closed once its remaining
// work has entered as a new idea on the story's own line and milestone; anything else, or a refused idea, leaves the
// story as it was. Model-free: a temporary git source and the protocol fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup } from './source-story-setup.mjs';
import { approveWork } from '../src/core/proposals.mjs';
import { noteOutdated } from '../src/connectors/source-changes.mjs';
import { projectMilestones } from '../src/connectors/source-milestones.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import { sentAsIdeaReason } from '../src/core/idea-intake.mjs';

const project = 'project-legacy',
  summary = 'Keeps the board quick when many stories wait.',
  // Two unrelated stories of one breakdown, the first with a plain planned summary.
  stories = [
    { files: ['src/core/workflows.mjs'], summary, dependencies: [] },
    { files: ['src/core/projects.mjs'], dependencies: [] },
  ],
  // A path, a file name or a record's identifier.
  identifiers = /[\\/]|\.mjs|\.md|T-[0-9a-f]|attempt-|workflow-/i;

// The source story fixture with its project's dispatch held, so a new idea's steps wait instead of running.
async function studio(t) {
  const c = await setup(t),
    { store } = c.app;
  // The fixture's project takes ideas as a source project does: fresh checks, then a breakdown.
  const org = store.organization(),
    kinds = ['checks', 'breakdown', 'change', 'change-review'].map(name => `studio-development:${name}`);
  org.taskKinds = [...new Set([...(org.taskKinds || []), ...kinds])];
  org.kindOwners = { ...org.kindOwners, [kinds[0]]: 'W-06', [kinds[1]]: 'W-01' };
  store.setOrganization(org);
  c.send = (id, data = {}) => c.request(`/api/tasks/${id}/send-as-idea`, { projectId: project, ...data });
  c.outdated = id => {
    const task = store.task(id);
    assert.ok(noteOutdated(task, { outdated: { files: ['src/core/created.mjs'] } }));
    store.putTask(task);
    return task;
  };
  c.hold = () => store.putProject({ ...store.project(project), dispatchPaused: true });
  // The task and its attempts as recorded, and the ideas started so far.
  c.record = id => JSON.stringify({ task: store.task(id), attempts: store.attempts(id), runs: store.runs().length });
  return c;
}

test('a story whose plan is out of date is closed and its remaining work sent in as a new idea in plain words, or in the words given', async t => {
  const c = await studio(t),
    { store, runner } = c.app,
    { ids } = await c.breakdown(stories);
  c.hold();
  for (const id of ids) approveWork(store, runner.registries, store.task(id));
  for (const id of ids) c.outdated(id);
  // (a) Without words, the idea is the story's title, its planned summary and that it continues work the code moved
  // past: never its files, scope or identifiers.
  const sent = await c.send(ids[0]);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.closed, ids[0]);
  const run = store.run(sent.data.runId),
    title = store.task(ids[0]).title;
  assert.ok(run, "The answer names the new idea's run.");
  assert.ok(run.brief.includes(title), run.brief);
  assert.ok(run.brief.includes(summary), run.brief);
  assert.match(run.brief, /moved past/);
  assert.doesNotMatch(run.brief, identifiers);
  assert.doesNotMatch(run.brief, /Add a bounded comment/, 'The scope stays out of the idea.');
  assert.deepEqual(
    sent.data.idea.taskIds,
    store
      .tasks()
      .filter(task => task.workflowReference?.runId === run.id)
      .map(task => task.id),
  );
  // The story is closed with the recorded reason and the new idea's run.
  const closed = store.task(ids[0]);
  assert.equal(closed.status, 'denied');
  assert.equal(closed.reason, sentAsIdeaReason);
  assert.equal(closed.sentAsIdea.runId, run.id);
  assert.ok(Number.isFinite(Date.parse(closed.sentAsIdea.at)));
  const events = store.events().filter(event => event.task_id === ids[0]);
  const plain = events.find(event => event.kind === 'sent_as_idea');
  assert.ok(plain, 'The activity carries a plain event.');
  assert.doesNotMatch(plain.message, identifiers);
  // With the director's words, the idea is those words.
  const words = 'Bring the project fixture up to date with the new layout.',
    given = await c.send(ids[1], { idea: `  ${words}  ` });
  assert.equal(given.status, 201, JSON.stringify(given.data));
  assert.equal(store.run(given.data.runId).brief, words);
  assert.equal(store.task(ids[1]).sentAsIdea.runId, given.data.runId);
  // A closed story is not sent twice.
  const again = await c.send(ids[1]);
  assert.ok(again.status >= 400 && again.status < 500, JSON.stringify(again.data));
});

test('a started story in Review is closed with its pending attempt, and the idea lands on its release line and milestone', async t => {
  const c = await studio(t),
    { store } = c.app;
  // The fixture repository's history: 1.0.0 and 1.1.0 released, and main moved on.
  git(c.root, ['tag', 'v1.0.0']);
  fs.writeFileSync(path.join(c.root, 'README.md'), '// 1.1 work\n');
  git(c.root, ['commit', '--quiet', '-am', '1.1 work']);
  git(c.root, ['tag', 'v1.1.0']);
  const made = await c.request(`/api/projects/${project}/milestones`, { projectId: project, version: '1.1.1' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const milestone = made.data.milestone;
  assert.equal(milestone.line, 'release/1.1');
  // The setup's story waits in Review on the patch line's milestone.
  const story = store.task(c.taskId);
  story.release = {
    milestoneId: milestone.id,
    version: milestone.version,
    by: { type: 'director' },
    line: milestone.line,
  };
  store.putTask(story);
  await c.start();
  const edit = await c.wait(c.taskId);
  c.hold();
  c.outdated(c.taskId);
  // (b) The new idea lands on the story's line and milestone.
  const sent = await c.send(c.taskId);
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const run = store.run(sent.data.runId);
  assert.equal(run.release.milestoneId, milestone.id);
  assert.equal(run.line, 'release/1.1');
  const closed = store.task(c.taskId);
  assert.equal(closed.status, 'denied');
  assert.equal(closed.closed.reason, sentAsIdeaReason);
  assert.equal(closed.sentAsIdea.runId, run.id);
  assert.equal(closed.sourceStage.current, 'closed');
  assert.equal(store.attempt(edit.id).status, 'closed', 'Its attempt in Review is closed as close closes it.');
  assert.doesNotMatch(run.brief, identifiers);
});

test('a story without the note, a running story and an integrated one are refused and left as they were', async t => {
  const c = await studio(t),
    { store, runner } = c.app,
    { ids } = await c.breakdown(stories);
  for (const id of ids) approveWork(store, runner.registries, store.task(id));
  // An integrated story.
  runner.start(ids[0]);
  const { review } = await c.toReview(ids[0]);
  c.integrated(ids[0], review, 'src/core/workflows.mjs', '// Integrated\n');
  c.hold();
  const refused = async (id, pattern) => {
    const before = c.record(id),
      answer = await c.send(id);
    assert.ok(answer.status >= 400 && answer.status < 500, JSON.stringify(answer.data));
    assert.match(answer.data.error, pattern);
    assert.equal(c.record(id), before, 'The task, its attempts and the ideas are unchanged.');
  };
  // (c) Without the note.
  await refused(ids[1], /moved past/);
  await refused(ids[0], /moved past/);
  // Integrated, with the note.
  c.outdated(ids[0]);
  await refused(ids[0], /Accepted work is final/);
  // Running, with the note: the running attempt is modelled at its record.
  c.outdated(ids[1]);
  store.putTask({ ...store.task(ids[1]), status: 'running' });
  await refused(ids[1], /Cancel the running attempt first/);
  // A field the step does not take is refused before it acts.
  store.putTask({ ...store.task(ids[1]), status: 'ready' });
  const before = c.record(ids[1]),
    odd = await c.send(ids[1], { reason: 'Not a field.' });
  assert.equal(odd.status, 400);
  assert.equal(c.record(ids[1]), before);
});

test('when intake refuses the idea, the story is not closed', async t => {
  const c = await studio(t),
    { store, runner } = c.app,
    { ids } = await c.breakdown(stories);
  git(c.root, ['tag', 'v1.0.0']);
  const made = await c.request(`/api/projects/${project}/milestones`, { projectId: project, version: '1.1.0' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = ids[0],
    milestone = made.data.milestone,
    story = store.task(id);
  story.release = { milestoneId: milestone.id, version: milestone.version, by: { type: 'director' } };
  store.putTask(story);
  approveWork(store, runner.registries, store.task(id));
  c.hold();
  c.outdated(id);
  // (d) The story's milestone is released, so no new idea lands on it.
  store.putSetting(
    'milestones:' + project,
    projectMilestones(store, project).map(item => (item.id === milestone.id ? { ...item, state: 'released' } : item)),
  );
  let before = c.record(id),
    answer = await c.send(id);
  assert.ok(answer.status >= 400 && answer.status < 500, JSON.stringify(answer.data));
  assert.match(answer.data.error, /released, so no new idea lands on it/);
  assert.equal(c.record(id), before, 'The story stays as it was.');
  assert.equal(store.task(id).status, 'ready');
  // Words intake does not take are refused the same way.
  before = c.record(id);
  answer = await c.send(id, { idea: '   ' });
  assert.equal(answer.status, 400);
  assert.match(answer.data.error, /Idea must be nonempty text/);
  assert.equal(c.record(id), before);
});
