// The records a project's pages hold, and how each change reaches them (MP-026). Every page of a project shares
// its shell and its live set. A change to one task fetches that task alone and patches it into whatever holds
// it; the live set reloads only when work joins or leaves it, and finished runs reload when a run finishes or
// changes. Nothing is fetched for a task no page holds.
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  finishedUrl,
  getJSON,
  liveUrl,
  peopleUrl,
  settledUrl,
  shellUrl,
  taskUrl,
  type ChangeMessage,
  type FinishedPage,
  type Live,
  type PeopleSummary,
  type SettledKind,
  type SettledFilter,
  type SettledPage,
  type Shell,
  type TaskPage,
} from './api';
import { useStreamReady } from './stream-context';
import { settled, type StudioState } from './studio-runs';

// Query names start with the project, so a reload refreshes only that project's records.
export const queryKeys = {
  task: (projectId: string, taskId: string) => [projectId, 'task', taskId] as const,
  attempt: (projectId: string, attemptId: string) => [projectId, 'attempt', attemptId] as const,
  shell: (projectId: string) => [projectId, 'shell'] as const,
  instructions: (projectId: string) => [projectId, 'instructions'] as const,
  live: (projectId: string) => [projectId, 'live'] as const,
  finished: (projectId: string) => [projectId, 'finished'] as const,
  run: (projectId: string, runId: string) => [projectId, 'run', runId] as const,
  settled: (projectId: string, kind: SettledKind, filter: SettledFilter = {}) =>
    [projectId, 'settled', kind, filter] as const,
  people: (projectId: string) => [projectId, 'people'] as const,
  activity: (projectId: string) => [projectId, 'activity'] as const,
  story: (projectId: string, taskId: string) => [projectId, 'story', taskId] as const,
  settledCounts: (projectId: string) => [projectId, 'settled', 'counts'] as const,
};

const taskTypes = new Set(['task', 'attempt', 'event']);
export type RunItem = FinishedPage['runs'][number];

// One task's record and attempts in place of the ones the live set holds.
function patched(live: Live, page: TaskPage): Live {
  const id = page.task.id,
    fresh = new Map(page.attempts.map(attempt => [attempt.id, attempt])),
    attempts = live.attempts
      .filter(attempt => attempt.taskId !== id || fresh.has(attempt.id))
      .map(attempt => {
        const next = fresh.get(attempt.id);
        fresh.delete(attempt.id);
        return next ?? attempt;
      });
  return {
    ...live,
    tasks: live.tasks.map(task => (task.id === id ? page.task : task)),
    attempts: [...attempts, ...fresh.values()],
  };
}

export class RecordSync {
  private readonly client: QueryClient;
  private readonly projectId: string;
  private readonly fetchJSON: typeof getJSON;
  private readonly tickets = new Map<string, number>();
  private counter = 0;
  private reloading: Promise<void> | null = null;
  private again = false;

  constructor(client: QueryClient, projectId: string, fetchJSON: typeof getJSON = getJSON) {
    this.client = client;
    this.projectId = projectId;
    this.fetchJSON = fetchJSON;
  }

  async apply(message: ChangeMessage) {
    const { client, projectId } = this;
    if (message.reload) return void (await client.invalidateQueries({ queryKey: [projectId] }));
    const tasks = new Set<string>();
    let runs = false,
      shell = false,
      events = false;
    for (const change of message.changes ?? []) {
      const taskId = change.type === 'task' && change.id !== undefined ? String(change.id) : change.taskId;
      if (change.type === 'event') events = true;
      if (taskTypes.has(change.type)) {
        if (taskId) tasks.add(taskId);
      } else if (change.type === 'run') runs = true;
      else shell = true;
    }
    const work: Promise<unknown>[] = [];
    // The organization pages' counts and the activity log refresh only while a page shows them.
    if (tasks.size) work.push(client.invalidateQueries({ queryKey: queryKeys.people(projectId) }));
    // An attempt's full record changes with the attempt and with each phase it records.
    for (const change of message.changes ?? []) {
      const attemptId =
        change.type === 'attempt'
          ? change.id
          : change.type === 'event' && change.kind === 'phase'
            ? change.attemptId
            : null;
      if (attemptId) work.push(client.invalidateQueries({ queryKey: queryKeys.attempt(projectId, String(attemptId)) }));
    }
    if (events) work.push(client.invalidateQueries({ queryKey: queryKeys.activity(projectId) }));
    // A story's Activity reads its task's events, but not its phases, and the instructions published while it ran.
    for (const change of message.changes ?? [])
      if (change.type === 'event' && change.taskId && change.kind !== 'phase')
        work.push(client.invalidateQueries({ queryKey: queryKeys.story(projectId, change.taskId) }));
    // Instruction texts change with the organization records the shell holds; only an open page reads them.
    if (shell)
      work.push(
        client.invalidateQueries({ queryKey: queryKeys.shell(projectId) }),
        client.invalidateQueries({ queryKey: queryKeys.instructions(projectId) }),
        client.invalidateQueries({ queryKey: [projectId, 'story'] }),
      );
    if (runs)
      work.push(
        this.reloadLive(),
        client.invalidateQueries({ queryKey: queryKeys.finished(projectId) }),
        client.invalidateQueries({ queryKey: [projectId, 'run'] }),
      );
    for (const id of tasks) work.push(this.refreshTask(id, !runs));
    await Promise.all(work);
  }

  // Fetches one task when a page holds it, or when the live set may need it, and patches it in. The newest
  // request for a task wins.
  private async refreshTask(id: string, patchLive: boolean) {
    const { client, projectId } = this,
      key = queryKeys.task(projectId, id),
      shown = client.getQueryData(key) !== undefined,
      live = patchLive && client.getQueryData<Live>(queryKeys.live(projectId)) !== undefined;
    if (!shown && !live && !this.inFinished(id) && !this.inRun(id) && !this.inSettled(id)) return;
    const ticket = ++this.counter;
    this.tickets.set(id, ticket);
    let page: TaskPage;
    try {
      page = await this.fetchJSON<TaskPage>(taskUrl(projectId, id));
    } catch {
      if (this.tickets.get(id) !== ticket) return;
      await Promise.all([client.invalidateQueries({ queryKey: key }), live ? this.reloadLive() : null]);
      return;
    }
    if (this.tickets.get(id) !== ticket) return;
    if (shown) client.setQueryData(key, page);
    if (this.inFinished(id)) void client.invalidateQueries({ queryKey: queryKeys.finished(projectId) });
    if (this.inSettled(id)) void client.invalidateQueries({ queryKey: [projectId, 'settled'] });
    for (const [key, item] of client.getQueriesData<RunItem>({ queryKey: [projectId, 'run'] }))
      if (item?.tasks.some(task => task.id === id)) void client.invalidateQueries({ queryKey: key, exact: true });
    if (!live) return;
    // A reload in flight may have read the task before this change; read the set once more after it.
    if (this.reloading) return void (this.again = true);
    const current = client.getQueryData<Live>(queryKeys.live(projectId));
    if (!current) return;
    const before = current.tasks.find(task => task.id === id),
      now = settled(page.task, page.attempts);
    // Work joining the set, or settling (which may finish its run), changes what the set holds.
    if (before ? settled(before, current.attempts) !== now : !now) {
      void client.invalidateQueries({ queryKey: [projectId, 'settled'] });
      return this.reloadLive();
    }
    if (before) client.setQueryData(queryKeys.live(projectId), patched(current, page));
  }

  private inFinished(id: string) {
    return this.client
      .getQueriesData<InfiniteData<FinishedPage>>({ queryKey: queryKeys.finished(this.projectId) })
      .some(([, data]) => data?.pages.some(page => page.runs.some(run => run.tasks.some(task => task.id === id))));
  }

  // Whether a page of settled work holds the task.
  private inSettled(id: string) {
    return this.client
      .getQueriesData<InfiniteData<SettledPage>>({ queryKey: [this.projectId, 'settled'] })
      .some(([, data]) => data?.pages?.some(page => page.tasks.some(task => task.id === id)));
  }

  // Whether a run read on its own holds the task.
  private inRun(id: string) {
    return this.client
      .getQueriesData<RunItem>({ queryKey: [this.projectId, 'run'] })
      .some(([, item]) => item?.tasks.some(task => task.id === id));
  }

  private reloadLive() {
    if (this.reloading) {
      this.again = true;
      return this.reloading;
    }
    const key = queryKeys.live(this.projectId);
    this.reloading = (async () => {
      try {
        do {
          this.again = false;
          const before = this.client.getQueryData<Live>(key)?.runs.map(run => run.id) ?? [];
          await this.client.invalidateQueries({ queryKey: key });
          const after = new Set(this.client.getQueryData<Live>(key)?.runs.map(run => run.id) ?? []);
          if (before.some(id => !after.has(id)))
            await this.client.invalidateQueries({ queryKey: queryKeys.finished(this.projectId) });
        } while (this.again);
      } finally {
        this.reloading = null;
      }
    })();
    return this.reloading;
  }
}

export function useShell(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.shell(projectId),
    queryFn: ({ signal }) => getJSON<Shell>(shellUrl(projectId), signal),
  });
}

export function useLive(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.live(projectId),
    queryFn: ({ signal }) => getJSON<Live>(liveUrl(projectId), signal),
  });
}

// Finished runs, newest first, `size` at a time. Their records are large (a real page of ten weighed 715 KB
// before compression), so Home reads only the few it lists and Runs pages through the rest.
export function useFinished(projectId: string, size: number) {
  return useInfiniteQuery({
    enabled: useStreamReady(),
    queryKey: [...queryKeys.finished(projectId), size],
    queryFn: ({ signal, pageParam }) => getJSON<FinishedPage>(finishedUrl(projectId, pageParam, size), signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next,
  });
}

// How much settled work there is of each kind, for a folded column.
export function useSettledCounts(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.settledCounts(projectId),
    queryFn: ({ signal }) => getJSON<SettledPage>(settledUrl(projectId, 'accepted', null, 0), signal),
    select: page => page.counts,
  });
}

// Settled work of one kind, a page at a time, read only while it is shown; an employee's or a team's page
// reads only its own.
export function useSettled(projectId: string, kind: SettledKind, shown: boolean, filter: SettledFilter = {}) {
  return useInfiniteQuery({
    enabled: useStreamReady() && shown,
    queryKey: queryKeys.settled(projectId, kind, filter),
    queryFn: ({ signal, pageParam }) =>
      getJSON<SettledPage>(settledUrl(projectId, kind, pageParam, 12, filter), signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next,
  });
}

// The shell with the live set, shaped as the shared run rules read a project.
export function useStudio(projectId: string) {
  const shell = useShell(projectId),
    live = useLive(projectId);
  const state = useMemo<StudioState | null>(
    () => (shell.data && live.data ? { ...shell.data, ...live.data } : null),
    [shell.data, live.data],
  );
  return { state, error: shell.error ?? live.error, shell: shell.data };
}

// Finished runs as the shared rules read them: the shell with every loaded page's records.
export function finishedState(shell: Shell, pages: FinishedPage[]): StudioState {
  const items = pages.flatMap(page => page.runs);
  return {
    ...shell,
    tasks: items.flatMap(item => item.tasks),
    attempts: items.flatMap(item => item.attempts),
    runs: items.map(item => item.run),
  };
}

// Each employee's and team's accepted work and the goal tasks, for the organization pages.
export function usePeople(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.people(projectId),
    queryFn: ({ signal }) => getJSON<PeopleSummary>(peopleUrl(projectId), signal),
  });
}
