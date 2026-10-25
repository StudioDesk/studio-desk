// The controller's records as the dashboard reads them (MP-026): one route per thing on screen. Records carry
// more fields than a page reads; the shared run rules (public/runs.js) read the rest.
import type { AgentLook } from './design/agent-kit.js';

export interface AttemptSummary {
  id: string;
  taskId: string;
  status: string;
  projectId?: string;
  provider?: string;
  workerId?: string;
  startedAt?: string;
  finishedAt?: string | null;
  acceptedAt?: string;
  error?: string;
  result?: { outcome?: string; summary?: string; issues?: string[] };
  executionTiming?: { durationMs: number | null; activeStart: string | null };
  candidateReviewVerdict?: string;
  workReviewVerdict?: string;
  sourceIntegration?: { state?: string; error?: string } | null;
  artifacts?: { path: string; hash: string; kind?: string }[];
  [field: string]: unknown;
}

export interface Task {
  id: string;
  title: string;
  kind: string;
  status: string;
  brief?: string;
  acceptance?: string;
  direction?: string;
  lastAttemptId?: string;
  acceptedAttemptId?: string;
  closed?: boolean | { reason?: string };
  workerId?: string;
  team?: string;
  dependencies?: string[];
  createdAt?: string;
  queued?: boolean;
  // A blocked task the controller holds itself (its turn after the story before it, a usage reset) and starts again
  // on its own: a wait, not a stop.
  controllerWait?: boolean;
  maxSeconds?: number;
  maxAttempts?: number;
  complexity?: number | null;
  sourceStage?: { version?: string; current?: string; phase?: string; [field: string]: unknown } | null;
  [field: string]: unknown;
}

export interface TaskPage {
  task: Task;
  attempts: AttemptSummary[];
}

export interface Project {
  id: string;
  name: string;
  goal?: string;
  direction?: string;
  legacy?: boolean;
  dispatchPaused?: boolean;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  // The palette color the director chose for the project's mark (frame.tsx projectPalette); none takes its place's.
  color?: string;
  // A project's own git repository and its profile, with the profile's revision; the controller's own source has
  // none recorded.
  source?: { root: string; profile: SourceProfile; revision?: number; updatedAt?: string };
}

// How the source pipeline works on one repository (src/connectors/source-profile.mjs): the folders and top-level
// files a snapshot covers, the file types stories may change, the names left to the director, the documents the
// breakdown and reviews read, where the tests live, the formatter integration applies and the snapshot limits.
export interface SourceProfile {
  id: string;
  directories: string[];
  files: string[];
  extensions: string[];
  protectedNames: string[];
  contextFiles: string[];
  tests: { directory: string; suffix: string };
  formatter: { package: string; args: string[] } | null;
  install?: 'npm-ci' | null;
  limits: { files: number; fileBytes: number; totalBytes: number };
}

// What adding a git repository would record (POST /api/projects/inspect-repository): its real path, branch and
// commit, the proposed profile, what a snapshot under it covers (null when it cannot be measured), how many test
// files it runs, and every problem that stops the repository being added. Nothing is recorded.
export interface RepositoryInspection {
  root: string;
  branch: string;
  head: string;
  profile: SourceProfile;
  files: number | null;
  bytes: number | null;
  testFiles: number;
  problems: string[];
}

// The folders inside a folder on this computer (POST /api/folders, src/connectors/folders.mjs), for Create a
// project's folder browser: the real path listed (the controller's home folder when no path is given), the folder
// one level up (null at a root), the trail from the root down, the drive roots on Windows (none elsewhere), and the
// folders inside by name, each marked when it holds a .git entry. Files, dot folders and folders that cannot be
// opened are left out, and `limited` says more folders were inside than the reply lists. Nothing is recorded.
export interface FolderListing {
  path: string;
  parent: string | null;
  trail: { name: string; path: string }[];
  drives: string[];
  folders: { name: string; path: string; repository: boolean }[];
  limited: boolean;
}

// The first run (GET /api/templates, v1.0 item 24): whether a project has ever existed in this data folder, the
// CLIs signed in on this computer (none listed when none is), whether git is found, and the templates bundled with
// the app, each with its default name, its files, who works on it (a face only when one was chosen) and its two
// suggested first ideas. The controller detects the CLIs and git again on each request, so Check again reads it
// again.
export interface TemplateMember {
  agentId: string;
  name: string;
  // "Planner", "plans", and what the agent does in this template, in a sentence.
  role: string;
  does: string;
  line: string;
  look: AgentLook | null;
}
export interface ProjectTemplate {
  id: string;
  kind: 'code' | 'writing';
  name: string;
  description: string;
  files: { path: string; bytes: number }[];
  team: TemplateMember[];
  needsGit: boolean;
  suggestions: string[];
  houseRules: string;
}
export interface FirstRunTemplates {
  firstRun: boolean;
  clis: { id: string; label: string }[];
  git: { found: boolean; version: string | null };
  /** Where a code project's candidate tests will run (v1.0 item 25). */
  testSandbox?: 'codex' | 'none';
  /** Where a sample's folder is made unless the director chooses another folder: the data folder's samples. */
  samples: string;
  templates: ProjectTemplate[];
}

// An employee's identity in the project, and the execution settings future attempts use.
export interface Execution {
  provider?: string;
  model?: string;
  effort?: string;
  mode?: string;
}
export interface Worker extends Execution {
  id: string;
  displayName?: string;
  jobTitle?: string;
  team?: string;
  teamId?: string;
  role?: string;
  responsibility?: string;
  enabled?: boolean;
  paused?: boolean;
  configVersion?: number;
  // The face the director chose (POST /api/workers/:id/look); without one, the agent kit's pick.
  look?: AgentLook;
  // The project an agent was made in, where alone it works (1.0.1); the starting agents have none and are shared.
  projectId?: string;
  // When it was deleted: it stays in the directory so the work it did keeps its name.
  deletedAt?: string;
}

export interface Team {
  id: string;
  name: string;
  mark?: string;
  purpose?: string;
  goal?: string;
  outcome?: string;
  leadId?: string | null;
  goalTaskIds?: string[];
}

export interface TaskKind {
  kind?: string;
  label?: string;
  cardLabel?: string;
  available?: boolean;
  creatable?: boolean;
  packId?: string;
  executionAdapter?: string;
  executionNotice?: string;
  scopeRequestLabel?: string;
  integrationLabel?: string;
  proposesWork?: boolean;
  requiredResources?: string[];
  operation?: {
    connector?: string;
    operation?: string;
    source?: string;
    inputContract?: string;
    outputContract?: string;
    configuration?: { categories?: string[] };
  };
}

// An execution adapter (a CLI or the Simulator) and what an employee may choose on it.
export interface Adapter {
  id: string;
  name: string;
  label?: string;
  available?: boolean;
  subscription?: boolean;
  quotaLabel?: string;
  workerSelectable?: boolean;
  capabilities?: string[];
  models?: { id: string; label: string; efforts?: string[]; defaultEffort?: string }[];
  efforts?: string[];
  modes?: string[];
}

export interface Workflow {
  id: string;
  name: string;
  version: number;
  description?: string;
  steps?: unknown[];
  budget?: { totalAttemptSeconds?: number };
  graph?: {
    nodes?: { key: string; title: string; kind?: string; role?: string; workerId?: string }[];
    edges?: { from: string; to: string }[];
  };
}

// What the policy does for one task type: each step waits for the director or is automatic.
export type Mode = 'director' | 'auto';
export interface KindModes {
  approve: Mode;
  accept: Mode;
  scope?: Mode;
  integrate?: Mode;
}
export interface AutonomyPolicy {
  enabled?: boolean;
  revision?: number;
  retries?: number;
  kinds?: Record<string, KindModes>;
  cycle?: { enabled?: boolean; [field: string]: unknown };
}

// Model, effort and mode for each tier and CLI, over the employees' own settings.
export type Tiers = Record<string, Record<string, Partial<Record<'model' | 'effort' | 'mode', string>>>>;
export interface Member {
  workerId: string;
  teamId: string;
  role?: string;
  responsibility?: string;
  roles?: string[];
}
export interface OrganizationConfiguration {
  revision?: number;
  inherited?: boolean;
  teams?: Team[];
  members?: Member[];
  taskKinds?: string[];
  kindOwners?: Record<string, string>;
  tiers?: Tiers;
}

// What every page of a project shares: no records, history or instruction text.
export interface Shell {
  project: Project;
  projects: Project[];
  workers: Worker[];
  employeeDirectory?: Worker[];
  teams?: Team[];
  company?: { name?: string; mission?: string; milestone?: string; outcome?: string; goalTaskIds?: string[] };
  taskKinds: Record<string, TaskKind>;
  kindOwners?: Record<string, string>;
  workflows: Workflow[];
  adapters?: Record<string, Adapter>;
  roles?: { id: string; label: string }[];
  operations?: {
    connectorId?: string;
    id?: string;
    capability?: string;
    inputContract?: string;
    outputContract?: string;
    scope?: string;
  }[];
  paused?: boolean;
  pipelineEnabled?: boolean;
  maxParallel?: number;
  quota?: Record<string, unknown>;
  leases?: { resource: string; attemptId: string; token: number }[];
  sprints?: { id: string; name: string }[];
  // Where the next candidate tests run: the director's choice, or Codex's sandbox where Codex CLI is installed.
  testSandbox?: 'codex' | 'none';
  // Approved commands for Claude Code employees, and whether auto mode is the default (v1.0 item 22).
  agentPermissions?: { auto?: boolean; commands?: string[] };
  organizationConfiguration?: OrganizationConfiguration | null;
  autonomy?: {
    policy?: AutonomyPolicy | null;
    recommended?: Record<string, KindModes>;
    pendingIntegration?: unknown;
    restart?: { reason?: string } | null;
    supervised?: boolean;
    selfHosted?: boolean;
  };
  runtime?: {
    version?: string;
    dataDirectory?: string;
    integrationGateway?: { reason?: string } | null;
  };
  [field: string]: unknown;
}

// What the organization pages count from the whole history: the project's tasks, accepted work by employee
// and by team, and the goal tasks of the company and its teams.
export interface PeopleSummary {
  tasks: number;
  accepted: { total: number; workers: Record<string, number>; teams: Record<string, number> };
  goals: Record<string, Task>;
}

// Recorded events without agent output, newest first; `next` is the sequence the following page starts before.
export interface ActivityPage {
  events: LogEvent[];
  next: number | null;
}

// What happened to one task besides its agents' output, oldest first: its recorded events, the idea its run
// started from, and the instructions published while it ran that its attempts follow.
export interface StoryActivity {
  events: LogEvent[];
  idea: { runId: string; brief: string; createdAt: string | null; files: string[] } | null;
  instructions: { scope: string; id: string; revision: number; note: string; publishedAt: string }[];
}

// One set of published instructions, its unpublished draft and the revisions before it.
export interface InstructionDoc {
  scope: string;
  id: string;
  revision: number;
  text: string;
  draft?: { text: string } | null;
  history: { revision: number; note: string; text: string }[];
}
export interface InstructionsPage {
  instructions: {
    company: InstructionDoc;
    teams: Record<string, InstructionDoc>;
    employees: Record<string, InstructionDoc>;
  };
}

export interface RunRecord {
  id: string;
  createdAt?: string;
  archive?: { archived?: boolean } | null;
  [field: string]: unknown;
}

// The live set: unsettled work, every task of a run with open work, their direct prerequisites, their
// attempt summaries and those runs.
export interface Live {
  tasks: Task[];
  attempts: AttemptSummary[];
  runs: RunRecord[];
}

// Finished runs, newest first, a page at a time; `next` names the run the following page starts after.
export interface FinishedPage {
  runs: { run: RunRecord; tasks: Task[]; attempts: AttemptSummary[] }[];
  next: string | null;
}

// Settled work for the board, newest finished first, a page at a time, with the counts of each kind.
export type SettledKind = 'accepted' | 'closed';
export interface SettledPage {
  tasks: Task[];
  attempts: AttemptSummary[];
  next: string | null;
  counts: Record<SettledKind, number>;
}

export interface LogEvent {
  seq: number;
  time: string;
  kind: string;
  message: string;
  task_id: string | null;
  attempt_id: string | null;
}

// What a change event names: the record's type and identity, and its project when it has one.
export interface Change {
  seq: number;
  type: string;
  id?: string | number;
  taskId?: string;
  attemptId?: string;
  kind?: string;
  projectId?: string | null;
}

export interface ChangeMessage {
  version: number;
  start: string;
  changes?: Change[];
  reload?: boolean;
}

const project = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;
const projectPath = (projectId: string, page: string) => `/api/projects/${encodeURIComponent(projectId)}/${page}`;
export const projectsUrl = '/api/projects';
export const templatesUrl = '/api/templates';
export const shellUrl = (projectId: string) => projectPath(projectId, 'shell');
export const liveUrl = (projectId: string) => projectPath(projectId, 'live');
export const finishedUrl = (projectId: string, before: string | null, limit = 10) =>
  `${projectPath(projectId, 'runs')}?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
// An employee's or a team's page reads only its own settled work.
export interface SettledFilter {
  workerId?: string;
  team?: string;
}
export const settledUrl = (
  projectId: string,
  kind: SettledKind,
  before: string | null,
  limit = 12,
  filter: SettledFilter = {},
) =>
  `${projectPath(projectId, 'settled')}?kind=${kind}&limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}${
    filter.workerId ? `&workerId=${encodeURIComponent(filter.workerId)}` : ''
  }${filter.team ? `&team=${encodeURIComponent(filter.team)}` : ''}`;
export const peopleUrl = (projectId: string) => projectPath(projectId, 'people');
export const activityUrl = (projectId: string, before: number | null) =>
  `${projectPath(projectId, 'activity')}${before ? `?before=${before}` : ''}`;
export const runUrl = (projectId: string, runId: string) =>
  `${projectPath(projectId, 'runs')}/${encodeURIComponent(runId)}`;
export const instructionsUrl = (projectId: string) => projectPath(projectId, 'instructions');
export const taskUrl = (projectId: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}?${project(projectId)}`;
export const storyActivityUrl = (projectId: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/activity?${project(projectId)}`;
export const logsUrl = (projectId: string, attemptId: string) =>
  `/api/attempts/${encodeURIComponent(attemptId)}/logs?${project(projectId)}`;
export const eventsUrl = (projectId: string, watch?: { attemptId: string; after: number }) =>
  `/api/events?${project(projectId)}${watch ? `&log=${encodeURIComponent(watch.attemptId)}&after=${watch.after}` : ''}`;
export const changesUrl = (projectId: string, after: number, start: string) =>
  `/api/changes?${project(projectId)}&after=${after}&start=${encodeURIComponent(start)}`;

export async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `The controller refused the request (${response.status}).`);
  return body as T;
}

// Commands carry this start's request token, as the current dashboard's do.
export async function send<T>(
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<T> {
  const token = document.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content ?? '';
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error || `The controller refused the request (${response.status}).`);
  return result as T;
}
