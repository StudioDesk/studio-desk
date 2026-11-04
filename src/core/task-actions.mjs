// The actions the director may take on one task now, as the story page offers them: the shared rules
// (public/task-actions.js, which reads public/runs.js) run on the records the dashboard holds for the task's project.
// Both scripts set their rules on globalThis when loaded, in the browser and in Node alike; nothing in them sends or
// writes anything, so listing the actions runs none of them.
import '../../public/runs.js';
import '../../public/task-actions.js';
import { bringBackTargets } from '../connectors/source-carries.mjs';
import { liveRecords } from './project-records.mjs';

// The project's records with the task's own page in place of the live set's copy, which is the newest (the story
// page's withPage, dashboard/src/task-page.tsx); a task the live set leaves out, such as closed work, joins it.
function withPage(state, page) {
  const ids = new Set(page.attempts.map(attempt => attempt.id));
  return {
    ...state,
    tasks: [...state.tasks.filter(task => task.id !== page.task.id), page.task],
    attempts: [...state.attempts.filter(attempt => !ids.has(attempt.id)), ...page.attempts],
  };
}

// The actions for one task of a project, each with its label, emphasis, whether it is a closing action, method, path
// and fields (public/task-actions.js).
// `page` is the task's read, { task, attempts }; `shared` is what the project's shell answers beside its records (the
// server's common fields: task types, workflows, adapters, autonomy and the runtime, whose integrationRun names the
// integration the controller is running now, so its reconciling is left out). The state is the one the story
// page holds: the shell (GET /api/projects/<id>/shell) with the live set (GET /api/projects/<id>/live) and the page.
// For a source story that landed, the shared rules name each older line it can go back to from the task's bring-back
// targets (`record`'s, the answer GET /api/tasks/<id>/bring-back gives); no other task reads them, nor git.
export function taskActionsFor(store, projectId, page, shared, record = page.task) {
  const state = withPage({ ...store.shell(projectId), ...shared, ...liveRecords(store, projectId) }, page),
    rules = globalThis.StudioTaskActions,
    reads = rules.bringBackable(page.task, state) ? { bringBack: bringBackTargets(store, record) } : {};
  return rules.taskActions(page.task, state, reads);
}

// One task's read with the actions the director may take on it now: what GET /api/tasks/:id answers. `taskPage` reads
// the task's page, (projectId, record) => { task, attempts, version }, as the server reads it; `shared` is as above.
// The task read and the project's list of calls (core/director-calls.mjs) both answer through it, so a task's actions
// in the two never differ.
export function taskRead(store, projectId, record, { taskPage, shared }) {
  const page = taskPage(projectId, record);
  return { ...page, actions: taskActionsFor(store, projectId, page, shared, record) };
}
