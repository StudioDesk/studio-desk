// The project rail's calls for the director (the attention indicator, October 29): each project's count is the
// controller's list of what needs the director in it (GET /api/projects/<id>/calls), the list Today's Your calls
// draws, so a tile never says other than the project's own Today. The open project's list is read with its own
// records, as its stream reports their changes. Every other project's list is read once, under the name its own pages
// read it by, and read again only when the stream's `projects` event names it: a moment after the event, and at most
// once a second for each project. Nothing is read on a timer or on focus. Its shell and live set are read with it,
// under their own names, only for the lines of the card beside its tile (rail-card.tsx); the count never waits on them.
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { callsUrl, getJSON, shellUrl, type DirectorCalls, type Live, type Shell } from './api';
import { queryKeys, readLive, servedItems, useCalls, useStudio } from './records';
import { useLiveStream, useStreamReady } from './stream-context';
import { liveSummary, type HomeItem, type StudioState } from './studio-runs';

export interface ProjectCalls {
  count: number;
  // The served calls as the card draws them, once the project's records are read (none before).
  items: HomeItem[];
}

// How long after an event a project is read again, and the least time between two reads of one project.
export const railDelay = 250;
export const railGap = 1000;

// Read only when first shown and when an event names the project.
const quiet = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;

// One state for each shell and live set read, so liveSummary works each version's stories out once.
const states = new WeakMap<Shell, WeakMap<Live, StudioState>>();
function stateOf(shell: Shell, live: Live) {
  let byLive = states.get(shell);
  if (!byLive) states.set(shell, (byLive = new WeakMap()));
  let state = byLive.get(live);
  if (!state) byLive.set(live, (state = { ...shell, ...live }));
  return state;
}

function callsOf(served: DirectorCalls | undefined, state: StudioState | null): ProjectCalls | undefined {
  if (!served) return undefined;
  return { count: served.count, items: state ? servedItems(served.items, state, liveSummary(state).stories) : [] };
}

// Each project's calls by ID (none while its list is unread, or when its read failed), with the total of every
// project and of every project but the open one.
export function useRailCalls(projectId: string, projects: { id: string }[]) {
  const { state } = useStudio(projectId),
    own = useCalls(projectId),
    client = useQueryClient(),
    stream = useLiveStream(),
    ready = useStreamReady(),
    others = projects.map(project => project.id).filter(id => id !== projectId),
    listed = useRef<string[]>([]);
  const lists = useQueries({
    queries: others.map(id => ({
      enabled: ready,
      queryKey: queryKeys.calls(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getJSON<DirectorCalls>(callsUrl(id), signal),
      ...quiet,
    })),
  });
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
      queryFn: ({ signal }: { signal: AbortSignal }) => readLive(id, signal),
      ...quiet,
    })),
  });
  useEffect(() => {
    listed.current = others;
  });
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>(),
      lastRead = new Map<string, number>(),
      keys = (id: string) => [queryKeys.calls(id), queryKeys.shell(id), queryKeys.live(id)];
    const read = (id: string) => {
      timers.delete(id);
      lastRead.set(id, Date.now());
      for (const queryKey of keys(id)) void client.invalidateQueries({ queryKey });
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
        for (const queryKey of keys(id)) void client.invalidateQueries({ queryKey, refetchType: 'none' });
      }
      timers.clear();
    };
  }, [stream, client, projectId]);
  const calls: Record<string, ProjectCalls | undefined> = {
    [projectId]: own.isError ? undefined : callsOf(own.data, state),
  };
  others.forEach((id, index) => {
    const list = lists[index],
      shell = shells[index],
      live = lives[index],
      read = shell?.data && live?.data && !shell.isError && !live.isError ? stateOf(shell.data, live.data) : null;
    calls[id] = list && !list.isError ? callsOf(list.data, read) : undefined;
  });
  const sum = (ids: string[]) => ids.reduce((total, id) => total + (calls[id]?.count ?? 0), 0);
  return { calls, total: sum([projectId, ...others]), others: sum(others) };
}
