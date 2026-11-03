// Every route the controller answers (src/server.mjs), in one frozen table, and the match the server's guard uses:
// an /api request this table does not name is refused before any handler runs, so a route that is handled but not
// listed can never be reached, and GET /api/routes answers the table itself.
//
// Each entry: `method`; `path`, with `:name` for a part the request fills in and a final `*` for any rest; `fields`,
// the body fields a command takes or the query fields a read takes, each { name, required }; `access`, who may call
// it ('director': the director's session cookie or the x-studio-key header; 'attempt': only the attempt's own token
// while its editor runs; 'anyone': no sign-in); `token`, the request token it needs ('none'; 'unless-keyed': a
// command needs this start's X-Studio-Token when signed in by the session cookie, and none when it carries
// x-studio-key; 'attempt': the attempt's X-Studio-Attempt-Token); and `summary`, one plain line.

const field = (name, required = false) => Object.freeze({ name, required });
const optional = names => names.map(name => field(name));
const project = field('projectId'),
  selected = field('projectId', true);

// A read the director's session or key opens; a command that also needs the request token unless it is keyed.
const read = (path, summary, fields = []) => ({
  method: 'GET',
  path,
  fields,
  access: 'director',
  token: 'none',
  summary,
});
const command = (method, path, summary, fields = [selected]) => ({
  method,
  path,
  fields,
  access: 'director',
  token: 'unless-keyed',
  summary,
});
const post = (path, summary, fields) => command('POST', path, summary, fields);
const patch = (path, summary, fields) => command('PATCH', path, summary, fields);
// One of a task's actions (src/server.mjs, POST /api/tasks/:id/<action>): its project and the fields it takes.
const taskAction = (action, summary, fields = []) =>
  post(`/api/tasks/:id/${action}`, summary, [
    selected,
    ...fields.map(name => (typeof name === 'string' ? field(name) : name)),
  ]);
const intakeFields = [
  selected,
  field('idea', true),
  ...optional(['files', 'autoMode', 'line', 'milestone', 'libraryLeftOut']),
];
const toolFields = optional([
  'name',
  'purpose',
  'kind',
  'rules',
  'limits',
  'program',
  'getFrom',
  'address',
  'operations',
]);
const workflowFields = [project, field('name', true), ...optional(['description', 'steps', 'graph'])];
const milestone = '/api/projects/:id/milestones/:milestoneId';

const table = [
  read('/api/routes', 'Every route the studio answers: its method, address, fields, who may call it and what it does.'),
  // The change stream and what a tab missed.
  read(
    '/api/events',
    "One tab's change stream, with the log events of up to four of the project's attempts it watches.",
    optional(['projectId', 'log', 'after']),
  ),
  read('/api/changes', 'The changes a tab missed since a point, or reload when they cannot be told.', [
    field('after', true),
    ...optional(['start', 'projectId']),
  ]),
  // The studio's reads that belong to no project.
  read('/api/projects', 'Every project, so a tab can choose one.'),
  read('/api/templates', 'The sample projects, the signed-in CLIs, git and whether this is the first run.'),
  read('/api/tools', "The studio's tools, retired ones included."),
  read('/api/tools/:id', 'One tool, with what the director may do with it.'),
  read('/api/health/load', "The controller's own measures: event-loop delay, scheduler passes, requests and memory."),
  read('/api/state', "The selected project's whole state, or with mode=dashboard the compact one.", [
    project,
    field('mode'),
  ]),
  read('/api/export', "The selected project's records as a file to download.", [project]),
  // A project's pages.
  read('/api/projects/:id/shell', "A project's shared shell, without instruction text."),
  read('/api/projects/:id/messages', 'One chat of the project a page at a time.', [
    field('channel', true),
    ...optional(['before', 'after', 'limit']),
  ]),
  read('/api/projects/:id/live', "The project's live work a page at a time.", optional(['before', 'limit'])),
  read('/api/projects/:id/library', "The project's library, every entry with its revisions."),
  read('/api/projects/:id/library/:entryId/readers', 'The attempts that read a library entry, newest first.'),
  read('/api/projects/:id/library/:entryId/revisions/:revision', "One library revision's bytes, as an inert file."),
  read('/api/projects/:id/artifacts', "Every file the project's accepted work handed back, and its snapshots."),
  read('/api/projects/:id/work', 'What the work made, one row per file with its versions.'),
  read('/api/projects/:id/snapshots', "The project's snapshots of accepted files."),
  read('/api/projects/:id/snapshots/:snapshotId/download', "A snapshot's files as one zip, each checked by hash."),
  read('/api/projects/:id/try', "The project's try copy, its settings and where Run runs."),
  read('/api/projects/:id/try/output', "A Run's output in the try copy, as inert plain text."),
  read('/api/projects/:id/visual-check', "The project's visual check: its settings and the browser found."),
  read('/api/projects/:id/releases', "The project's release lines, milestones and their work."),
  read('/api/projects/:id/runs', 'Finished runs a page at a time.', optional(['before', 'limit'])),
  read('/api/projects/:id/runs/:runId', 'One run of the project.'),
  read(
    '/api/projects/:id/runs/:runId/bring-back',
    'The older lines an idea whose stories landed can be brought back to.',
  ),
  read('/api/projects/:id/runs/:runId/inputs/:inputId', "One of an idea's input files, to download.", [selected]),
  read('/api/projects/:id/settled', 'Settled work for the board a page at a time, or only the counts.', [
    field('kind', true),
    ...optional(['before', 'limit', 'workerId', 'team']),
  ]),
  read('/api/projects/:id/people', "Each agent's and team's accepted work and the goal tasks."),
  read('/api/projects/:id/activity', 'Recorded events without agent output, newest first, a page at a time.', [
    field('before'),
  ]),
  read('/api/projects/:id/instructions', "The project's instruction texts, for the page that edits them."),
  read('/api/projects/:id/agents/:workerId/told', 'What one agent of the project is told, as rules, with its drafts.'),
  // A task's reads.
  read('/api/tasks/:id', 'One task with its attempts and the actions the director may take on it now.', [project]),
  read('/api/tasks/:id/activity', 'What happened to a task besides its agents’ output.', [project]),
  read('/api/tasks/:id/bring-back', 'The older lines a story that landed can be brought back to, or why not.', [
    project,
  ]),
  read('/api/tasks/:id/pages', "A story's pages for the visual check.", [project]),
  // An attempt's reads.
  read('/api/attempts/:id', 'One attempt with its phase events.', [project]),
  read('/api/attempts/:id/phases', "An attempt's phase events.", [project]),
  read(
    '/api/attempts/:id/trace',
    "An attempt's trace, or only the steps after a point.",
    optional(['projectId', 'after']),
  ),
  read(
    '/api/attempts/:id/logs',
    "An attempt's log events, all or a page at a time.",
    optional(['projectId', 'limit', 'after', 'snapshot']),
  ),
  read('/api/attempts/:id/logs/download', "An attempt's whole log as a text file.", [project]),
  read('/api/attempts/:id/artifact', 'One registered file of an attempt, checked by its hash.', [
    project,
    field('path', true),
  ]),
  read('/api/attempts/:id/test-runs/:number', "The output or errors of one of an agent's own test runs.", [
    project,
    field('file', true),
  ]),
  read('/api/attempts/:id/test-record', "A measured test run's record summary.", optional(['projectId', 'run'])),
  read(
    '/api/attempts/:id/test-record/text',
    "A measured test run's whole record as plain text.",
    optional(['projectId', 'run']),
  ),
  {
    method: 'POST',
    path: '/api/attempts/:id/tests',
    fields: [field('files')],
    access: 'attempt',
    token: 'attempt',
    summary: "A code-editing agent runs the project's tests on its edits, with its running attempt's token.",
  },
  // Commands that need no project yet.
  post('/api/intake', "Sends an idea to the project's own intake.", intakeFields),
  post('/api/studio-development/intake', 'Sends an idea to the Studio desk development intake.', intakeFields),
  post('/api/projects/inspect-repository', 'What adding a git repository would record; nothing is recorded.', [
    project,
    field('root', true),
    field('profile'),
  ]),
  post(
    '/api/folders',
    'The folders inside a folder, for the folder browser.',
    optional(['projectId', 'path', 'nearest']),
  ),
  post('/api/built-in-sandbox', 'Sets up the built-in sandbox on this computer.', [project]),
  post('/api/projects', 'Creates a project on a git repository or for general work.', [
    project,
    field('name', true),
    ...optional(['goal', 'direction', 'repository', 'houseRules']),
  ]),
  post('/api/projects/from-template', 'Creates a project from one of the samples.', [
    project,
    field('template', true),
    field('name', true),
    ...optional(['cli', 'location', 'idea']),
  ]),
  post('/api/tools', 'Adds a tool to the studio.', [project, ...toolFields]),
  patch('/api/tools/:id', 'Changes a tool, naming the revision it changes.', [
    project,
    field('expectedRevision', true),
    ...toolFields,
  ]),
  post('/api/tools/:id/retire', 'Retires a tool, which keeps it.', [project, field('expectedRevision', true)]),
  post('/api/studio-development', 'Sets up the Studio desk development project and its workflow.', [project]),
  post('/api/tasks/close', 'Closes several tasks at once.', [project, field('taskIds', true), field('reason')]),
  // A project's commands.
  patch('/api/projects/:id', "Edits a project's name, goal, direction or color.", [
    selected,
    field('expectedRevision', true),
    ...optional(['name', 'goal', 'direction', 'color']),
  ]),
  post('/api/projects/:id/messages', "Posts a message to one of the project's chats.", [
    selected,
    field('channel', true),
    ...optional(['text', 'replyTo', 'attachments']),
  ]),
  post('/api/projects/:id/runs/:runId/bring-back', "Brings an idea's stories back to an older line.", [
    selected,
    field('line', true),
  ]),
  post('/api/projects/:id/runs/:runId/archive', 'Archives a run.'),
  post('/api/projects/:id/runs/:runId/restore', 'Restores an archived run.'),
  post('/api/projects/:id/runs/:runId/library', "Leaves library entries out of one idea's work.", [
    selected,
    field('leftOut'),
  ]),
  post('/api/projects/:id/agents', 'Adds an agent of the project to one of its teams.', [
    selected,
    ...optional([
      'expectedRevision',
      'displayName',
      'jobTitle',
      'responsibility',
      'teamId',
      'roles',
      'provider',
      'model',
      'effort',
      'mode',
      'look',
      'instructions',
    ]),
  ]),
  post('/api/projects/:id/agents/:workerId/delete', "Deletes one of the project's agents, keeping its record.", [
    selected,
    field('expectedRevision', true),
  ]),
  post('/api/projects/:id/try-settings', "Saves the project's try copy settings.", [
    selected,
    ...optional(['start', 'address', 'folder', 'runIn']),
  ]),
  post('/api/projects/:id/try/run', "Runs the app in the project's try copy.", [selected, field('confirmOutside')]),
  post('/api/projects/:id/try/stop', "Stops the app running in the project's try copy."),
  post('/api/projects/:id/try/open', "Opens the try copy's folder."),
  post('/api/projects/:id/visual-check', "Saves the project's visual check settings.", [
    selected,
    ...optional(['enabled', 'widths', 'themes', 'browser']),
  ]),
  post('/api/projects/:id/snapshots', "Names a snapshot of the project's accepted files.", [
    selected,
    field('name', true),
    field('files'),
  ]),
  post('/api/projects/:id/library', "Adds an entry to the project's library.", [
    selected,
    ...optional(['name', 'purpose', 'file', 'from']),
  ]),
  post('/api/projects/:id/library/proposals/:proposalId/approve', "Approves an agent's library proposal."),
  post('/api/projects/:id/library/proposals/:proposalId/reject', "Rejects an agent's library proposal."),
  post('/api/projects/:id/library/:entryId/revisions', 'Adds a revision to a library entry.', [
    selected,
    ...optional(['file', 'from']),
  ]),
  post('/api/projects/:id/library/:entryId/edit', "Edits a library entry's name or purpose.", [
    selected,
    ...optional(['name', 'purpose']),
  ]),
  post('/api/projects/:id/library/:entryId/remove', 'Removes a library entry, keeping its revisions.'),
  post('/api/projects/:id/library/:entryId/copy', 'Copies a library entry to another project.', [
    selected,
    field('to', true),
  ]),
  post('/api/projects/:id/delete', 'Deletes a project, its name typed back to confirm.', [
    selected,
    field('name', true),
  ]),
  ...['POST', 'PATCH'].map(method =>
    command(method, '/api/projects/:id/autonomy', "Saves the project's autonomy policy.", [
      selected,
      field('expectedRevision', true),
      field('enabled', true),
      ...optional(['kinds', 'retries', 'cycle', 'sendWaiting']),
    ]),
  ),
  ...['POST', 'PATCH'].map(method =>
    command(method, '/api/projects/:id/organization', "Saves the project's teams and roles, or its defaults.", [
      selected,
      ...optional(['expectedRevision', 'teams', 'members', 'taskKinds', 'kindOwners', 'tiers', 'preset']),
    ]),
  ),
  post('/api/projects/:id/source', "Records an edited repository profile once the project's tests pass with it.", [
    selected,
    field('expectedRevision', true),
    field('profile', true),
  ]),
  post('/api/projects/:id/source/inspect', "Inspects the project's repository again; nothing is recorded.", [
    selected,
    field('profile'),
  ]),
  post('/api/projects/:id/lines', 'Adds a release line for a branch, or a new branch made from a starting point.', [
    selected,
    field('branch', true),
    field('from'),
  ]),
  patch('/api/projects/:id/lines', 'Retires a release line, or keeps it again.', [
    selected,
    field('branch', true),
    field('retired'),
  ]),
  post('/api/projects/:id/version-lines', 'Gives each version its own line, with releases shipping to one branch.', [
    selected,
    field('shipsTo', true),
  ]),
  post('/api/projects/:id/milestones', 'Makes a milestone for a version.', [
    selected,
    field('version', true),
    field('goal'),
  ]),
  patch('/api/projects/:id/milestones', "Edits a milestone's goal.", [selected, field('id', true), field('goal')]),
  post(`${milestone}/release`, 'Releases a milestone: the planner drafts its notes.', [selected, field('moveOpen')]),
  post(`${milestone}/release/again`, 'Releases a milestone again after its release stopped.'),
  post(`${milestone}/ship`, 'Ships a release again to the branch releases ship to.'),
  post(`${milestone}/push`, "Pushes a milestone's release, confirmed.", [selected, field('confirm', true)]),
  post(`${milestone}/ideas`, 'Writes an idea into a milestone to send later.', [
    selected,
    field('idea', true),
    field('autoMode'),
  ]),
  post(`${milestone}/ideas/:ideaId/order`, 'Moves a waiting idea to a new place in its milestone.', [
    selected,
    field('index', true),
  ]),
  post(`${milestone}/ideas/:ideaId/move`, 'Moves a waiting idea to another milestone.', [
    selected,
    field('milestone', true),
  ]),
  post(`${milestone}/ideas/:ideaId/send`, 'Sends a waiting idea now.'),
  post(`${milestone}/ideas/:ideaId/remove`, 'Takes a waiting idea out of its milestone.'),
  // Workflows, the pipeline, integrations, plans and tasks.
  post('/api/workflows', 'Saves a new workflow as a graph or a step list.', workflowFields),
  patch('/api/workflows/:id', 'Saves a workflow again, naming the version it changes.', [
    ...workflowFields,
    field('expectedVersion', true),
  ]),
  post('/api/workflows/:id/run', 'Creates a run of a workflow.', [
    project,
    field('expectedVersion', true),
    field('brief'),
  ]),
  post('/api/pipeline', "Pauses, resumes, queues or removes the project's work.", [
    project,
    field('action', true),
    field('taskIds'),
  ]),
  post('/api/integrations', 'Creates a controller-owned integration from an accepted manifest.', [
    project,
    ...['sourceTaskId', 'attemptId', 'manifestHash', 'workerId'].map(name => field(name, true)),
    field('title'),
  ]),
  post('/api/plans', 'Asks a planner for a bounded plan, or a repair plan for an accepted review.', [
    project,
    field('workerId', true),
    ...optional(['title', 'brief', 'reviewTaskId', 'attemptId', 'reviewHash', 'proposalMode']),
  ]),
  post('/api/tasks', 'Assigns a task to an agent.', [
    project,
    field('workerId', true),
    field('kind', true),
    field('title', true),
    field('brief', true),
    ...optional([
      'acceptance',
      'dependencies',
      'resources',
      'complexity',
      'maxSeconds',
      'countsTowardGoal',
      'inputData',
      'execution',
      'planned',
    ]),
  ]),
  patch(
    '/api/tasks/:id',
    "Changes a task's future settings: owner, direction, execution, hold, release or auto mode.",
    [selected, ...optional(['workerId', 'direction', 'execution', 'hold', 'release', 'autoMode'])],
  ),
  taskAction('project-owner', "Reassigns a project's draft task to another agent.", ['workerId']),
  taskAction('pages', "Changes a story's pages for the visual check.", ['pages']),
  taskAction('try', "Moves the project's try copy to this story's candidate.", ['discard']),
  taskAction('approve-work', 'Approves planned work.'),
  taskAction('replan', 'Replies to an accepted plan whose steps have not started, and plans again.', ['direction']),
  taskAction('deny-work', 'Denies planned work.', ['reason']),
  taskAction('close', 'Closes started work.', ['reason']),
  taskAction('send-back', "Sends work back to its editor with the review's findings.", ['note']),
  taskAction('merge-source', 'Merges a story whose integration stopped on a conflict onto the current source.'),
  taskAction('carry', "Approves a fix's next carry to a line.", [field('line', true)]),
  taskAction('carry-skip', "Skips a fix's carry to a line, with a reason.", [
    field('line', true),
    field('reason', true),
  ]),
  taskAction('bring-back', 'Brings a fix that landed back to an older line.', [field('line', true)]),
  taskAction('allow-commands', 'Approves commands Claude Code refused, and starts the work again.', [
    field('attemptId', true),
    field('commands', true),
  ]),
  taskAction('edit-scope', "Changes a stopped story's files and sends it back, keeping its work.", [
    ...['files', 'newFiles', 'deleteFiles'].map(name => field(name)),
    ...optional(['reason', 'keepWork', 'note', 'request']),
  ]),
  taskAction('propose-work', "Shows a report's proposed tasks in Planned.", [
    field('attemptId', true),
    field('proposalHash', true),
  ]),
  taskAction('accept-proposal', 'Accepts a planning result and shows its proposed tasks in Planned.', [
    field('attemptId', true),
    field('proposalHash', true),
  ]),
  taskAction('start', 'Starts or queues the work, with an optional note for its next attempt.', ['direction']),
  taskAction('answer', "Answers the question the task's latest attempt stopped to ask.", [
    field('attemptId', true),
    ...optional(['option', 'text', 'autoMode']),
  ]),
  taskAction('change-answer', "Replaces auto mode's answer to a question.", [
    field('attemptId', true),
    ...optional(['option', 'text', 'autoMode']),
  ]),
  taskAction('integrate-source', "Integrates a reviewed story into the project's source.", [
    field('attemptId', true),
    field('reviewHash', true),
    field('overrideReason'),
  ]),
  taskAction('restore-source', 'Reconciles an interrupted source integration.'),
  taskAction('cancel', "Asks the task's running attempt to stop."),
  taskAction('reconcile', 'Reconciles an interrupted attempt.'),
  taskAction('approve-plan', 'Approves a reviewed plan and creates its assignments.', [
    field('attemptId', true),
    field('planHash', true),
  ]),
  taskAction('accept', "Accepts a task's result, or over a failed check with a reason.", ['overReason']),
  taskAction('revise', 'Asks for a revision with the director’s direction.', [field('direction', true)]),
  // Agents, instructions and the studio's own switches.
  post('/api/workers/:id/look', "Changes an agent's face.", [project, field('look', true)]),
  patch('/api/workers/:id', "Changes an agent's name, CLI, model, effort, mode or pause.", [
    project,
    field('expectedVersion', true),
    ...optional(['displayName', 'provider', 'model', 'effort', 'mode', 'paused']),
  ]),
  post('/api/instructions/:scope/:id/draft', 'Saves an instruction draft, as its text or its rules.', [
    project,
    field('baseRevision', true),
    ...optional(['text', 'rules']),
  ]),
  post('/api/instructions/:scope/:id/discard', 'Discards an instruction draft.', [
    project,
    field('baseRevision', true),
  ]),
  post('/api/instructions/:scope/:id/publish', 'Publishes the saved instruction draft as a new revision.', [
    project,
    field('baseRevision', true),
    field('text', true),
    field('note'),
  ]),
  post('/api/preview', "Previews the instructions a task's next attempt would get.", [
    project,
    field('workerId', true),
    field('taskId', true),
  ]),
  post('/api/control', "The studio's switches: pause, attempts at once, a usage hold, the test sandbox, permissions.", [
    project,
    ...optional(['paused', 'maxParallel', 'clearQuota', 'testSandbox', 'agentPermissions']),
  ]),
  // Outside /api: the launch link, the dashboard's files and its pages.
  {
    method: 'GET',
    path: '/launch/:code',
    fields: [],
    access: 'anyone',
    token: 'none',
    summary: "This start's launch link: signs a browser in and opens the dashboard.",
  },
  {
    method: 'GET',
    path: '/assets/:file',
    fields: [],
    access: 'anyone',
    token: 'none',
    summary: "The built dashboard's scripts, styles, pictures and fonts, named by their content.",
  },
  read('/theme.js', 'The saved light or dark appearance, applied before the dashboard draws.'),
  read('/next/*', 'Addresses from before the dashboard moved to the main address, sent on to the same page.'),
  read('/*', "The dashboard's pages: any other address without a file extension, with this start's request token."),
];

// The table as GET /api/routes answers it.
export const routes = Object.freeze(
  table.map(route => Object.freeze({ ...route, fields: Object.freeze(route.fields.map(item => Object.freeze(item))) })),
);

// A path's parts, as the route table writes them and as a request names them. A path with an empty part (a doubled
// or a trailing slash) names no listed route, apart from the dashboard's root.
const partsOf = pathname => pathname.slice(1).split('/');
const patterns = routes.map(route => ({ route, parts: partsOf(route.path) }));

// How a pattern's parts compare with a request's, or null when they do not match; where several routes match, the
// one with a fixed part where another has a parameter or the rest comes first.
function fit(pattern, parts) {
  const rank = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && i === pattern.length - 1) {
      rank.push(0);
      return rank;
    }
    const part = parts[i];
    if (part === undefined || part === '') return null;
    if (pattern[i].startsWith(':')) rank.push(1);
    else if (pattern[i] === part) rank.push(2);
    else return null;
  }
  return parts.length === pattern.length ? rank : null;
}
const better = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) > (b[i] ?? -1);
  return false;
};

// The listed route a request names by its method and path, or null. A path under /api is matched only by /api
// routes, so the dashboard's pages never stand for an unknown API route.
export function match(method, pathname) {
  if (typeof method !== 'string' || typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const parts = pathname === '/' ? [] : partsOf(pathname),
    api = parts[0] === 'api';
  let found = null,
    rank = null;
  for (const pattern of patterns) {
    if (pattern.route.method !== method || (pattern.parts[0] === 'api') !== api) continue;
    const fitted = fit(pattern.parts, parts);
    if (fitted && (!rank || better(fitted, rank))) {
      found = pattern.route;
      rank = fitted;
    }
  }
  return found;
}
