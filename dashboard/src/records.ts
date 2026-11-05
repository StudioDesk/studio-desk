// The records a project's pages hold, and how each change reaches them (MP-026). Every page of a project shares
// its shell and its live set. A change to one task fetches that task alone and patches it into whatever holds
// it; the live set reloads only when work joins or leaves it, and finished runs reload when a run finishes or
// changes. Nothing is fetched for a task no page holds. A command's answer carries the pages of the tasks it
// changed, which go in at once without a read. The controller answers the live set a page at a time; the records
// read every page and hold them as one set (readLive).
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  callsUrl,
  finishedUrl,
  getJSON,
  liveUrl,
  peopleUrl,
  settledUrl,
  shellUrl,
  taskUrl,
  type Change,
  type ChangeMessage,
  type CommandRecords,
  type DirectorCall,
  type DirectorCalls,
  type DirectorTaskCall,
  type FinishedPage,
  type IdeaName,
  type Live,
  type PeopleSummary,
  type ReleaseOverview,
  type RunRecord,
  type SettledKind,
  type SettledFilter,
  type SettledPage,
  type Shell,
  type TaskPage,
  type TestRecordRun,
} from './api';
import { useStreamReady } from './stream-context';
import {
  explain,
  isResume,
  settled,
  type HomeItem,
  type NeedsItem,
  type RunStory,
  type StudioState,
} from './studio-runs';

// Query names start with the project, so a reload refreshes only that project's records.
export const queryKeys = {
  task: (projectId: string, taskId: string) => [projectId, 'task', taskId] as const,
  attempt: (projectId: string, attemptId: string) => [projectId, 'attempt', attemptId] as const,
  // A measured test run's whole record: its summary, and with `text` its whole output.
  testRecord: (projectId: string, attemptId: string, run: TestRecordRun, text = false) =>
    [projectId, 'test-record', attemptId, run, text ? 'text' : 'summary'] as const,
  shell: (projectId: string) => [projectId, 'shell'] as const,
  instructions: (projectId: string) => [projectId, 'instructions'] as const,
  // Under the instructions, so whatever reads them again reads what each agent is told again too.
  told: (projectId: string, workerId: string) => [projectId, 'instructions', 'told', workerId] as const,
  live: (projectId: string) => [projectId, 'live'] as const,
  finished: (projectId: string) => [projectId, 'finished'] as const,
  run: (projectId: string, runId: string) => [projectId, 'run', runId] as const,
  settled: (projectId: string, kind: SettledKind, filter: SettledFilter = {}) =>
    [projectId, 'settled', kind, filter] as const,
  people: (projectId: string) => [projectId, 'people'] as const,
  activity: (projectId: string) => [projectId, 'activity'] as const,
  story: (projectId: string, taskId: string) => [projectId, 'story', taskId] as const,
  settledCounts: (projectId: string) => [projectId, 'settled', 'counts'] as const,
  // The project's release lines and milestones, for the Releases page and every release chip.
  releases: (projectId: string) => [projectId, 'releases'] as const,
  // What needs the director now, as the controller lists it (GET /api/projects/<id>/calls).
  calls: (projectId: string) => [projectId, 'calls'] as const,
};

const taskTypes = new Set(['task', 'attempt', 'event']);
export type RunItem = FinishedPage['runs'][number];

// The tasks the project's releases name: each milestone's stories, those moved in or out of it, and its release notes.
function releaseTasks(overview?: ReleaseOverview) {
  const ids = new Set<string>();
  for (const milestone of overview?.milestones ?? []) {
    for (const idea of milestone.ideas) for (const story of [...idea.stories, ...idea.movedOut]) ids.add(story.id);
    for (const story of milestone.movedIn) ids.add(story.id);
    if (milestone.release?.notesTaskId) ids.add(milestone.release.notesTaskId);
  }
  return ids;
}

// One task's record and attempts in place of the ones the live set holds, or added to it.
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
    tasks: live.tasks.some(task => task.id === id)
      ? live.tasks.map(task => (task.id === id ? page.task : task))
      : [...live.tasks, page.task],
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
    if (message.reload) return void (await this.client.invalidateQueries({ queryKey: [this.projectId] }));
    const changes = message.changes ?? [];
    // The controller's list of calls is read again with every change the stream reports: those that refresh the live
    // set, and the settings and usage holds the shell holds. A read under way is dropped for one after the change. A
    // command's answer leaves it to the page that sent the command and to the stream's message for the same change.
    await Promise.all([
      changes.length ? this.client.invalidateQueries({ queryKey: queryKeys.calls(this.projectId) }) : null,
      this.changed(changes),
    ]);
  }

  // A command's answer names what it changed as the stream's message for it will, with the page of each task it
  // names (api.ts onRecords). Each supplied page goes in at once in place of a read, and every read the message would
  // start starts now; the stream's message confirms them afterwards. Another project's answer changes nothing.
  async answer(records: CommandRecords) {
    if (records.projectId !== this.projectId) return;
    if (records.reload) return void (await this.client.invalidateQueries({ queryKey: [this.projectId] }));
    await this.changed(records.changes ?? [], records.tasks ?? []);
  }

  private async changed(changes: Change[], supplied: TaskPage[] = []) {
    const { client, projectId } = this;
    const given = new Set(supplied.map(page => page.task.id)),
      read = new Set<string>();
    // The tasks whose own records changed, as opposed to their attempts' or events'.
    const tasks = new Set(given);
    let runs = false,
      shell = false,
      events = false;
    for (const change of changes) {
      const taskId = change.type === 'task' && change.id !== undefined ? String(change.id) : change.taskId;
      if (change.type === 'event') events = true;
      if (change.type === 'task' && taskId) tasks.add(taskId);
      if (taskTypes.has(change.type)) {
        if (taskId && !given.has(taskId)) read.add(taskId);
      } else if (change.type === 'run') runs = true;
      else shell = true;
    }
    const work: Promise<unknown>[] = [];
    // Supplied tasks go in before this answer starts any read, so only a reload already reading can predate them;
    // one reload of the live set confirms them, as it does a run change.
    let reload = false;
    for (const page of supplied) reload = this.place(page) || reload;
    // The organization pages' counts and the activity log refresh only while a page shows them.
    if (given.size || read.size) work.push(client.invalidateQueries({ queryKey: queryKeys.people(projectId) }));
    // An attempt's full record changes with the attempt and with each phase it records.
    for (const change of changes) {
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
    for (const change of changes)
      if (change.type === 'event' && change.taskId && change.kind !== 'phase')
        work.push(client.invalidateQueries({ queryKey: queryKeys.story(projectId, change.taskId) }));
    // Instruction texts change with the organization records the shell holds; only an open page reads them.
    if (shell)
      work.push(
        client.invalidateQueries({ queryKey: queryKeys.shell(projectId) }),
        client.invalidateQueries({ queryKey: queryKeys.instructions(projectId) }),
        client.invalidateQueries({ queryKey: [projectId, 'story'] }),
      );
    // The releases follow their milestones and lines (settings and projects), the ideas sent to them and the stories
    // they name. Reading them reads git, so an event or an attempt alone, such as each phase an attempt logs, leaves
    // them, and so does a task they do not name, as nothing is fetched for a task no page holds.
    const named = releaseTasks(client.getQueryData<ReleaseOverview>(queryKeys.releases(projectId)));
    if (shell || runs || [...tasks].some(id => named.has(id)))
      work.push(client.invalidateQueries({ queryKey: queryKeys.releases(projectId) }));
    if (runs || reload) work.push(this.reloadLive());
    if (runs)
      work.push(
        client.invalidateQueries({ queryKey: queryKeys.finished(projectId) }),
        client.invalidateQueries({ queryKey: [projectId, 'run'] }),
      );
    for (const id of read) work.push(this.refreshTask(id, !runs));
    await Promise.all(work);
  }

  // Puts a task's supplied page wherever a page holds it, as a read of it would, and counts it as the task's newest
  // read; the lists it is in read again. The live set takes it at once, joining or settling included (settled work
  // stays until the confirming reload drops it). Returns whether the live set must be read again: work joined or
  // settled, or a reload already reading may have read the task before this change.
  private place(page: TaskPage) {
    const { client, projectId } = this,
      id = page.task.id,
      key = queryKeys.task(projectId, id);
    this.tickets.set(id, ++this.counter);
    if (client.getQueryData(key) !== undefined) client.setQueryData(key, page);
    this.confirm(id);
    const current = client.getQueryData<Live>(queryKeys.live(projectId));
    if (!current) return false;
    const before = current.tasks.find(task => task.id === id),
      now = settled(page.task, page.attempts);
    // A settled task the set does not hold stays out of it.
    if (!before && now) return false;
    client.setQueryData(queryKeys.live(projectId), patched(current, page));
    if (before && settled(before, current.attempts) === now) return this.reloading !== null;
    void client.invalidateQueries({ queryKey: [projectId, 'settled'] });
    return true;
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
    this.confirm(id);
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

  // Starts the reads of the lists that hold a changed task: finished runs, settled work and runs read on their own.
  private confirm(id: string) {
    const { client, projectId } = this;
    if (this.inFinished(id)) void client.invalidateQueries({ queryKey: queryKeys.finished(projectId) });
    if (this.inSettled(id)) void client.invalidateQueries({ queryKey: [projectId, 'settled'] });
    for (const [key, item] of client.getQueriesData<RunItem>({ queryKey: [projectId, 'run'] }))
      if (item?.tasks.some(task => task.id === id)) void client.invalidateQueries({ queryKey: key, exact: true });
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

// Newest first by when it was made, as the controller lists runs and ideas (src/core/graph.mjs projectRuns); equal
// times keep the order they were read in.
const newestFirst = <T extends { createdAt?: string }>(items: T[]) =>
  items.sort((a, b) => {
    const one = a.createdAt ?? '',
      other = b.createdAt ?? '';
    return one < other ? 1 : one > other ? -1 : 0;
  });

// The live set's pages held as one, as the controller answered it whole before it came in pages: every page's tasks
// and attempts in the order read, each open run once, and each finished idea once with its tasks from every page. It
// reflects the change sequence of its first page, the earliest, so a reader resumes from there and misses nothing.
export function joinLive(pages: Live[]): Live {
  if (pages.length === 1) return pages[0]!;
  const runs = new Map<string, RunRecord>(),
    ideas = new Map<string, IdeaName>();
  for (const page of pages) {
    for (const run of page.runs) if (!runs.has(run.id)) runs.set(run.id, run);
    for (const idea of page.ideas ?? []) {
      const held = ideas.get(idea.id);
      ideas.set(idea.id, held ? { ...held, taskIds: [...held.taskIds, ...idea.taskIds] } : idea);
    }
  }
  const versions = pages.map(page => page.version).filter((version): version is number => version !== undefined);
  return {
    tasks: pages.flatMap(page => page.tasks),
    attempts: pages.flatMap(page => page.attempts),
    runs: newestFirst([...runs.values()]),
    ideas: newestFirst([...ideas.values()]),
    next: null,
    ...(versions.length ? { version: Math.min(...versions) } : {}),
  };
}

// Reads the live set a page at a time, the next page while one says next, and holds them as one. A page whose cursor
// settled out of the set while the pages were read is refused (404); the set is read again from its first page, twice
// at most.
export async function readLive(projectId: string, signal?: AbortSignal, fetchJSON: typeof getJSON = getJSON) {
  for (let tries = 0; ; tries++) {
    const pages: Live[] = [],
      seen = new Set<string>();
    let before: string | null = null;
    try {
      do {
        const page: Live = await fetchJSON<Live>(liveUrl(projectId, before), signal);
        pages.push(page);
        before = page.next ?? null;
        if (before !== null && seen.has(before)) throw new Error('The open work repeated a page.');
        if (before !== null) seen.add(before);
      } while (before !== null);
    } catch (error) {
      if (pages.length && tries < 2 && !signal?.aborted) continue;
      throw error;
    }
    return joinLive(pages);
  }
}

export function useLive(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.live(projectId),
    queryFn: ({ signal }) => readLive(projectId, signal),
  });
}

// What needs the director now in the project, as the controller lists it (GET /api/projects/<id>/calls), in its
// order. It is read again with every change the project's stream reports and every command's answer (RecordSync).
export function useCalls(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.calls(projectId),
    queryFn: ({ signal }) => getJSON<DirectorCalls>(callsUrl(projectId), signal),
  });
}

// A call's name on a page, served or worked out from the records: its task, its idea's cleanup, its CLI's hold or its
// project's resume.
export function callKey(call: DirectorCall | HomeItem) {
  if ('type' in call)
    return call.type === 'hold'
      ? `hold:${call.provider}`
      : call.type === 'resume'
        ? `resume:${call.projectId}`
        : call.type === 'cleanup'
          ? `cleanup:${call.runId}`
          : call.taskId;
  if ('members' in call) return `cleanup:${call.run.id}`;
  if (isResume(call)) return `resume:${call.projectId}`;
  return 'provider' in call ? `hold:${call.provider}` : call.taskId;
}

// A served task's call as the pages' cards read it: the served words and attempt, with the refused commands and the
// idea the page's own records hold.
function needsItem(call: DirectorTaskCall, state: StudioState, stories: RunStory[], cleanup = false) {
  const task = state.tasks.find(record => record.id === call.taskId),
    commands = task && call.kind === 'command-request' ? explain(task, state).commands : undefined,
    run = !cleanup && call.runId ? stories.find(story => story.id === call.runId) : undefined;
  const item: NeedsItem & { run?: RunStory } = {
    taskId: call.taskId,
    kind: call.kind,
    reason: call.reason,
    details: call.details,
    next: call.next,
    action: call.action,
    requiresDirector: true,
    text: call.reason,
    cleanup,
    canClose: call.canClose,
    ...(call.attemptId ? { attemptId: call.attemptId } : {}),
    ...(commands ? { commands } : {}),
    ...(run ? { run } : {}),
  };
  return item;
}

// The served calls, in the served order, as the items the pages draw: each task's call joined with the task, attempts
// and idea the records hold, a cleanup with its members and its idea, a hold with its CLI, and a project's resume with
// the work waiting only for it. A cleanup whose idea
// the records do not hold has nothing to draw it by and is left out.
export function servedItems(calls: DirectorCall[], state: StudioState, stories: RunStory[]): HomeItem[] {
  return calls.flatMap((call): HomeItem[] => {
    if (call.type === 'hold')
      return [
        {
          kind: 'subscription-hold',
          provider: call.provider,
          label: call.label,
          resetAt: null,
          resetTime: null,
          taskIds: call.taskIds,
          reason: call.reason,
          next: call.next,
          action: call.action,
          requiresDirector: true,
        },
      ];
    if (call.type === 'resume')
      return [
        {
          kind: 'project-resume',
          projectId: call.projectId,
          taskIds: call.taskIds,
          reason: call.reason,
          next: call.next,
          action: call.action,
          requiresDirector: true,
        },
      ];
    if (call.type === 'cleanup') {
      const run = stories.find(story => story.id === call.runId);
      if (!run) return [];
      return [
        {
          run,
          members: call.members.map(member => needsItem(member, state, stories, true)),
          taskIds: call.taskIds,
          requiresDirector: true,
        },
      ];
    }
    return [needsItem(call, state, stories)];
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
