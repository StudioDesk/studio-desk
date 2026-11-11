// What needs the director now, for one project (GET /api/projects/:id/calls): the calls the shared rules
// (public/runs.js needsYouItems) list from the records the dashboard holds, keeping only those whose requiresDirector
// is true, so a wait (a usage reset, another story, the test turn, a free slot) is never on it. Each task's call
// carries the actions its task read answers (core/task-actions.mjs taskRead), worked out by that same helper. After
// them come the two stops only the director moves on, which the shared rules do not list: a milestone's release that
// stopped (Release again) and a story whose next carry or bring-back was turned down or stopped part-way (Carry or
// Bring back again, Not needed), each only once the test turn it held is given back. Reading writes nothing and runs
// no action: the shared script sets its rules on globalThis when loaded and sends nothing.
import '../../public/runs.js';
import { projectMilestones } from '../connectors/source-milestones.mjs';
import { liveMaxLimit, liveRecords } from './project-records.mjs';
import { recordProject } from './projects.mjs';
import { taskRead } from './task-actions.mjs';
import { holdsTestTurn } from './test-turn.mjs';

// The whole live set, every page of it read at once as the dashboard holds it (dashboard/src/records.ts joinLive):
// each page's tasks and attempts in order, each open run once and each finished idea once with its tasks from every
// page. The pages are read without yielding, so none can settle out from under the next.
export function wholeLive(store, projectId, registries = null) {
  const pages = [];
  let before = null;
  do {
    const page = liveRecords(store, projectId, { before, limit: liveMaxLimit, registries });
    pages.push(page);
    before = page.next;
  } while (before !== null);
  const runs = new Map(),
    ideas = new Map();
  for (const page of pages) {
    for (const run of page.runs) if (!runs.has(run.id)) runs.set(run.id, run);
    for (const idea of page.ideas || []) {
      const held = ideas.get(idea.id);
      ideas.set(idea.id, held ? { ...held, taskIds: [...held.taskIds, ...idea.taskIds] } : idea);
    }
  }
  return {
    tasks: pages.flatMap(page => page.tasks),
    attempts: pages.flatMap(page => page.attempts),
    runs: [...runs.values()],
    ideas: [...ideas.values()],
    next: null,
    version: pages[0].version,
  };
}

// The project's records as Today holds them: its shell (store.shell with the server's common fields, `shared`) and its
// whole live set, each task with its automatic attempts counted as GET /api/projects/:id/live serves it (the
// registries).
export function callsState(store, projectId, shared, registries = null) {
  return { ...store.shell(projectId), ...shared, ...wholeLive(store, projectId, registries) };
}

// The shared rules' calls for those records, as Today works them out (dashboard/src/studio-runs.ts liveSummary): the
// stories of the runs the live set names, then needsYouItems over them. Every item, the waits included.
export function sharedCalls(state) {
  const rules = globalThis.StudioRuns,
    named = new Set((state.runs || []).map(run => run.id)),
    stories = rules.buildRunStories(state).filter(story => named.has(story.id));
  return rules.needsYouItems(state, stories);
}

// The list for one project: { projectId, items, count, version }. `taskPage` and `shared` are what the task read
// takes (core/task-actions.mjs taskRead); `registries` as the live read takes them. Each item is plain: a task's
// call, a cleanup of a run's unstarted steps with its member task calls, a CLI's usage hold with no known reset, the
// project's resume while a restart holds it, with the queued work waiting only for that, then a milestone's stopped
// release (type 'release', in milestone order) and a story's turned-down or stopped carry (type 'carry', in record
// order).
// The resume call's one action: the project's resume step (POST /api/pipeline), in the shape task actions take
// (public/task-actions.js).
export const resumeAction = projectId => ({
  key: 'resume',
  label: 'Resume this project',
  emphasis: 'primary',
  closing: false,
  method: 'POST',
  path: '/api/pipeline',
  fields: [
    { name: 'projectId', required: true, kind: 'id', value: projectId },
    { name: 'action', required: true, kind: 'text', value: 'resume' },
  ],
});

// The release call's one action: Release again (POST /api/projects/<id>/milestones/<id>/release/again), sending
// exactly what the Releases page sends, the project's ID and nothing else.
export const releaseAgainAction = (projectId, milestoneId) => ({
  key: 'release-again',
  label: 'Release again',
  emphasis: 'primary',
  closing: false,
  method: 'POST',
  path: `/api/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}/release/again`,
  fields: [{ name: 'projectId', required: true, kind: 'id', value: projectId }],
});

// The states a release or carry stops in that only the director moves on (connectors/source-releases.mjs
// releaseAgain, connectors/source-carries.mjs approveCarry), and a reason worded with its recorded error.
const stoppedStates = ['rejected', 'needs-reconciliation'],
  carryActions = ['carry', 'carry-skip'],
  stoppedWith = (text, error) => (error ? `${text}: ${error}` : `${text}.`);

// A milestone's release that stopped, while the test turn it held is given back (a stopped release whose test run may
// still go on waits for that, not for the director).
function releaseCall(store, projectId, milestone) {
  const release = milestone.release;
  if (!release || !stoppedStates.includes(release.state) || holdsTestTurn(store, release.id)) return null;
  const partWay = release.state === 'needs-reconciliation';
  return {
    type: 'release',
    projectId,
    milestoneId: milestone.id,
    version: milestone.version,
    state: release.state,
    taskIds: release.notesTaskId ? [release.notesTaskId] : [],
    runId: null,
    kind: 'release-stopped',
    reason: stoppedWith(
      `The release of ${milestone.version} ${partWay ? 'stopped part-way' : 'stopped'}`,
      release.error,
    ),
    next: partWay
      ? "Restore or commit any of the release's files left changed in the project's folder, then release it again; it is tagged once."
      : 'Release it again; it is tagged once.',
    action: 'Release again',
    details: release.error ? [release.error] : [],
    actions: [releaseAgainAction(projectId, milestone.id)],
  };
}

// The carry whose turn it is on a story's accepted review (the first neither carried nor skipped, as
// public/task-actions.js picks it), when it was turned down or stopped part-way and holds no test turn; else null.
function stoppedCarry(store, projectId, journal) {
  let story;
  try {
    story = store.task(journal.taskId);
  } catch {
    return null;
  }
  if (recordProject(story) !== projectId || story.sourceStage?.review?.attemptId !== journal.id) return null;
  const carry = journal.sourceCarries.find(item => !['carried', 'skipped'].includes(item.state));
  if (!carry || !stoppedStates.includes(carry.state) || holdsTestTurn(store, carry.id)) return null;
  return { story, carry };
}

// A story's carry call, with the story's own Carry (or Bring back) again and Not needed actions.
function carryCall(projectId, { story, carry }, actions) {
  const back = !!carry.back,
    partWay = carry.state === 'needs-reconciliation',
    moving = back ? `Bringing this fix back to ${carry.line}` : `Carrying this fix to ${carry.line}`,
    again = back ? 'bring it back again' : 'carry it again';
  return {
    type: 'carry',
    projectId,
    taskId: story.id,
    taskIds: [story.id],
    title: story.title,
    line: carry.line,
    back,
    state: carry.state,
    runId: null,
    kind: 'carry-stopped',
    reason: stoppedWith(`${moving} ${partWay ? 'stopped part-way' : 'was turned down'}`, carry.error),
    next: partWay
      ? `Restore or commit any of its files left changed in the project's folder, then ${again}.`
      : `${again[0].toUpperCase()}${again.slice(1)}, or say it is not needed there.`,
    action: actions[0].label,
    details: carry.error ? [carry.error] : [],
    actions,
  };
}

// Whether a task's actions read git: the shared rules name the older lines a story whose review's change landed on a
// line can be brought back to, which reads each line's history (connectors/source-carries.mjs bringBackTargets, which
// reads nothing outside the records for any other task). Git is not among the records store.version covers.
const readsGit = (store, record) => {
  if (record.kind !== 'studio-development:change' || !record.sourceStage?.review?.attemptId) return false;
  try {
    const integration = store.attempt(record.sourceStage.review.attemptId).sourceIntegration;
    return integration?.state === 'integrated' && !!integration.repository?.branch;
  } catch {
    return false;
  }
};

// The list worked out afresh, every time: what directorCalls answers when nothing it keeps still holds.
export function computeDirectorCalls(store, projectId, options) {
  return workCalls(store, projectId, options).answer;
}

// The list with whether it may be kept: not when a listed task's actions read git (readsGit).
function workCalls(store, projectId, { taskPage, shared, registries = null }) {
  computations++;
  let keepable = true;
  const version = store.version,
    state = callsState(store, projectId, shared, registries),
    actionsOf = taskId => {
      let record;
      try {
        record = store.task(taskId);
      } catch {
        return [];
      }
      if (readsGit(store, record)) keepable = false;
      return taskRead(store, projectId, record, { taskPage, shared }).actions;
    },
    taskCall = item => ({
      type: 'task',
      taskId: item.taskId,
      runId: item.run?.id ?? null,
      kind: item.kind,
      reason: item.reason,
      next: item.next,
      action: item.action ?? null,
      details: item.details || [],
      attemptId: item.attemptId ?? null,
      canClose: !!item.canClose,
      actions: actionsOf(item.taskId),
    }),
    items = sharedCalls(state)
      .filter(item => item.requiresDirector)
      .map(item => {
        if (item.kind === 'subscription-hold')
          return {
            type: 'hold',
            provider: item.provider,
            label: item.label,
            taskIds: item.taskIds || [],
            runId: null,
            kind: item.kind,
            reason: item.reason,
            next: item.next,
            action: item.action ?? null,
            details: [],
            actions: [],
          };
        if (item.kind === 'project-resume')
          return {
            type: 'resume',
            projectId,
            taskIds: item.taskIds || [],
            runId: null,
            kind: item.kind,
            reason: item.reason,
            next: item.next,
            action: item.action ?? null,
            details: [],
            actions: [resumeAction(projectId)],
          };
        if (item.members)
          return {
            type: 'cleanup',
            runId: item.run.id,
            taskIds: item.taskIds,
            members: item.members.map(member => taskCall({ ...member, run: item.run })),
          };
        return taskCall(item);
      });
  // The stops the shared rules do not list: releases in milestone order, then carries in record order, a story with a
  // call of its own listed once.
  const listed = new Set(
    items.flatMap(item =>
      item.type === 'task' ? [item.taskId] : item.type === 'cleanup' ? item.members.map(member => member.taskId) : [],
    ),
  );
  for (const milestone of projectMilestones(store, projectId)) {
    const call = releaseCall(store, projectId, milestone);
    if (call) items.push(call);
  }
  for (const journal of store.carryJournals()) {
    if (listed.has(journal.taskId)) continue;
    const stopped = stoppedCarry(store, projectId, journal);
    if (!stopped) continue;
    // Listed only while the story itself offers to move it on.
    const actions = actionsOf(journal.taskId).filter(action => carryActions.includes(action.key));
    if (!actions.length) continue;
    listed.add(journal.taskId);
    items.push(carryCall(projectId, stopped, actions));
  }
  return { answer: { projectId, items, count: items.length, version }, keepable };
}

// The last list worked out for each project of each store (separate stores never share one), with what it was worked
// out from: { key, taskPage, registries, answer }. Kept per store and dropped with it.
const kept = new WeakMap();
let computations = 0;

// What the list is worked out from beyond the arguments that are compared as they are (taskPage and registries): the
// store's version, which every write raises; the server's common fields, which carry the controller's in-memory state
// (the runner's adapters, the integration running now, pending integration and restart) and today's cycle count; and
// the local day and time zone, since the shared rules word a reset time with its date only when it is not today
// (public/runs.js resetClock). The rules read no other clock: every other time they compare is a recorded one.
const keyOf = (store, shared) => {
  const now = new Date();
  return JSON.stringify([store.version, now.toDateString(), now.getTimezoneOffset(), shared ?? null]);
};

// The list for one project, as computeDirectorCalls works it out (GET /api/projects/:id/calls). It is worked out once
// for each change: while the project, the store's version, the common fields, the day, the task read and the
// registries are those it was last worked out from, the same list is answered again, exactly what working it out now
// would answer. A list whose actions read git is never kept. Each caller gets its own copy, so no caller can change
// what another is answered.
export function directorCalls(store, projectId, options) {
  const { taskPage, shared, registries = null } = options,
    key = keyOf(store, shared);
  let projects = kept.get(store);
  const held = projects?.get(projectId);
  if (held && held.key === key && held.taskPage === taskPage && held.registries === registries)
    return structuredClone(held.answer);
  const { answer, keepable } = workCalls(store, projectId, options);
  if (!projects) kept.set(store, (projects = new Map()));
  // The key is read again after working the list out: a list worked out while the records moved is not kept.
  if (keepable && keyOf(store, shared) === key) projects.set(projectId, { key, taskPage, registries, answer });
  else projects.delete(projectId);
  return structuredClone(answer);
}

// For tests: how many times a list has been worked out, and forgetting a store's kept lists so the next read works
// each out afresh.
export const directorCallsComputed = () => computations;
export const forgetDirectorCalls = store => kept.delete(store);
