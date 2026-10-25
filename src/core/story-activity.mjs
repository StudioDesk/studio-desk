// What happened to a task besides its agents' output, for its Activity (the director, October 24: "The activity
// stream doesn't show any of the user input"): its recorded events without agent output, the idea its run started
// from, and the instructions the director published while it ran that its attempts follow. The dashboard words
// them. Who acted is in each event's own wording ("Director …", "… autonomy policy revision …"), since the events
// table has no column for it.
import { projectOrganization } from './project-organization.mjs';
import { recordProject } from './projects.mjs';

export function storyActivity(store, task) {
  const run = task.runReference?.runId ? store.run(task.runReference.runId) : null,
    attempts = store.attempts(task.id),
    // Instructions published after the task was made and, once it is settled, before its last attempt started.
    from = Date.parse(task.createdAt ?? '') || 0,
    until = ['done', 'closed'].includes(task.status)
      ? Math.max(0, ...attempts.map(attempt => Date.parse(attempt.startedAt ?? '') || 0))
      : Infinity,
    { instructions } = projectOrganization(store, recordProject(task)),
    // The company's, the task's team's and those of the agents who worked on it or will.
    workers = new Set([task.workerId, task.sourceStage?.reviewTask?.workerId, ...attempts.map(item => item.workerId)]),
    documents = [
      instructions?.company,
      instructions?.teams?.[task.teamId],
      ...Object.values(instructions?.employees ?? {}).filter(doc => workers.has(doc.id)),
    ].filter(Boolean);
  return {
    events: store.taskEvents(task),
    idea: run
      ? {
          runId: run.id,
          brief: run.brief ?? '',
          createdAt: run.createdAt ?? null,
          files: (run.directorInputs ?? []).map(file => file.name),
        }
      : null,
    instructions: documents
      .flatMap(doc =>
        (doc.history ?? [])
          .filter(entry => {
            const at = Date.parse(entry.publishedAt ?? '');
            return entry.revision > 1 && at > from && at < until;
          })
          .map(entry => ({
            scope: doc.scope,
            id: doc.id,
            revision: entry.revision,
            note: entry.note ?? '',
            publishedAt: entry.publishedAt,
          })),
      )
      .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt)),
  };
}
