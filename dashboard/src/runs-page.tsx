// Ideas: the project's ideas (ideas-page.tsx), and each idea's own page, its journey (idea-page.tsx). Open ideas
// come from the live set, finished ones a page at a time, and one the loaded pages have not reached is read on its
// own.
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getJSON, runUrl } from './api';
import { IdeaPage } from './idea-page';
import { IdeasList } from './ideas-page';
import { finishedState, queryKeys, useFinished, useStudio, type RunItem } from './records';
import { useStreamReady } from './stream-context';
import { liveSummary, runStories, type RunStory, type StudioState } from './studio-runs';

const newest = (a: RunStory, b: RunStory) => Date.parse(b.startedAt) - Date.parse(a.startedAt);

// The live records with a finished run's own tasks and attempts, the live copy of any record winning.
function withRecords(state: StudioState, item?: RunItem): StudioState {
  if (!item) return state;
  const tasks = new Set(state.tasks.map(task => task.id)),
    attempts = new Set(state.attempts.map(attempt => attempt.id));
  return {
    ...state,
    tasks: [...state.tasks, ...item.tasks.filter(task => !tasks.has(task.id))],
    attempts: [...state.attempts, ...item.attempts.filter(attempt => !attempts.has(attempt.id))],
  };
}

export function RunsPage({ projectId, runId }: { projectId: string; runId?: string }) {
  const { state, error, shell } = useStudio(projectId),
    finished = useFinished(projectId, 5),
    ready = useStreamReady();
  const finishedStories = useMemo(
    () => (shell && finished.data ? runStories(finishedState(shell, finished.data.pages)) : []),
    [shell, finished.data],
  );
  const live = state ? liveSummary(state).stories : [],
    all = [...live, ...finishedStories.filter(story => !live.some(open => open.id === story.id))].sort(newest),
    known = runId ? all.find(story => story.id === runId) : undefined;
  // A run beyond the loaded pages, from an address or a link, is read on its own.
  const single = useQuery({
    enabled: ready && !!runId && !!state && finished.isSuccess && !known,
    queryKey: queryKeys.run(projectId, runId ?? ''),
    queryFn: ({ signal }) => getJSON<RunItem>(runUrl(projectId, runId ?? ''), signal),
  });
  const alone = useMemo(
    () =>
      shell && single.data ? runStories(finishedState(shell, [{ runs: [single.data], next: null }]))[0] : undefined,
    [shell, single.data],
  );
  // The finished pages' and a single run's own records, by run.
  const recordsOf = (story: RunStory) =>
    [...(finished.data?.pages.flatMap(page => page.runs) ?? []), ...(single.data ? [single.data] : [])].find(
      item => item.run.id === story.id,
    );
  const selected = known ?? alone;
  if (error) return <p role="alert">The project could not be loaded: {error.message}</p>;
  // An idea's own page is its journey (v1.0 item 23). A finished idea's tasks and attempts are not in the live set,
  // so its page reads the records its story was told from.
  if (runId)
    return state && selected ? (
      <IdeaPage
        key={selected.id}
        projectId={projectId}
        run={selected}
        state={withRecords(state, recordsOf(selected))}
      />
    ) : single.isError ? (
      <p role="alert">This idea could not be found: {single.error.message}</p>
    ) : (
      <p role="status" className="sd-meta">
        Loading the idea…
      </p>
    );
  if (!state || finished.isPending)
    return (
      <p role="status" className="sd-meta">
        Loading the ideas…
      </p>
    );
  const entry = (run: RunStory) => ({
    run,
    state: live.includes(run) ? state : withRecords(state, recordsOf(run)),
  });
  return (
    <IdeasList
      projectId={projectId}
      projectName={state.project.name}
      ideas={all.filter(story => !story.archive?.archived).map(entry)}
      archived={all.filter(story => story.archive?.archived).map(entry)}
      more={!!finished.hasNextPage}
      loadingMore={finished.isFetchingNextPage}
      onMore={() => void finished.fetchNextPage()}
    />
  );
}
