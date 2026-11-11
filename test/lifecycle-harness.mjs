// A lifecycle harness for property tests: a seeded generator writes random step sequences (work added, a director
// action the controller lists, an agent finishing, an attempt's time limit, a controller restart), a model-free
// general-work studio plays them, and after every step the studio's promises are checked from the store and the task
// read. A failing sequence is shrunk to the shortest one that still breaks the same promise and printed as an ordinary
// test. Model-free: the work runs through the Claude protocol fixture (fixture-general-work.mjs), the review through
// the Simulator. Nothing here changes the controller; it reads the records any test reads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio as modelFreeStudio } from './model-free-studio.mjs';
import { createRegistries } from '../src/registry.mjs';
import { hash } from '../src/core/contracts.mjs';
import { artifactPath } from '../src/core/artifacts.mjs';
import { attemptResource } from '../src/core/store.mjs';

const fixture = fileURLToPath(new URL('./fixture-general-work.mjs', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// The seeded generator: mulberry32, written here so no package is added. The same seed gives the same numbers.
export function createRandom(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: n => Math.floor(next() * n),
    pick: list => list[Math.floor(next() * list.length)],
    chance: p => next() < p,
  };
}

// The agent results the fixture gives, chosen by the direction it reads.
export const results = ['write', 'fail-check', 'block', 'ask', 'hang'];
// A hanging attempt is drawn twice as often: it is the one a time limit, a cancellation and a crash can catch running.
const drawn = [...results, 'hang'];
export const question = {
  schemaVersion: 'question-v1',
  ask: 'Should the notes lead with the outcome or the steps?',
  why: 'The brief names both.',
  options: [{ label: 'Outcome first' }, { label: 'Steps first' }],
  recommended: 0,
  choice: 'director',
  topics: [],
};
export function directionFor(result) {
  const notes = 'write notes.md Notes from the lifecycle check.';
  if (result === 'fail-check') return `fail-check\n${notes}`;
  if (result === 'block') return `${notes}\nblock`;
  if (result === 'ask') return `${notes}\nask ${JSON.stringify(question)}`;
  if (result === 'hang') return `${notes}\nhang`;
  return notes;
}

// One step, from the generator alone (never from the studio), so the same seed always writes the same sequence. Tasks
// are named by the order they were added (w1, w2, ...), so a sequence replays on any fresh studio.
export function generateStep(random, added) {
  const roll = random.next();
  if (!added || roll < 0.1)
    return { kind: 'add', task: `w${added + 1}`, result: random.pick(drawn), maxSeconds: 5 + random.int(5) };
  const task = `w${1 + random.int(added)}`;
  if (roll < 0.66)
    return { kind: 'act', task, choice: Math.round(random.next() * 1000) / 1000, result: random.pick(drawn) };
  if (roll < 0.78) return { kind: 'finish', task };
  if (roll < 0.89) return { kind: 'timeout', task };
  return { kind: 'restart', crash: random.chance(0.7) };
}
export function generateSequence(seed, length, generate = generateStep) {
  const random = createRandom(seed),
    steps = [];
  let added = 0;
  for (let index = 0; index < length; index++) {
    const step = generate(random, added, steps.at(-1));
    if (step.kind === 'add') added++;
    steps.push(step);
  }
  return steps;
}
// Each sequence's own seed, from the run's seed.
export const sequenceSeed = (seed, index) => (Math.imul(seed >>> 0, 31) + Math.imul(index + 1, 0x9e3779b1)) >>> 0;

// ---------------------------------------------------------------------------------------------------------------
// The promises, as checks over plain records. Each returns a list of violations, { rule, message, ... }.

// The statuses the controller records for a task and the changes between them it makes today: planned work waits in
// backlog for approval; Ready → Working (running) → Review → Accepted (done) is the success path; stopping, blocked,
// failed and cancelled are the side states; a closed or denied task is denied. A staged task (work, then its
// independent review) goes from done back to ready for the next stage, or to blocked when the review sends it back.
export const allowedTransitions = {
  '': ['backlog', 'ready'],
  backlog: ['ready', 'denied'],
  ready: ['running', 'blocked', 'denied'],
  running: ['review', 'blocked', 'failed', 'stopping', 'cancelled', 'ready'],
  stopping: ['failed', 'cancelled', 'blocked', 'review'],
  review: ['done', 'ready', 'blocked', 'denied'],
  done: ['ready', 'blocked'],
  blocked: ['running', 'ready', 'denied'],
  failed: ['running', 'ready', 'denied'],
  cancelled: ['running', 'ready', 'denied'],
  denied: [],
};
export function checkTransitions(changes, table = allowedTransitions) {
  return changes
    .filter(change => change.from !== change.to && !(table[change.from ?? ''] || []).includes(change.to))
    .map(change => ({
      rule: 'transition',
      task: change.task,
      message: `${change.task} went from ${change.from ?? 'nothing'} to ${change.to}, which is not an allowed change.`,
    }));
}

// A task recorded as accepted names an attempt of its own that is accepted, completed, and whose files still match.
// `view.files[attemptId][path]` is the file's hash now (null when it is missing).
export function checkAccepted(view) {
  const violations = [];
  for (const task of view.tasks.filter(task => task.status === 'done')) {
    const fail = message => violations.push({ rule: 'acceptance', task: task.id, message: `${task.id} ${message}` });
    const attempt = view.attempts.find(item => item.id === task.acceptedAttemptId);
    if (!task.acceptedAttemptId) fail('is done but names no accepted attempt.');
    else if (!attempt || attempt.taskId !== task.id) fail(`names ${task.acceptedAttemptId}, which is not its attempt.`);
    else if (attempt.status !== 'accepted') fail(`names ${attempt.id}, whose status is ${attempt.status}.`);
    else if (attempt.result?.outcome !== 'completed')
      fail(`names ${attempt.id}, whose result is ${attempt.result?.outcome ?? 'missing'}.`);
    else
      for (const item of attempt.artifacts || []) {
        const now = view.files?.[attempt.id]?.[item.path];
        if (now !== item.hash) fail(`names ${attempt.id}, whose file ${item.path} no longer matches its hash.`);
      }
  }
  return violations;
}

// Every attempt that may still run (store.liveAttempts) holds its own reservation (attemptResource). In the code-story
// world (`view.journals`), a source integration journal in a busy state, one that may still change the source or that
// awaits Reconcile source integration, holds reservations of its own (leases owned by the journal's ID).
export function checkLeases(view) {
  const integrations = Object.values(view.journals || {})
    .filter(
      journal =>
        busyJournalStates.includes(journal.state) && !view.leases.some(lease => lease.attemptId === journal.id),
    )
    .map(journal => ({
      rule: 'reservation',
      task: journal.taskId,
      message: `The integration ${journal.id} is ${journal.state} but holds no reservation.`,
    }));
  return view.liveAttempts
    .filter(
      attempt =>
        !view.leases.some(lease => lease.resource === attemptResource(attempt.id) && lease.attemptId === attempt.id),
    )
    .map(attempt => ({
      rule: 'reservation',
      task: attempt.taskId,
      message: `${attempt.id} is ${attempt.status} but no longer holds its reservation ${attemptResource(attempt.id)}.`,
    }))
    .concat(integrations);
}

const unreconciled = attempt => ['interrupted', 'quarantined'].includes(attempt.status) && !attempt.reconciledAt;
// Uncertain work is never replayed. Across any step, a task that had an unreconciled interrupted attempt gets no new
// attempt. Across a restart, no attempt is created at all, and an attempt that was running or stopping is interrupted
// with its task blocked (after a crash), or has ended (a graceful close stops it first).
export function checkReplay(before, after, { restart = false, crash = false } = {}) {
  const violations = [],
    known = new Set(before.attempts.map(attempt => attempt.id)),
    created = after.attempts.filter(attempt => !known.has(attempt.id));
  for (const attempt of created) {
    if (restart)
      violations.push({ rule: 'no-replay', task: attempt.taskId, message: `A restart created ${attempt.id}.` });
    else if (before.attempts.some(old => old.taskId === attempt.taskId && unreconciled(old)))
      violations.push({
        rule: 'no-replay',
        task: attempt.taskId,
        message: `${attempt.taskId} started ${attempt.id} while an interrupted attempt was not reconciled.`,
      });
  }
  if (restart)
    for (const old of before.attempts.filter(attempt => ['running', 'stopping'].includes(attempt.status))) {
      const now = after.attempts.find(attempt => attempt.id === old.id),
        task = after.tasks.find(item => item.id === old.taskId);
      const interrupted = now?.status === 'interrupted' && task?.status === 'blocked';
      if (
        crash
          ? !interrupted
          : !now || ['running', 'stopping'].includes(now.status) || (now.status === 'interrupted' && !interrupted)
      )
        violations.push({
          rule: 'no-replay',
          task: old.taskId,
          message: `${old.id} was ${old.status} at the restart and is ${now?.status ?? 'missing'} after it (its task ${task?.status ?? 'missing'}).`,
        });
    }
  return violations;
}

// What waits for the director: a blocked task, a task with an unreconciled interrupted attempt and, in the code-story
// world, a story whose integration journal awaits Reconcile source integration.
const waitsForDirector = (task, attempts, journals) =>
  !task.closed &&
  task.status !== 'denied' &&
  (task.status === 'blocked' ||
    attempts.some(attempt => attempt.taskId === task.id && unreconciled(attempt)) ||
    Object.values(journals || {}).some(
      journal => journal.taskId === task.id && journal.state === 'needs-reconciliation',
    ));
// An interrupted or blocked task that is not closed, or a story whose integration awaits reconciliation, always offers
// the director a way forward.
export function checkWayForward(view) {
  return view.tasks
    .filter(task => waitsForDirector(task, view.attempts, view.journals))
    .filter(task => !(view.actions[task.id] || []).length)
    .map(task => ({
      rule: 'way-forward',
      task: task.id,
      message: `${task.id} is ${task.status} and lists no action.`,
    }));
}

// Every action the controller lists is accepted when it is sent.
export function checkAnswer({ task, action, status, data }) {
  return status >= 200 && status < 300
    ? []
    : [
        {
          rule: 'listed-action',
          task,
          action: action.key,
          status,
          message: `${task}: the listed action ${action.label} (${action.method} ${action.path}) was answered ${status}: ${JSON.stringify(data)}`,
        },
      ];
}

// ---------------------------------------------------------------------------------------------------------------
// The studio: a model-free general-work project on a temporary folder, reopened on the same folder at a restart.

const model = 'Model-free lifecycle check.';
// The value a field the records leave empty is sent with; undefined leaves it out.
function fill(field, step, review) {
  if ('value' in field) return field.value;
  if (field.name === 'direction') return directionFor(step.result || 'write');
  if (field.name === 'overReason')
    return review?.result?.checks?.some(check => check.status === 'fail') ? model : undefined;
  if (field.name === 'option') return 0;
  if (field.kind === 'boolean') return field.required ? false : undefined;
  if (field.kind === 'list') return field.required ? [] : undefined;
  if (field.kind === 'number') return 0;
  return field.required || ['reason', 'text'].includes(field.name) ? model : undefined;
}

async function openStudio(c) {
  c.app = c.factory({
    directory: c.directory,
    port: 0,
    runnerOptions: { registries: createRegistries(), claudeBinary: fixture },
  });
  c.origin = await c.app.start();
  c.token = (await (await fetch(c.origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  c.store = c.app.store;
  // Every status a task is recorded with, as it is written: the changes between steps are checked one by one.
  const put = c.store.putTask,
    store = c.store;
  store.putTask = function (task) {
    const row = store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id),
      from = row ? JSON.parse(row.data).status : null;
    put.call(this, task);
    if (from !== task.status) c.changes.push({ task: task.id, from, to: task.status });
  };
}

async function request(c, url, data, method = 'POST') {
  const response = await fetch(c.origin + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': c.token },
    ...(method === 'GET' ? {} : { body: JSON.stringify(data ?? {}) }),
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, data: body };
}
async function must(c, url, data, method, expected) {
  const answer = await request(c, url, data, method);
  if (answer.status !== expected)
    throw new Error(`${method} ${url} answered ${answer.status}: ${JSON.stringify(answer.data)}`);
  return answer.data;
}

async function createProject(c) {
  const created = await must(c, '/api/projects', { name: 'Lifecycle check' }, 'POST', 201);
  c.projectId = created.id;
  await must(
    c,
    `/api/projects/${c.projectId}/organization`,
    {
      projectId: c.projectId,
      expectedRevision: c.store.setting('project-organization:' + c.projectId).revision,
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
    200,
  );
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const written = (c, attempt) =>
  c.store
    .events(attempt.id)
    .some(event => event.kind === 'log' && String(event.message).includes('fixture.work-written'));
// Waits until nothing is moving: every attempt has settled, except a hanging one that has written its work, and no
// record changed for a few polls (a stage the controller queues starts and settles too).
async function settle(c, label) {
  const deadline = Date.now() + 30000;
  let version = -1,
    quiet = 0;
  for (;;) {
    const moving = c.store
      .liveAttempts()
      .some(attempt => attempt.status === 'stopping' || (attempt.status === 'running' && !written(c, attempt)));
    if (!moving && c.store.version === version) quiet++;
    else quiet = 0;
    if (quiet >= 3) return;
    version = c.store.version;
    if (Date.now() > deadline)
      throw new Error(
        `The studio did not settle (${label}): ${JSON.stringify(c.store.liveAttempts().map(a => [a.id, a.status]))}`,
      );
    await sleep(25);
  }
}

async function readActions(c, id) {
  const read = await request(
    c,
    `/api/tasks/${encodeURIComponent(id)}?projectId=${encodeURIComponent(c.projectId)}`,
    undefined,
    'GET',
  );
  if (read.status !== 200)
    throw new Error(`The task read of ${id} answered ${read.status}: ${JSON.stringify(read.data)}`);
  return read.data.actions || [];
}

async function snapshot(c) {
  const tasks = c.store.projectTasks(c.projectId),
    attempts = tasks.flatMap(task => c.store.attempts(task.id).map(({ instructions, ...attempt }) => attempt)),
    files = {},
    actions = {};
  for (const task of tasks.filter(task => task.status === 'done')) {
    const attempt = attempts.find(item => item.id === task.acceptedAttemptId);
    if (!attempt) continue;
    files[attempt.id] = {};
    for (const item of attempt.artifacts || []) {
      try {
        files[attempt.id][item.path] = hash(fs.readFileSync(artifactPath(c.store, attempt, item.path)));
      } catch {
        files[attempt.id][item.path] = null;
      }
    }
  }
  for (const task of tasks) if (waitsForDirector(task, attempts)) actions[task.id] = await readActions(c, task.id);
  return { tasks, attempts, files, actions, leases: c.store.leases(), liveAttempts: c.store.liveAttempts() };
}

// What an attempt's settled result counts as, once.
function countResults(c, view) {
  for (const attempt of view.attempts) {
    if (c.counted.has(attempt.id) || attempt.assignment?.kind !== 'general:work') continue;
    let result = null;
    if (attempt.question?.ask) result = 'question';
    else if (attempt.status === 'blocked' && attempt.result?.outcome === 'blocked') result = 'blocked';
    else if (attempt.result?.outcome === 'completed' && !['running', 'stopping'].includes(attempt.status))
      result = attempt.result.checks?.some(check => check.status === 'fail') ? 'failed-check' : 'completed';
    if (!result) continue;
    c.counted.add(attempt.id);
    c.counters.results[result] = (c.counters.results[result] || 0) + 1;
  }
}

const bump = (map, key) => (map[key] = (map[key] || 0) + 1);

async function restartStudio(c, crash) {
  if (crash)
    // The controller stops without seeing its CLIs stop, as a crash leaves it (test/general-work-continuation.test.mjs):
    // the attempts stay running in the database with their reservations.
    for (const [id, entry] of [...c.app.runner.active]) {
      clearTimeout(entry.timer);
      c.app.runner.active.delete(id);
      if (entry.child && entry.child.exitCode === null) {
        const closed = new Promise(resolve => entry.child.once('close', resolve));
        entry.child.kill('SIGKILL');
        await closed;
      }
    }
  await c.app.close();
  c.app = null;
  await openStudio(c);
}

// Plays one step. Returns the step as it ran (a director action names the listed action it sent), or the step marked
// skipped when it had nothing to act on.
async function play(c, step) {
  const id = c.ids[step.task];
  if (step.kind === 'add') {
    const made = await must(
      c,
      '/api/tasks',
      {
        projectId: c.projectId,
        kind: 'general:work',
        workerId: 'W-03',
        title: `Lifecycle notes ${step.task}`,
        brief: 'Write the notes the direction names.',
        acceptance: 'The notes hold what the direction says.',
        // Work waits for the director's approval, unless the step adds it approved (a shrunk sequence folds an
        // approval into its add; see foldApprovals).
        planned: !step.approved,
        maxSeconds: step.maxSeconds,
        execution: { provider: 'claude', mode: 'workspace' },
      },
      'POST',
      201,
    );
    c.ids[step.task] = made.id;
    c.limits.add(step.maxSeconds * 1000);
    await must(
      c,
      `/api/tasks/${made.id}`,
      { projectId: c.projectId, direction: directionFor(step.result) },
      'PATCH',
      200,
    );
    return { ...step };
  }
  if (step.kind === 'finish') {
    await settle(c, `finish ${step.task}`);
    return { ...step };
  }
  if (step.kind === 'restart') {
    await settle(c, 'before the restart');
    c.restartBefore = await snapshot(c);
    await restartStudio(c, !!step.crash);
    bump(c.counters.steps, step.crash ? 'crash restart' : 'graceful restart');
    return { ...step };
  }
  if (!id) return { ...step, skipped: true };
  if (step.kind === 'timeout') {
    await settle(c, `timeout ${step.task}`);
    const attempt = c.store.liveAttempts().find(a => a.taskId === id && a.status === 'running'),
      entry = attempt && c.app.runner.active.get(attempt.id),
      limit = entry && c.timers.get(entry.timer);
    if (!limit) return { ...step, skipped: true };
    limit();
    bump(c.counters.steps, 'timeout fired');
    return { ...step };
  }
  // A director action: the task read lists what the director may do now; one is sent, with every field the records
  // leave empty filled in.
  await settle(c, `act ${step.task}`);
  const actions = await readActions(c, id);
  if (!actions.length) return { ...step, skipped: true };
  // Most choices fall among the actions that carry the work on; the rest among all, so closing and denying work
  // stay possible without ending most tasks before they run.
  const onward = actions.filter(item => !item.key.startsWith('deny-') && item.key !== 'close'),
    choice = step.choice ?? 0,
    [among, at] = onward.length && choice < 0.85 ? [onward, choice / 0.85] : [actions, choice],
    action = step.action
      ? actions.find(item => item.key === step.action)
      : among[Math.min(among.length - 1, Math.floor(at * among.length))];
  if (!action) return { ...step, skipped: true };
  const task = c.store.task(id),
    review = task.status === 'review' ? c.store.attempt(task.lastAttemptId) : null,
    body = {};
  for (const field of action.fields || []) {
    const value = fill(field, step, review);
    if (value !== undefined) body[field.name] = value;
  }
  const answer = await request(c, action.path, body, action.method);
  bump(c.counters.actions, action.key);
  c.answer = { task: step.task, action, status: answer.status, data: answer.data };
  return { kind: 'act', task: step.task, action: action.key, result: step.result };
}

// The checks after one step: the recorded changes, acceptance, reservations, replay, a way forward and the answer.
function checkStep(c, step, before, after) {
  const named = violation => ({ ...violation, task: c.labels[violation.task] ?? violation.task });
  const violations = [
    ...checkTransitions(c.changes.splice(0)),
    ...checkAccepted(after),
    ...checkLeases(after),
    ...checkReplay(step.kind === 'restart' ? c.restartBefore : before, after, {
      restart: step.kind === 'restart',
      crash: !!step.crash,
    }),
    ...checkWayForward(after),
    ...(c.answer ? checkAnswer(c.answer) : []),
  ];
  c.answer = null;
  return violations.map(named);
}

function freshCounters() {
  return { sequences: 0, steps: {}, actions: {}, results: {} };
}

// Runs one sequence on a fresh studio and checks the promises after every step. Returns the steps as they ran and the
// first violation (null when every promise held). `counters` collects what the run covered.
export async function runSequence(steps, { factory = modelFreeStudio, counters = freshCounters() } = {}) {
  const realSetTimeout = globalThis.setTimeout,
    delay = process.env.STUDIO_MOCK_DELAY_MS,
    c = {
      factory,
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lifecycle-')),
      ids: {},
      labels: {},
      limits: new Set(),
      timers: new Map(),
      changes: [],
      counted: new Set(),
      counters,
      answer: null,
    };
  process.env.STUDIO_MOCK_DELAY_MS = '15';
  // An attempt's own time limit (maxSeconds * 1000) is captured instead of waited for, as the time-limit test in
  // test/general-work-continuation.test.mjs does; a timeout step calls it. Every other timer runs as usual.
  globalThis.setTimeout = function (callback, ms, ...args) {
    if (!c.limits.has(ms)) return realSetTimeout(callback, ms, ...args);
    const held = realSetTimeout(() => {}, 2147483647);
    held.unref?.();
    c.timers.set(held, () => callback(...args));
    return held;
  };
  const ran = [];
  let violation = null;
  try {
    await openStudio(c);
    await createProject(c);
    c.changes.splice(0);
    counters.sequences++;
    let before = await snapshot(c);
    for (const step of steps) {
      const done = await play(c, step);
      for (const [label, taskId] of Object.entries(c.ids)) c.labels[taskId] = label;
      ran.push(done);
      if (!done.skipped) bump(counters.steps, step.kind);
      const after = await snapshot(c);
      countResults(c, after);
      const found = checkStep(c, step, before, after);
      if (found.length) {
        violation = { ...found[0], step: ran.length - 1 };
        break;
      }
      before = after;
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    await c.app?.close().catch(() => {});
    if (delay === undefined) delete process.env.STUDIO_MOCK_DELAY_MS;
    else process.env.STUDIO_MOCK_DELAY_MS = delay;
    fs.rmSync(c.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { steps: ran, violation };
}

// ---------------------------------------------------------------------------------------------------------------
// Shrinking: chunks are removed, then single steps, and a candidate is kept only when it still breaks the same rule.
// `fails(steps)` answers the rule a sequence breaks, or null. Works on any list, so it is tested without a studio.
// When no single step can go, `simplify(steps)` offers simpler forms of the sequence, each with fewer steps; the first
// that still breaks the rule is kept and removal starts again from it.
export async function shrink(steps, fails, rule, simplify = () => []) {
  rule ??= await fails(steps);
  if (!rule) return steps;
  let current = steps,
    size = Math.max(1, Math.floor(current.length / 2));
  for (;;) {
    let changed = false;
    for (let start = 0; start < current.length; ) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if ((await fails(candidate)) === rule) {
        current = candidate;
        changed = true;
      } else start += size;
    }
    if (size > 1) size = Math.max(1, Math.floor(size / 2));
    else if (!changed) {
      let simpler = null;
      for (const candidate of simplify(current))
        if (candidate.length < current.length && (await fails(candidate)) === rule) {
          simpler = candidate;
          break;
        }
      if (!simpler) break;
      current = simpler;
    }
  }
  return current;
}

// The lifecycle's simpler forms: work added as planned and approved later is added approved instead, and the approval
// step goes. One candidate for each approval of work the sequence adds before it.
export function foldApprovals(steps) {
  const candidates = [];
  steps.forEach((step, index) => {
    if (step.kind !== 'act' || step.action !== 'approve') return;
    const added = steps.findIndex(item => item.kind === 'add' && item.task === step.task);
    if (added < 0 || added > index || steps[added].approved) return;
    candidates.push(
      steps.flatMap((item, at) => (at === index ? [] : at === added ? [{ ...item, approved: true }] : [item])),
    );
  });
  return candidates;
}

// Steps as they replay: a director action is named by the listed action it sent, and skipped steps are left out.
const replayable = steps => steps.filter(step => !step.skipped).map(({ skipped, choice, ...step }) => step);

// The shortest failing sequence as an ordinary test, ready to paste.
export function asTest({ seed, rule, steps }, replayName = 'replay') {
  const lines = steps.map(step => `    ${JSON.stringify(step)},`).join('\n');
  return `test('lifecycle: ${rule} (seed ${seed})', async () => {\n  await ${replayName}([\n${lines}\n  ]);\n});`;
}

// Replays a kept sequence and fails with the promise it breaks.
export async function replay(steps, options = {}) {
  const { violation } = await runSequence(steps, options);
  if (violation)
    throw new Error(`Lifecycle promise broken (${violation.rule}) at step ${violation.step}: ${violation.message}`);
}

// Runs `runs` sequences of up to `length` steps from `seed`. Returns the counters and, for the first failing sequence,
// its seed, rule, shrunk steps and the ready-to-paste test.
// `generate` and `run` choose the world: the general-work studio by default, or code stories (exploreSourceLifecycles).
export async function exploreLifecycles({
  seed,
  runs,
  length,
  factory = modelFreeStudio,
  log = () => {},
  generate = generateStep,
  run = runSequence,
  replayName = 'replay',
}) {
  const counters = freshCounters(),
    sequences = [];
  for (let index = 0; index < runs; index++) {
    const own = sequenceSeed(seed, index),
      steps = generateSequence(own, length, generate),
      { steps: ran, violation } = await run(steps, { factory, counters });
    sequences.push({ seed: own, steps: ran.length });
    log(
      `sequence ${index + 1}/${runs} (seed ${own}): ${ran.length} steps${violation ? `, broke ${violation.rule}: ${violation.message}` : ''}`,
    );
    if (!violation) continue;
    const fails = async candidate => (await run(candidate, { factory })).violation?.rule ?? null,
      shrunk = await shrink(replayable(ran.slice(0, violation.step + 1)), fails, violation.rule, foldApprovals),
      last = (await run(shrunk, { factory })).violation;
    const failure = { seed: own, rule: violation.rule, message: last?.message ?? violation.message, steps: shrunk };
    return { counters, sequences, failure: { ...failure, test: asTest(failure, replayName) } };
  }
  return { counters, sequences, failure: null };
}

// ---------------------------------------------------------------------------------------------------------------
// The code-story world: studio-development:change stories on the disposable repository of test/source-story-setup.mjs
// (a temporary git repository, seeded measured checks, and the model-free source-edit and source-check fixtures). The
// first story added is the one that setup stages and approves; a second is staged and approved by its propose helper
// on another file, so the two can land one after the other and the later one may need Merge onto the current source.
// The director-action step sends what the shared rules (public/task-actions.js) list for a story, Send back,
// Integrate, Merge onto the current source and Reconcile source integration among them; an integrate-restart step
// sends Integrate while the integration's verification is held running and restarts the controller while its journal
// is busy. The setup module is imported when a code-story run starts, so the general-work world keeps its imports
// (test/lifecycle-shrink.test.mjs copies only what that world needs).

const sourceCheckFixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url));
// The integration journal states that may still change the source or that wait for Reconcile source integration (the
// shared rules' busy states).
export const busyJournalStates = [
  'verifying',
  'preparing',
  'prepared',
  'applying',
  'committing',
  'needs-reconciliation',
];
const journalStates = [...busyJournalStates, 'integrated', 'rejected', 'abandoned'];
// The director actions that ask the controller to change the main branch.
export const integrationActions = ['integrate', 'over'];
// The files each added story changes, in the order stories are added.
const storyFiles = [['src/core/workflows.mjs'], ['src/core/projects.mjs']];
export const sourceStoryLimit = storyFiles.length;

// One code-story step. A director action carries the verdict the review fixture gives if the action accepts an edit:
// a passing review, or one that asks for changes.
export function generateSourceStep(random, added, previous) {
  const roll = random.next();
  if (!added || (added < sourceStoryLimit && roll < 0.08)) return { kind: 'add', task: `s${added + 1}` };
  const drawn = `s${1 + random.int(added)}`,
    // A step follows through on the story the one before it touched, half the time: an action after a restart during
    // its integration, or an integration after an action. Only the generator's own steps decide it.
    task = previous?.task && previous.kind !== 'add' && random.chance(0.5) ? previous.task : drawn;
  if (roll < 0.76)
    return {
      kind: 'act',
      task,
      choice: Math.round(random.next() * 1000) / 1000,
      verdict: random.chance(0.7) ? 'pass' : 'needs-work',
    };
  if (roll < 0.8) return { kind: 'finish', task };
  if (roll < 0.93) return { kind: 'integrate-restart', task };
  return { kind: 'restart', crash: random.chance(0.5) };
}

// A story recorded as integrated has an accepted, completed attempt and an integration journal whose state is
// integrated (on the attempt its stage names, or its accepted one).
export function checkIntegrated(view) {
  const violations = [];
  for (const task of view.tasks) {
    const stage = task.sourceStage;
    if (stage?.current !== 'integrated' && stage?.integration?.state !== 'integrated') continue;
    const fail = message => violations.push({ rule: 'integrated', task: task.id, message: `${task.id} ${message}` });
    const accepted = view.attempts.find(attempt => attempt.id === task.acceptedAttemptId && attempt.taskId === task.id),
      journalOf = view.attempts.find(
        attempt => attempt.id === (stage.integration?.attemptId ?? task.acceptedAttemptId),
      );
    if (!accepted) fail('is recorded as integrated but names no accepted attempt of its own.');
    else if (accepted.status !== 'accepted' || accepted.result?.outcome !== 'completed')
      fail(
        `is recorded as integrated but its attempt ${accepted.id} is ${accepted.status} with result ${accepted.result?.outcome ?? 'missing'}.`,
      );
    if (journalOf?.sourceIntegration?.state !== 'integrated')
      fail(
        `is recorded as integrated but its integration journal is ${journalOf?.sourceIntegration?.state ?? 'missing'}.`,
      );
  }
  return violations;
}

// No integration is re-run on its own. `view.journals` maps an attempt's ID to its journal ({ id, taskId, state }) and
// `view.mainTip` is the repository's main branch tip.
// - Across a restart, a journal that was busy is left awaiting Reconcile source integration (needs-reconciliation),
//   and the main branch tip does not move.
// - A journal that awaits Reconcile source integration stays so, and the main branch tip does not move, until the
//   director sends that action for its story (`reconciled`, the task IDs it was sent for in this step).
// - The main branch tip moves only on a step where the director sent an integration (`directed`).
export function checkIntegrationReplay(before, after, { restart = false, directed = false, reconciled = [] } = {}) {
  const violations = [],
    moved = before.mainTip !== after.mainTip,
    tip = `the main branch tip moved from ${before.mainTip} to ${after.mainTip}`;
  for (const [attemptId, journal] of Object.entries(before.journals || {})) {
    const now = after.journals?.[attemptId];
    if (restart && busyJournalStates.includes(journal.state)) {
      if (now?.state !== 'needs-reconciliation')
        violations.push({
          rule: 'integration-replay',
          task: journal.taskId,
          message: `The integration ${journal.id} was ${journal.state} at the restart and is ${now?.state ?? 'missing'} after it, not awaiting Reconcile source integration.`,
        });
      continue;
    }
    if (journal.state !== 'needs-reconciliation' || reconciled.includes(journal.taskId)) continue;
    if (now?.state !== 'needs-reconciliation')
      violations.push({
        rule: 'integration-replay',
        task: journal.taskId,
        message: `The integration ${journal.id} awaited Reconcile source integration and became ${now?.state ?? 'missing'} without it.`,
      });
    if (moved)
      violations.push({
        rule: 'main-tip',
        task: journal.taskId,
        message: `While ${journal.id} awaited Reconcile source integration, ${tip}.`,
      });
  }
  if (moved && (restart || !directed) && !violations.some(violation => violation.rule === 'main-tip'))
    violations.push({
      rule: 'main-tip',
      message: `${restart ? 'Across a restart' : 'With no integration sent by the director'}, ${tip}.`,
    });
  return violations;
}

// Waits until nothing moves: no attempt running or stopping, no integration run, and no record changed for a few polls.
async function settleSource(c, label) {
  const deadline = Date.now() + 60000;
  let version = -1,
    quiet = 0;
  for (;;) {
    const store = c.f.app.store,
      moving =
        store.liveAttempts().some(attempt => ['running', 'stopping'].includes(attempt.status)) ||
        !!c.f.app.runner.sourceIntegrationRun;
    if (!moving && store.version === version) quiet++;
    else quiet = 0;
    if (quiet >= 3) return;
    version = store.version;
    if (Date.now() > deadline)
      throw new Error(
        `The code stories did not settle (${label}): ${JSON.stringify(store.liveAttempts().map(a => [a.id, a.status]))}` +
          (c.f.app.runner.sourceIntegrationRun ? ' and an integration is still running' : ''),
      );
    await sleep(25);
  }
}

async function sourceSnapshot(c) {
  const store = c.f.app.store,
    ids = new Set(Object.values(c.ids)),
    tasks = [...ids].map(id => store.task(id)).filter(Boolean),
    attempts = tasks.flatMap(task => store.attempts(task.id).map(({ instructions, ...attempt }) => attempt)),
    journals = {},
    files = {},
    actions = {};
  // Journals are read through the integration index (store.integrationJournals).
  for (const record of store.integrationJournals(...journalStates))
    if (ids.has(record.taskId))
      journals[record.id] = {
        id: record.sourceIntegration.id,
        taskId: record.taskId,
        state: record.sourceIntegration.state,
      };
  for (const task of tasks.filter(task => task.status === 'done')) {
    const attempt = attempts.find(item => item.id === task.acceptedAttemptId);
    if (!attempt) continue;
    files[attempt.id] = {};
    for (const item of attempt.artifacts || []) {
      try {
        files[attempt.id][item.path] = hash(fs.readFileSync(artifactPath(store, attempt, item.path)));
      } catch {
        files[attempt.id][item.path] = null;
      }
    }
  }
  for (const task of tasks)
    if (waitsForDirector(task, attempts, journals)) actions[task.id] = await readActions(c, task.id);
  return {
    tasks,
    attempts,
    files,
    actions,
    journals,
    mainTip: c.git(['rev-parse', 'refs/heads/main']),
    commits: Number(c.git(['rev-list', '--count', 'refs/heads/main'])),
    leases: store.leases(),
    liveAttempts: store.liveAttempts(),
  };
}

// Restarts the controller on the same records and repository. A crash ends its CLIs without letting it see them stop,
// as restartStudio does; `pending` is an integration run the close interrupts, awaited before the controller reopens.
async function restartSource(c, crash, pending) {
  const app = c.f.app;
  if (crash)
    for (const [id, entry] of [...app.runner.active]) {
      clearTimeout(entry.timer);
      app.runner.active.delete(id);
      if (entry.child && entry.child.exitCode === null) {
        const closed = new Promise(resolve => entry.child.once('close', resolve));
        entry.child.kill('SIGKILL');
        await closed;
      }
    }
  await app.close();
  await pending?.catch(() => {});
  await c.f.reopen();
  recordChanges(c, c.f.app.store);
}

// Chooses one of the listed actions: most choices fall among the actions that carry the work on, and most of those
// among the primary ones, so a story moves along its path; the rest fall among all, closing and denying included.
// Release-line actions (Bring back, Carry to a line, Not needed on a line) are left out: the disposable repository has
// no maintained release line, so the line a director would type for Bring back has no valid value here.
const releaseLineAction = action => /^(bring-back|carry)/.test(action.key);
function chooseSourceAction(listed, choice) {
  const actions = listed.filter(item => !releaseLineAction(item)),
    onward = actions.filter(item => !item.key.startsWith('deny-') && item.key !== 'close'),
    // Reconcile source integration is the one way on for a story whose integration a restart cut off; the shared rules
    // list it as a default action, so it counts with the primary ones here.
    primary = onward.filter(item => item.emphasis === 'primary' || item.key === 'restore');
  const [among, at] =
    primary.length && choice < 0.55
      ? [primary, choice / 0.55]
      : onward.length && choice < 0.9
        ? [onward, Math.max(0, choice - 0.55) / 0.35]
        : [actions, choice >= 0.9 ? (choice - 0.9) / 0.1 : choice];
  return among[Math.min(among.length - 1, Math.max(0, Math.floor(at * among.length)))];
}

// Sends one listed action with every field the records leave empty filled in. Accepting a story's edit is done as
// the setup's review helper does it: the edit's evidence is marked measured (the fixture's trusted seam for the
// measured-only review and integration gates), the studio is paused while the result is accepted, the review stage's
// direction is set to the step's verdict, and the studio resumes.
async function sendSourceAction(c, step, id, action) {
  const store = c.f.app.store,
    task = store.task(id),
    latest = task.lastAttemptId && store.attempt(task.lastAttemptId),
    review = task.status === 'review' ? latest : null,
    edit =
      action.key === 'accept' &&
      latest?.assignment?.kind === 'studio-development:change' &&
      !!latest.checkExecution &&
      !!latest.sourceEditExecution &&
      !!latest.artifacts?.some(item => item.path === 'check-report.json');
  const body = {};
  for (const field of action.fields || []) {
    const value = fill(field, {}, review);
    if (value !== undefined) body[field.name] = value;
  }
  let paused;
  if (edit) {
    c.f.measuredFixture(latest);
    const org = store.organization();
    paused = org.paused;
    org.paused = true;
    store.setOrganization(org);
  }
  const answer = await request(c, action.path, body, action.method);
  if (edit) {
    const story = store.task(id);
    if (story.sourceStage) {
      story.sourceStage.reviewDirection = step.verdict === 'needs-work' ? 'negative-review' : '';
      store.putTask(story);
    }
    const org = store.organization();
    org.paused = paused;
    store.setOrganization(org);
    c.f.app.runner.schedule();
  }
  bump(c.counters.actions, action.key);
  c.answer = { task: step.task, action, status: answer.status, data: answer.data };
  return answer;
}

async function playSource(c, step) {
  const id = c.ids[step.task];
  if (step.kind === 'add') {
    const added = Object.keys(c.ids).length;
    if (id || added >= sourceStoryLimit) return { ...step, skipped: true };
    // The first story is the one setup staged and approved.
    c.ids[step.task] = added ? await c.f.propose(step.task, { files: storyFiles[added] }) : c.f.taskId;
    return { ...step };
  }
  if (step.kind === 'finish') {
    await settleSource(c, `finish ${step.task}`);
    return { ...step };
  }
  if (step.kind === 'restart') {
    await settleSource(c, 'before the restart');
    c.restartBefore = await sourceSnapshot(c);
    await restartSource(c, !!step.crash);
    bump(c.counters.steps, step.crash ? 'crash restart' : 'graceful restart');
    return { ...step };
  }
  if (!id) return { ...step, skipped: true };
  await settleSource(c, `${step.kind} ${step.task}`);
  const actions = await readActions(c, id);
  if (step.kind === 'integrate-restart') {
    // Integrate is sent while the integration's verification is held running (the check fixture's hang mode), and the
    // controller restarts while its journal is busy, as test/source-changes.test.mjs does by hand.
    const action = actions.find(item => item.key === 'integrate');
    if (!action) return { ...step, skipped: true };
    const runner = c.f.app.runner,
      reviewId = action.fields.find(field => field.name === 'attemptId')?.value;
    runner.sourceCheckCommand = { executable: process.execPath, args: [sourceCheckFixture, 'hang'] };
    const answer = await sendSourceAction(c, step, id, action);
    if (answer.status >= 200 && answer.status < 300)
      for (let i = 0; i < 600 && !runner.integrationProcess?.spawnargs.includes('hang'); i++) await sleep(15);
    const journal = c.f.app.store.attempt(reviewId)?.sourceIntegration,
      busy = !!runner.integrationProcess?.spawnargs.includes('hang') && busyJournalStates.includes(journal?.state);
    c.restartBefore = await sourceSnapshot(c);
    await restartSource(c, false, runner.sourceIntegrationRun?.promise);
    if (busy) bump(c.counters.steps, 'restart during integration');
    return { kind: 'integrate-restart', task: step.task, busy };
  }
  if (!actions.some(item => !releaseLineAction(item))) return { ...step, skipped: true };
  const action = step.action
    ? actions.find(item => item.key === step.action)
    : chooseSourceAction(actions, step.choice ?? 0);
  if (!action) return { ...step, skipped: true };
  await sendSourceAction(c, step, id, action);
  // An integration verifies in the background; it settles within the step that sent it.
  await settleSource(c, `after ${action.key} ${step.task}`);
  return { kind: 'act', task: step.task, action: action.key, ...(step.verdict ? { verdict: step.verdict } : {}) };
}

function checkSourceStep(c, step, before, after) {
  const named = violation => ({ ...violation, task: c.labels[violation.task] ?? violation.task }),
    stories = new Set(Object.values(c.ids)),
    restart = !step.skipped && ['restart', 'integrate-restart'].includes(step.kind),
    answered = !!c.answer && c.answer.status >= 200 && c.answer.status < 300,
    from = restart ? c.restartBefore : before;
  const violations = [
    ...checkTransitions(c.changes.splice(0).filter(change => stories.has(change.task))),
    ...checkAccepted(after),
    ...checkLeases(after),
    ...checkReplay(from, after, { restart, crash: step.kind === 'restart' && !!step.crash }),
    ...checkWayForward(after),
    ...checkIntegrated(after),
    // An integrate-restart step sent Integrate before its restart; the integration's verification was held running,
    // so up to the restart the main branch tip must not have moved either.
    ...(restart && step.kind === 'integrate-restart' ? checkIntegrationReplay(before, from) : []),
    ...checkIntegrationReplay(from, after, {
      restart,
      directed: step.kind === 'act' && integrationActions.includes(step.action) && answered,
      reconciled: step.kind === 'act' && step.action === 'restore' && answered ? [c.ids[step.task]] : [],
    }),
    ...(c.answer ? checkAnswer(c.answer) : []),
  ];
  c.answer = null;
  return violations.map(named);
}

// Every status a story is recorded with, as it is written: the changes between steps are checked one by one.
function recordChanges(c, store) {
  const put = store.putTask;
  store.putTask = function (task) {
    const row = store.db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id),
      from = row ? JSON.parse(row.data).status : null;
    put.call(this, task);
    if (from !== task.status) c.changes.push({ task: task.id, from, to: task.status });
  };
}

// Runs one code-story sequence on a fresh disposable repository and checks the promises after every step. Returns the
// steps as they ran and the first violation. `onStep({ step, view, labels })` sees each step and the records after it.
export async function runSourceSequence(steps, { counters = freshCounters(), onStep = () => {} } = {}) {
  const { setup } = await import('./source-story-setup.mjs'),
    { git } = await import('../src/connectors/source-integration.mjs'),
    cleanups = [],
    c = { ids: {}, labels: {}, changes: [], counters, answer: null };
  const ran = [];
  let violation = null;
  try {
    c.f = await setup({ after: cleanup => cleanups.push(cleanup) });
    c.git = args => git(c.f.root, args);
    Object.defineProperty(c, 'origin', { get: () => c.f.origin });
    Object.defineProperty(c, 'token', { get: () => c.f.token });
    c.projectId = c.f.app.store.task(c.f.taskId).projectId;
    recordChanges(c, c.f.app.store);
    counters.sequences++;
    let before = await sourceSnapshot(c);
    for (const step of steps) {
      const done = await playSource(c, step);
      for (const [label, taskId] of Object.entries(c.ids)) c.labels[taskId] = label;
      ran.push(done);
      if (!done.skipped) bump(counters.steps, step.kind);
      const after = await sourceSnapshot(c),
        found = checkSourceStep(c, done, before, after);
      await onStep({ step: done, view: after, labels: c.labels });
      if (found.length) {
        violation = { ...found[0], step: ran.length - 1 };
        break;
      }
      before = after;
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
  }
  return { steps: ran, violation };
}

// Replays a kept code-story sequence and fails with the promise it breaks.
export async function replaySource(steps, options = {}) {
  const { violation } = await runSourceSequence(steps, options);
  if (violation)
    throw new Error(`Lifecycle promise broken (${violation.rule}) at step ${violation.step}: ${violation.message}`);
}

// The seeded search over code stories (exploreLifecycles with this world's generator and run).
export const exploreSourceLifecycles = options =>
  exploreLifecycles({ ...options, generate: generateSourceStep, run: runSourceSequence, replayName: 'replaySource' });
