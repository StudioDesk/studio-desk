// The project rail's calls for the director (the attention indicator, October 29): each project's count by the rule
// Today's Your calls uses (liveSummary), so a tile never says other than the project's own Today. The open project's
// comes from its own records, which its stream keeps current. Every other project's shell and live set is read once,
// under the names its own pages read them by, and read again only when the stream's `projects` event names it: a
// moment after the event, and at most once a second for each project. Nothing is read on a timer or on focus.
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getJSON, liveUrl, shellUrl, type Live, type Shell } from './api';
import { queryKeys, useStudio } from './records';
import { useLiveStream, useStreamReady } from './stream-context';
import { liveSummary, type HomeItem, type StudioState } from './studio-runs';

export interface ProjectCalls {
  count: number;
  items: HomeItem[];
}

// How long after an event a project is read again, and the least time between two reads of one project.
export const railDelay = 250;
export const railGap = 1000;

// Read only when first shown and when an event names the project.
const quiet = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

// One state for each shell and live set read, so liveSummary works each version's calls out once.
const states = new WeakMap<Shell, WeakMap<Live, StudioState>>();
function stateOf(shell: Shell, live: Live) {
  let byLive = states.get(shell);
  if (!byLive) states.set(shell, (byLive = new WeakMap()));
  let state = byLive.get(live);
  if (!state) byLive.set(live, (state = { ...shell, ...live }));
  return state;
}

function callsOf(state: StudioState | null): ProjectCalls | undefined {
  if (!state) return undefined;
  const summary = liveSummary(state);
  return { count: summary.decisions, items: summary.items.filter(item => item.requiresDirector) };
}

// Each project's calls by ID (none while its records are unread, or when a read failed), with the total of every
// project and of every project but the open one.
export function useRailCalls(projectId: string, projects: { id: string }[]) {
  const { state } = useStudio(projectId),
    client = useQueryClient(),
    stream = useLiveStream(),
    ready = useStreamReady(),
    others = projects.map(project => project.id).filter(id => id !== projectId),
    listed = useRef<string[]>([]);
  const shells = useQueries({
    queries: others.map(id => ({
      enabled: ready,
      queryKey: queryKeys.shell(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getJSON<Shell>(shellUrl(id), signal),
      ...quiet,
    })),
  });
  const lives = useQueries({
    queries: others.map(id => ({
      enabled: ready,
      queryKey: queryKeys.live(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getJSON<Live>(liveUrl(id), signal),
      ...quiet,
    })),
  });
  useEffect(() => {
    listed.current = others;
  });
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>(),
      lastRead = new Map<string, number>();
    const read = (id: string) => {
      timers.delete(id);
      lastRead.set(id, Date.now());
      void client.invalidateQueries({ queryKey: queryKeys.shell(id) });
      void client.invalidateQueries({ queryKey: queryKeys.live(id) });
    };
    const unsubscribe = stream.subscribe({
      projects: projectIds => {
        for (const id of new Set(projectIds)) {
          // A read already waiting covers this event too.
          if (id === projectId || !listed.current.includes(id) || timers.has(id)) continue;
          const last = lastRead.get(id),
            wait = Math.max(railDelay, last === undefined ? 0 : last + railGap - Date.now());
          timers.set(
            id,
            setTimeout(() => read(id), wait),
          );
        }
      },
    });
    return () => {
      unsubscribe();
      // A project named but not read again yet reads afresh wherever it shows next, without reading it now.
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        void client.invalidateQueries({ queryKey: queryKeys.shell(id), refetchType: 'none' });
        void client.invalidateQueries({ queryKey: queryKeys.live(id), refetchType: 'none' });
      }
      timers.clear();
    };
  }, [stream, client, projectId]);
  const calls: Record<string, ProjectCalls | undefined> = { [projectId]: callsOf(state) };
  others.forEach((id, index) => {
    const shell = shells[index],
      live = lives[index];
    calls[id] =
      shell?.data && live?.data && !shell.isError && !live.isError
        ? callsOf(stateOf(shell.data, live.data))
        : undefined;
  });
  const sum = (ids: string[]) => ids.reduce((total, id) => total + (calls[id]?.count ?? 0), 0);
  return { calls, total: sum([projectId, ...others]), others: sum(others) };
}
