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
  // What stopped an integration: the files that conflicted, or what landed after the change was tested when it fails
  // only merged onto that (the stories that landed, and every commit, so the rest were made by hand).
  sourceIntegration?: {
    state?: string;
    error?: string;
    verification?: { conflicts?: string[]; landedSince?: { commits: number; stories: string[] } };
  } | null;
  // A fix integrated on an older line, carried to each newer one (1.1 step 4), or brought back to older ones by the
  // director (`back`), with the stories whose carry to the same line it waits for (`after`).
  sourceCarries?: {
    line: string;
    state: string;
    back?: boolean;
    after?: string[];
    approved?: boolean;
    storyId?: string;
    commit?: string;
    reason?: string;
    error?: string;
  }[];
  artifacts?: { path: string; hash: string; kind?: string }[];
  // A question the agent stopped to ask the director (1.2 step 2), or why its question could not be read.
  question?: {
    ask?: string;
    why?: string;
    options?: { label: string; detail?: string }[];
    recommended?: number | null;
    choice?: string;
    topics?: string[];
    problem?: string;
  };
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
  // The release a source story is for, once the director moved it (1.1); otherwise its idea's.
  release?: { milestoneId?: string; version: string; line?: string; by?: { type?: string } };
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
  // The build that runs before the tests, a program and its arguments (1.1); the dialog keeps it as recorded.
  build?: string[] | null;
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
// Where candidate tests run (v1.0 item 20): the built-in sandbox (1.0.1), or none by the director's choice.
export type TestSandbox = 'built-in' | 'none';
// The built-in sandbox on this computer (src/adapters/built-in-sandbox.mjs): its one-time setup asks Windows for
// an administrator, or installs Linux's packages, and macOS needs none; `missing` means the packages are not
// installed, `unsupported` that the runtime has no sandbox for this system.
export interface BuiltInSandbox {
  state: 'ready' | 'not-set-up' | 'outdated' | 'missing' | 'unsupported';
  setup?: { state: 'running' | 'failed'; startedAt?: string; exitCode?: number; output?: string };
  /** On Linux, not set up: the packages it needs, the command that installs them (null when no known package
   *  manager is found), and whether Set up can show the system's password prompt itself. */
  needs?: string[];
  command?: string | null;
  prompt?: boolean;
}
export interface FirstRunTemplates {
  firstRun: boolean;
  clis: { id: string; label: string }[];
  git: { found: boolean; version: string | null };
  /** Where a code project's candidate tests will run (v1.0 item 25). */
  testSandbox?: TestSandbox;
  builtInSandbox?: BuiltInSandbox;
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
  // Where the next candidate tests run (the built-in sandbox unless the director chose none) and where the
  // built-in sandbox stands on this computer.
  testSandbox?: TestSandbox;
  builtInSandbox?: BuiltInSandbox;
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

// What an agent is told, as rules (1.2 step 1, src/core/rules.mjs): each paragraph of a document is one rule, named by
// the bold words it opens with, or with no name (null) when it opens without them.
export interface Rule {
  title: string | null;
  text: string;
}
// One document an agent reads, in the order its attempts read them (src/core/instructions.mjs toldView): every
// project's shared document (never edited from a project, read by every project: `readers` null), the project's, its
// team's and its own. `draft.current` says the draft was saved on the published revision, so it may be published.
export interface ToldLayer {
  layer: 'every-project' | 'project' | 'team' | 'own';
  scope: 'company' | 'team' | 'employee';
  id: string;
  projectId: string | null;
  editable: boolean;
  revision: number;
  publishedAt: string | null;
  readers: string[] | null;
  text: string;
  rules: Rule[];
  draft: { baseRevision: number; savedAt: string | null; current: boolean; text: string; rules: Rule[] } | null;
}
// GET /api/projects/:id/agents/:workerId/told: the agent, its documents, and exactly the text they put at the start of
// its next attempt's instructions, with each current draft in place of its published text (`drafts` of them).
export interface ToldView {
  agent: { id: string; name: string; teamId: string; team: string; role: string | null };
  layers: ToldLayer[];
  receives: { text: string; drafts: number };
}

export interface RunRecord {
  id: string;
  createdAt?: string;
  archive?: { archived?: boolean } | null;
  [field: string]: unknown;
}

// An idea named without its graph or records (src/core/project-records.mjs ideasOf): its words, when it was
// made, and which of the records that name it are its own.
export interface IdeaName {
  id: string;
  brief: string;
  createdAt?: string;
  taskIds: string[];
}

// The live set: unsettled work, every task of a run with open work, their direct prerequisites, their
// attempt summaries and those runs; a prerequisite from a finished idea names that idea.
export interface Live {
  tasks: Task[];
  attempts: AttemptSummary[];
  runs: RunRecord[];
  ideas?: IdeaName[];
}

// Finished runs, newest first, a page at a time; `next` names the run the following page starts after.
export interface FinishedPage {
  runs: { run: RunRecord; tasks: Task[]; attempts: AttemptSummary[] }[];
  next: string | null;
}

// Settled work for the board, newest finished first, a page at a time, with the counts of each kind and the ideas
// its work belongs to.
export type SettledKind = 'accepted' | 'closed';
export interface SettledPage {
  tasks: Task[];
  attempts: AttemptSummary[];
  next: string | null;
  counts: Record<SettledKind, number>;
  ideas?: IdeaName[];
}

export interface LogEvent {
  seq: number;
  time: string;
  kind: string;
  message: string;
  task_id: string | null;
  attempt_id: string | null;
}

// A measured test run's whole record (src/connectors/test-records.mjs): `attempt` is the attempt's own checks or
// candidate tests, `merge` its story's merge. A run that kept a record says how large it is, whether it stops at its
// 64 MB limit, its totals (null when it stopped before reporting them) and its failed tests; one that kept none
// says so.
export type TestRecordRun = 'attempt' | 'merge';
export type TestRecordSummary =
  | { recorded: false; run: TestRecordRun }
  | {
      recorded: true;
      run: TestRecordRun;
      bytes: number;
      limited: boolean;
      totals: { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo: number } | null;
      failedTests: { name: string; file?: string; error?: string }[];
    };

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

// What a command's answer says it changed (src/server.mjs commandRecords): the changes recorded since it began that
// its project's page would hear, as a change event names them, and the page of each task they name, as the task's
// own route reads it; or reload, when the controller cannot say.
export interface CommandRecords {
  projectId: string;
  version: number;
  start: string;
  changes?: Change[];
  tasks?: TaskPage[];
  reload?: boolean;
}

// Trying a story yourself (1.2 step 7) as GET /api/projects/:id/try answers it (src/connectors/try-copy.mjs tryView):
// the project's settings with their defaults, where the next Run runs, and the try copy's record, null before the
// project's first Try it. Run runs in the built-in sandbox only where it lets a local port through, else on this
// computer.
export type TryPlace = 'built-in' | 'computer';
export interface TrySettings {
  // A program and its arguments, run without a shell; null until the director names one.
  start: string[] | null;
  address: string | null;
  // `<folder>-try` beside the project's folder unless the settings name another.
  folder: string | null;
  runIn: TryPlace;
  // When the director confirmed, once for the project, that Run may run on this computer outside the sandbox.
  outsideConfirmedAt: string | null;
}
// A Run in the copy: its address is the settings' one, or the first local address the app printed, and null until one
// is known; `installing` while the packages are installed first. An ended Run says how: its exit code and signal,
// why it was stopped, or why it could not run.
export interface TryRun {
  id: string;
  state: 'running' | 'ended';
  place: TryPlace;
  start: string[];
  address: string | null;
  taskId: string;
  commit: string;
  startedAt: string;
  installing?: boolean;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stopped?: string;
  error?: string;
}
// What the copy holds: a story's candidate merged onto its line's tip (`tip` on `branch`), as integrating it would
// merge it, or the candidate as built when that merge conflicts, with the conflicting files; and its last Run.
export interface TryCopy {
  folder: string;
  taskId: string;
  title: string;
  candidateAttemptId: string;
  branch: string;
  tip: string;
  commit: string;
  merged: boolean;
  conflicts: string[];
  at: string;
  run: TryRun | null;
}
export interface TryView {
  settings: TrySettings;
  runsIn: TryPlace;
  copy: TryCopy | null;
}

// The visual check (1.2 step 8; src/connectors/visual-check.mjs and story-pages.mjs). A story's pages, each a name, a
// path on the app's own address and the steps that reach the state to capture: click a button, link, tab or label by
// its text, type into a field by its label, or wait for a text.
export type StoryPageStep = { click: string } | { type: string; into: string } | { wait: string };
export interface StoryPage {
  name: string;
  path: string;
  steps: StoryPageStep[];
}
// A story's pages as GET /api/tasks/:id/pages?projectId= answers them (storyPagesView): the pages its next check
// captures, whether they are the director's own (`changed`), and whether they may still change, with the reason when
// not.
export interface StoryPagesView {
  pages: StoryPage[];
  changed: boolean;
  editable: boolean;
  reason: string | null;
}
export type VisualTheme = 'light' | 'dark';
// A project's settings: on or off, one to three widths, the themes, and the browser program the director chose.
export interface VisualSettings {
  enabled: boolean;
  widths: number[];
  themes: VisualTheme[];
  browser: string | null;
}
// GET /api/projects/:id/visual-check (visualView): the settings, the browser found (null with the note about
// installing one when none is), and why the check would not run here, or null.
export interface VisualView {
  settings: VisualSettings;
  browser: string | null;
  note: string | null;
  blocked: string | null;
}
// One captured image: a page at one width and theme, with the step or page problem it was taken with, and whether it
// was cut at the screen's height.
export interface VisualImage {
  path: string;
  page: string;
  pagePath: string;
  width: number;
  theme: VisualTheme;
  height: number;
  problem?: string;
  trimmed?: boolean;
}
// The candidate's recorded visual-check.json (visual-check-v1): what was captured, or why nothing was.
export interface VisualCheckRecord {
  schemaVersion: 'visual-check-v1';
  state: 'captured' | 'failed' | 'not-run';
  reason?: string;
  note?: string;
  browser: string | null;
  widths: number[];
  themes: VisualTheme[];
  pages: StoryPage[];
  address?: string | null;
  images: VisualImage[];
}
// What the review says of one image (its report's `visual` entries, reviewVisualProblems): the image as the candidate
// or the review's inputs name it, a note and a verdict.
export interface VisualNote {
  image: string;
  note: string;
  verdict: 'match' | 'problem';
}

// The library, the Artifacts listing and snapshots (1.2 step 6; src/core/library.mjs and snapshots.mjs). Every file a
// project's accepted work handed back, newest first (GET /api/projects/:id/artifacts): its story and accepted attempt,
// the agent who made it, the run of the idea it came from (null outside an idea) and when it was accepted.
export interface ProjectArtifact {
  taskId: string;
  title: string;
  attemptId: string;
  workerId?: string;
  runId: string | null;
  kind?: string;
  path: string;
  hash: string;
  acceptedAt: string | null;
}
// Who recorded a library change or a snapshot: the director, or the autonomy policy at its revision.
export interface RecordedBy {
  type: string;
  revision?: number;
}
// Where a library revision's bytes came from: an upload, one file of accepted work (checked by its hash), or another
// project's entry it was copied from.
export type LibrarySource =
  | { type: 'upload' }
  | { type: 'accepted'; taskId: string; attemptId: string; path: string; hash: string }
  | { type: 'copy'; projectId: string; entryId: string; revision: number; sha256: string };
export interface LibraryRevision {
  revision: number;
  file: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  source: LibrarySource;
  at: string;
  by: RecordedBy;
}
// An entry later work follows at its newest revision, until it is removed; its record stays.
export interface LibraryEntry {
  id: string;
  name: string;
  purpose: string;
  createdAt: string;
  by: RecordedBy;
  removedAt?: string;
  revisions: LibraryRevision[];
}
// An agent's proposal for the library, from its accepted work: waiting for the director, approved (with the entry it
// made or revised), rejected, or refused by the library with its problem.
export interface LibraryProposal {
  id: string;
  name: string;
  purpose: string;
  path: string;
  entryId?: string;
  from: { taskId: string; attemptId: string; path: string };
  proposedBy: string;
  at: string;
  state: 'waiting' | 'approved' | 'rejected' | 'refused';
  problem?: string;
  decidedAt?: string;
  decidedBy?: RecordedBy;
}
// A project's library (GET /api/projects/:id/library).
export interface LibraryIndex {
  entries: LibraryEntry[];
  proposals?: LibraryProposal[];
}
// An attempt that read an entry, newest first (…/library/:entryId/readers): the revision it received, and whether
// its file was delivered beside the work or only named in the index.
export interface LibraryReader {
  attemptId: string;
  taskId: string;
  status: string;
  startedAt: string;
  revision: number;
  delivered: boolean;
}
// A named set of accepted files, oldest first (GET /api/projects/:id/snapshots), each by reference and hash, with what
// changed since the snapshot before it, by task and path.
export interface SnapshotFile {
  taskId: string;
  title: string;
  attemptId: string;
  kind?: string;
  path: string;
  hash: string;
}
export interface Snapshot {
  id: string;
  name: string;
  at: string;
  by: RecordedBy;
  files: SnapshotFile[];
  changes: Record<'added' | 'changed' | 'removed', { taskId: string; path: string }[]>;
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
// What one agent of the project is told, as rules.
export const toldUrl = (projectId: string, workerId: string) =>
  projectPath(projectId, `agents/${encodeURIComponent(workerId)}/told`);
// The try view, and its Run's output as plain text.
export const tryUrl = (projectId: string) => projectPath(projectId, 'try');
export const tryOutputUrl = (projectId: string) => projectPath(projectId, 'try/output');
// The project's visual check view, and a story's pages to capture.
export const visualUrl = (projectId: string) => projectPath(projectId, 'visual-check');
export const storyPagesUrl = (projectId: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/pages?${project(projectId)}`;
// The project's accepted files, its library with an entry's readers and a revision's bytes, and its snapshots with
// one's zip.
export const artifactsUrl = (projectId: string) => projectPath(projectId, 'artifacts');
export const libraryUrl = (projectId: string) => projectPath(projectId, 'library');
export const libraryReadersUrl = (projectId: string, entryId: string) =>
  projectPath(projectId, `library/${encodeURIComponent(entryId)}/readers`);
export const libraryRevisionUrl = (projectId: string, entryId: string, revision: number) =>
  projectPath(projectId, `library/${encodeURIComponent(entryId)}/revisions/${revision}`);
export const snapshotsUrl = (projectId: string) => projectPath(projectId, 'snapshots');
export const snapshotDownloadUrl = (projectId: string, snapshotId: string) =>
  projectPath(projectId, `snapshots/${encodeURIComponent(snapshotId)}/download`);
export const taskUrl = (projectId: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}?${project(projectId)}`;
export const storyActivityUrl = (projectId: string, taskId: string) =>
  `/api/tasks/${encodeURIComponent(taskId)}/activity?${project(projectId)}`;
export const logsUrl = (projectId: string, attemptId: string) =>
  `/api/attempts/${encodeURIComponent(attemptId)}/logs?${project(projectId)}`;
// The run's summary, or with `text` its whole output as plain text.
export const testRecordUrl = (projectId: string, attemptId: string, run: TestRecordRun, text = false) =>
  `/api/attempts/${encodeURIComponent(attemptId)}/test-record${text ? '/text' : ''}?${project(projectId)}&run=${run}`;
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

// A route that answers plain text, such as a Run's output; a refusal still answers JSON with its message.
export async function getText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `The controller refused the request (${response.status}).`);
  }
  return response.text();
}

// A command the controller refused: its message, and the fields it answers beside it that a page can act on
// (src/server.mjs fail), such as the files that keep the try copy from moving (`edits`) or the ask to confirm a Run
// outside the sandbox (`confirm`). A refusal without any has none.
export class Refusal extends Error {
  readonly fields: Readonly<Record<string, unknown>>;
  constructor(message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.fields = fields;
  }
}

// The page's request token, which the controller fills in for its start each time it serves the page.
const tokenMeta = () => document.querySelector<HTMLMetaElement>('meta[name="studio-token"]');
let refreshing: Promise<boolean> | null = null;

// Reads this start's request token from the page the controller serves, as loading the page again would, into
// this page's studio-token meta, where send() reads it. It resolves false and leaves the token as it was when the
// controller cannot be reached or its page carries no token, and never rejects; callers at the same time share
// one read.
export function refreshToken(): Promise<boolean> {
  refreshing ??= readServedToken().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function readServedToken() {
  try {
    const response = await fetch('/', { cache: 'no-store' });
    // The page that says the dashboard is not built still carries the token.
    if (!response.ok && response.status !== 503) return false;
    const page = new DOMParser().parseFromString(await response.text(), 'text/html'),
      token = page.querySelector<HTMLMetaElement>('meta[name="studio-token"]')?.content;
    if (!token) return false;
    let meta = tokenMeta();
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'studio-token';
      document.head.append(meta);
    }
    meta.content = token;
    return true;
  } catch {
    return false;
  }
}

// The controller's answer to a command whose token is not this start's.
const staleToken = (response: Response, result: { error?: unknown } | null) =>
  response.status === 403 && result?.error === 'Invalid controller request.';
const restarted = 'The controller restarted. Reload this page to continue.';

export type RecordsListener = (records: CommandRecords) => void;
const recordsListeners = new Set<RecordsListener>();

// Hears the records of each successful command's answer, before send() resolves with it, so a page's records change
// together with the command's own message. It returns the way to stop.
export function onRecords(listener: RecordsListener) {
  recordsListeners.add(listener);
  return () => {
    recordsListeners.delete(listener);
  };
}

// Commands carry this start's request token, as the current dashboard's do. A controller that restarted since the
// page loaded refuses the old token, so a command refused for its token reads the new one and is sent once more;
// refused again, or with no token to read, it asks the director to reload the page. Each command asks for the records
// it changed, and a successful answer's records go to every listener (onRecords); a refused command has none, and
// rejects with a Refusal carrying the controller's message and the fields it answered beside it.
export async function send<T>(
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<T> {
  const payload = JSON.stringify(body),
    request = async () => {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Studio-Token': tokenMeta()?.content ?? '',
          'X-Studio-Records': '1',
        },
        body: payload,
      });
      return { response, result: await response.json() };
    };
  let { response, result } = await request();
  if (staleToken(response, result)) {
    if (!(await refreshToken())) throw new Error(restarted);
    ({ response, result } = await request());
    if (staleToken(response, result)) throw new Error(restarted);
  }
  if (!response.ok) {
    const { error, ...fields } = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    throw new Refusal(error || `The controller refused the request (${response.status}).`, fields);
  }
  const records: CommandRecords | undefined = result?.records;
  if (records && typeof records === 'object') for (const listener of [...recordsListeners]) listener(records);
  return result as T;
}

// What a project's Releases page reads (1.1 step 6): its lines, each with its last release and what landed since, and
// its milestones with their ideas, stories and waiting ideas (GET /api/projects/:id/releases).
export interface ReleaseStory {
  id: string;
  title: string;
  status: string;
  started: boolean;
  integration: string | null;
  carries: { line: string; state: string; back?: boolean; after?: string[] }[];
}
export interface ReleaseIdea {
  runId: string;
  idea: string;
  at: string | null;
  by: string | null;
  stories: ReleaseStory[];
  movedOut: { id: string; title: string; version: string | null }[];
}
export interface WaitingIdea {
  id: string;
  idea: string;
  at: string;
  autoMode?: boolean;
}
export interface MilestoneRelease {
  state: string;
  notesTaskId?: string;
  tag?: string;
  error?: string;
  interrupted?: string;
  pushed?: { remote: string; at: string };
}
export interface Milestone {
  id: string;
  version: string;
  line: string | null;
  goal: string;
  state: 'open' | 'released';
  waiting: WaitingIdea[];
  release?: MilestoneRelease;
  ideas: ReleaseIdea[];
  movedIn: ReleaseStory[];
  counts: { ideas: number; waiting: number; stories: number; integrated: number; started: number };
}
export interface ReleaseLine {
  branch: string;
  state: string;
  newest: boolean;
  from?: string;
  head: string | null;
  lastRelease: { name: string; version: string } | null;
  landed: {
    studio: number;
    hand: number;
    more: boolean;
    commits: { commit: string; subject: string; at: string; studio: boolean }[];
  } | null;
  onRemote: { known: boolean; ahead?: number; behind?: number } | null;
}
export interface ReleaseOverview {
  available: boolean;
  reason?: string;
  copy?: { branch: string | null; clean: boolean };
  remote?: { name: string; url: string } | null;
  lines?: ReleaseLine[];
  milestones?: Milestone[];
  tags?: string[];
}
export const releasesUrl = (projectId: string) => projectPath(projectId, 'releases');
export const milestonesUrl = (projectId: string) => projectPath(projectId, 'milestones');
export const linesUrl = (projectId: string) => projectPath(projectId, 'lines');
