// A stand-in controller for the dashboard's tests: one project's records behind the routes the pages read, an
// event stream the test drives, and a log of every request. No real controller or model is involved.
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  ActivityPage,
  AttemptSummary,
  CommandRecords,
  FinishedPage,
  FirstRunTemplates,
  IdeaName,
  InstructionsPage,
  LibraryIndex,
  LibraryReader,
  LogEvent,
  PeopleSummary,
  ProjectArtifact,
  ReleaseOverview,
  RunRecord,
  SettledKind,
  SettledPage,
  Shell,
  Snapshot,
  StoryActivity,
  StoryPagesView,
  Task,
  TestRecordSummary,
  ToldLayer,
  ToldView,
  TryView,
  VisualView,
} from './api';
import type { BringBackTargets } from './bring-back';
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

// What `read` finds on the page in the render where `text` first shows, such as a command's toast: what changed with
// it reads changed, and what changes only in a later render reads as it was.
export const whenShown = <T>(text: string, read: () => T) =>
  new Promise<T>(resolve => {
    const observer = new MutationObserver(() => {
      if (!document.body.textContent?.includes(text)) return;
      observer.disconnect();
      resolve(read());
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  });

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

// What an agent is told as the controller's told view answers it (src/core/instructions.mjs toldView): every project's
// shared set, read-only here, then the project's (its text the stand-in's company instructions), the team's and the
// agent's own, each published at revision 1 with no draft, and the text they start its next attempt with. A rule's
// name is its document's bold opening, as src/core/rules.mjs reads it.
export function toldFixture(workerId = 'W-1', projectId = 'project-x'): ToldView {
  const set = (
    layer: ToldLayer['layer'],
    scope: ToldLayer['scope'],
    id: string,
    rules: ToldLayer['rules'],
  ): ToldLayer => ({
    layer,
    scope,
    id,
    projectId: layer === 'every-project' ? null : projectId,
    editable: layer !== 'every-project',
    revision: 1,
    publishedAt: '2026-10-21T20:00:00Z',
    readers: layer === 'every-project' ? null : [workerId],
    text: rules.map(rule => (rule.title ? `**${rule.title}.** ${rule.text}` : rule.text)).join('\n\n'),
    rules,
    draft: null,
  });
  const layers = [
    set('every-project', 'company', 'company', [
      { title: 'Stay local', text: 'Keep records, files and the dashboard on this computer.' },
    ]),
    set('project', 'company', 'company', [{ title: null, text: 'Company direction.' }]),
    set('team', 'team', 'engineering', [
      { title: 'Hand off what changed', text: 'Say which files changed and what you checked.' },
    ]),
    set('own', 'employee', workerId, [
      { title: 'Stay inside the story', text: 'Change only the files the story may change.' },
      { title: null, text: 'Ask the director when a choice is not yours to make.' },
    ]),
  ];
  const heading = (layer: ToldLayer) =>
    `# ${layer.projectId ? 'Project ' : ''}${layer.scope}: ${layer.id} (revision ${layer.revision})`;
  return {
    agent: { id: workerId, name: 'Eli', teamId: 'engineering', team: 'Engineering', role: 'Software engineer' },
    layers,
    receives: { text: layers.map(layer => `${heading(layer)}\n\n${layer.text}`).join('\n\n'), drafts: 0 },
  };
}

export interface Controller {
  shell: Shell;
  tasks: Task[];
  attempts: AttemptSummary[];
  runs: RunRecord[];
  // The finished ideas the live set names for its prerequisites from them; none sends no list.
  ideas?: IdeaName[];
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
  // Measured test runs' whole records, as `<attempt>/<run>` (run `attempt` or `merge`): the summary the record route
  // answers and the text its /text route sends. A run not listed answers as one the attempt did not measure does.
  testRecords: Record<string, { summary: TestRecordSummary; text?: string }>;
  instructions: InstructionsPage['instructions'];
  // What each agent is told, as rules (1.2 step 1), by agent: the told route answers it, and an agent not listed as
  // one the project does not hold (404). The default tells W-1 the four sets toldFixture lays out.
  told: Record<string, ToldView>;
  people: PeopleSummary;
  // Pages of recorded events, newest first; each page's `next` names the sequence the following one starts before.
  activity: ActivityPage[];
  // What happened to each task besides its agents' output, by task; none recorded reads as nothing yet.
  stories: Record<string, StoryActivity>;
  // Other projects' shells by ID, for a test that opens another project: their pages read no records yet.
  shells: Record<string, Shell>;
  // No projects yet's templates and signed-in CLIs (v1.0 item 24); none answers as a controller without the route.
  templates?: FirstRunTemplates;
  // The Releases page's records (1.1 step 6); none answers as a project without the source workflow.
  releases?: ReleaseOverview;
  // Where a landed story, by task, and an idea, by run, can be brought back to (1.1); none listed has no older line.
  bringBack: Record<string, BringBackTargets>;
  runBringBack: Record<string, BringBackTargets>;
  // The project's try copy as its try view reads it (1.2 step 7), and its Run's output as text; the default is a
  // project not tried yet, with nothing set and Run in the built-in sandbox.
  tryView: TryView;
  tryOutput: string;
  // The project's visual check as its view reads it (1.2 step 8); the default is a check that is off, at 1440 and
  // 390 px in both themes, with Edge found. And each story's pages by task: a story not listed names none, and they
  // may still change.
  visualView: VisualView;
  pages: Record<string, StoryPagesView>;
  // The project's accepted files as its Artifacts listing sends them, its library, each entry's readers by entry (an
  // entry not listed has none) and its snapshots (1.2 step 6); the defaults are a project with none of them yet.
  projectArtifacts: ProjectArtifact[];
  library: LibraryIndex;
  libraryReaders: Record<string, LibraryReader[]>;
  // Library revisions' text, as `<entry>/<revision>`, which the revision's route answers as plain text; a revision not
  // listed answers as one the library does not hold.
  libraryTexts: Record<string, string>;
  snapshots: Snapshot[];
  // The release an idea's words name, by the words; words not listed name none.
  requests: { url: string; method: string; body?: unknown }[];
  // Answers a command; the default accepts it, and one that throws refuses it with the error's message, with the
  // error's `status` (400 without one) and its `fields` beside the message, as src/server.mjs answers a refusal. A
  // promise holds the answer until the test resolves it, or refuses the command when the test rejects it.
  command(url: string, method: string, body: unknown): unknown;
  // What the controller answers a command with when the page asks for its records (src/server.mjs commandRecords):
  // a change for each task named, each with its own seq after the last one recorded, and each task's page from the
  // current records. A command changes the records first and answers `{ ...answer, records: records([...]) }`; the
  // stream's change event for the same command carries the same version, start and changes.
  records(taskIds: string[]): CommandRecords;
  reads(): string[];
}

const respond = (body: unknown, ok = true, status = ok ? 200 : 400) => ({
  ok,
  status,
  json: async () => structuredClone(body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)).buffer,
});

// Installs the stand-in as fetch. Every route answers from the controller's current records, so a test changes
// a record and then emits the change that names it.
export function fakeController(projectId = 'project-x'): Controller {
  FakeSource.all = [];
  FakeSource.hello = { version: 1, start: 'start-a' };
  // The newest change's seq, from where each connection's hello says the controller is.
  let version = FakeSource.hello.version;
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
    testRecords: {},
    instructions: {
      company: { scope: 'company', id: 'company', revision: 1, text: 'Company direction.', draft: null, history: [] },
      teams: {},
      employees: {},
    },
    told: { 'W-1': toldFixture('W-1', projectId) },
    people: { tasks: 0, accepted: { total: 0, workers: {}, teams: {} }, goals: {} },
    activity: [{ events: [], next: null }],
    stories: {},
    shells: {},
    bringBack: {},
    runBringBack: {},
    tryView: {
      settings: { start: null, address: null, folder: null, runIn: 'built-in', outsideConfirmedAt: null },
      runsIn: 'built-in',
      copy: null,
    },
    tryOutput: '',
    visualView: {
      settings: { enabled: false, widths: [1440, 390], themes: ['light', 'dark'], browser: null },
      browser: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      note: null,
      blocked: null,
    },
    pages: {},
    projectArtifacts: [],
    library: { entries: [], proposals: [] },
    libraryReaders: {},
    libraryTexts: {},
    snapshots: [],
    requests: [],
    command: () => ({}),
    records: taskIds => {
      const changes = taskIds.map(id => ({ seq: ++version, type: 'task', id, projectId }));
      return {
        projectId,
        version,
        start: FakeSource.hello?.start ?? 'start-a',
        changes,
        tasks: controller.tasks
          .filter(task => taskIds.includes(task.id))
          .map(task => ({ task, attempts: controller.attempts.filter(attempt => attempt.taskId === task.id) })),
      };
    },
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
          const { message, status, fields } = error as Error & { status?: number; fields?: Record<string, unknown> };
          return respond({ error: message, ...fields }, false, status || 400);
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
        // Unsettled work, every task of the runs the test names as open and their direct prerequisites, as the
        // controller's live set holds them.
        const open = new Set(controller.runs.map(run => run.id)),
          wanted = new Set(
            controller.tasks
              .filter(
                task =>
                  !settled(task, controller.attempts) ||
                  open.has(String((task.workflowReference as { runId?: string } | undefined)?.runId)),
              )
              .flatMap(task => [task.id, ...(task.dependencies ?? [])]),
          ),
          tasks = controller.tasks.filter(task => wanted.has(task.id)),
          ids = new Set(tasks.map(task => task.id));
        return respond({
          tasks,
          attempts: controller.attempts.filter(attempt => ids.has(attempt.taskId)),
          runs: controller.runs,
          ...(controller.ideas ? { ideas: controller.ideas } : {}),
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
      const toldBy = path.match(new RegExp(`^/api/projects/${projectId}/agents/([^/]+)/told$`))?.[1];
      if (toldBy) {
        const view = controller.told[decodeURIComponent(toldBy)];
        return view ? respond(view) : respond({ error: 'This agent is not in this project.' }, false, 404);
      }
      if (path === `/api/projects/${projectId}/try`) return respond(controller.tryView);
      if (path === `/api/projects/${projectId}/try/output`) return respond(controller.tryOutput);
      if (path === `/api/projects/${projectId}/visual-check`) return respond(controller.visualView);
      if (path === `/api/projects/${projectId}/artifacts`) return respond(controller.projectArtifacts);
      if (path === `/api/projects/${projectId}/library`) return respond(controller.library);
      if (path === `/api/projects/${projectId}/snapshots`) return respond(controller.snapshots);
      const readers = path.match(new RegExp(`^/api/projects/${projectId}/library/([^/]+)/readers$`))?.[1];
      if (readers) return respond(controller.libraryReaders[decodeURIComponent(readers)] ?? []);
      const [, revised, number] =
        path.match(new RegExp(`^/api/projects/${projectId}/library/([^/]+)/revisions/([0-9]+)$`)) ?? [];
      if (revised) {
        const text = controller.libraryTexts[`${decodeURIComponent(revised)}/${number}`];
        return text === undefined ? respond({ error: 'Library revision not found.' }, false, 404) : respond(text);
      }
      if (path === `/api/projects/${projectId}/releases`)
        return respond(
          controller.releases ?? { available: false, reason: 'Only a project on the source workflow has releases.' },
        );
      if (path === `/api/projects/${projectId}/activity`) {
        const before = new URLSearchParams(url.split('?')[1] ?? '').get('before'),
          index = before ? controller.activity.findIndex(page => String(page.events.at(-1)?.seq) === before) + 1 : 0;
        return respond(controller.activity[index] ?? { events: [], next: null });
      }
      const runBack = path.match(new RegExp(`^/api/projects/${projectId}/runs/([^/]+)/bring-back$`))?.[1];
      if (runBack) return respond(controller.runBringBack[decodeURIComponent(runBack)] ?? { lines: [] });
      const run = path.match(new RegExp(`^/api/projects/${projectId}/runs/([^/]+)$`))?.[1];
      if (run) {
        const item = controller.runItems[decodeURIComponent(run)];
        return item ? respond(item) : respond({ error: 'Run not found.' }, false);
      }
      const back = path.match(/^\/api\/tasks\/([^/]+)\/bring-back$/)?.[1];
      if (back) return respond(controller.bringBack[decodeURIComponent(back)] ?? { lines: [] });
      const pages = path.match(/^\/api\/tasks\/([^/]+)\/pages$/)?.[1];
      if (pages)
        return respond(
          controller.pages[decodeURIComponent(pages)] ?? { pages: [], changed: false, editable: true, reason: null },
        );
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
        const record = controller.traces[decodeURIComponent(trace)],
          after = new URLSearchParams(url.split('?')[1] ?? '').getAll('after');
        if (!record) return respond({ error: 'Unknown controller route.' }, false);
        // As the controller's route does, a read names at most one after, and it is a nonnegative integer.
        if (after.length > 1 || (after.length === 1 && !/^(0|[1-9][0-9]*)$/.test(after[0]!)))
          return respond({ error: 'after must be a single nonnegative integer.' }, false);
        return respond(record);
      }
      // A measured run's whole record: its summary, or with /text the text, when the run kept one.
      const [, measured, plain] = path.match(/^\/api\/attempts\/([^/]+)\/test-record(\/text)?$/) ?? [];
      if (measured) {
        const run = new URLSearchParams(url.split('?')[1] ?? '').get('run') ?? 'attempt',
          record = controller.testRecords[`${decodeURIComponent(measured)}/${run}`];
        if (!record) return respond({ error: 'This attempt ran no measured tests.' }, false);
        if (!plain) return respond(record.summary);
        return record.summary.recorded && record.text !== undefined
          ? respond(record.text)
          : respond({ error: 'This run has no whole record.' }, false);
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
