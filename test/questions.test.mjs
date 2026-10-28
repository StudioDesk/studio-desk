// An agent asks the director (1.2 step 2): it stops blocked with question.json, the controller records the
// question on the attempt, the attempt uses none of the work's attempts, and the answer (the director's, or auto
// mode's for a choice inside the work) becomes the next attempt's direction, which continues from the saved work.
// Model-free: the work runs through the Claude protocol fixture (fixture-general-work.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { waitFor } from './wait-for.mjs';
import { createRegistries } from '../src/registry.mjs';
import { countsTowardLimit } from '../src/core/registry.mjs';
import { answerableInAutoMode } from '../src/core/questions.mjs';

const fixture = fileURLToPath(new URL('./fixture-general-work.mjs', import.meta.url));

const question = (fields = {}) => ({
  schemaVersion: 'question-v1',
  ask: 'Should the summary lead with the outcome or with the steps?',
  why: 'The brief names both, and the reader skims.',
  options: [{ label: 'Outcome first', detail: 'One line on what changed, then the steps.' }, { label: 'Steps first' }],
  recommended: 0,
  choice: 'inside-story',
  topics: [],
  ...fields,
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-questions-')),
    app = createStudio({
      directory,
      port: 0,
      runnerOptions: { registries: createRegistries(), claudeBinary: fixture },
    }),
    origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1],
    store = app.store;
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = async (url, data = {}, method = 'POST') => {
    const response = await fetch(origin + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(data),
    });
    return { status: response.status, data: await response.json() };
  };
  const until = (check, label) =>
    waitFor(check, label, { interval: 10, detail: () => JSON.stringify(store.tasks().slice(-2)) });
  const created = await request('/api/projects', { name: 'Questions' }),
    projectId = created.data.id;
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const saved = await request(
    `/api/projects/${projectId}/organization`,
    {
      projectId,
      expectedRevision: store.setting('project-organization:' + projectId).revision,
      teams: [{ id: 'team', name: 'Team', purpose: 'Bounded work that is not code.' }],
      members: [
        ['W-03', 'worker'],
        ['W-04', 'reviewer'],
      ].map(([workerId, role]) => ({
        workerId,
        teamId: 'team',
        role: 'Contributor',
        responsibility: 'Bounded work that is not code.',
        roles: [role],
      })),
      taskKinds: ['general', 'general:work', 'general:review'],
      kindOwners: {},
    },
    'PATCH',
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  // An approved Do the work step on the Claude fixture, started; `fields` patch the task first (auto mode).
  const work = async (title, direction, fields = {}) => {
    const made = await request('/api/tasks', {
      projectId,
      kind: 'general:work',
      workerId: 'W-03',
      title,
      brief: 'Write the summary the direction names.',
      acceptance: 'The summary reads as the director chose.',
      planned: true,
      execution: { provider: 'claude', mode: 'workspace' },
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.id;
    assert.equal((await request(`/api/tasks/${id}`, { projectId, direction, ...fields }, 'PATCH')).status, 200);
    assert.equal((await request(`/api/tasks/${id}/approve-work`, { projectId })).status, 200);
    const started = await request(`/api/tasks/${id}/start`, { projectId });
    assert.equal(started.status, 202, JSON.stringify(started.data));
    return id;
  };
  const asked = id =>
    until(() => {
      const task = store.task(id),
        attempt = task.lastAttemptId && store.attempt(task.lastAttemptId);
      return (
        task.status === 'blocked' && attempt?.status === 'blocked' && !app.runner.active.has(attempt.id) && attempt
      );
    }, `${id} asked`);
  const reviewed = id =>
    until(() => store.task(id).status === 'review' && store.attempt(store.task(id).lastAttemptId), `${id} in review`);
  return { app, store, projectId, request, until, work, asked, reviewed };
}

test('an agent that asks stops with its question recorded, uses none of its attempts, and continues from its saved work with the answer', async t => {
  const c = await setup(t),
    asking = question(),
    id = await c.work('Write the summary', `write notes.md Notes before asking.\nask ${JSON.stringify(asking)}`),
    attempt = await c.asked(id);
  const { schemaVersion, ...recorded } = asking;
  assert.equal(schemaVersion, 'question-v1');
  assert.deepEqual(attempt.question, recorded);
  assert.equal(c.store.task(id).reason, `Asks: ${asking.ask}`);
  assert.equal(countsTowardLimit(attempt), false, 'asking uses none of the attempts');
  assert.equal(c.app.runner.registries.workflows.stageAttempts(c.store, c.store.task(id)).length, 0);
  // Without auto mode, nothing answers for the director.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(c.store.task(id).status, 'blocked');
  assert.equal(c.store.task(id).answers, undefined);

  // An answer must name the attempt that asked, and an option the question has or the director's own words.
  for (const [body, message] of [
    [{ attemptId: 'attempt-other', option: 0 }, /Only the question of the task's latest attempt/],
    [{ attemptId: attempt.id, option: 5 }, /an option the question does not have/],
    [{ attemptId: attempt.id }, /Answer with one of the options, your own words, or both/],
    [{ attemptId: attempt.id, option: 0, color: 'blue' }, /An answer takes the attempt that asked/],
  ]) {
    const refused = await c.request(`/api/tasks/${id}/answer`, { projectId: c.projectId, ...body });
    assert.ok(refused.status >= 400, JSON.stringify(refused.data));
    assert.match(refused.data.error, message);
  }

  const answered = await c.request(`/api/tasks/${id}/answer`, {
    projectId: c.projectId,
    attemptId: attempt.id,
    option: 0,
    text: 'Keep it to five lines.',
  });
  assert.equal(answered.status, 202, JSON.stringify(answered.data));
  assert.deepEqual(
    { ...answered.data.answer, at: undefined, by: answered.data.answer.by.type },
    {
      attemptId: attempt.id,
      option: 0,
      label: 'Outcome first',
      text: 'Keep it to five lines.',
      by: 'director',
      at: undefined,
    },
  );
  assert.ok(c.store.events(attempt.id).some(event => event.kind === 'question_answered'));

  const next = await c.reviewed(id);
  assert.notEqual(next.id, attempt.id);
  assert.match(next.assignment.direction, new RegExp(`The director answered the question of ${attempt.id}`));
  assert.match(next.assignment.direction, /Chosen: Outcome first \(One line on what changed, then the steps\.\)/);
  assert.match(next.assignment.direction, /The director wrote: Keep it to five lines\./);
  // It continued from the saved work, which never carries the question itself.
  assert.equal(next.continueFrom.attemptId, attempt.id);
  assert.deepEqual(
    next.continueFrom.files.map(file => file.path),
    ['notes.md'],
  );
  assert.ok(next.artifacts.some(item => item.path === 'notes.md'));
  // The answered question is no longer waiting, so it cannot be answered twice.
  const again = await c.request(`/api/tasks/${id}/answer`, {
    projectId: c.projectId,
    attemptId: attempt.id,
    option: 1,
  });
  assert.ok(again.status >= 400);
  // The next attempt read the question and its answer in its history.
  const history = fs.readFileSync(
    path.join(path.dirname(next.outputFolder), 'history', `001-${attempt.id}.md`),
    'utf8',
  );
  assert.match(history, /## Question to the director/);
  assert.match(history, /Option 1 \(recommended\): Outcome first/);
  assert.match(history, /Answer \(the director, .*\): Outcome first; Keep it to five lines\./);
});

test('auto mode answers a choice inside the work with the agent’s recommendation, never a kind kept for the director', async t => {
  const c = await setup(t),
    inside = await c.work('Inside the work', `ask ${JSON.stringify(question({ recommended: 1 }))}`, { autoMode: true }),
    kept = await c.work('A new package', `ask ${JSON.stringify(question({ topics: ['package'] }))}`, {
      autoMode: true,
    }),
    off = await c.work('Auto mode off', `ask ${JSON.stringify(question())}`);
  // Inside the work, in auto mode: answered for the director and started again.
  const reviewed = await c.reviewed(inside),
    answer = c.store.task(inside).answers[0];
  assert.equal(answer.by.type, 'auto-mode');
  assert.equal(answer.option, 1);
  assert.equal(answer.label, 'Steps first');
  assert.match(reviewed.assignment.direction, /Auto mode answered for the director the question of/);
  // A question that touches a kind kept for the director waits, auto mode or not, and so does one in work that
  // does not run in auto mode.
  for (const id of [kept, off]) {
    const attempt = await c.asked(id);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(c.store.task(id).status, 'blocked');
    assert.equal(c.store.task(id).answers, undefined, `${id} waits for the director`);
    assert.equal(countsTowardLimit(attempt), false);
  }
});

test('a question the controller cannot read is recorded as a problem, and that attempt counts', async t => {
  const c = await setup(t),
    id = await c.work('Unreadable', `ask ${JSON.stringify(question({ choice: 'maybe' }))}`, { autoMode: true }),
    attempt = await c.asked(id);
  assert.deepEqual(attempt.question, { problem: 'The question\'s choice must be "inside-story" or "director".' });
  assert.notEqual(c.store.task(id).reason, `Asks: ${question().ask}`);
  assert.equal(countsTowardLimit(attempt), true);
  const refused = await c.request(`/api/tasks/${id}/answer`, {
    projectId: c.projectId,
    attemptId: attempt.id,
    option: 0,
  });
  assert.ok(refused.status >= 400);
});

test('auto mode may answer only a recorded choice inside the work, with a recommendation and no file request', () => {
  const asked = fields => ({ question: { ...question(), ...fields } });
  assert.equal(answerableInAutoMode(asked({})), true);
  assert.equal(answerableInAutoMode(asked({ choice: 'director' })), false);
  assert.equal(answerableInAutoMode(asked({ topics: ['push'] })), false);
  assert.equal(answerableInAutoMode(asked({ recommended: null })), false);
  assert.equal(answerableInAutoMode({ ...asked({}), scopeRequest: { files: ['a'] } }), false);
  assert.equal(answerableInAutoMode({ question: { problem: 'Unreadable.' } }), false);
});
