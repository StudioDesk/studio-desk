// The work board's page (the canvas's Board, v1.0 item 23, drawn by board-view.tsx).
import type { SettledPage } from './api';
import { Board } from './board-view';
import { useStudio } from './records';
import type { StudioState } from './studio-runs';

// The live set with every loaded page of settled work, so cards read their attempts and the shared rules.
export function withSettled(state: StudioState, pages: SettledPage[]): StudioState {
  const tasks = new Map(state.tasks.map(task => [task.id, task])),
    attempts = new Map(state.attempts.map(attempt => [attempt.id, attempt]));
  for (const page of pages) {
    for (const task of page.tasks) if (!tasks.has(task.id)) tasks.set(task.id, task);
    for (const attempt of page.attempts) if (!attempts.has(attempt.id)) attempts.set(attempt.id, attempt);
  }
  return { ...state, tasks: [...tasks.values()], attempts: [...attempts.values()] };
}

export function BoardPage({ projectId, accepted, closed }: { projectId: string; accepted: boolean; closed: boolean }) {
  const { state, error } = useStudio(projectId);
  if (error) return <p role="alert">The project could not be loaded: {error.message}</p>;
  if (!state)
    return (
      <p role="status" className="sd-meta">
        Loading the board…
      </p>
    );
  return <Board projectId={projectId} state={state} accepted={accepted} closed={closed} />;
}
