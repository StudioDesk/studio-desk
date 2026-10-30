// The talks going in a project, which the sidebar lists under "Talking it through" while the chat box is switched on
// (frame.tsx): each live idea whose plan is not official yet, newest first. Its plan step is found as the idea's page
// finds it, among its steps that are not stories, and the page's own rule says it is still being talked through: not
// done, not closed and not denied. Once the plan is official the idea leaves the list and lives on its page.
import { planStepOf } from './idea-conversation';
import { runRecords } from './journey';
import { liveSummary, type RunStory, type StudioState } from './studio-runs';

export interface TalkItem {
  runId: string;
  title: string;
}

// The idea's plan step, if it has one, as the idea's page finds it.
function planOf(run: RunStory, state: StudioState) {
  const { nodes, stories, tasks } = runRecords(run, state);
  return planStepOf(
    nodes.flatMap(node => {
      const task = tasks.get(node.taskId);
      return task && !stories.includes(task) ? [task] : [];
    }),
  );
}

export function talks(state: StudioState): TalkItem[] {
  return liveSummary(state)
    .stories.filter(run => {
      const plan = planOf(run, state);
      return !!plan && plan.status !== 'done' && !plan.closed && plan.status !== 'denied';
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map(run => ({ runId: run.id, title: run.title || (run.brief.trim().split('\n')[0]?.trim() ?? '') }));
}
