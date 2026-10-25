// A stand-in controller for the dashboard's tests: one project's records behind the routes the pages read, an
// event stream the test drives, and a log of every request. No real controller or model is involved.
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  ActivityPage,
  AttemptSummary,
  FinishedPage,
  FirstRunTemplates,
  InstructionsPage,
  LogEvent,
  PeopleSummary,
  RunRecord,
  SettledKind,
  SettledPage,
  Shell,
  StoryActivity,
  Task,
} from './api';
import { settled } from './studio-runs';

export class FakeSource {
  static all: FakeSource[] = [];
  // Each connection opens by saying where the controller is, as the real stream does; pages wait for it.
  static hello: { version: number; start: string } | null = { version: 1, start: 'start-a' };
  readonly listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
    const hello = FakeSource.hello;
    if (hello) setTimeout(() => !this.closed && this.emit('change', hello));
  }
  addEventListener(name: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(name, listener);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data?: unknown) {
    act(() => this.listeners.get(name)?.({ data: JSON.stringify(data ?? null) } as MessageEvent));
  }
}
export const latest = () => FakeSource.all.filter(source => !source.closed).at(-1)!;
export const createStream = (url: string) => new FakeSource(url) as unknown as EventSource;

export const shellFixture = (projectId = 'project-x'): Shell => ({
  project: { id: projectId, name: 'Project X' },
  projects: [
    { id: projectId, name: 'Project X' },
    { id: 'project-y', name: 'Project Y' },
  ],
  teams: [],
  workers: [{ id: 'W-1', displayName: 'Eli', team: 'Engineering' }],
  employeeDirectory: [],
  taskKinds: { general: { label: 'General task', cardLabel: 'Task' } },
  workflows: [{ id: 'workflow-1', name: 'Source checks and review', version: 3 }],
  paused: false,
  pipelineEnabled: true,
  quota: {},
  maxParallel: 2,
  leases: [],
  adapters: {},
  modelFreeProviders: [],
  autonomy: { policy: { enabled: true, revision: 1 } },
  organizationConfiguration: { taskKinds: ['studio-development:breakdown'] },
  runtime: { version: 'test' },
});

export const taskFixture = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  title: id,
  kind: 'general',
  status: 'ready',
  workerId: 'W-1',
  team: 'Engineering',
  dependencies: [],
  createdAt: '2026-10-21T20:00:00Z',
  maxSeconds: 600,
  maxAttempts: 3,
  brief: 'Fixture work.',
  acceptance: 'Fixture acceptance.',
  ...extra,
});

export interface Controller {
  shell: Shell;
  tasks: Task[];
  attempts: AttemptSummary[];
  runs: RunRecord[];
  finished: FinishedPage;
  // Later pages of finished runs, by the run they start after, and runs read on their own.
  olderRuns: Record<string, FinishedPage>;
  runItems: Record<string, FinishedPage['runs'][number]>;
  // Settled work by kind, each a list of pages the test lays out; the counts are the lists' lengths.
  settled: Record<SettledKind, Omit<SettledPage, 'counts'>[]>;
  logs: Record<string, LogEvent[]>;
  // Recorded files by attempt and path, as `<attempt>/<path>`.
  artifacts: Record<string, string>;
  // What an attempt's full record adds to its summary, by attempt.
  details: Record<string, Record<string, unknown>>;
  // Attempts' traces (item 21), by attempt; one without a trace answers as a controller without the route does.
  traces: Record<string, unknown>;
  instructions: InstructionsPage['instructions'];
  people: PeopleSummary;
  // Pages of recorded events, newest first; each page's `next` names the sequence the following one starts before.
  activity: ActivityPage[];
  // What happened to each task besides its agents' output, by task; none recorded reads as nothing yet.
  stories: Record<string, StoryActivity>;
  // Other projects' shells by ID, for a test that opens another project: their pages read no records yet.
  shells: Record<string, Shell>;
  // No projects yet's templates and signed-in CLIs (v1.0 item 24); none answers as a controller without the route.
  templates?: FirstRunTemplates;
  requests: { url: string; method: string; body?: unknown }[];
  // Answers a command; the default accepts it, and one that throws refuses it with the error's message. A
  // promise holds the answer until the test resolves it, or refuses the command when the test rejects it.
  command(url: string, method: string, body: unknown): unknown;
  reads(): string[];
}

const respond = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 400,
  json: async () => structuredClone(body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer,
});

// Installs the stand-in as fetch. Every route answers from the controller's current records, so a test changes
// a record and then emits the change that names it.
export function fakeController(projectId = 'project-x'): Controller {
  FakeSource.all = [];
  FakeSource.hello = { version: 1, start: 'start-a' };
  const controller: Controller = {
    shell: shellFixture(projectId),
    tasks: [],
    attempts: [],
    runs: [],
    finished: { runs: [], next: null },
    olderRuns: {},
    runItems: {},
    settled: { accepted: [], closed: [] },
    logs: {},
    artifacts: {},
    details: {},
    traces: {},
    instructions: {
      company: { scope: 'company', id: 'company', revision: 1, text: 'Company direction.', draft: null, history: [] },
      teams: {},
      employees: {},
    },
    people: { tasks: 0, accepted: { total: 0, workers: {}, teams: {} }, goals: {} },
    activity: [{ events: [], next: null }],
    stories: {},
    shells: {},
    requests: [],
    command: () => ({}),
    reads: () => controller.requests.filter(request => request.method === 'GET').map(request => request.url),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit = {}) => {
      const method = options.method ?? 'GET',
        body = options.body ? JSON.parse(String(options.body)) : undefined;
      controller.requests.push({ url, method, ...(body === undefined ? {} : { body }) });
      if (method !== 'GET') {
        try {
          return respond(await controller.command(url, method, body));
        } catch (error) {
          return respond({ error: (error as Error).message }, false);
        }
      }
      const path = url.split('?')[0]!;
      if (path === '/api/projects') return respond({ projects: controller.shell.projects });
      if (path === '/api/templates')
        return controller.templates
          ? respond(controller.templates)
          : respond({ error: 'Unknown controller route.' }, false);
      // Another project the test names reads its shell and no records.
      const [, other, page] = path.match(/^\/api\/projects\/([^/]+)\/([a-z]+)$/) ?? [],
        otherShell = other && other !== projectId ? controller.shells[decodeURIComponent(other)] : undefined;
      if (otherShell && page) {
        const records: Record<string, unknown> = {
          shell: otherShell,
          live: { tasks: [], attempts: [], runs: [] },
          runs: { runs: [], next: null },
          settled: { tasks: [], attempts: [], next: null, counts: { accepted: 0, closed: 0 } },
          people: { tasks: 0, accepted: { total: 0, workers: {}, teams: {} }, goals: {} },
          activity: { events: [], next: null },
        };
        if (page in records) return respond(records[page]);
      }
      if (path === `/api/projects/${projectId}/shell`) return respond(controller.shell);
      if (path === `/api/projects/${projectId}/live`) {
        // Unsettled work and every task of the runs the test names as open.
        const open = new Set(controller.runs.map(run => run.id)),
          tasks = controller.tasks.filter(
            task =>
              !settled(task, controller.attempts) ||
              open.has(String((task.workflowReference as { runId?: string } | undefined)?.runId)),
          ),
          ids = new Set(tasks.map(task => task.id));
        return respond({
          tasks,
          attempts: controller.attempts.filter(attempt => ids.has(attempt.taskId)),
          runs: controller.runs,
        });
      }
      if (path === `/api/projects/${projectId}/runs`) {
        const before = new URLSearchParams(url.split('?')[1] ?? '').get('before');
        return respond(before ? controller.olderRuns[before] : controller.finished);
      }
      if (path === `/api/projects/${projectId}/settled`) {
        const query = new URLSearchParams(url.split('?')[1] ?? ''),
          kind = query.get('kind') as SettledKind,
          counts = {
            accepted: controller.settled.accepted.reduce((sum, page) => sum + page.tasks.length, 0),
            closed: controller.settled.closed.reduce((sum, page) => sum + page.tasks.length, 0),
          };
        if (query.get('limit') === '0') return respond({ tasks: [], attempts: [], next: null, counts });
        const pages = controller.settled[kind],
          index = query.get('before') ? pages.findIndex(page => page.tasks.at(-1)?.id === query.get('before')) + 1 : 0,
          page = pages[index] ?? { tasks: [], attempts: [], next: null },
          // An employee's or a team's page reads only its own work.
          mine = (task: Task) =>
            (!query.get('workerId') || task.workerId === query.get('workerId')) &&
            (!query.get('team') || task.team === query.get('team'));
        return respond({ ...page, tasks: page.tasks.filter(mine), counts });
      }
      if (path === `/api/projects/${projectId}/instructions`) return respond({ instructions: controller.instructions });
      if (path === `/api/projects/${projectId}/people`) return respond(controller.people);
      if (path === `/api/projects/${projectId}/activity`) {
        const before = new URLSearchParams(url.split('?')[1] ?? '').get('before'),
          index = before ? controller.activity.findIndex(page => String(page.events.at(-1)?.seq) === before) + 1 : 0;
        return respond(controller.activity[index] ?? { events: [], next: null });
      }
      const run = path.match(new RegExp(`^/api/projects/${projectId}/runs/([^/]+)$`))?.[1];
      if (run) {
        const item = controller.runItems[decodeURIComponent(run)];
        return item ? respond(item) : respond({ error: 'Run not found.' }, false);
      }
      const story = path.match(/^\/api\/tasks\/([^/]+)\/activity$/)?.[1];
      if (story)
        return respond(controller.stories[decodeURIComponent(story)] ?? { events: [], idea: null, instructions: [] });
      const task = path.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
      if (task) {
        const record = controller.tasks.find(item => item.id === decodeURIComponent(task));
        return record
          ? respond({ task: record, attempts: controller.attempts.filter(attempt => attempt.taskId === record.id) })
          : respond({ error: 'Task not found.' }, false);
      }
      const artifact = path.match(/^\/api\/attempts\/([^/]+)\/artifact$/)?.[1];
      if (artifact) {
        const file = new URLSearchParams(url.split('?')[1] ?? '').get('path'),
          text = controller.artifacts[`${decodeURIComponent(artifact)}/${file}`];
        return text === undefined ? respond({ error: 'Artifact not found.' }, false) : respond(text);
      }
      // An attempt's full record: its summary with whatever the test adds, and its phase events.
      const detail = path.match(/^\/api\/attempts\/([^/]+)$/)?.[1];
      if (detail) {
        const id = decodeURIComponent(detail),
          summary = controller.attempts.find(attempt => attempt.id === id);
        return summary
          ? respond({ phaseEvents: [], ...summary, ...controller.details[id] })
          : respond({ error: 'Attempt not found.' }, false);
      }
      const trace = path.match(/^\/api\/attempts\/([^/]+)\/trace$/)?.[1];
      if (trace) {
        const record = controller.traces[decodeURIComponent(trace)];
        return record ? respond(record) : respond({ error: 'Unknown controller route.' }, false);
      }
      const logs = path.match(/^\/api\/attempts\/([^/]+)\/logs$/)?.[1];
      if (logs) {
        const events = controller.logs[decodeURIComponent(logs)] ?? [],
          query = new URLSearchParams(url.split('?')[1] ?? '');
        if (!query.has('limit')) return respond(events);
        // The whole log, a page at a time, up to the snapshot the first page names.
        const after = Number(query.get('after') ?? 0),
          limit = Number(query.get('limit')),
          snapshot = Number(query.get('snapshot') ?? events.at(-1)?.seq ?? 0),
          page = events.filter(event => event.seq > after && event.seq <= snapshot).slice(0, limit),
          last = page.at(-1)?.seq;
        return respond({
          events: page,
          total: events.filter(event => event.seq <= snapshot).length,
          snapshot,
          nextCursor: last !== undefined && last < snapshot ? last : null,
        });
      }
      return respond({ error: `Unexpected request ${url}` }, false);
    }),
  );
  return controller;
}
