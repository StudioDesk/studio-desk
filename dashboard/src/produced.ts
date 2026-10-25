// What an idea produced, for the Viewer on its page: each step's files from its accepted attempt (or its latest
// finished one, while it waits for you), each code story's change as a link to its story, and their reviews and
// records.
import type { AttemptSummary, Task } from './api';
import { diffStatOf, plural } from './evidence';
import { fileGroup, type ViewerEntry } from './files';
import { journeyStories, runRecords } from './journey';
import { workerName } from './names';
import { isSourceStory, storyPeople } from './story';
import type { RunStory, StudioState } from './studio-runs';

// An attempt that ended without a result to read, or has not ended.
const stopped = ['running', 'stopping', 'failed', 'cancelled', 'quarantined', 'uncertain', 'interrupted'];

export function produced(run: RunStory, state: StudioState): ViewerEntry[] {
  const { tasks, attempts } = runRecords(run, state),
    stories = journeyStories(run, state),
    entries: ViewerEntry[] = [];
  const add = (task: Task, attempt?: AttemptSummary) => {
    if (!attempt) return;
    for (const item of attempt.artifacts ?? []) {
      const group = fileGroup(attempt, item);
      if (group)
        entries.push({
          key: `${attempt.id}/${item.path}`,
          group,
          name: item.path.split(/[\\/]/).pop() ?? item.path,
          meta: `${workerName(state, attempt.workerId)} · ${task.title}`,
          file: { attempt, item },
          step: { taskId: task.id, title: task.title },
        });
    }
  };
  for (const id of run.taskIds) {
    const task = tasks.get(id);
    if (!task) continue;
    if (isSourceStory(task)) {
      const { candidate, review } = storyPeople(task, state),
        story = stories.find(item => item.task.id === task.id),
        stat = diffStatOf(candidate);
      if (candidate && stat)
        entries.push({
          key: `change:${task.id}`,
          group: 'made',
          name: story ? `Story ${story.number}'s change` : task.title,
          meta: [
            workerName(state, candidate.workerId),
            `${stat.files} ${plural(stat.files, 'file')}, +${stat.added} −${stat.removed}`,
            story?.commit ? `landed as ${story.commit}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          step: { taskId: task.id, title: task.title },
        });
      add(task, candidate);
      add(task, review);
      continue;
    }
    const tried = attempts(task.id);
    add(
      task,
      tried.find(attempt => attempt.id === task.acceptedAttemptId) ??
        tried.findLast(attempt => !!attempt.artifacts?.length && !stopped.includes(attempt.status)),
    );
  }
  return entries;
}
