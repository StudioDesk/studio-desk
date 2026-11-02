// What a project's pages read without its whole history (Decision MP-026, v1.0 item 19b). The live set is
// what Home, the board and the current runs show: every unsettled task, every task of a run that still has
// open work, the direct prerequisites of those, their attempt summaries and those runs, a page at a time in record
// order. Finished runs come a page at a time, newest first, each with its tasks and attempt summaries, and any one
// run on its own. Every read says the store's change sequence it reflects (version), the point a reader resumes the
// change stream from; reads are synchronous, so no write lands while one is built.
import { directorInputsOf } from './idea-inputs.mjs';
import { projectRuns } from './graph.mjs';

// A settled task needs nothing more: closed, denied, or accepted with nothing left to integrate. A source story
// is accepted while it waits for integration (public/runs.js integrationReview), and so is a passing review in
// the older two-task layout; both stay live until integrated. Failed, cancelled and waiting work may need more.
export function settled(task, reviewOf = () => null) {
  if (task.closed || task.status === 'denied') return true;
  if (task.status !== 'done') return false;
  if (task.kind === 'studio-development:change' && task.sourceStage?.version === 'source-story-stages-v1')
    return task.sourceStage.current === 'integrated';
  if (task.kind === 'studio-development:change-review' && !task.sourceStage) {
    const review = reviewOf(task.acceptedAttemptId);
    return review?.candidateReviewVerdict !== 'pass' || review.sourceIntegration?.state === 'integrated';
  }
  return true;
}

// The accepted attempts of older-layout reviews, read in one query, for settled().
function reviewReader(store, projectId, tasks) {
  const ids = tasks
    .filter(task => task.kind === 'studio-development:change-review' && task.status === 'done' && !task.sourceStage)
    .map(task => task.id);
  const attempts = new Map(
    (ids.length ? store.dashboardAttempts(projectId, ids) : []).map(attempt => [attempt.id, attempt]),
  );
  return task => settled(task, id => attempts.get(id) ?? null);
}

// The run each task belongs to, by the dashboard's rule (public/runs.js runMembership): its own run
// reference, or the run of the task it retries or was proposed from.
export function runMembership(tasks) {
  const runOf = new Map();
  for (const task of tasks) {
    const runId = task.workflowReference?.runId || task.runReference?.runId;
    if (runId) runOf.set(task.id, runId);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (runOf.has(task.id)) continue;
      const parent = runOf.get(task.retryOf) || runOf.get(task.proposalReference?.taskId);
      if (parent) {
        runOf.set(task.id, parent);
        changed = true;
      }
    }
  }
  return runOf;
}

const withInputs = record => ({ ...record, directorInputs: directorInputsOf(record) });
// A project's tasks in record order, read through the project index (core/store.mjs).
const projectTasks = (store, projectId) => store.projectTasks(projectId);

// A finished run's records as its story reads them (public/runs.js): without each task's direction, brief,
// acceptance text and accepted inputs, or each attempt's input references, files and review notes, which a
// finished story never shows and which made a page of ten runs about 715 KB. A task's own page reads them.
const omitted = (record, fields) => Object.fromEntries(Object.entries(record).filter(([key]) => !fields.includes(key)));
const storyTask = task => withInputs(omitted(task, ['direction', 'brief', 'acceptance', 'acceptedInputs']));
const storyAttempt = attempt =>
  omitted(attempt, ['inputReferences', 'artifacts', 'candidateReviewNotes', 'continueFrom']);

// The idea each of these tasks belongs to, named for the board's lanes without its graph, tasks or attempts: its ID,
// words and when it was made, and which of these tasks are its own, newest idea first as projectRuns orders them.
function ideasOf(runs, runOf, tasks) {
  const own = new Map();
  for (const task of tasks) {
    const runId = runOf.get(task.id);
    if (!runId) continue;
    if (!own.has(runId)) own.set(runId, []);
    own.get(runId).push(task.id);
  }
  return runs
    .filter(run => own.has(run.id))
    .map(run => ({ id: run.id, brief: run.brief ?? '', createdAt: run.createdAt, taskIds: own.get(run.id) }));
}

// The live set a page at a time (page-read-limits): limit tasks after the task before, in record order, with their
// attempt summaries, the open runs they belong to and the finished ideas they name; next is the last task's ID while
// more follow. The pages' union is the whole live set. A cursor that left the live set answers 404.
export const liveLimit = 200,
  liveMaxLimit = 500;
export function liveRecords(store, projectId, { before = null, limit = liveLimit } = {}) {
  store.project(projectId);
  const version = store.version,
    tasks = projectTasks(store, projectId),
    done = reviewReader(store, projectId, tasks),
    runOf = runMembership(tasks),
    openRuns = new Set(tasks.filter(task => !done(task) && runOf.has(task.id)).map(task => runOf.get(task.id))),
    live = new Set(tasks.filter(task => !done(task) || openRuns.has(runOf.get(task.id))).map(task => task.id));
  // Direct prerequisites only, so a live story shows what it waits on without pulling in their history.
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const id of [...live]) for (const dependency of byId.get(id)?.dependencies || []) live.add(dependency);
  const chosen = tasks.filter(task => live.has(task.id)),
    size = Math.min(Math.max(1, Math.trunc(limit)), liveMaxLimit),
    from = before === null ? 0 : chosen.findIndex(task => task.id === before) + 1;
  if (from === 0 && before !== null)
    throw Object.assign(new Error('That page of open work no longer exists.'), { status: 404 });
  const page = chosen.slice(from, from + size),
    needed = new Set(page.map(task => runOf.get(task.id)).filter(Boolean)),
    runs = projectRuns(store, projectId, tasks);
  return {
    tasks: page.map(withInputs),
    attempts: page.length
      ? store.dashboardAttempts(
          projectId,
          page.map(task => task.id),
        )
      : [],
    runs: runs
      .filter(run => openRuns.has(run.id) && needed.has(run.id))
      .map(run => ({ ...run, directorInputs: directorInputsOf(store.run(run.id)) })),
    // A prerequisite from a finished idea names that idea briefly; the runs above tell their own tasks.
    ideas: ideasOf(
      runs.filter(run => !openRuns.has(run.id)),
      runOf,
      page,
    ),
    next: from + size < chosen.length ? page.at(-1).id : null,
    version,
  };
}

export function finishedRuns(store, projectId, { before = null, limit = 10 } = {}) {
  store.project(projectId);
  const version = store.version,
    tasks = projectTasks(store, projectId),
    done = reviewReader(store, projectId, tasks),
    runOf = runMembership(tasks),
    members = new Map();
  for (const task of tasks) {
    const runId = runOf.get(task.id);
    if (!runId) continue;
    if (!members.has(runId)) members.set(runId, []);
    members.get(runId).push(task);
  }
  // Newest finished first, each with when it finished (November 2, 2026, the drift audit's D15): an idea sent days
  // ago that finished tonight comes before one sent today that finished this morning, so Today's Shipped today reads
  // it. An idea finished when the last thing was recorded on any of its tasks; one with nothing recorded keeps its
  // place among the others in the order they were sent, after them.
  const sent = projectRuns(store, projectId, tasks).filter(run => members.get(run.id)?.every(done)),
    last = store.lastTaskEvents(sent.flatMap(run => members.get(run.id).map(task => task.id))),
    ended = new Map(
      sent.map(run => [
        run.id,
        members
          .get(run.id)
          .map(task => last.get(task.id))
          .reduce((latest, event) => (event && event.seq > (latest?.seq ?? 0) ? event : latest), null),
      ]),
    ),
    finished = sent.sort((a, b) => (ended.get(b.id)?.seq ?? 0) - (ended.get(a.id)?.seq ?? 0));
  const from = before === null ? 0 : finished.findIndex(run => run.id === before) + 1;
  if (from === 0 && before !== null)
    throw Object.assign(new Error('That page of runs no longer exists.'), { status: 404 });
  const page = finished.slice(from, from + limit),
    ids = page.flatMap(run => members.get(run.id).map(task => task.id)),
    attempts = ids.length ? store.dashboardAttempts(projectId, ids) : [];
  return {
    runs: page.map(run => {
      const own = new Set(members.get(run.id).map(task => task.id)),
        finishedAt = ended.get(run.id)?.time;
      return {
        run: { ...run, directorInputs: directorInputsOf(store.run(run.id)), ...(finishedAt ? { finishedAt } : {}) },
        tasks: members.get(run.id).map(storyTask),
        attempts: attempts.filter(attempt => own.has(attempt.taskId)).map(storyAttempt),
      };
    }),
    next: from + limit < finished.length ? page.at(-1).id : null,
    version,
  };
}

// One run with its tasks and attempt summaries, open or finished, for a page that shows a run the loaded
// pages have not reached.
export function oneRun(store, projectId, runId) {
  store.project(projectId);
  const version = store.version,
    tasks = projectTasks(store, projectId),
    runOf = runMembership(tasks),
    run = projectRuns(store, projectId, tasks).find(item => item.id === runId);
  if (!run) throw Object.assign(new Error('Run not found.'), { status: 404 });
  const members = tasks.filter(task => runOf.get(task.id) === runId),
    // An open run keeps everything its open work may still need, such as what an integration checks.
    finished = members.every(reviewReader(store, projectId, tasks)),
    attempts = members.length
      ? store.dashboardAttempts(
          projectId,
          members.map(task => task.id),
        )
      : [];
  return {
    run: { ...run, directorInputs: directorInputsOf(store.run(run.id)) },
    tasks: members.map(finished ? storyTask : withInputs),
    attempts: finished ? attempts.map(storyAttempt) : attempts,
    version,
  };
}

// Settled work for the board, newest finished first, a page at a time: accepted results, or closed and denied
// work. The counts let a folded column show its size without its records.
export const settledKinds = ['accepted', 'closed'];
// Settled work of one kind, newest finished first, a page at a time; an employee's or a team's page reads only
// its own (v1.0 item 19c). Each idea the page's work belongs to is named briefly, so the board keeps a finished
// idea's work in its lane.
export function settledTasks(store, projectId, { kind, before = null, limit = 12, workerId = null, team = null }) {
  store.project(projectId);
  const version = store.version,
    all = projectTasks(store, projectId),
    tasks = all.filter(
      task => (workerId === null || task.workerId === workerId) && (team === null || task.team === team),
    ),
    done = reviewReader(store, projectId, tasks),
    // When these tasks last finished, from their own attempts rather than every attempt of every project.
    finished = store.lastFinished(tasks.map(task => task.id)),
    when = task => finished.get(task.id) || task.createdAt || '',
    groups = {
      accepted: tasks.filter(task => done(task) && task.status === 'done' && !task.closed),
      closed: tasks.filter(task => done(task) && (task.closed || task.status === 'denied')),
    },
    list = groups[kind].sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0)),
    from = before === null ? 0 : list.findIndex(task => task.id === before) + 1;
  if (from === 0 && before !== null)
    throw Object.assign(new Error('That page of tasks no longer exists.'), { status: 404 });
  const page = list.slice(from, from + limit);
  return {
    tasks: page.map(withInputs),
    attempts: page.length
      ? store.dashboardAttempts(
          projectId,
          page.map(task => task.id),
        )
      : [],
    next: page.length && from + limit < list.length ? page.at(-1).id : null,
    counts: { accepted: groups.accepted.length, closed: groups.closed.length },
    // Membership reads the project's every task, so a retry or a proposed story finds its idea through work
    // another employee or team did.
    ideas: page.length ? ideasOf(projectRuns(store, projectId, all), runMembership(all), page) : [],
    version,
  };
}

// What the organization pages count from the whole history (v1.0 item 19c): the project's tasks, each
// employee's and team's accepted work, and the goal tasks of the company and its teams, which may have settled
// long ago.
export function peopleSummary(store, projectId, goalIds = []) {
  store.project(projectId);
  const version = store.version,
    tasks = projectTasks(store, projectId),
    wanted = new Set(goalIds),
    accepted = { total: 0, workers: {}, teams: {} },
    goals = {};
  for (const task of tasks) {
    if (task.status === 'done') {
      accepted.total++;
      accepted.workers[task.workerId] = (accepted.workers[task.workerId] || 0) + 1;
      accepted.teams[task.team] = (accepted.teams[task.team] || 0) + 1;
    }
    if (wanted.has(task.id))
      goals[task.id] = {
        id: task.id,
        title: task.title,
        kind: task.kind,
        status: task.status,
        ...(task.closed ? { closed: task.closed } : {}),
        ...(task.sourceStage ? { sourceStage: task.sourceStage } : {}),
      };
  }
  return { tasks: tasks.length, accepted, goals, version };
}
