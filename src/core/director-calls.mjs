// What needs the director now, for one project (GET /api/projects/:id/calls): the calls the shared rules
// (public/runs.js needsYouItems) list from the records the dashboard holds, keeping only those whose requiresDirector
// is true, so a wait (a usage reset, another story, the test turn, a free slot) is never on it. Each task's call
// carries the actions its task read answers (core/task-actions.mjs taskRead), worked out by that same helper. Reading
// writes nothing and runs no action: the shared script sets its rules on globalThis when loaded and sends nothing.
import '../../public/runs.js';
import { liveMaxLimit, liveRecords } from './project-records.mjs';
import { taskRead } from './task-actions.mjs';

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
// call, a cleanup of a run's unstarted steps with its member task calls, a CLI's usage hold with no known reset, or the
// project's resume while a restart holds it, with the queued work waiting only for that.
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

export function directorCalls(store, projectId, { taskPage, shared, registries = null }) {
  const version = store.version,
    state = callsState(store, projectId, shared, registries),
    actionsOf = taskId => {
      let record;
      try {
        record = store.task(taskId);
      } catch {
        return [];
      }
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
  return { projectId, items, count: items.length, version };
}
