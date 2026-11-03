import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from './store.mjs';
import {
  directorAccess,
  directorKey,
  launchFileName,
  sameSecret,
  signInMessage,
  signInPage,
  staleLaunchPage,
} from './director-access.mjs';
import { previousStop, stopRecorder } from './stop-record.mjs';
import { Runner, artifactPath, acceptedReference, validateAcceptedReferences } from './runner.mjs';
import { hash, complexityPolicy, validateComplexity } from './core/contracts.mjs';
import {
  integrateSource,
  interruptedSourceIntegrations,
  restoreSourceIntegration,
  sourceIntegrationTarget,
  sourceIntegrationFailure,
  sourceIntegrationRequested,
  editSourceStory,
  mergeSourceStory,
  proposedStory,
} from './connectors/source-changes.mjs';
import { stopIntegrationProcess } from './connectors/source-integration.mjs';
import { addProjectLine, retireProjectLine } from './connectors/source-lines.mjs';
import {
  approveCarry,
  bringBack,
  bringBackIdea,
  bringBackTargets,
  ideaBringBackTargets,
  skipCarry,
} from './connectors/source-carries.mjs';
import { pushRelease, releaseAgain, shipAgain, startRelease } from './connectors/source-releases.mjs';
import {
  addWaitingIdea,
  editMilestone,
  makeMilestone,
  moveStory,
  moveWaitingIdea,
  orderWaitingIdea,
  projectMilestones,
  takeWaitingIdea,
  useVersionLines,
} from './connectors/source-milestones.mjs';
import { releaseOverview } from './connectors/release-overview.mjs';
import { listFolders } from './connectors/folders.mjs';
import { packageBoundary } from './connectors/package-installs.mjs';
import {
  editProjectProfile,
  inspectProjectSource,
  inspectRepository,
  projectSource,
  sourceResources,
  sourceRoot,
} from './connectors/source-projects.mjs';
import { testsSentence } from './connectors/source-checks.mjs';
import { testRecordStream, testRecordSummary } from './connectors/test-records.mjs';
import { chosenTestSandbox, testSandboxes } from './adapters/source-test-sandbox.mjs';
import { builtInSandbox } from './adapters/built-in-sandbox.mjs';
import { applyAgentPermissions, approveCommands, commandRule, taskAutoMode } from './core/agent-permissions.mjs';
import { employeeTestsAllowed, runEmployeeTests, savedTestRun } from './connectors/employee-tests.mjs';
import { attemptTrace } from './core/attempt-trace.mjs';
import { storyActivity } from './core/story-activity.mjs';
import { validateReview } from './packs/game-production/contracts.mjs';
import { validatePlan } from './planning.mjs';
import { createRegistries } from './registry.mjs';
import { bootstrapFactory } from './core/bootstrap.mjs';
import { createProject } from './core/project-creation.mjs';
import { sendWaitingIdea, startIdeaIntake } from './core/idea-intake.mjs';
import { answerQuestion, changeAnswer } from './core/questions.mjs';
import {
  openTryFolder,
  runTry,
  saveTrySettings,
  stopTry,
  tryOutput,
  tryStory,
  tryView,
} from './connectors/try-copy.mjs';
import { saveVisualSettings, setStoryPages, storyPagesView, visualView } from './connectors/visual-check.mjs';
import {
  addLibraryEntry,
  copyLibraryEntry,
  decideLibraryProposal,
  editLibraryEntry,
  libraryLimits,
  libraryOf,
  libraryReaders,
  setIdeaLibraryLeftOut,
  readLibraryRevision,
  removeLibraryEntry,
  reviseLibraryEntry,
} from './core/library.mjs';
import { createSnapshot, projectArtifacts, snapshotView, snapshotZip } from './core/snapshots.mjs';
import { projectWork } from './core/project-work.mjs';
import { createFromTemplate, listTemplates, sampleIdeaFiles } from './core/project-templates.mjs';
import { deleteProject } from './core/project-deletion.mjs';
import { agentName, createProjectAgent, deleteProjectAgent, sharedAgents, validFace } from './core/project-agents.mjs';
import { LEGACY_PROJECT, recordProject, assertProject, validateTaskProject } from './core/projects.mjs';
import { checkChannel, recordMessage } from './core/messages.mjs';
import {
  finishedRuns,
  liveLimit,
  liveMaxLimit,
  liveRecords,
  oneRun,
  peopleSummary,
  settledKinds,
  settledTasks,
} from './core/project-records.mjs';
import { validateWorkflow, validateGraph, materializeWorkflow } from './core/workflows.mjs';
import {
  ideaInputLimits,
  validateIdeaFiles,
  directorInputsOf,
  stageIdeaInputs,
  readIdeaInput,
} from './core/idea-inputs.mjs';
import { projectRuns, workflowGraph, runArchive, setRunArchived } from './core/graph.mjs';
import { developmentSteps, intakeSteps } from './packs/studio-development/index.mjs';
import { generalIntakeSteps } from './packs/general-work/index.mjs';
import {
  prepareProposedWork,
  recordProposedWork,
  approveWork,
  denyWork,
  closeWork,
  closeStartedWork,
  sendBackWork,
  replanWork,
} from './core/proposals.mjs';
import { acceptAttempt } from './core/acceptance.mjs';
import { applyWorkerExecution, taskExecution } from './core/execution.mjs';
import { autonomyPolicy, recommendedKinds, saveAutonomyPolicy, cycleRunsToday } from './core/autonomy.mjs';
import {
  projectOrganization,
  organizationConfiguration,
  projectCatalog,
  assertProjectKind,
  saveProjectOrganization,
  saveProjectInstructions,
  reassignProjectDraft,
} from './core/project-organization.mjs';
import { developmentOrganization } from './organizations/studio-development/project.mjs';
import { toldView } from './core/instructions.mjs';
import { formatRules } from './core/rules.mjs';
import { createLoadMeasures } from './core/load-measures.mjs';
import { addTool, changeTool, readTool, readTools, retireTool } from './core/tools.mjs';

// The most attempts the studio-wide limit allows at once (MP-033).
const mostAttemptsAtOnce = 16;

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'public');
// The version Settings shows is the app's own, from its package.json.
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
// The security policy of every page the controller serves: the dashboard and the sign-in pages (C-01). Images may
// also come from blob: URLs, which only the dashboard's own scripts create: the idea composer's thumbnails of files
// the director selected or pasted.
const pagePolicy =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const signInHeaders = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': pagePolicy,
};
const dashboardTypes = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
};
// Without a build the page still carries this start's request token, which the controller's tests and local
// tools read from the main address.
const dashboardNotBuilt =
  '<!doctype html><meta charset="utf-8"><meta name="studio-token" content="%STUDIO_TOKEN%"><title>Studio desk</title><h1>The dashboard is not built</h1><p>Run <code>npm ci</code> in the controller\'s folder, then restart it: <code>npm start</code> builds the dashboard. A release includes it already built.</p>';
// A command signed in by the session cookie alone is refused without this start's request token, saying which header
// it lacks and where its value comes from, or, for a token that is not this start's, that the controller restarted.
// The dashboard reads the second as a restart and reads the token again (dashboard/src/api.ts staleToken).
const missingTokenMessage =
  "This command needs the X-Studio-Token header: this start's request token, which the dashboard page the controller serves carries in its studio-token meta tag. The dashboard sends it with every command; a local tool sends the director's key (X-Studio-Key) instead.";
const earlierTokenMessage =
  "This command's X-Studio-Token is from an earlier start of the controller. Reload the page, or read the token from it again.";
// A refusal the page can act on may carry fields beside its message, such as the files that keep the try copy from
// moving (1.2 step 7).
function fail(message, status = 400, fields) {
  const e = new Error(message);
  e.status = status;
  if (fields) e.fields = fields;
  throw e;
}
// A studio tool's ID as the controller makes it (core/tools.mjs): 'tool-' and a UUID. Any other names no tool.
const toolIdPattern = /^tool-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function toolId(id) {
  if (!toolIdPattern.test(id)) fail('Tool not found.', 404);
  return id;
}
// The revision a tool's change or retiring names; the tool list refuses it with 409 when it is not the current one.
function toolRevision(data) {
  if (!Object.hasOwn(data, 'expectedRevision'))
    fail('Name the revision this changes as expectedRevision, from the tool as last read.');
  if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 1)
    fail('expectedRevision must be a whole number from 1.');
  return data.expectedRevision;
}
function text(v, field, max = 24000, required = false) {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) fail(`${field} is missing or too long.`);
  return v.trim();
}
function attemptLogLine(event) {
  const escapes = {
      '\\': '\\\\',
      '\r': '\\r',
      '\n': '\\n',
      '\t': '\\t',
      '\u0085': '\\u0085',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029',
    },
    field = value => String(value).replace(/[\\\r\n\t\u0085\u2028\u2029]/g, character => escapes[character]);
  return [event.time, event.kind, event.message].map(field).join('\t') + '\n';
}
function instruction(org, scope, id) {
  const doc =
    scope === 'company' && id === 'company'
      ? org.instructions.company
      : scope === 'team'
        ? org.instructions.teams[id]
        : scope === 'employee'
          ? org.instructions.employees[id]
          : null;
  if (!doc) fail('Instruction document not found.', 404);
  return doc;
}
async function body(req, maxBytes = 512 * 1024) {
  if (Number(req.headers['content-length']) > maxBytes) {
    req.resume();
    fail('Request is too large.', 413);
  }
  let size = 0,
    chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      req.resume();
      fail('Request is too large.', 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) || '{}');
  } catch {
    fail('Request must contain JSON.');
  }
}
export function createStudio({
  directory = process.env.STUDIO_DATA_DIR || path.join(root, 'data'),
  port = Number(process.env.STUDIO_PORT || 4317),
  runnerOptions = {},
  restart = null,
  // The built dashboard (MP-026).
  dashboardDirectory = path.join(root, 'dist'),
  // Who may use it (C-01, src/director-access.mjs): 'session', the default, asks every request for the director's
  // session cookie or key; 'open' asks for neither, for a studio of seeded sample data that the visual check
  // photographs (scripts/sample-studio.mjs). A trusted option of the code that starts the controller, never a
  // setting, a variable or a request.
  access = 'session',
  // A fresh data folder starts at No projects yet (v1.0 item 24); the game organization and its starter tasks are
  // the `game-studio` preset, chosen with STUDIO_ORGANIZATION_PRESET.
  bootstrap = {
    organizationPreset: process.env.STUDIO_ORGANIZATION_PRESET || 'first-run',
    workflowPresets:
      process.env.STUDIO_WORKFLOW_PRESETS === undefined
        ? (process.env.STUDIO_ORGANIZATION_PRESET || 'first-run') === 'game-studio'
          ? ['game-production']
          : []
        : process.env.STUDIO_WORKFLOW_PRESETS.split(',')
            .map(id => id.trim())
            .filter(Boolean),
  },
} = {}) {
  if (!['session', 'open'].includes(access)) throw new Error('Access must be session or open.');
  const registries = runnerOptions.registries || createRegistries();
  const store = new Store(directory, bootstrapFactory(registries, bootstrap)),
    owner = { id: randomUUID(), pid: process.pid };
  try {
    store.tx(() => {
      const row = store.db.prepare('SELECT data FROM settings WHERE id=?').get('controller-owner');
      if (row) {
        const previous = JSON.parse(row.data);
        let alive = true;
        try {
          process.kill(previous.pid, 0);
        } catch (err) {
          if (err.code === 'ESRCH') alive = false;
        }
        if (alive) fail('Another controller owns this data folder. Stop it before starting another instance.');
      }
      store.db
        .prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run('controller-owner', JSON.stringify(owner));
    });
  } catch (err) {
    store.close();
    throw err;
  }
  packageBoundary(store.directory);
  const key = directorKey(store.directory),
    director = directorAccess(key);
  let runner;
  const measures = createLoadMeasures();
  const planningContext = (org, repair, projectId) =>
    registries.workflows.planningContext(org, repair, registries.adapters, store.project(projectId));
  try {
    runner = new Runner(store, {
      integrate: integrateSource,
      // Each project integrates into its own repository under its own source resources; only
      // integrating the controller's own source pauses it and restarts it.
      integration: {
        target: sourceIntegrationTarget,
        failed: sourceIntegrationFailure,
        requested: sourceIntegrationRequested,
        stop: stopIntegrationProcess,
        recover: interruptedSourceIntegrations,
        resources: task => sourceResources(store, task),
        pauses: task => !!runner.selfHosted && !projectSource(store, recordProject(task)).own,
        controllerSource: task => !projectSource(store, recordProject(task)).own,
      },
      restart,
      ...runnerOptions,
      registries,
    });
  } catch (error) {
    store.db.prepare('DELETE FROM settings WHERE id=? AND data=?').run('controller-owner', JSON.stringify(owner));
    store.close();
    throw error;
  }
  // Each start has its own ID, so a cache tag from before a restart never matches (MP-026).
  const csrf = randomBytes(24).toString('hex'),
    startId = randomBytes(6).toString('hex'),
    clients = new Set();
  let actualPort = port,
    closing = false,
    closePromise,
    lastBroadcast = 0,
    broadcastTimer = null;
  const origin = () => `http://127.0.0.1:${actualPort}`;
  // The line a command sent with the director's key leaves in its project's activity: which route, and the task it
  // names. A command for no known project leaves it in the activity that belongs to no project. A line that cannot
  // be written never fails the command.
  const keyedCommandRecorded = (method, route, parts, data) => {
    try {
      const named = typeof data?.projectId === 'string' ? data.projectId : parts[1] === 'projects' ? parts[2] : null,
        projectId = named && store.projects().some(project => project.id === named) ? named : null,
        task = typeof data?.taskId === 'string' && /^[\w.:-]{1,120}$/.test(data.taskId) ? ` for ${data.taskId}` : '';
      store.event(
        'director_key',
        null,
        null,
        `A local tool sent ${method} ${route}${task} with the director's key.`,
        projectId,
      );
    } catch (error) {
      console.warn(`The command sent with the director's key was not recorded: ${error.message}`);
    }
  };
  // A code-editing employee's test command calls back here (connectors/employee-tests.mjs).
  runner.controllerOrigin = origin;
  runner.loadMeasures = measures;
  // A burst of writes reaches each tab as one change event, at most four a second, naming each changed
  // record of the tab's project and every shared one, with the store's version. Log lines are not
  // changes: they go only to the tabs watching their attempt. Recent changes stay in a capped list in
  // memory, so a reconnecting tab catches up (/api/changes); after a restart, or a gap beyond the list,
  // it reloads what it shows. A tab also hears which other projects' records changed (a `projects` event naming
  // them), so the project rail can count each project's calls for the director as its own page does (the attention
  // indicator, October 29).
  const journal = [],
    journalLimit = 2000,
    relevant = (change, projectId) => !change.projectId || change.projectId === projectId;
  let pending = [];
  const broadcast = () => {
    broadcastTimer = null;
    lastBroadcast = Date.now();
    const batch = pending;
    pending = [];
    const changedProjects = [...new Set(batch.map(change => change.projectId).filter(Boolean))];
    for (const client of clients) {
      const elsewhere = changedProjects.filter(projectId => projectId !== client.projectId);
      if (elsewhere.length) client.res.write(`event: projects\ndata: ${JSON.stringify({ projectIds: elsewhere })}\n\n`);
      const changes = batch.filter(change => relevant(change, client.projectId));
      if (!changes.length) continue;
      const data =
        changes.length > 200
          ? { version: store.version, start: startId, reload: true }
          : { version: store.version, start: startId, changes };
      client.res.write(`event: change\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };
  const notify = change => {
    // An event row, an attempt's speech bubble or a chat message changes no task's readiness, so it starts no
    // scheduler pass (C-19). Each is still journaled and sent to its project's tabs below.
    if (!['event', 'message'].includes(change.type) && !change.trace) runner.schedule();
    journal.push(change);
    if (journal.length > journalLimit) journal.shift();
    pending.push(change);
    if (broadcastTimer || closing) return;
    const wait = lastBroadcast + 250 - Date.now();
    if (wait <= 0) broadcast();
    else broadcastTimer = setTimeout(broadcast, wait);
  };
  const eventMessage = event => `id: ${event.seq}\nevent: log\ndata: ${JSON.stringify(event)}\n\n`;
  store.onChange = notify;
  store.onEvent = event => {
    if (!event.attempt_id) return;
    for (const client of clients) if (client.logs.has(event.attempt_id)) client.res.write(eventMessage(event));
  };
  const unchanged = (req, tag) => (req.headers['if-none-match'] || '').split(',').some(value => value.trim() === tag);
  const compressedAssets = new Map();
  const state = (projectId, options) => {
    // Compact polling observes recorded controller state. Rechecking scheduling
    // here would expand full attempts (and their instruction snapshots) through
    // readiness validators. Dispatch/mutation paths still own those checks.
    if (options?.mode !== 'dashboard') runner.refreshReadiness();
    return {
      ...store.state(projectId, options),
      ...common(projectId),
      runs: projectRuns(store, projectId).map(run => ({
        ...run,
        directorInputs: directorInputsOf(store.run(run.id)),
      })),
    };
  };
  // What the state and a project's shell share: its task types, workflows, adapters and autonomy and the
  // controller's runtime, none of which grows with its history.
  const common = projectId => {
    const available = projectCatalog(store, registries, projectId).map(definition => definition.kind);
    return {
      taskKinds: Object.fromEntries(
        Object.entries(registries.workflows.describe()).map(([kind, definition]) => [
          kind,
          { ...definition, available: available.includes(kind) },
        ]),
      ),
      // Each workflow's graph (saved step lists read as chains) and each run's recorded graph.
      workflows: store.workflows(projectId).map(workflow => ({ ...workflow, graph: workflowGraph(workflow) })),
      adapters: registries.adapters.describe(runner),
      // Where the next candidate tests run (the built-in sandbox unless the director chose none) and where
      // the built-in sandbox stands on this computer.
      testSandbox: chosenTestSandbox(store.organization()),
      builtInSandbox: runner.builtInSandbox.status(),
      modelFreeProviders: registries.adapters.modelFree(),
      roles: [...registries.workflows.roles.values()],
      operations: registries.connectors?.describe() || [],
      autonomy: {
        policy: autonomyPolicy(store, projectId),
        recommended: recommendedKinds(store, registries, projectId),
        cyclesToday: cycleRunsToday(store, projectId),
        pendingIntegration: runner.autonomy.pendingIntegration(),
        restart: runner.autonomy.restartRequired(),
        supervised: !!restart,
        // A self-hosted controller pauses and restarts to integrate; otherwise other work continues.
        selfHosted: !!runner.selfHosted,
      },
      runtime: {
        version: appVersion,
        dataDirectory: store.directory,
        origin: origin(),
        engineConnected: false,
        integrationGateway: runner.gateway.status(),
      },
    };
  };
  // Replies over a kilobyte go compressed to a browser that accepts gzip (MP-026): records are repetitive
  // text, so they shrink to a fraction, with Node's own zlib.
  const send = (res, status, headers, body) => {
    if (body.length > 1024 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
      res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      return res.end(zlib.gzipSync(body));
    }
    res.writeHead(status, headers);
    res.end(body);
  };
  // A planned story's summary in plain words for the director (November 1, 2026), read from its accepted breakdown;
  // a story planned before summaries, or a breakdown that cannot be read, has none.
  const storySummary = record => {
    if (record.proposalReference?.path !== 'source-breakdown.json') return undefined;
    try {
      const summary = proposedStory(store, record)?.summary;
      return typeof summary === 'string' && summary.trim() ? summary.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  // One task as its page reads it, and as a command's records carry it, with the change sequence it reflects.
  const taskPage = (projectId, record) => {
    const summary = storySummary(record);
    return {
      task: { ...record, directorInputs: directorInputsOf(record), ...(summary ? { summary } : {}) },
      attempts: store.dashboardAttempts(projectId, record.id),
      version: store.version,
    };
  };
  // A command the dashboard sends with X-Studio-Records: 1 is answered with what it changed: the changes recorded
  // since it began that its project's tab would hear, as a change event names them, and the page of each task of
  // that project they name, so the page shows the effect without waiting for the stream. Beyond the stream's 200
  // changes, or 50 tasks, or past the capped list, the answer says reload instead. Kept per response.
  const commands = new WeakMap();
  const commandRecords = ({ projectId, after }) => {
    const base = { projectId, version: store.version, start: startId },
      changes = journal.filter(change => change.seq > after && relevant(change, projectId));
    if ((journal[0]?.seq ?? after + 1) > after + 1 || changes.length > 200) return { ...base, reload: true };
    // A task change names its task by its id, an attempt or event change by its taskId (dashboard/src/records.ts).
    const named = new Set();
    for (const change of changes)
      if (change.type === 'task') named.add(String(change.id));
      else if (['attempt', 'event'].includes(change.type) && change.taskId) named.add(String(change.taskId));
    const tasks = [];
    for (const id of named) {
      let record;
      try {
        record = store.task(id);
      } catch {
        continue;
      }
      if (recordProject(record) === projectId) tasks.push(record);
    }
    if (tasks.length > 50) return { ...base, reload: true };
    return { ...base, changes, tasks: tasks.map(record => taskPage(projectId, record)) };
  };
  const json = (res, data, status = 200) => {
    const command = status < 400 && data && typeof data === 'object' && !Array.isArray(data) && commands.get(res);
    let answer = data;
    if (command) {
      // The command has already succeeded: records that cannot be read never turn its answer into an error.
      let records;
      try {
        records = commandRecords(command);
      } catch {
        records = { projectId: command.projectId, version: store.version, start: startId, reload: true };
      }
      answer = { ...data, records };
    }
    return send(
      res,
      status,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(answer),
    );
  };
  const server = http.createServer(async (req, res) => {
    // How long each request takes, for the controller's own measures (C-18); the change stream stays open, so not it.
    const began = performance.now();
    if (!req.url.startsWith('/api/events') && typeof res.on === 'function')
      res.on('finish', () => measures.request(performance.now() - began));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!allowedHosts.includes(req.headers.host)) fail('Use the loopback URL printed by the controller.', 403);
      if (req.headers.origin && ![origin(), `http://localhost:${actualPort}`].includes(req.headers.origin))
        fail('Cross-origin requests are not accepted.', 403);
      const url = new URL(req.url, origin()),
        parts = url.pathname.split('/').filter(Boolean);
      // The launch link this start printed signs a browser in (C-01): it sets the session cookie and opens the
      // dashboard. A link from an earlier start says so.
      if (parts[0] === 'launch' && parts.length === 2 && req.method === 'GET') {
        if (!director.launches(parts[1])) {
          res.writeHead(403, signInHeaders);
          return res.end(staleLaunchPage);
        }
        res.writeHead(303, { Location: '/', 'Set-Cookie': director.sessionCookie, 'Cache-Control': 'no-store' });
        return res.end();
      }
      // Every other request needs the director's session or key, reads and the change stream included, apart from
      // the built dashboard's files (they hold no records) and an agent's own test run, which its attempt's token
      // authorizes below.
      const attemptTests = parts[0] === 'api' && parts[1] === 'attempts' && parts[3] === 'tests' && parts.length === 4;
      if (
        access === 'session' &&
        !attemptTests &&
        !url.pathname.startsWith('/assets/') &&
        !director.authenticated(req.headers)
      ) {
        if (parts[0] === 'api') fail(signInMessage, 401);
        res.writeHead(401, signInHeaders);
        return res.end(signInPage);
      }
      const queryProject = url.searchParams.get('projectId') || LEGACY_PROJECT;
      // The project a tab follows; none on a fresh install's No projects yet, where it follows only the changes that
      // belong to no project (a project appearing, the agents).
      const followedProject = () => {
        if (!url.searchParams.get('projectId') && !store.projects().some(project => project.id === LEGACY_PROJECT))
          return null;
        store.project(queryProject);
        return queryProject;
      };
      if (url.pathname === '/api/events' && req.method === 'GET') {
        // One stream per tab. `log=<attempt>` watches an attempt of the selected project: its
        // events stream to this tab alone, and a reconnect resumes after the last one received.
        const logs = url.searchParams.getAll('log');
        if (logs.length > 4) fail('Watch at most four attempt logs on one stream.');
        for (const id of logs) assertProject(store, store.attempt(id), queryProject);
        const resume = req.headers['last-event-id'] ?? url.searchParams.get('after');
        if (resume != null && !/^(0|[1-9][0-9]{0,15})$/.test(resume))
          fail('The resume point must be a nonnegative integer.');
        const followed = followedProject();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(`event: change\ndata: ${JSON.stringify({ version: store.version, start: startId })}\n\n`);
        const client = { res, logs: new Set(logs), projectId: followed };
        if (resume != null && logs.length) {
          const missed = store.eventsAfter(logs, Number(resume), 1001);
          for (const event of missed.slice(0, 1000)) res.write(eventMessage(event));
          // More than a resume can carry: the tab reads the rest through the paged log route.
          if (missed.length > 1000)
            res.write(`event: log-gap\ndata: ${JSON.stringify({ after: missed[999].seq })}\n\n`);
        }
        clients.add(client);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
        req.on('close', () => {
          clients.delete(client);
          clearInterval(heartbeat);
        });
        return;
      }
      // The changes a tab missed since `after`, from this start's capped list; `reload` when the list
      // cannot say (another start, or a gap beyond it), so the tab reloads what it shows.
      if (url.pathname === '/api/changes' && req.method === 'GET') {
        const after = url.searchParams.get('after');
        if (!/^(0|[1-9][0-9]{0,15})$/.test(after || '')) fail('after must be a nonnegative integer.');
        const followed = followedProject();
        const oldest = journal[0]?.seq ?? store.version + 1;
        if (url.searchParams.get('start') !== startId || Number(after) > store.version || Number(after) < oldest - 1)
          return json(res, { start: startId, version: store.version, reload: true });
        return json(res, {
          start: startId,
          version: store.version,
          changes: journal.filter(change => change.seq > Number(after) && relevant(change, followed)),
        });
      }
      // A project's pages read what they show (MP-026): the project list, so a new tab can choose one; the
      // shared shell without instruction text, the live set, finished runs a page at a time or one run on its
      // own, and the instruction texts for the page that edits them.
      if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, { projects: store.projects() });
      // No projects yet: the samples, the signed-in CLIs, git and whether this is the first run (v1.0 item 24).
      if (url.pathname === '/api/templates' && req.method === 'GET') return json(res, listTemplates(store, runner));
      // The studio's tools (1.4, tools, step 3; core/tools.mjs), which belong to no project: the list, retired ones
      // included, and one tool, each with what the director may do with it and its key read as not set. Like every
      // read they need the director's session or key; an attempt's token opens only its own test run.
      if (parts[0] === 'api' && parts[1] === 'tools' && req.method === 'GET') {
        if (parts.length === 2) return json(res, { tools: readTools(store, { reader: 'director' }) });
        if (parts.length === 3) return json(res, { tool: readTool(store, toolId(parts[2]), { reader: 'director' }) });
      }
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'runs' &&
        parts.length === 5 &&
        req.method === 'GET'
      )
        return json(res, oneRun(store, parts[2], parts[4]));
      // The older lines an idea whose stories landed can be brought back to, or why not.
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'runs' &&
        parts[5] === 'bring-back' &&
        parts.length === 6 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        return json(res, ideaBringBackTargets(store, parts[2], parts[4]));
      }
      // A snapshot's files as one zip, each checked by hash (1.2 step 6).
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'snapshots' &&
        parts[5] === 'download' &&
        parts.length === 6 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        const { name, bytes } = snapshotZip(store, parts[2], parts[4]);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${name}"`,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        });
        res.end(bytes);
        return;
      }
      // The attempts that read a library entry, newest first (1.2 step 6).
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'library' &&
        parts[5] === 'readers' &&
        parts.length === 6 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        return json(res, libraryReaders(store, parts[2], parts[4]));
      }
      // One library revision's bytes, as an inert file: images as themselves, everything else as plain text (1.2 step 6).
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'library' &&
        parts[5] === 'revisions' &&
        parts.length === 7 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        const { revision, bytes } = readLibraryRevision(store, parts[2], parts[4], parts[6]);
        res.writeHead(200, {
          'Content-Type': /^image\/(png|jpeg|webp|gif)$/.test(revision.mediaType)
            ? revision.mediaType
            : 'text/plain; charset=utf-8',
          'Content-Disposition': `inline; filename="${revision.file.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
        });
        res.end(bytes);
        return;
      }
      // A Run's output in the try copy, as inert plain text (1.2 step 7).
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'try' &&
        parts[4] === 'output' &&
        parts.length === 5 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
        });
        res.end(tryOutput(store, parts[2]));
        return;
      }
      // What one agent of the project is told, as rules, with its drafts (1.2 step 1).
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'agents' &&
        parts[5] === 'told' &&
        parts.length === 6 &&
        req.method === 'GET'
      ) {
        store.project(parts[2]);
        try {
          return json(res, toldView(projectOrganization(store, parts[2]), parts[4]));
        } catch (error) {
          fail(error.message, error.status);
        }
      }
      if (parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && req.method === 'GET') {
        const projectId = parts[2];
        if (parts[3] === 'shell') return json(res, { ...store.shell(projectId), ...common(projectId) });
        // One chat of the project a page at a time (team chat): the newest page, the page before a message's seq, or
        // what came after one, always newest last, with the highest seq read as the point a reader resumes from.
        if (parts[3] === 'messages') {
          store.project(projectId);
          const channels = url.searchParams.getAll('channel'),
            named = channels.length === 1 ? /^(?:(project)|(run|task):(.+))$/.exec(channels[0]) : null;
          if (!named) fail('channel must be project, run:<runId> or task:<taskId>, given once.');
          let channel;
          try {
            channel = checkChannel(store, projectId, named[1] ? { type: 'project' } : { type: named[2], id: named[3] });
          } catch (error) {
            fail(error.message, error.status);
          }
          const paging = {};
          for (const name of ['before', 'after', 'limit']) {
            if (!url.searchParams.has(name)) continue;
            const values = url.searchParams.getAll(name);
            if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]))
              fail(`${name} must be a single nonnegative integer.`);
            paging[name] = Number(values[0]);
          }
          if ('before' in paging && 'after' in paging) fail('Read a page before a message or after one, not both.');
          const { before = null, after, limit } = paging;
          try {
            if (after === undefined) {
              const page = store.messagePage(projectId, channel, { before, ...(limit === undefined ? {} : { limit }) });
              return json(res, { ...page, cursor: page.messages.at(-1)?.seq ?? null, version: store.version });
            }
            const page = store.messagesAfter(projectId, channel, after, limit === undefined ? {} : { limit }),
              // Whether the chat holds messages before the first one read: before `after` itself when none was new.
              first = Math.min(page.messages[0]?.seq ?? after + 1, Number.MAX_SAFE_INTEGER),
              older = store.messagePage(projectId, channel, { before: first, limit: 1 }).messages.length > 0;
            return json(res, {
              messages: page.messages,
              older,
              newer: page.newer,
              cursor: page.messages.at(-1)?.seq ?? after,
              version: store.version,
            });
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        // The live set a page at a time in record order (page-read-limits): after the task before, limit at a time.
        if (parts[3] === 'live') {
          const limit = url.searchParams.get('limit') ?? String(liveLimit);
          if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > liveMaxLimit)
            fail(`limit must be a whole number from 1 to ${liveMaxLimit}.`);
          return json(
            res,
            liveRecords(store, projectId, { before: url.searchParams.get('before'), limit: Number(limit) }),
          );
        }
        // The project's library (1.2 step 6): every entry with its revisions, removed ones marked.
        if (parts[3] === 'library') return json(res, libraryOf(store, projectId));
        // Every file the project's accepted work handed back, and its snapshots (1.2 step 6).
        if (parts[3] === 'artifacts') return json(res, projectArtifacts(store, projectId));
        // What the work made, one row per file with its versions, the visual check's pictures, and the records counted
        // (the Artifacts redesign, October 29).
        if (parts[3] === 'work') return json(res, projectWork(store, projectId));
        if (parts[3] === 'snapshots') return json(res, snapshotView(store, projectId));
        // The project's try copy, its settings and where Run runs (1.2 step 7).
        if (parts[3] === 'try') return json(res, tryView(store, projectId, runner));
        // The project's visual check: its settings, the browser found and whether it can run here (1.2 step 8).
        if (parts[3] === 'visual-check') return json(res, visualView(store, projectId, runner));
        // A project's releases (1.1 step 6): its lines, milestones and their work, read from records and git alone.
        if (parts[3] === 'releases')
          try {
            return json(res, await releaseOverview(store, projectId, runner));
          } catch (error) {
            fail(error.message);
          }
        if (parts[3] === 'runs') {
          const limit = url.searchParams.get('limit') ?? '10';
          if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) fail('limit must be a whole number from 1 to 50.');
          return json(
            res,
            finishedRuns(store, projectId, { before: url.searchParams.get('before'), limit: Number(limit) }),
          );
        }
        // Settled work for the board, a page at a time; a limit of 0 reads only the counts.
        if (parts[3] === 'settled') {
          const kind = url.searchParams.get('kind'),
            limit = url.searchParams.get('limit') ?? '12';
          if (!settledKinds.includes(kind)) fail('kind must be accepted or closed.');
          if (!/^(0|[1-9][0-9]?)$/.test(limit) || Number(limit) > 50)
            fail('limit must be a whole number from 0 to 50.');
          return json(
            res,
            settledTasks(store, projectId, {
              kind,
              before: url.searchParams.get('before'),
              limit: Number(limit),
              workerId: url.searchParams.get('workerId'),
              team: url.searchParams.get('team'),
            }),
          );
        }
        // Each employee's and team's accepted work and the goal tasks, for the organization pages.
        if (parts[3] === 'people') {
          const organization = projectOrganization(store, projectId);
          return json(
            res,
            peopleSummary(store, projectId, [
              ...(organization.company?.goalTaskIds ?? []),
              ...organization.teams.flatMap(team => team.goalTaskIds ?? []),
            ]),
          );
        }
        // Recorded events without agent output, newest first, a page at a time.
        if (parts[3] === 'activity') {
          const before = url.searchParams.get('before');
          if (before !== null && !/^[1-9][0-9]{0,15}$/.test(before)) fail('before must be an event sequence number.');
          store.project(projectId);
          // The change sequence the page reflects, as every page read says it (page-read-limits).
          return json(res, {
            ...store.activity(projectId, { before: before === null ? null : Number(before) }),
            version: store.version,
          });
        }
        if (parts[3] === 'instructions') {
          const organization = projectOrganization(store, projectId),
            configuration = organizationConfiguration(store, projectId);
          return json(res, {
            instructions: organization.instructions,
            projectInstructions: configuration?.instructions ?? null,
            history: configuration?.history ?? null,
          });
        }
      }
      // One task of the selected project with its attempt summaries: what a task's page shows. Its activity is what
      // happened to it besides its agents' output, which its Activity tab reads.
      const taskRoute = parts[0] === 'api' && parts[1] === 'tasks' && req.method === 'GET';
      if (
        taskRoute &&
        (parts.length === 3 || (parts.length === 4 && ['activity', 'bring-back', 'pages'].includes(parts[3])))
      ) {
        let record;
        try {
          record = store.task(parts[2]);
        } catch {
          fail('Task not found.', 404);
        }
        assertProject(store, record, queryProject);
        // The older lines a story that landed can be brought back to, or why not, read from records and git.
        if (parts[3] === 'bring-back') return json(res, bringBackTargets(store, record));
        // A story's pages for the visual check, its planned ones until the director changes them (1.2 step 8).
        if (parts[3] === 'pages') return json(res, storyPagesView(store, record));
        if (parts[3]) return json(res, storyActivity(store, record));
        return json(res, taskPage(queryProject, record));
      }
      // The controller's own measures (C-18): event-loop delay, scheduler passes, requests, memory and record sizes.
      if (url.pathname === '/api/health/load' && req.method === 'GET') return json(res, measures.snapshot(store));
      if (url.pathname === '/api/state' && req.method === 'GET') {
        const mode = url.searchParams.get('mode') ?? 'full';
        if (mode !== 'dashboard') return json(res, state(queryProject, { mode }));
        // The compact state reads only records and does not write, so the store's version names
        // its content: a tab holding this tag gets a 304 with no body, before anything is built.
        const tag = `"${startId}-${store.version}-${queryProject}"`,
          headers = { 'Cache-Control': 'private, no-cache', ETag: tag };
        if (unchanged(req, tag)) {
          res.writeHead(304, headers);
          return res.end();
        }
        return send(
          res,
          200,
          { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
          JSON.stringify(state(queryProject, { mode })),
        );
      }
      if (url.pathname === '/api/export' && req.method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename="studio-records.json"');
        return json(res, state(queryProject));
      }
      if (
        parts.length === 7 &&
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'runs' &&
        parts[5] === 'inputs' &&
        req.method === 'GET'
      ) {
        if (parts[2] !== queryProject) fail('Select the owning project to download its inputs.');
        const { item, bytes } = readIdeaInput(store, queryProject, parts[4], parts[6]);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': bytes.length,
          'Content-Disposition': `attachment; filename="${item.name.replace(/[^a-zA-Z0-9_.-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(item.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16))}`,
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
        });
        return res.end(bytes);
      }
      if (parts[0] === 'api' && parts[1] === 'attempts' && req.method === 'GET') {
        const attempt = store.attempt(parts[2]);
        assertProject(store, attempt, queryProject);
        if (parts.length === 4 && parts[3] === 'phases') return json(res, store.phaseEvents(attempt.id));
        // The attempt's trace (v1.0 item 21), read when its page opens; `after` returns only newer steps.
        if (parts.length === 4 && parts[3] === 'trace') {
          let after;
          if (url.searchParams.has('after')) {
            const values = url.searchParams.getAll('after');
            if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]))
              fail('after must be a single nonnegative integer.');
            after = Number(values[0]);
          }
          // A source adapter (planning, editing) runs the employee's model, whose adapter reads the lines it wrote.
          const adapter = registries.adapters.find(attempt.provider),
            reader = adapter?.traceEvent ? adapter : registries.adapters.find(attempt.configuration?.model);
          return json(res, await attemptTrace(store, attempt, reader, { after }));
        }
        if (parts[3] === 'logs') {
          if (parts.length === 5 && parts[4] === 'download') {
            // Capture the bound before sending headers. The stream reads only
            // bounded pages and honors response backpressure without collecting
            // the complete log in memory or following newly appended events.
            const first = store.attemptEventPage(attempt.id);
            res.writeHead(200, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Disposition': `attachment; filename="${attempt.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}-logs.txt"`,
              'Cache-Control': 'no-store',
            });
            await pipeline(
              Readable.from(
                (async function* () {
                  let page = first;
                  while (true) {
                    if (page.events.length) yield page.events.map(attemptLogLine).join('');
                    if (page.nextCursor === null) return;
                    page = store.attemptEventPage(attempt.id, { after: page.nextCursor, snapshot: first.snapshot });
                  }
                })(),
              ),
              res,
            );
            return;
          }
          const paging = {};
          for (const name of ['limit', 'after', 'snapshot']) {
            if (!url.searchParams.has(name)) continue;
            const values = url.searchParams.getAll(name);
            if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]))
              fail(`${name} must be a single nonnegative integer.`);
            paging[name] = Number(values[0]);
          }
          return json(
            res,
            Object.keys(paging).length ? store.attemptEventPage(attempt.id, paging) : store.events(attempt.id),
          );
        }
        if (parts[3] === 'artifact') {
          const relative = url.searchParams.get('path'),
            item = attempt.artifacts.find(x => x.path === relative);
          if (!item) fail('Artifact not registered.', 404);
          const file = artifactPath(store, attempt, relative);
          if (hash(fs.readFileSync(file)) !== item.hash)
            fail('Artifact was modified after its result was recorded.', 409);
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, {
            'Content-Type':
              ext === '.json'
                ? 'application/json; charset=utf-8'
                : ext === '.txt' || ext === '.md' || ext === '.diff'
                  ? 'text/plain; charset=utf-8'
                  : 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, '_')}"`,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(file).pipe(res);
          return;
        }
        // The whole output or errors of one of a code-editing employee's own test runs, saved in its job folder
        // as the run printed them and read only while the bytes match the run's record.
        if (parts.length === 5 && parts[3] === 'test-runs') {
          const names = url.searchParams.getAll('file');
          if (names.length !== 1 || !['output', 'errors'].includes(names[0])) fail('file must be output or errors.');
          if (!/^[1-9][0-9]{0,8}$/.test(parts[4])) fail('Test run not found.', 404);
          const number = Number(parts[4]),
            file = await savedTestRun(store, attempt, number, names[0]);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `inline; filename="${attempt.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}-test-run-${number}-${names[0]}.txt"`,
            'Cache-Control': 'no-store',
          });
          await pipeline(fs.createReadStream(file), res);
          return;
        }
        // A measured test run's whole record, read-only (src/connectors/test-records.mjs): `run=attempt` (the
        // default) is the attempt's own checks or candidate tests, `run=merge` its story's merge. The summary
        // says whether the run kept one; /text sends it as inert plain text, read as it streams.
        if (parts[3] === 'test-record' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'text'))) {
          const run = url.searchParams.get('run');
          if (parts.length === 4) return json(res, await testRecordSummary(store, attempt, run));
          const record = testRecordStream(store, attempt, run);
          if (!record) fail('This run has no whole record.', 404);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'Cache-Control': 'no-store',
          });
          await pipeline(record, res);
          return;
        }
        return json(res, { ...attempt, phaseEvents: store.phaseEvents(attempt.id) });
      }
      // A code-editing employee runs the project's tests on its edits (v1.0 item 22). Its attempt's token, which
      // exists only while its editor runs, authorizes this one request and nothing else; the dashboard's does not.
      if (parts[0] === 'api' && parts[1] === 'attempts' && parts[3] === 'tests' && parts.length === 4) {
        const entry = runner.active.get(parts[2]);
        if (req.method !== 'POST' || !employeeTestsAllowed(entry, req.headers['x-studio-attempt-token']))
          fail('This attempt cannot run tests now.', 403);
        if (closing) fail('Controller is stopping.', 503);
        const data = await body(req);
        if (Object.keys(data).some(key => key !== 'files')) fail('A test run takes only files.');
        // A client that gives up (its command timed out) stops the run.
        res.on('close', () => !res.writableFinished && entry.employeeTests?.child?.kill());
        return json(res, await runEmployeeTests(runner, entry, data));
      }
      if (parts[0] === 'api') {
        // Every read route answered above, so a read that gets here names no read route: a mistyped one, or a command
        // asked for with GET. A command is a POST or a PATCH.
        if (req.method === 'GET' || req.method === 'HEAD')
          fail('Unknown read route. Commands are sent with POST or PATCH.', 404);
        if (!['POST', 'PATCH'].includes(req.method)) {
          res.setHeader('Allow', 'POST, PATCH');
          fail('Commands are sent with POST or PATCH.', 405);
        }
        // The page's request token keeps another page in the director's browser from riding on the session cookie,
        // which the browser sends by itself. The key in its header needs no token: no page can send it without
        // knowing the key, and whoever knows the key can read the token from the page anyway (the November 2
        // review). A request signed in by the cookie alone still needs the token, on every route. Its refusal says
        // whether the header is missing or carries a token from an earlier start, which the dashboard reads as a
        // restart (dashboard/src/api.ts staleToken).
        const keyed = director.keyed(req.headers);
        if (!keyed) {
          const token = req.headers['x-studio-token'];
          if (token === undefined) fail(missingTokenMessage, 403);
          if (!sameSecret(token, csrf)) fail(earlierTokenMessage, 403);
        }
        if (closing) fail('Controller is stopping.', 503);
        // Idea intake: the Studio desk route, and the general one (1.0 item 11), which starts the
        // project's own intake: source checks and a breakdown for a source project, the planner for
        // a general-work project.
        const intake =
          ['/api/studio-development/intake', '/api/intake'].includes(url.pathname) && req.method === 'POST';
        // A file added to the library carries its bytes too (1.2 step 6).
        const libraryUpload =
          req.method === 'POST' && /^\/api\/projects\/[^/]+\/library(?:\/[^/]+\/revisions)?$/.test(url.pathname);
        const data = await body(
          req,
          intake ? ideaInputLimits.wireBytes : libraryUpload ? libraryLimits.wireBytes + 64 * 1024 : undefined,
        );
        // A command a local tool sends with the key leaves a line in its project's activity before it runs, so the
        // director can tell a script's decisions from their own (the decisions themselves still say the director),
        // and a command's answer still carries only the records the command made.
        if (keyed) keyedCommandRecorded(req.method, url.pathname, parts, data);
        // The newest change's seq before the command runs: its answer's records are what was recorded after it.
        if (req.headers['x-studio-records'] === '1' && typeof data?.projectId === 'string')
          commands.set(res, { projectId: data.projectId, after: store.version });
        if (intake) {
          if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            !Object.hasOwn(data, 'projectId') ||
            !Object.hasOwn(data, 'idea') ||
            Object.keys(data).some(
              key => !['projectId', 'idea', 'files', 'autoMode', 'line', 'milestone', 'libraryLeftOut'].includes(key),
            )
          )
            fail(
              'Idea intake accepts projectId, idea, optional files, optional autoMode, an optional line or milestone and optional library entries to leave out.',
            );
          const projectId = data.projectId;
          store.project(projectId);
          let started;
          try {
            started = startIdeaIntake(
              store,
              registries,
              runner,
              {
                projectId,
                idea: data.idea,
                files: data.files,
                autoMode: data.autoMode,
                general: url.pathname === '/api/intake',
                line: data.line,
                milestone: data.milestone,
                libraryLeftOut: data.libraryLeftOut,
              },
              sampleIdeaFiles,
            );
          } catch (error) {
            fail(error.message, error.status);
          }
          return json(res, started, 201);
        }
        // Making a project needs no project, so these come before the project check: a fresh install has none.
        // What adding a git repository would record (1.0 step 4b): its branch, whether the tree is clean,
        // a proposed profile (or the edited one given) and what its snapshot measures. Nothing is recorded.
        if (url.pathname === '/api/projects/inspect-repository' && req.method === 'POST') {
          if (Object.keys(data).some(key => !['projectId', 'root', 'profile'].includes(key)))
            fail('Repository inspection accepts root and an optional profile.');
          try {
            return json(res, inspectRepository(store, data.root, runner, data.profile));
          } catch (error) {
            fail(error.message);
          }
        }
        // The folders inside a folder (the home folder without a path) for the dashboard's folder browser,
        // leaving out files, dot entries, folders that cannot be read and a Windows drive's top-level $ folders.
        // With nearest, a path that does not exist or names a file lists the nearest existing folder above it
        // (the home folder when nothing along it exists) instead of being refused.
        // POST only, with the request token, so a page without the dashboard's token cannot read folder names.
        if (url.pathname === '/api/folders' && req.method === 'POST') {
          if (Object.keys(data).some(key => !['projectId', 'path', 'nearest'].includes(key)))
            fail('The folder list accepts only an optional path and nearest.');
          if (data.nearest !== undefined && typeof data.nearest !== 'boolean') fail('Nearest must be true or false.');
          try {
            return json(res, listFolders(data.path, { nearest: data.nearest === true }));
          } catch (error) {
            fail(error.message);
          }
        }
        // Set up the built-in sandbox on this computer (1.0.1): the runtime's own setup, which asks Windows for an
        // administrator, so the director answers Windows' prompt, or on Linux the install of the packages it needs
        // through the system's password prompt. One at a time; its state is in the shell and state.
        if (url.pathname === '/api/built-in-sandbox' && req.method === 'POST') {
          if (Object.keys(data).some(key => key !== 'projectId')) fail('The sandbox setup takes no settings.');
          const started = runner.builtInSandbox.setup(status =>
            store.event(
              'control',
              null,
              null,
              status.state === 'ready'
                ? 'The built-in sandbox is set up on this computer.'
                : 'The built-in sandbox setup did not finish; Settings → Candidate tests says why.',
            ),
          );
          if (!started)
            fail('The built-in sandbox is set up already, its setup is running, or it is not available here.', 409);
          return json(res, { ok: true, builtInSandbox: runner.builtInSandbox.status() });
        }
        // Create a project (item 10): a git repository checked first, or general work.
        if (url.pathname === '/api/projects' && req.method === 'POST') {
          let created;
          try {
            created = await createProject(store, registries, runner, data);
          } catch (error) {
            fail(error.message, error.status);
          }
          return json(res, created, 201);
        }
        // A project from one of No projects yet's samples (v1.0 item 24): its folder under the data folder, its team on the
        // chosen CLI, the recommended house rules and an optional first idea.
        if (url.pathname === '/api/projects/from-template' && req.method === 'POST') {
          let created;
          try {
            created = await createFromTemplate(store, registries, runner, data);
          } catch (error) {
            fail(error.message, error.status);
          }
          return json(res, created, 201);
        }
        // The director's changes to the studio's tools (1.4, tools, step 3), which belong to no project: add one, change
        // one by naming the revision it changes, or retire one, which keeps it. A stale revision or a retired tool
        // answers 409, and each answer is the tool as the director reads it. There is no delete. Each write goes on the
        // change stream as { type: 'tool', id, revision }, for every tab (core/store.mjs).
        if (parts[1] === 'tools') {
          if (!data || typeof data !== 'object' || Array.isArray(data)) fail('Send a tool command as a JSON object.');
          const asDirector = { reader: 'director' };
          if (parts.length === 2 && req.method === 'POST') {
            const added = addTool(store, data);
            return json(res, { tool: readTool(store, added.id, asDirector) }, 201);
          }
          if (parts.length === 3 && req.method === 'PATCH') {
            const id = toolId(parts[2]),
              { expectedRevision, ...fields } = data,
              changed = changeTool(store, id, toolRevision(data), fields);
            return json(res, { tool: readTool(store, changed.id, asDirector) });
          }
          if (parts.length === 4 && parts[3] === 'retire' && req.method === 'POST') {
            const id = toolId(parts[2]);
            if (Object.keys(data).some(field => field !== 'expectedRevision'))
              fail('Retiring a tool takes only expectedRevision.');
            const retired = retireTool(store, id, toolRevision(data));
            return json(res, { tool: readTool(store, retired.id, asDirector) });
          }
          fail('Unknown controller route.', 404);
        }
        // A message to one of the selected project's chats (team chat). Until a mention does something (later
        // stories), each message waits for a reply, and says so in the same write that keeps it.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'messages' && !parts[4] && req.method === 'POST') {
          if (!data || typeof data !== 'object' || Array.isArray(data) || data.projectId !== parts[2])
            fail('Select this project before posting to its chat.');
          if (Object.keys(data).some(key => !['projectId', 'channel', 'text', 'replyTo', 'attachments'].includes(key)))
            fail('A message takes only projectId, channel, text, replyTo and attachments.');
          store.project(parts[2]);
          const { projectId: selected, ...fields } = data;
          let message;
          try {
            message = recordMessage(store, selected, fields, undefined, {
              outcome: { type: 'waiting', reason: 'Waiting for a reply.' },
            });
          } catch (error) {
            fail(error.message, error.status);
          }
          return json(res, message, 201);
        }
        const projectId = data.projectId ?? LEGACY_PROJECT;
        store.project(projectId);
        if (url.pathname === '/api/tasks/close' && req.method === 'POST') {
          if (Object.keys(data).some(key => !['projectId', 'taskIds', 'reason'].includes(key)))
            fail('Unsupported close fields.');
          const closed = closeWork(store, projectId, data.taskIds, data.reason ?? '');
          runner.autonomy.sendWaiting(projectId);
          return json(res, closed);
        }
        if (url.pathname === '/api/studio-development' && req.method === 'POST') {
          if (Object.keys(data).some(key => key !== 'projectId'))
            fail('Studio desk setup uses its registered source and workflow only.');
          const id = 'project-studio-desk',
            workflowId = 'workflow-studio-development';
          let project = store.projects().find(project => project.id === id),
            workflow = store.workflows(id).find(workflow => workflow.id === workflowId);
          store.tx(() => {
            if (!project) {
              if (
                store.projects().length >= 50 ||
                store.projects().some(project => project.name.toLowerCase() === 'studio desk development')
              )
                fail('Project limit or name conflict.');
              project = {
                id,
                name: 'Studio desk development',
                goal: 'Improve the local orchestration pipeline using measured source checks and bounded Codex proposals.',
                direction:
                  'Preserve controller ownership and existing project history. Accept evidence and proposals separately.',
                revision: 1,
                dispatchPaused: true,
                createdAt: new Date().toISOString(),
              };
              store.putProject(project);
              saveProjectOrganization(
                store,
                registries,
                id,
                developmentOrganization(sharedAgents(store.organization())),
                true,
              );
            }
            if (!workflow) {
              const steps = developmentSteps(projectOrganization(store, id)),
                budget = validateWorkflow(store, registries, steps, id);
              workflow = {
                id: workflowId,
                projectId: id,
                name: 'Check Studio desk and propose one improvement',
                description: 'Copied-source Node tests → director acceptance → Codex review → director acceptance.',
                version: 1,
                steps,
                budget,
                createdAt: new Date().toISOString(),
              };
            }
            store.putProject(project);
            store.putWorkflow(workflow);
          });
          store.event(
            'development_workflow_ready',
            null,
            null,
            'Studio desk development project and workflow are ready. Start a run explicitly; each result needs acceptance.',
            id,
          );
          return json(res, { project, workflow }, 201);
        }
        // Bring the idea back to <branch> (1.1, October 27): each of its stories, in the order they landed.
        if (
          parts[1] === 'projects' &&
          parts[3] === 'runs' &&
          parts[4] &&
          parts[5] === 'bring-back' &&
          !parts[6] &&
          req.method === 'POST'
        ) {
          if (parts[2] !== projectId) fail('Select this project before bringing its ideas back.');
          if (Object.keys(data).some(key => !['projectId', 'line'].includes(key))) fail('Bring back takes the line.');
          let stories;
          try {
            stories = bringBackIdea(store, projectId, parts[4], data.line);
          } catch (error) {
            fail(error.message);
          }
          runner.autonomy.tryCarries();
          return json(res, { stories }, 202);
        }
        if (
          parts[1] === 'projects' &&
          parts[2] &&
          parts[3] === 'runs' &&
          parts[4] &&
          ['archive', 'restore'].includes(parts[5]) &&
          !parts[6] &&
          req.method === 'POST'
        ) {
          if (parts[2] !== projectId) fail('Select this project before archiving or restoring its runs.');
          if (Object.keys(data).some(key => key !== 'projectId')) fail('Unsupported run archive fields.');
          const held = new Set(store.leases().map(lease => lease.attemptId)),
            previous = runArchive(store, projectId, parts[4]),
            archive = setRunArchived(store, registries, projectId, parts[4], parts[5] === 'archive', {
              activeTaskIds: [...runner.active.values()].map(entry => entry.attempt.taskId),
              pendingTaskId: runner.autonomy.pendingIntegration()?.taskId,
              // External integrations reserve under their journal identity, rather than the
              // model attempt's identity. Keep that application binding out of graph policy.
              reservedTaskIds: store
                .allAttempts()
                .filter(attempt =>
                  [attempt.id, attempt.sourceIntegration?.id, attempt.integration?.id].some(id => held.has(id)),
                )
                .map(attempt => attempt.taskId),
            });
          if (previous.archived !== archive.archived)
            store.event(
              'run_' + parts[5],
              null,
              null,
              `Director requested ${parts[5]} for run ${parts[4]}.`,
              projectId,
            );
          return json(res, { runId: parts[4], projectId, archive });
        }
        // A project's own agents (1.0.1): a new one joins one of its teams; deleting one keeps its record.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'agents' && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before changing its agents.');
          try {
            if (!parts[4]) return json(res, createProjectAgent(store, registries, projectId, data), 201);
            if (parts[5] === 'delete' && !parts[6])
              return json(res, deleteProjectAgent(store, registries, projectId, parts[4], data));
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        // Trying a story yourself (1.2 step 7): the project's settings, and Run, Stop and Open folder on its copy.
        // Only the director's click reaches these; the autonomy policy and agents never do.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'try-settings' && !parts[4] && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before editing its settings.');
          const { projectId: selected, ...settings } = data;
          try {
            return json(res, saveTrySettings(store, projectId, settings, runner));
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        if (
          parts[1] === 'projects' &&
          parts[2] &&
          parts[3] === 'try' &&
          parts[4] &&
          !parts[5] &&
          req.method === 'POST'
        ) {
          if (parts[2] !== projectId) fail('Select this project before running its try copy.');
          const fields = { run: ['projectId', 'confirmOutside'], stop: ['projectId'], open: ['projectId'] }[parts[4]];
          if (!fields) fail('Unknown try copy action.', 404);
          if (Object.keys(data).some(key => !fields.includes(key))) fail('Unsupported try copy fields.');
          try {
            if (parts[4] === 'run')
              return json(res, runTry(runner, projectId, { confirmOutside: data.confirmOutside === true }), 202);
            if (parts[4] === 'stop') return json(res, { run: await stopTry(runner, projectId) });
            return json(res, openTryFolder(store, projectId));
          } catch (error) {
            fail(error.message, error.status, error.confirm ? { confirm: error.confirm } : undefined);
          }
        }
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'visual-check' && !parts[4] && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before editing its settings.');
          const { projectId: selected, ...settings } = data;
          try {
            return json(res, saveVisualSettings(store, projectId, settings, runner));
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        // A snapshot of the project's accepted files (1.2 step 6).
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'snapshots' && !parts[4] && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before naming a snapshot.');
          const { projectId: selected, ...fields } = data;
          try {
            return json(res, createSnapshot(store, projectId, fields), 201);
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        // Entries the director leaves out of one idea's work (1.2 step 6).
        if (
          parts[1] === 'projects' &&
          parts[2] &&
          parts[3] === 'runs' &&
          parts[4] &&
          parts[5] === 'library' &&
          !parts[6] &&
          req.method === 'POST'
        ) {
          if (parts[2] !== projectId) fail('Select this project before changing its idea.');
          if (Object.keys(data).some(key => !['projectId', 'leftOut'].includes(key)))
            fail('Leaving library files out of an idea takes only the entries to leave out.');
          try {
            return json(res, setIdeaLibraryLeftOut(store, projectId, parts[4], data.leftOut));
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        // The project's library (1.2 step 6): add an entry, a revision, an edit, a removal or a copy to another project.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'library' && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before changing its library.');
          const { projectId: selected, ...fields } = data;
          try {
            if (!parts[4]) return json(res, addLibraryEntry(store, projectId, fields), 201);
            // A proposal an agent made, approved or rejected by the director.
            if (parts[4] === 'proposals' && parts[5] && ['approve', 'reject'].includes(parts[6]) && !parts[7]) {
              if (Object.keys(fields).length) fail('Deciding a proposal takes nothing else.');
              return json(res, decideLibraryProposal(store, projectId, parts[5], parts[6] === 'approve'));
            }
            if (parts[5] === 'revisions' && !parts[6])
              return json(res, reviseLibraryEntry(store, projectId, parts[4], fields), 201);
            if (parts[5] === 'edit' && !parts[6])
              return json(res, editLibraryEntry(store, projectId, parts[4], fields));
            if (parts[5] === 'remove' && !parts[6]) {
              if (Object.keys(fields).length) fail('Removing an entry takes nothing else.');
              return json(res, removeLibraryEntry(store, projectId, parts[4]));
            }
            if (parts[5] === 'copy' && !parts[6]) {
              if (Object.keys(fields).some(key => key !== 'to') || typeof fields.to !== 'string')
                fail('Copying an entry names the project to copy it to.');
              return json(res, copyLibraryEntry(store, projectId, parts[4], fields.to), 201);
            }
          } catch (error) {
            fail(error.message, error.status);
          }
          fail('Unknown library action.', 404);
        }
        // Deleting a project (v1.0 item 24): its name typed back confirms it.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'delete' && !parts[4] && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before deleting it.');
          if (Object.keys(data).some(key => !['projectId', 'name'].includes(key)))
            fail('Deleting a project takes its name, typed to confirm.');
          try {
            return json(res, deleteProject(store, projectId, data.name));
          } catch (error) {
            fail(error.message, error.status);
          }
        }
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'autonomy' && !parts[4]) {
          if (parts[2] !== projectId) fail('Select this project before editing its autonomy policy.');
          const { projectId: selected, ...policy } = data,
            saved = saveAutonomyPolicy(store, registries, projectId, policy);
          // Turning on the setting that sends waiting ideas sends one at once to a line that is free (1.1 step 2a).
          runner.autonomy.sendWaiting(projectId);
          return json(res, saved);
        }
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'organization' && !parts[4]) {
          if (parts[2] !== projectId) fail('Select this project before editing its organization.');
          if (data.preset !== undefined) {
            if (
              data.preset !== 'studio-development' ||
              Object.keys(data).some(key => !['projectId', 'preset', 'expectedRevision'].includes(key))
            )
              fail('Unknown project organization preset.');
            if (store.setting('project-organization:' + projectId))
              fail('Project defaults cannot replace an existing configuration. Edit its teams and roles instead.');
            const config = developmentOrganization(sharedAgents(store.organization()));
            config.expectedRevision = data.expectedRevision;
            return json(res, saveProjectOrganization(store, registries, projectId, config));
          }
          const { projectId: selected, ...config } = data;
          return json(res, saveProjectOrganization(store, registries, projectId, config));
        }
        if (parts[1] === 'projects' && parts[2] && !parts[3] && req.method === 'PATCH') {
          if (parts[2] !== projectId) fail('Select this project before editing it.');
          if (
            Object.keys(data).some(
              key => !['projectId', 'expectedRevision', 'name', 'goal', 'direction', 'color'].includes(key),
            )
          )
            fail('Unsupported project fields.');
          const project = store.project(projectId);
          if (data.expectedRevision !== project.revision)
            fail('Project direction changed. Refresh before saving.', 409);
          // The color the director chose for the project's mark, by its name in the dashboard's palette, or null
          // for the one the project's place gives it. It is not direction, so it records no new revision.
          const color = data.color === undefined ? project.color : data.color;
          if (color != null && (typeof color !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(color)))
            fail('A project color is the name of one in the palette.');
          let directed = false;
          if (['name', 'goal', 'direction'].some(key => data[key] !== undefined)) {
            const name = text(data.name, 'Project name', 100, true);
            if (store.projects().some(item => item.id !== projectId && item.name.toLowerCase() === name.toLowerCase()))
              fail('Choose a distinct project name.');
            const next = {
              name,
              goal: text(data.goal || '', 'Project goal'),
              direction: text(data.direction || '', 'Project direction'),
            };
            directed = Object.keys(next).some(key => next[key] !== (project[key] ?? ''));
            if (directed)
              Object.assign(project, next, { revision: project.revision + 1, updatedAt: new Date().toISOString() });
          }
          const colored = (color ?? null) !== (project.color ?? null);
          if (color == null) delete project.color;
          else project.color = color;
          if (directed || colored) store.putProject(project);
          if (directed)
            store.event('project_updated', null, null, 'Project direction updated for future attempts.', projectId);
          if (colored) store.event('project_color', null, null, 'Project color changed.', projectId);
          return json(res, project);
        }
        // A project's own repository inspected again, with its recorded profile or an edited one, and an edited
        // profile recorded once the project's tests pass with it (Settings: Check again, Edit the profile).
        if (
          parts[1] === 'projects' &&
          parts[2] &&
          parts[3] === 'source' &&
          (!parts[4] || parts[4] === 'inspect') &&
          !parts[5] &&
          req.method === 'POST'
        ) {
          if (parts[2] !== projectId) fail("Select this project before changing its repository's settings.");
          const inspect = parts[4] === 'inspect';
          if (
            Object.keys(data).some(
              key => !['projectId', 'profile', ...(inspect ? [] : ['expectedRevision'])].includes(key),
            )
          )
            fail('Unsupported repository profile fields.');
          if (inspect)
            try {
              return json(res, inspectProjectSource(store, projectId, runner, data.profile));
            } catch (error) {
              fail(error.message);
            }
          if (data.profile === undefined) fail('Give the edited profile.');
          let edited;
          try {
            edited = await editProjectProfile(store, projectId, runner, {
              expectedRevision: data.expectedRevision,
              profile: data.profile,
            });
          } catch (error) {
            fail(error.message, error.status);
          }
          store.event(
            'project_profile',
            null,
            null,
            `Repository settings revision ${edited.source.revision} recorded for future stories; its tests: ${testsSentence(edited.tests)}.`,
            projectId,
          );
          return json(res, edited);
        }
        // A project's release lines (1.1 step 1): a line for a branch, or for a new branch made at a tag, branch or
        // commit (POST), and retiring a line or keeping it again (PATCH).
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'lines' && !parts[4]) {
          if (parts[2] !== projectId) fail('Select this project before changing its lines.');
          if (req.method === 'POST') {
            if (Object.keys(data).some(key => !['projectId', 'branch', 'from'].includes(key)))
              fail('A line takes a branch and an optional starting point.');
            try {
              return json(res, { lines: addProjectLine(store, projectId, runner, data) }, 201);
            } catch (error) {
              fail(error.message);
            }
          }
          if (Object.keys(data).some(key => !['projectId', 'branch', 'retired'].includes(key)))
            fail('Retiring a line takes its branch and whether it is retired.');
          try {
            return json(res, { lines: retireProjectLine(store, projectId, data) });
          } catch (error) {
            fail(error.message);
          }
        }
        // Version lines (decided by the director, November 2, 2026): each version has its own line and releases ship to
        // shipsTo, which moves only when one is released.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'version-lines' && !parts[4] && req.method === 'POST') {
          if (parts[2] !== projectId) fail('Select this project before changing how it releases.');
          if (Object.keys(data).some(key => !['projectId', 'shipsTo'].includes(key)))
            fail('Version lines take shipsTo, the branch releases ship to.');
          try {
            return json(res, useVersionLines(store, projectId, runner, { shipsTo: data.shipsTo }));
          } catch (error) {
            fail(error.message);
          }
        }
        // A project's milestones (1.1 step 2a): one made for a version (POST) and its goal edited (PATCH); an idea
        // written into one to send later, and a waiting idea sent now or dropped.
        if (parts[1] === 'projects' && parts[2] && parts[3] === 'milestones') {
          if (parts[2] !== projectId) fail('Select this project before changing its milestones.');
          const settle = fn => {
            try {
              return fn();
            } catch (error) {
              fail(error.message);
            }
          };
          if (!parts[4] && req.method === 'POST') {
            if (Object.keys(data).some(key => !['projectId', 'version', 'goal'].includes(key)))
              fail('A milestone takes a version and an optional goal.');
            const milestone = settle(() =>
              makeMilestone(store, projectId, runner, { version: data.version, goal: data.goal ?? '' }),
            );
            return json(res, { milestone, milestones: projectMilestones(store, projectId) }, 201);
          }
          if (!parts[4] && req.method === 'PATCH') {
            if (Object.keys(data).some(key => !['projectId', 'id', 'goal'].includes(key)))
              fail('Editing a milestone takes its ID and goal.');
            return json(res, { milestone: settle(() => editMilestone(store, projectId, data)) });
          }
          // Release on a milestone and Push (1.1 step 5): Release asks the planner for the notes, and moves open work on
          // when moveOpen is set; accepting the notes tags it. Release again after it stopped. Push, confirmed.
          if (parts[4] && parts[5] === 'release' && req.method === 'POST') {
            if (!parts[6]) {
              if (Object.keys(data).some(key => !['projectId', 'moveOpen'].includes(key)))
                fail('Release takes moveOpen, whether to move open work to the next milestone.');
              let task;
              try {
                task = startRelease(store, runner, projectId, parts[4], { moveOpen: data.moveOpen === true });
              } catch (error) {
                fail(error.message, error.status);
              }
              return json(res, { task, milestones: projectMilestones(store, projectId) }, 201);
            }
            if (parts[6] === 'again' && !parts[7]) {
              if (Object.keys(data).some(key => key !== 'projectId')) fail('Unsupported release fields.');
              const release = settle(() => releaseAgain(store, projectId, parts[4]));
              runner.autonomy.tryReleases();
              return json(res, release, 202);
            }
          }
          // Ship again, after a release's shipping to the branch releases ship to stopped (version lines).
          if (parts[4] && parts[5] === 'ship' && !parts[6] && req.method === 'POST') {
            if (Object.keys(data).some(key => key !== 'projectId')) fail('Ship again takes no fields.');
            return json(res, { shipped: settle(() => shipAgain(store, projectId, parts[4])) });
          }
          if (parts[4] && parts[5] === 'push' && !parts[6] && req.method === 'POST') {
            if (Object.keys(data).some(key => !['projectId', 'confirm'].includes(key)))
              fail('Push takes confirm: true.');
            try {
              return json(res, await pushRelease(store, runner, projectId, parts[4], { confirm: data.confirm }));
            } catch (error) {
              fail(error.message);
            }
          }
          if (parts[4] && parts[5] === 'ideas' && !parts[6] && req.method === 'POST') {
            if (Object.keys(data).some(key => !['projectId', 'idea', 'autoMode'].includes(key)))
              fail('A waiting idea takes its words and an optional auto mode.');
            const waiting = settle(() =>
              addWaitingIdea(store, projectId, { milestoneId: parts[4], idea: data.idea, autoMode: data.autoMode }),
            );
            runner.autonomy.sendWaiting(projectId);
            return json(res, waiting, 201);
          }
          // A waiting idea's place in its milestone, or a move to another milestone (1.1 step 6).
          if (
            parts[4] &&
            parts[5] === 'ideas' &&
            parts[6] &&
            ['order', 'move'].includes(parts[7]) &&
            !parts[8] &&
            req.method === 'POST'
          ) {
            const field = parts[7] === 'order' ? 'index' : 'milestone';
            if (Object.keys(data).some(key => !['projectId', field].includes(key)))
              fail(parts[7] === 'order' ? 'Ordering takes the idea’s new place.' : 'Moving takes the milestone.');
            settle(() =>
              parts[7] === 'order'
                ? orderWaitingIdea(store, projectId, parts[4], parts[6], data.index)
                : moveWaitingIdea(store, projectId, parts[4], parts[6], data.milestone),
            );
            if (parts[7] === 'move') runner.autonomy.sendWaiting(projectId);
            return json(res, { milestones: projectMilestones(store, projectId) });
          }
          if (
            parts[4] &&
            parts[5] === 'ideas' &&
            parts[6] &&
            ['send', 'remove'].includes(parts[7]) &&
            !parts[8] &&
            req.method === 'POST'
          ) {
            if (Object.keys(data).some(key => key !== 'projectId')) fail('Unsupported waiting idea fields.');
            if (parts[7] === 'remove') {
              const { milestone } = settle(() => takeWaitingIdea(store, projectId, parts[4], parts[6]));
              store.event(
                'idea_removed',
                null,
                null,
                `A waiting idea was taken out of milestone ${milestone.version}.`,
                projectId,
              );
              return json(res, { milestones: projectMilestones(store, projectId) });
            }
            return json(
              res,
              settle(() =>
                sendWaitingIdea(store, registries, runner, projectId, parts[4], parts[6], { type: 'director' }),
              ),
              201,
            );
          }
        }
        if (parts[1] === 'workflows') {
          if (parts[3] === 'run' && req.method === 'POST') {
            const workflow = store.workflow(parts[2]);
            assertProject(store, workflow, projectId);
            if (data.expectedVersion !== workflow.version)
              fail('Workflow changed. Refresh before creating its run.', 409);
            const brief = text(data.brief ?? '', 'Run brief', 4000);
            const { runId, tasks, budget, run } = materializeWorkflow(store, registries, workflow, { brief });
            store.tx(() => {
              tasks.forEach(task => store.putTask(task));
              store.putRun(run);
              runner.enablePipeline(projectId);
            });
            store.event(
              'workflow_started',
              tasks[0].id,
              null,
              `Director created workflow run: ${workflow.name}${brief ? ' with a run brief' : ''}. Results require acceptance.`,
              projectId,
            );
            return json(res, { runId, taskIds: tasks.map(task => task.id), budget }, 201);
          }
          if ((req.method === 'POST' && !parts[2]) || (req.method === 'PATCH' && parts[2] && !parts[3])) {
            if (
              Object.keys(data).some(
                key => !['projectId', 'name', 'description', 'steps', 'graph', 'expectedVersion'].includes(key),
              )
            )
              fail('Unsupported workflow fields.');
            const previous = parts[2] ? store.workflow(parts[2]) : null;
            if (previous) {
              assertProject(store, previous, projectId);
              if (data.expectedVersion !== previous.version) fail('Workflow changed. Refresh before saving.', 409);
            } else if (store.workflows(projectId).length >= 50) fail('Workflow limit reached.');
            // A workflow is saved as a graph-v1 spec or, as before, a step list (MP-015 G2).
            if ((data.graph === undefined) === (data.steps === undefined))
              fail('Save a workflow as either a graph or a step list.');
            const budget =
              data.graph === undefined
                ? validateWorkflow(store, registries, data.steps, projectId)
                : validateGraph(store, registries, data.graph, projectId);
            const workflow = {
              id: previous?.id || 'workflow-' + randomUUID(),
              projectId,
              name: text(data.name, 'Workflow name', 160, true),
              description: text(data.description || '', 'Workflow description', 4000),
              version: (previous?.version || 0) + 1,
              ...(data.graph === undefined
                ? { steps: structuredClone(data.steps) }
                : { graph: structuredClone(data.graph) }),
              budget,
              createdAt: previous?.createdAt || new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            };
            store.putWorkflow(workflow);
            store.event('workflow_saved', null, null, `Saved workflow: ${workflow.name}.`, projectId);
            return json(res, workflow, previous ? 200 : 201);
          }
          fail('Unknown workflow action.');
        }
        if (url.pathname === '/api/pipeline') return json(res, runner.pipeline(data.action, data.taskIds, projectId));
        if (url.pathname === '/api/integrations' && req.method === 'POST') {
          if (
            Object.keys(data).some(
              key => !['projectId', 'sourceTaskId', 'attemptId', 'manifestHash', 'workerId', 'title'].includes(key),
            )
          )
            fail('Integration requests select accepted inputs; editor tools and target pins cannot be supplied.');
          const source = acceptedReference(store, data.sourceTaskId, data.attemptId, projectId);
          const a = store.attempt(source.attemptId),
            item = a.artifacts.find(
              item =>
                item.path === 'manifest.json' && item.kind === 'unreal-manifest' && item.hash === data.manifestHash,
            );
          if (!item || item.bytes > 64 * 1024) fail('Select a bounded accepted manifest.json and its registered hash.');
          const manifest = JSON.parse(fs.readFileSync(artifactPath(store, a, item.path), 'utf8'));
          const integration = runner.gateway.prepare(source, item, manifest);
          assertProjectKind(store, registries, projectId, 'unreal-integration');
          const worker = projectOrganization(store, projectId).workers.find(w => w.id === data.workerId && w.enabled);
          if (!worker) fail('Choose an enabled integration owner employee.');
          if (
            store
              .tasks()
              .some(
                t =>
                  t.integration?.pin.projectId === integration.pin.projectId &&
                  t.integration?.manifest.namespace === manifest.namespace,
              )
          )
            fail('This target namespace is already assigned; mutations are never replayed.', 409);
          const task = {
            id: 'U-' + randomUUID().slice(0, 8),
            title: text(data.title || 'Blockout integration fixture', 'Title', 160, true),
            kind: 'unreal-integration',
            workerId: worker.id,
            team: worker.team,
            goalId: null,
            brief:
              'Assemble only the pinned accepted blockout through the controller-owned gateway. This release supports model-free fixtures only.',
            acceptance:
              'Validated saved/reloaded target, exact actors and registered screenshot evidence; director acceptance required.',
            integration,
            dependencies: [source.taskId],
            acceptedInputs: [source],
            resources: ['unreal:editor'],
            maxSeconds: 120,
            maxAttempts: 1,
            direction: '',
            status: 'ready',
            reason: '',
            hold: false,
            queued: false,
            lastAttemptId: null,
            createdAt: new Date().toISOString(),
          };
          task.projectId = projectId;
          store.putTask(task);
          store.event(
            'integration_created',
            task.id,
            null,
            'Bounded controller-owned integration created from an exact accepted manifest. Explicit start or queue approval required.',
          );
          return json(res, task, 201);
        }
        if (url.pathname === '/api/plans' && req.method === 'POST') {
          assertProjectKind(store, registries, projectId, 'plan');
          const org = projectOrganization(store, projectId),
            worker = org.workers.find(
              w =>
                w.id === data.workerId &&
                w.enabled &&
                registries.adapters.list().some(adapter => adapter.id === w.provider && adapter.workerSelectable),
            );
          if (!worker) fail('Choose an enabled planner employee.');
          let repairContext = null,
            reviewedTask;
          if (data.reviewTaskId !== undefined) {
            reviewedTask = store.task(data.reviewTaskId);
            assertProject(store, reviewedTask, projectId);
            if (
              reviewedTask.kind !== 'review' ||
              reviewedTask.status !== 'done' ||
              data.attemptId !== reviewedTask.acceptedAttemptId
            )
              fail('Choose the exact accepted review report before requesting repairs.', 409);
            const a = store.attempt(data.attemptId),
              item = a.artifacts.find(item => item.path === 'review.json');
            if (!item || data.reviewHash !== item.hash || !['revise', 'blocked'].includes(a.reviewVerdict))
              fail('Repair planning requires an accepted revise or blocked report and its recorded hash.', 409);
            const reportRef = acceptedReference(store, reviewedTask.id, a.id, projectId);
            if (item.bytes > 64 * 1024)
              fail('Review findings are too large for bounded repair planning. Scope a smaller report.');
            const report = validateReview(JSON.parse(fs.readFileSync(artifactPath(store, a, item.path), 'utf8')));
            if (report.verdict !== a.reviewVerdict || !a.inputReferences.length || a.inputReferences.length > 19)
              fail('Repair planning needs 1 to 19 exact accepted reviewed sources. Scope missing inputs manually.');
            const sources = a.inputReferences.map(ref => {
              const source = acceptedReference(store, ref.taskId, ref.attemptId, projectId);
              if (
                source.artifacts.length !== ref.artifacts.length ||
                source.artifacts.some(
                  (item, i) =>
                    item.hash !== ref.artifacts[i].hash ||
                    item.kind !== ref.artifacts[i].kind ||
                    ref.artifacts[i].path !== `../inputs/${ref.taskId}/${i}-${path.basename(item.path)}`,
                )
              )
                fail('Reviewed inputs no longer match their accepted source manifest.', 409);
              return source;
            });
            repairContext = {
              review: { taskId: reviewedTask.id, attemptId: a.id, hash: item.hash },
              verdict: report.verdict,
              findings: report.findings,
              evidence: report.evidence,
              acceptedInputs: [reportRef, ...sources],
            };
            validateAcceptedReferences(store, repairContext.acceptedInputs, projectId);
            if (Buffer.byteLength(JSON.stringify(repairContext)) > 128 * 1024)
              fail('Repair context is too large. Scope a smaller review.');
            if (reviewedTask.repairPlanTaskId) return json(res, store.task(reviewedTask.repairPlanTaskId));
          }
          const title = repairContext
            ? `Repair plan: ${reviewedTask.title}`.slice(0, 160)
            : text(data.title, 'Plan title', 160, true);
          const brief = repairContext
            ? `Propose new bounded assignments to address the accepted ${repairContext.verdict} review. Use the pinned review findings and exact reviewed sources; keep all accepted artifacts immutable. Include independent review of the new accepted repair. Surface missing tools and director decisions.\n${text(data.brief || '', 'Additional repair direction', 23000)}`
            : text(data.brief, 'Director brief', 24000, true);
          const t = {
            id: 'P-' + randomUUID().slice(0, 8),
            title,
            brief,
            acceptance:
              'Return a bounded plan.json proposal using the recorded roster and planning contract. Do not execute proposed work.',
            kind: 'plan',
            workerId: worker.id,
            team: worker.team,
            goalId: null,
            dependencies: repairContext?.acceptedInputs.map(ref => ref.taskId) || [],
            resources: [],
            maxSeconds: 120,
            maxAttempts: 3,
            direction: '',
            status: 'ready',
            reason: '',
            hold: false,
            queued: true,
            lastAttemptId: null,
            createdAt: new Date().toISOString(),
            ...(repairContext ? { repairContext, acceptedInputs: repairContext.acceptedInputs } : {}),
          };
          t.projectId = projectId;
          if (data.proposalMode !== undefined && data.proposalMode !== 'backlog')
            fail('Unsupported planning proposal mode.');
          if (data.proposalMode === 'backlog') t.proposalMode = 'backlog';
          store.tx(() => {
            store.putTask(t);
            runner.enablePipeline(projectId);
            if (reviewedTask) {
              reviewedTask.repairPlanTaskId = t.id;
              store.putTask(reviewedTask);
            }
          });
          store.event(
            'plan_requested',
            t.id,
            null,
            `Director requested a bounded plan from ${worker.displayName}. Proposed work waits for approval.`,
          );
          return json(res, t, 201);
        }
        if (url.pathname === '/api/tasks' && req.method === 'POST') {
          const org = projectOrganization(store, projectId),
            worker = org.workers.find(w => w.id === data.workerId);
          if (!worker || !worker.enabled) fail('Choose an enabled employee.');
          const definition = registries.workflows.get(data.kind);
          assertProjectKind(store, registries, projectId, data.kind);
          if (!definition.creatable) fail('Unknown assignment kind.');
          let inputData;
          if (definition.operation?.source === 'task-data')
            inputData = registries.connectors.inputData(definition.operation, data.inputData);
          else if (data.inputData !== undefined) fail('This assignment does not accept supplied input data.');
          if (data.operation !== undefined)
            fail('Operation bindings are trusted workflow configuration, not assignment permissions.');
          let execution;
          try {
            execution = taskExecution(registries.adapters, worker, data.execution);
          } catch (error) {
            fail(error.message);
          }
          const dependencies = Array.isArray(data.dependencies) ? [...new Set(data.dependencies)] : [];
          if (dependencies.length > 20) fail('Too many dependencies.');
          dependencies.forEach(id => assertProject(store, store.task(id), projectId));
          const resources = Array.isArray(data.resources) ? [...new Set(data.resources)] : [];
          if (resources.length > 10 || resources.some(r => typeof r !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(r)))
            fail('Invalid shared resource name.');
          let limits;
          if (data.complexity !== undefined) {
            validateComplexity(data.complexity);
            limits = complexityPolicy[data.complexity];
          }
          const maxSeconds = limits?.maxSeconds ?? data.maxSeconds ?? 120;
          if (!limits && (!Number.isInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > 600))
            fail('Time limit must be 5 to 600 seconds.');
          const team = org.teams.find(t => t.name === worker.team);
          const t = {
            id: 'T-' + randomUUID().slice(0, 8),
            title: text(data.title, 'Title', 160, true),
            brief: text(data.brief, 'Brief', 24000, true),
            acceptance: text(data.acceptance || '', 'Acceptance criteria'),
            kind: data.kind,
            workerId: worker.id,
            team: worker.team,
            goalId: data.countsTowardGoal ? team.id : null,
            dependencies,
            resources,
            maxSeconds,
            maxAttempts: limits?.maxAttempts ?? 3,
            direction: '',
            status: 'ready',
            reason: '',
            hold: false,
            lastAttemptId: null,
            createdAt: new Date().toISOString(),
          };
          t.projectId = projectId;
          if (limits) t.complexity = data.complexity;
          if (inputData !== undefined) t.inputData = inputData;
          if (execution) t.execution = execution;
          if (data.planned !== undefined && typeof data.planned !== 'boolean') fail('Planned must be true or false.');
          if (data.planned) {
            t.status = 'backlog';
            t.approval = { status: 'pending' };
            t.reason = 'Awaiting director work approval.';
          }
          t.teamId = worker.teamId;
          t.organizationReference = org.projectOrganization;
          store.tx(() => {
            store.putTask(t);
            if (t.goalId) {
              team.goalTaskIds.push(t.id);
              const config = store.setting('project-organization:' + projectId);
              if (config) {
                config.teams = org.teams;
                store.putSetting('project-organization:' + projectId, config);
              } else store.setOrganization(org);
            }
          });
          store.event('created', t.id, null, `Assigned ${t.title} to ${worker.displayName}.`);
          return json(res, t, 201);
        }
        if (parts[1] === 'tasks') {
          const t = store.task(parts[2]),
            action = parts[3];
          assertProject(store, t, projectId);
          validateTaskProject(store, t);
          if (action === 'project-owner') {
            if (Object.keys(data).some(key => !['projectId', 'workerId'].includes(key)))
              fail('Unsupported owner fields.');
            return json(res, reassignProjectDraft(store, registries, t, data.workerId));
          }
          // A story's pages for the visual check (1.2 step 8): the director's change applies to the next check.
          if (action === 'pages') {
            if (Object.keys(data).some(key => !['projectId', 'pages'].includes(key)))
              fail('A story takes only its pages.');
            try {
              return json(res, { pages: setStoryPages(store, t, data.pages) });
            } catch (error) {
              fail(error.message, error.status);
            }
          }
          // Try it (1.2 step 7): the project's try copy moves to this story's candidate, at the director's click.
          if (action === 'try') {
            if (Object.keys(data).some(key => !['projectId', 'discard'].includes(key)))
              fail('Try it takes only whether to discard your edits in the copy.');
            try {
              return json(res, await tryStory(runner, t, { discard: data.discard === true }));
            } catch (error) {
              fail(error.message, error.status, error.edits ? { edits: error.edits } : undefined);
            }
          }
          if (action === 'approve-work') {
            const approved = approveWork(store, registries, t);
            runner.autonomy.approved(t.id);
            return json(res, approved);
          }
          // The director's reply to an accepted plan whose steps have not started (the chat box, October 30): the steps
          // are set aside and the plan runs again with the reply, started as the director's Start.
          if (action === 'replan') {
            if (Object.keys(data).some(key => !['projectId', 'direction'].includes(key)))
              fail('A reply to a plan takes only its words.');
            const replanned = replanWork(store, registries, t, data.direction);
            let start;
            try {
              start = runner.queueStart(t.id);
            } catch (error) {
              start = { ok: false, reason: error.message };
            }
            return json(res, { ...replanned, start }, 202);
          }
          // Work denied or closed may free its line for a milestone's next waiting idea (1.1 step 2a).
          if (action === 'deny-work') {
            const denied = denyWork(store, t, data.reason || '');
            runner.autonomy.sendWaiting(projectId);
            return json(res, denied);
          }
          if (action === 'close') {
            if (Object.keys(data).some(key => !['projectId', 'reason'].includes(key)))
              fail('Unsupported close fields.');
            if (runner.autonomy.pendingIntegration()?.taskId === t.id)
              fail('Integration is approved for this work and waiting to run; it cannot be closed now.', 409);
            const closed = closeStartedWork(store, registries, t, data.reason ?? '');
            runner.autonomy.sendWaiting(projectId);
            return json(res, closed);
          }
          // Back to implementation with the review's findings, then queued like Start.
          if (action === 'send-back') {
            if (Object.keys(data).some(key => !['projectId', 'note'].includes(key)))
              fail('Unsupported send-back fields.');
            // An integration approved for this work (by the director or the policy) is refused in the same
            // transaction that would send it back, so the two can never both happen.
            const sent = sendBackWork(store, registries, t, data.note ?? '', {
              refuse: () =>
                runner.autonomy.pendingIntegration()?.taskId === t.id &&
                Object.assign(
                  new Error('Integration is approved for this work and waiting to run; it cannot be sent back now.'),
                  { status: 409 },
                ),
            });
            let start;
            try {
              start = runner.queueStart(t.id);
            } catch (error) {
              // The work is sent back either way; Start can be pressed once the problem is resolved.
              start = { ok: false, reason: error.message };
            }
            return json(res, { ...sent, start }, 202);
          }
          // Merge onto the current source (1.1 step 3): a story whose integration stopped on a conflict goes back to its
          // editor with its change applied to the line's tip by git, then queued like Start.
          if (action === 'merge-source') {
            if (Object.keys(data).some(key => key !== 'projectId')) fail('Unsupported merge fields.');
            let merged;
            try {
              merged = mergeSourceStory(store, registries, t);
            } catch (error) {
              fail(error.message);
            }
            let start;
            try {
              start = runner.queueStart(t.id);
            } catch (error) {
              start = { ok: false, reason: error.message };
            }
            return json(res, { ...merged, start }, 202);
          }
          // Carry to <branch> and Not needed on <branch> (1.1 step 4): the director approves a fix's next carry, which
          // runs when the project's source is free, or skips that line with a reason.
          if (action === 'carry' || action === 'carry-skip') {
            const allowed = action === 'carry' ? ['projectId', 'line'] : ['projectId', 'line', 'reason'];
            if (Object.keys(data).some(key => !allowed.includes(key))) fail('Unsupported carry fields.');
            let carry;
            try {
              carry =
                action === 'carry' ? approveCarry(store, t, data.line) : skipCarry(store, t, data.line, data.reason);
            } catch (error) {
              fail(error.message);
            }
            runner.autonomy.tryCarries();
            return json(res, { carry, carries: store.attempt(t.sourceStage.review.attemptId).sourceCarries }, 202);
          }
          // Bring back to <branch> (1.1, October 27): the director brings a fix that landed on a newer line back to an
          // older one and every maintained line between, carried as carries are when the project's source is free.
          if (action === 'bring-back') {
            if (Object.keys(data).some(key => !['projectId', 'line'].includes(key))) fail('Bring back takes the line.');
            let planned;
            try {
              planned = bringBack(store, t, data.line);
            } catch (error) {
              fail(error.message);
            }
            runner.autonomy.tryCarries();
            return json(res, { ...planned, carries: store.attempt(t.sourceStage.review.attemptId).sourceCarries }, 202);
          }
          // The director approves commands Claude Code refused to the employee, which then apply to every
          // Claude employee's future attempts, and starts the work again from what it left (v1.0 item 22).
          if (action === 'allow-commands') {
            if (Object.keys(data).some(key => !['projectId', 'attemptId', 'commands'].includes(key)))
              fail('Allow commands takes the attempt and the commands.');
            const a = t.lastAttemptId && store.attempt(t.lastAttemptId);
            if (!a || a.id !== data.attemptId || t.status !== 'blocked' || a.status !== 'blocked')
              fail("Commands are allowed from the stopped work's latest attempt only.", 409);
            if (!a.commandDenials?.some(denial => denial.tool === 'Bash'))
              fail('Claude Code refused no commands in this attempt.', 409);
            const org = store.organization();
            let approved, commands;
            try {
              approved = approveCommands(org, data.commands);
              commands = [...new Set(data.commands.map(commandRule))];
            } catch (error) {
              fail(error.message);
            }
            store.tx(() => {
              store.setOrganization(org);
              (t.commandApprovals ||= []).push({ attemptId: a.id, commands, at: new Date().toISOString() });
              store.putTask(t);
            });
            store.event('commands_approved', t.id, a.id, `Approved for Claude employees: ${commands.join(', ')}.`);
            let start;
            try {
              start = runner.queueStart(t.id);
            } catch (error) {
              start = { ok: false, reason: error.message };
            }
            return json(res, { ok: true, agentPermissions: approved, start }, 202);
          }
          // The director changes a stopped story's files and sends it back, keeping its work.
          if (action === 'edit-scope') {
            const { projectId: _project, ...edit } = data;
            const edited = editSourceStory(store, t, edit, sourceRoot(store, t, runner));
            let start;
            try {
              start = runner.queueStart(t.id);
            } catch (error) {
              start = { ok: false, reason: error.message };
            }
            return json(res, { ...edited, start }, 202);
          }
          if (action === 'propose-work' || action === 'accept-proposal') {
            const attemptId = t.status === 'done' ? t.acceptedAttemptId : t.lastAttemptId;
            if (!['review', 'done'].includes(t.status) || data.attemptId !== attemptId)
              fail('Choose the current completed proposal.', 409);
            const a = store.attempt(attemptId),
              prepared = prepareProposedWork(store, registries, t, a);
            if (prepared.evidence.hash !== data.proposalHash)
              fail('Proposal evidence changed. Refresh before reviewing work.', 409);
            if (t.materializedTaskIds) return json(res, { taskIds: t.materializedTaskIds });
            if (action === 'accept-proposal' && t.kind !== 'plan')
              fail('Accept this report through its normal review.');
            store.tx(() => {
              recordProposedWork(store, t, prepared);
              if (action === 'accept-proposal' && t.status === 'review') {
                a.status = 'accepted';
                a.acceptedAt = new Date().toISOString();
                t.status = 'done';
                t.queued = false;
                t.reason = '';
                delete t.autonomyNote;
                t.acceptedAttemptId = a.id;
                store.updateAttempt(a);
                store.putTask(t);
              }
            });
            store.event(
              'work_proposed',
              t.id,
              a.id,
              'Proposed work is in Planned. Approve or deny each task; nothing was dispatched.',
            );
            return json(res, { taskIds: prepared.taskIds });
          }
          // A director's Start may carry a note for the next attempt (the dashboard asks for one past the attempt
          // limit), recorded as a PATCH direction is before the work starts; without one the direction is unchanged.
          // Work that Start refuses for its state keeps its direction.
          if (action === 'start') {
            if (data.direction !== undefined) {
              const direction = text(data.direction, 'Direction');
              if (!['ready', 'failed', 'cancelled', 'blocked'].includes(t.status))
                fail('Only ready or stopped assignments can start.');
              registries.workflows.direct(t, direction);
              store.putTask(t);
              store.event('task_updated', t.id, null, 'Direction for the next attempt updated with Start.');
            }
            return json(res, runner.queueStart(t.id), 202);
          }
          // The director answers the question the task's latest attempt stopped to ask (1.2 step 2): one of its options,
          // their own words, or both, and optionally the work's auto mode from here on (the message box's Auto mode).
          // The answer becomes the next attempt's direction and the work starts as by Start, continuing from the saved
          // work. Change-answer replaces auto mode's answer the same way, stopping an attempt still working on it.
          if (action === 'answer' || action === 'change-answer') {
            if (Object.keys(data).some(key => !['projectId', 'attemptId', 'option', 'text', 'autoMode'].includes(key)))
              fail('An answer takes the attempt that asked, an optional option, optional text and optional auto mode.');
            const fields = { attemptId: data.attemptId, option: data.option, text: data.text, autoMode: data.autoMode };
            if (action === 'answer') {
              let answer;
              try {
                answer = answerQuestion(store, registries, t, fields, {
                  type: 'director',
                  at: new Date().toISOString(),
                });
              } catch (error) {
                fail(error.message);
              }
              return json(res, { answer, start: runner.queueStart(t.id) }, 202);
            }
            let changed;
            try {
              changed = changeAnswer(store, registries, t, fields);
            } catch (error) {
              fail(error.message);
            }
            if (changed.stop) runner.stop(changed.stop);
            return json(
              res,
              { answer: changed.answer, start: changed.stop || t.answerChange ? null : runner.queueStart(t.id) },
              202,
            );
          }
          // overrideReason: the director integrates over a review that requested changes (MP-019).
          if (action === 'integrate-source')
            return json(
              res,
              runner.autonomy.requestIntegration(
                t,
                data.attemptId,
                data.reviewHash,
                data.overrideReason !== undefined ? { override: { reason: data.overrideReason } } : {},
              ),
            );
          if (action === 'restore-source') return json(res, restoreSourceIntegration(runner, t));
          if (action === 'cancel') {
            runner.stop(t.lastAttemptId);
            return json(res, { ok: true }, 202);
          }
          if (action === 'reconcile') {
            await runner.reconcile(t.id);
            return json(res, { ok: true });
          }
          if (action === 'approve-plan') {
            if (t.kind !== 'plan') fail('This assignment is not a plan.');
            if (t.status === 'done' && t.approvedPlanHash === data.planHash && t.acceptedAttemptId === data.attemptId)
              return json(res, { ok: true, taskIds: t.materializedTaskIds });
            if (t.status !== 'review' || data.attemptId !== t.lastAttemptId)
              fail('Approve the current reviewed plan attempt.', 409);
            const a = store.attempt(t.lastAttemptId),
              item = a.artifacts.find(x => x.path === 'plan.json' && x.kind === 'plan');
            if (
              a.status !== 'review' ||
              a.result?.outcome !== 'completed' ||
              !item ||
              data.planHash !== item.hash ||
              a.result.checks.some(c => c.status === 'fail')
            )
              fail('Plan is not ready for approval.', 409);
            let planBytes;
            for (const artifact of a.artifacts) {
              const contents = fs.readFileSync(artifactPath(store, a, artifact.path));
              if (hash(contents) !== artifact.hash) fail('Plan artifact changed after validation.', 409);
              if (artifact === item) planBytes = contents;
            }
            const proposal = JSON.parse(planBytes.toString('utf8')),
              org = projectOrganization(store, projectId);
            assertProject(store, a, projectId);
            validateAcceptedReferences(store, a.planContext.acceptedInputs || [], projectId);
            if (
              a.planContext.project &&
              (a.planContext.project.id !== projectId ||
                a.planContext.project.revision !== store.project(projectId).revision)
            )
              fail('Project direction changed. Request a revised plan.', 409);
            validatePlan(proposal, a.planContext);
            validatePlan(proposal, planningContext(org, a.assignment.repairContext, projectId));
            for (const job of proposal.tasks) {
              const recorded = a.planContext.workers.find(w => w.id === job.workerId),
                current = org.workers.find(w => w.id === job.workerId);
              if (
                recorded.team !== current.team ||
                recorded.provider !== current.provider ||
                recorded.model !== (current.model || '')
              )
                fail(
                  'A proposed employee adapter, model or team changed. Request a revised plan before approving.',
                  409,
                );
            }
            const drafts = (t.proposedTaskIds || []).map(id => store.task(id));
            if (drafts.some(task => task.approval?.status !== 'pending'))
              fail('Proposed work already has individual decisions. Approve or deny the rest one at a time.', 409);
            const ids = new Map(
                proposal.tasks.map(job => [
                  job.key,
                  drafts.find(
                    task => task.proposalReference.attemptId === a.id && task.proposalReference.key === job.key,
                  )?.id || 'T-' + randomUUID().slice(0, 8),
                ]),
              ),
              now = new Date().toISOString();
            const tasks = proposal.tasks.map(job => {
              const worker = org.workers.find(w => w.id === job.workerId);
              const acceptedInputs = (job.acceptedInputs || []).map(taskId =>
                a.planContext.acceptedInputs.find(ref => ref.taskId === taskId),
              );
              return {
                ...job,
                ...(drafts.length ? { approval: { status: 'approved', decidedAt: now } } : {}),
                acceptedInputs,
                id: ids.get(job.key),
                team: worker.team,
                goalId: null,
                dependencies: [...job.dependencies.map(key => ids.get(key)), ...acceptedInputs.map(ref => ref.taskId)],
                direction: '',
                status: 'ready',
                reason: '',
                hold: false,
                queued: true,
                lastAttemptId: null,
                createdAt: now,
                planReference: {
                  taskId: t.id,
                  attemptId: a.id,
                  hash: item.hash,
                  key: job.key,
                  summary: proposal.summary,
                  directorBrief: a.assignment.brief,
                  ...(a.planContext.repair ? { review: a.planContext.repair.review } : {}),
                },
              };
            });
            tasks.forEach(task => {
              task.projectId = projectId;
              validateTaskProject(store, { ...task, dependencies: task.acceptedInputs.map(ref => ref.taskId) });
            });
            t.materializedTaskIds = tasks.map(job => job.id);
            t.approvedPlanHash = item.hash;
            t.status = 'done';
            t.queued = false;
            t.acceptedAttemptId = a.id;
            t.reason = '';
            delete t.autonomyNote;
            a.status = 'accepted';
            a.acceptedAt = now;
            store.tx(() => {
              tasks.forEach(job => store.putTask(job));
              store.updateAttempt(a);
              store.putTask(t);
              runner.enablePipeline(projectId);
            });
            store.event(
              'plan_approved',
              t.id,
              a.id,
              `Director approved ${tasks.length} shared assignments. Eligible work starts automatically; results require acceptance.`,
            );
            return json(res, { ok: true, taskIds: t.materializedTaskIds });
          }
          if (action === 'accept') {
            // Over a failed check, with the director's reason, where the step's contract allows it (November 2, 2026).
            if (Object.keys(data).some(key => !['projectId', 'overReason'].includes(key)))
              fail('Accepting takes only a reason, to accept over a failed check.');
            const accepted = acceptAttempt(
              store,
              registries,
              t,
              data.overReason !== undefined
                ? {
                    type: 'director',
                    over: { reason: text(data.overReason, 'Reason for accepting over a failed check', 2000, true) },
                  }
                : { type: 'director' },
            );
            runner.autonomy.accepted(t.id);
            return json(res, { ok: true, proposedTaskIds: accepted.proposedTaskIds });
          }
          if (action === 'revise') {
            if (t.status !== 'review') fail('Only work awaiting review can be revised.');
            // Past the attempt limit, the revised task waits for the director to press Start,
            // except where the task type's limit is a safety rule.
            if (registries.workflows.get(t.kind).fixedAttemptLimit && store.attempts(t.id).length >= t.maxAttempts)
              fail('Attempt limit reached. Create a newly scoped assignment.');
            const direction = text(data.direction, 'Revision direction', 24000, true);
            registries.workflows.direct(t, direction);
            const a = store.attempt(t.lastAttemptId);
            a.status = 'revision_requested';
            a.revisionRequestedBy = { type: 'director', at: new Date().toISOString(), reason: direction };
            store.updateAttempt(a);
            t.status = 'ready';
            t.reason = '';
            delete t.autonomyNote;
            registries.workflows.stageProgress(store, t);
            store.putTask(t);
            store.event('revision', t.id, a.id, direction);
            return json(res, { ok: true });
          }
          if (req.method === 'PATCH' && !action) {
            if (['running', 'stopping', 'done'].includes(t.status))
              fail('Edit future work only after its active attempt stops; accepted work stays recorded.');
            if (data.workerId !== undefined) {
              const w = projectOrganization(store, projectId).workers.find(w => w.id === data.workerId && w.enabled);
              if (!w || w.team !== t.team) fail('Reassignment must stay in the owning team.');
              t.workerId = w.id;
            }
            if (data.direction !== undefined) registries.workflows.direct(t, text(data.direction, 'Direction'));
            if (data.execution !== undefined) {
              const owner = projectOrganization(store, projectId).workers.find(w => w.id === t.workerId);
              let execution;
              try {
                execution = taskExecution(registries.adapters, owner, data.execution);
              } catch (error) {
                fail(error.message);
              }
              if (execution) t.execution = execution;
              else delete t.execution;
            }
            if (data.hold !== undefined) {
              if (typeof data.hold !== 'boolean') fail('Hold must be true or false.');
              t.hold = data.hold;
            }
            // The release a story is for, changed until it starts (1.1 step 2a).
            if (data.release !== undefined)
              try {
                moveStory(store, runner, t, data.release);
              } catch (error) {
                fail(error.message);
              }
            // Auto mode for this task's future attempts; null follows the Settings (v1.0 item 22).
            if (data.autoMode !== undefined) {
              try {
                taskAutoMode(data.autoMode);
              } catch (error) {
                fail(error.message);
              }
              if (data.autoMode === null) delete t.autoMode;
              else t.autoMode = data.autoMode;
            }
            store.putTask(t);
            store.event('task_updated', t.id, null, 'Future assignment settings updated.');
            return json(res, t);
          }
        }
        // The face the director chose for an agent: the agent kit's six part numbers, ten of each, or null for
        // the one picked from its project and role. It is how the agent looks, not how it runs, so its
        // configuration version and its attempts are unchanged.
        if (parts[1] === 'workers' && parts[3] === 'look' && !parts[4] && req.method === 'POST') {
          const org = store.organization(),
            w = org.workers.find(w => w.id === parts[2]);
          if (!w || w.deletedAt) fail('Employee not found.');
          // An agent that belongs to a project changes only from that project (1.0.1).
          if (w.projectId && w.projectId !== projectId) fail(`${w.displayName ?? w.id} belongs to another project.`);
          if (Object.keys(data).some(key => !['projectId', 'look'].includes(key))) fail('A face is its look alone.');
          let look;
          try {
            look = validFace(data.look);
          } catch (error) {
            fail(error.message);
          }
          if (look === null) delete w.look;
          else w.look = look;
          store.setOrganization(org);
          store.event('worker_look', null, null, `${w.displayName}: face changed.`);
          return json(res, { ok: true, look: w.look ?? null });
        }
        if (parts[1] === 'workers' && req.method === 'PATCH') {
          const org = store.organization(),
            w = org.workers.find(w => w.id === parts[2]);
          if (!w || w.deletedAt) fail('Employee not found.');
          if (w.projectId && w.projectId !== projectId) fail(`${w.displayName ?? w.id} belongs to another project.`);
          if (data.expectedVersion !== (w.configVersion || 1))
            fail('Employee configuration changed. Refresh before saving.', 409);
          // A new name (1.0.1): a shared agent's is distinct among every agent, a project's own among that project's.
          let renamed = null;
          try {
            if (data.displayName !== undefined)
              renamed = agentName(org, data.displayName, { projectId: w.projectId, except: w.id });
            applyWorkerExecution(registries.adapters, w, data);
          } catch (error) {
            fail(error.message);
          }
          if (data.paused !== undefined) {
            if (typeof data.paused !== 'boolean') fail('Pause must be true or false.');
            w.paused = data.paused;
          }
          const before = w.displayName;
          if (renamed !== null && renamed !== before) w.displayName = renamed;
          w.configVersion = (w.configVersion || 1) + 1;
          store.setOrganization(org);
          if (w.displayName !== before)
            store.event('worker_renamed', null, null, `${before} is now called ${w.displayName}.`);
          store.event('worker_updated', null, null, `${w.displayName}: configuration updated for future attempts.`);
          return json(res, w);
        }
        if (parts[1] === 'instructions') {
          const org = projectOrganization(store, projectId),
            scope = parts[2],
            id = parts[3],
            action = parts[4],
            doc = instruction(org, scope, id);
          if (
            (scope === 'team' && !org.teams.some(team => team.id === id)) ||
            (scope === 'employee' && !org.workers.some(worker => worker.id === id))
          )
            fail('Instruction scope is not in this project.');
          if (data.baseRevision !== doc.revision) fail('Published instructions changed. Refresh before saving.', 409);
          if (action === 'draft') {
            // A draft is its whole text, or its rules (1.2 step 1), which the controller writes as that text.
            if (data.rules !== undefined && data.text !== undefined) fail('Send a draft as its text or as its rules.');
            let draft = data.text;
            if (data.rules !== undefined)
              try {
                draft = formatRules(data.rules);
              } catch (error) {
                fail(error.message);
              }
            doc.draft = {
              text: text(draft, 'Instruction draft', 48000, true),
              baseRevision: doc.revision,
              savedAt: new Date().toISOString(),
            };
          } else if (action === 'discard') doc.draft = null;
          else if (action === 'publish') {
            if (!doc.draft || doc.draft.baseRevision !== doc.revision) fail('Save a current draft before publishing.');
            if (data.text !== doc.draft.text)
              fail('The saved draft differs from the editor. Save the current text as a draft before publishing.', 409);
            doc.revision++;
            doc.text = doc.draft.text;
            doc.publishedAt = new Date().toISOString();
            doc.draft = null;
            doc.history.push({
              revision: doc.revision,
              text: doc.text,
              publishedAt: doc.publishedAt,
              note: text(data.note || 'Published by director', 'Change note', 500),
            });
          } else fail('Unknown instruction operation.');
          saveProjectInstructions(store, projectId, org);
          store.event(
            'instructions',
            null,
            null,
            `${scope} ${id}: ${action}, published revision ${doc.revision}.`,
            projectId,
          );
          return json(res, doc);
        }
        if (url.pathname === '/api/preview') {
          const org = projectOrganization(store, projectId),
            w = org.workers.find(w => w.id === data.workerId),
            t = store.task(data.taskId);
          assertProject(store, t, projectId);
          validateTaskProject(store, t);
          if (!w || w.id !== t.workerId) fail('Preview the assignment’s assigned employee.');
          const inputs = t.dependencies.map(id => {
            const d = store.task(id),
              pinned = t.acceptedInputs?.find(ref => ref.taskId === id);
            return pinned || { taskId: id, acceptedAttemptId: d.acceptedAttemptId || null, status: d.status };
          });
          return json(
            res,
            runner.compileInstructions(
              org,
              w,
              t,
              'next-attempt-preview',
              '(private output directory allocated at start)',
              inputs,
            ),
          );
        }
        if (url.pathname === '/api/control') {
          const org = store.organization();
          if (data.paused !== undefined) {
            if (typeof data.paused !== 'boolean') fail('Pause must be true or false.');
            org.paused = data.paused;
          }
          // How many attempts run at once across every project. An agent runs several at once (MP-033), so the
          // limit no longer follows the number of agents; it stays the studio's safety limit until each kind of
          // resource has its own. Running attempts are never stopped by a lower limit; new ones wait for a slot.
          if (data.maxParallel !== undefined) {
            if (!Number.isInteger(data.maxParallel) || data.maxParallel < 1 || data.maxParallel > mostAttemptsAtOnce)
              fail(`Choose from 1 to ${mostAttemptsAtOnce} attempts at the same time.`);
            org.maxParallel = data.maxParallel;
          }
          if (data.clearQuota !== undefined) {
            if (!registries.adapters.get(data.clearQuota).subscription) fail('Unknown subscription hold provider.');
            org.quota[data.clearQuota] = false;
            if (org.quotaResets) delete org.quotaResets[data.clearQuota];
            if (org.quotaResetSources) delete org.quotaResetSources[data.clearQuota];
          }
          // Where candidate tests and integration verification run; attempts already started keep theirs.
          if (data.testSandbox !== undefined) {
            if (!testSandboxes.includes(data.testSandbox))
              fail('Choose built-in or none for where candidate tests run.');
            org.testSandbox = data.testSandbox;
          }
          // Approved commands and the auto mode default for Claude employees (v1.0 item 22).
          if (data.agentPermissions !== undefined)
            try {
              applyAgentPermissions(org, data.agentPermissions);
            } catch (error) {
              fail(error.message);
            }
          store.setOrganization(org);
          // The timer then waits only for the holds still set with a recorded reset time.
          if (data.clearQuota !== undefined) runner.armQuotaTimer();
          store.event(
            'control',
            null,
            null,
            data.maxParallel !== undefined
              ? `Up to ${org.maxParallel} attempt${org.maxParallel === 1 ? '' : 's'} at the same time from now; running attempts continue.`
              : data.clearQuota
                ? `${registries.adapters.get(data.clearQuota).quotaLabel || registries.adapters.get(data.clearQuota).name} hold cleared by director. Actual provider availability is not inferred.`
                : data.agentPermissions
                  ? `Claude employees from the next attempt: auto mode ${org.agentPermissions.auto ? 'on' : 'off'} by default, ${org.agentPermissions.commands.length} approved command${org.agentPermissions.commands.length === 1 ? '' : 's'}.`
                  : data.testSandbox === 'none'
                    ? 'Candidate tests now run without a sandbox, with this account’s full access, from the next attempt.'
                    : data.testSandbox
                      ? 'Candidate tests now run in the built-in sandbox from the next attempt.'
                      : org.paused
                        ? 'New dispatch paused; active work continues.'
                        : 'Dispatch resumed.',
          );
          return json(res, { ok: true });
        }
        fail('Unknown controller route.', 404);
      }
      if (req.method !== 'GET') fail('Method not allowed.', 405);
      res.setHeader('Content-Security-Policy', pagePolicy);
      // The saved light or dark appearance applies before the dashboard draws, so it never flashes. It is
      // revalidated by content, not downloaded again on every load.
      if (url.pathname === '/theme.js') {
        const content = fs.readFileSync(path.join(publicRoot, 'theme.js')),
          tag = `"${hash(content)}"`,
          headers = { 'Cache-Control': 'no-cache', ETag: tag };
        if (unchanged(req, tag)) {
          res.writeHead(304, headers);
          return res.end();
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(content);
      }
      // Addresses from before the dashboard moved to the main address (v1.0 item 19c) open the same page.
      if (url.pathname === '/next' || url.pathname.startsWith('/next/')) {
        res.writeHead(302, {
          Location: (url.pathname.slice('/next'.length) || '/') + url.search,
          'Cache-Control': 'no-store',
        });
        return res.end();
      }
      // The dashboard (MP-026). Its built scripts and styles are named by their content, so they are kept;
      // any other address without a file extension is one of its pages and gets the page with this start's
      // request token.
      const asset = url.pathname.match(/^\/assets\/([\w-]+(?:\.[\w-]+)*\.(js|css|svg|png|woff2))$/);
      if (asset) {
        const file = path.join(dashboardDirectory, 'assets', asset[1]);
        if (!fs.existsSync(file)) fail('Dashboard file not found.', 404);
        const headers = { 'Content-Type': dashboardTypes[asset[2]], 'Cache-Control': 'max-age=31536000, immutable' };
        // A built file never changes under its name, so it is compressed once.
        if (!['js', 'css', 'svg'].includes(asset[2]) || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
          res.writeHead(200, headers);
          return res.end(fs.readFileSync(file));
        }
        if (!compressedAssets.has(file)) compressedAssets.set(file, zlib.gzipSync(fs.readFileSync(file)));
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
        return res.end(compressedAssets.get(file));
      }
      if (url.pathname.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(url.pathname)) fail('Page not found.', 404);
      const shell = path.join(dashboardDirectory, 'index.html');
      if (!fs.existsSync(shell)) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(dashboardNotBuilt.replace('%STUDIO_TOKEN%', csrf));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(shell, 'utf8').replace('%STUDIO_TOKEN%', csrf));
    } catch (err) {
      if (!res.headersSent)
        json(res, { error: err.message || 'Controller request failed.', ...(err.fields || {}) }, err.status || 400);
      else res.end();
    }
  });
  // An idle connection stays open longer than Node's 5 seconds. A client reuses one it believes open; when the
  // controller's own work held the event loop past both sides' timers (a source check hashing its snapshot in the
  // suite), the request then met the server's close and failed with ECONNRESET. A loopback controller has few
  // connections to keep.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  // How long a close lets a request still being answered finish before its connection is ended.
  const connectionGrace = 2000;
  return {
    store,
    runner,
    server,
    // The data folder's key, which local tools send as `x-studio-key` (C-01).
    directorKey: key,
    // This start's launch link, which signs a browser in. It is also written to <data>/launch-url for the scripts
    // that open one, and changes with every start.
    get launchUrl() {
      return `${origin()}/launch/${director.launchCode}`;
    },
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      actualPort = server.address().port;
      fs.writeFileSync(path.join(store.directory, launchFileName), this.launchUrl + '\n', { mode: 0o600 });
      return origin();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await runner.shutdown();
        measures.close();
        clearTimeout(broadcastTimer);
        for (const client of clients) client.res.end();
        // Node's close ends only the connections idle at that moment and stops timing out headers and requests. A
        // connection still answering a request then stayed open for its client's keep-alive once answered (63 seconds
        // measured with fetch), or without end when its request never completed, and held the close as long. Each
        // is ended once its answer is sent, and any still open after the grace period are ended.
        await new Promise(resolve => {
          const idle = setInterval(() => server.closeIdleConnections(), 50),
            cut = setTimeout(() => server.closeAllConnections(), connectionGrace);
          server.close(() => {
            clearInterval(idle);
            clearTimeout(cut);
            resolve();
          });
        });
        store.db.prepare('DELETE FROM settings WHERE id=? AND data=?').run('controller-owner', JSON.stringify(owner));
        store.close();
      })();
      return closePromise;
    },
  };
}
// Optional, git-ignored studio.local.json beside the installed source. A stable copy
// uses it to share the development copy's records and to develop that copy instead
// of itself: { "dataDirectory": "../game-studio/data", "sourceRoot": "../game-studio" }.
// Relative paths resolve from the installed source. Environment variables win.
export function localConfiguration(installRoot = root, environment = process.env) {
  const file = path.join(installRoot, 'studio.local.json');
  let local = {};
  if (fs.existsSync(file)) {
    try {
      local = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error('studio.local.json is not valid JSON.');
    }
    if (!local || typeof local !== 'object' || Array.isArray(local))
      throw new Error('studio.local.json must contain an object.');
    for (const key of Object.keys(local))
      if (!['dataDirectory', 'sourceRoot'].includes(key) || typeof local[key] !== 'string' || !local[key])
        throw new Error('studio.local.json takes only dataDirectory and sourceRoot paths.');
  }
  const resolve = value => (value ? path.resolve(installRoot, value) : undefined);
  return {
    dataDirectory: resolve(environment.STUDIO_DATA_DIR || local.dataDirectory) || path.join(installRoot, 'data'),
    sourceRoot: resolve(environment.STUDIO_SOURCE_ROOT || local.sourceRoot),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Under scripts/supervisor.mjs a planned restart exits with 75 and is relaunched.
  const supervised = process.env.STUDIO_SUPERVISED === '1',
    local = localConfiguration();
  // Every stop this process sees is recorded, and said, before it happens (C-41, src/stop-record.mjs).
  let stops = null;
  const stop = reason => {
    if (stops?.stop(reason)) console.log(`Studio desk: stopping at ${new Date().toISOString()}: ${reason}.`);
  };
  const app = createStudio({
    directory: local.dataDirectory,
    // Only the controller itself looks at this computer's built-in sandbox; tests pass their own.
    runnerOptions: {
      ...(local.sourceRoot ? { sourceChangeRoot: local.sourceRoot } : {}),
      builtInSandbox: builtInSandbox(),
    },
    restart: supervised
      ? () =>
          app.close().then(() => {
            stop('a planned restart to load updated source');
            process.exit(75);
          })
      : null,
  });
  const previous = previousStop(app.store.directory);
  stops = stopRecorder(app.store.directory);
  process.on('uncaughtExceptionMonitor', (error, origin) =>
    stop(
      `${origin === 'unhandledRejection' ? 'an unhandled rejection' : 'an uncaught error'}: ${error?.message ?? error}`,
    ),
  );
  process.on('exit', code => stop(`it exited with code ${code}`));
  try {
    const url = await app.start();
    console.log(
      `Studio desk: ${app.launchUrl}\nLocal records: ${app.store.directory}\nDeveloping: ${app.runner.sourceChangeRoot}${app.runner.selfHosted ? ' (this copy; integrations restart the controller)' : ' (separate development copy)'}\nOpen the link above in your browser once: it signs that browser in, and ${url} then opens the dashboard, also after restarts. Press Ctrl+C to stop. Approve a pipeline or start assignments individually. Restarts pause queued dispatch.${supervised ? '' : '\nRun through npm start or start-studio to allow planned restarts after source integration.'}`,
    );
    // The previous run's stop, in this window and in the activity that belongs to no project.
    if (previous) {
      console.log(`Studio desk: ${previous.text}`);
      app.store.event('controller_stop', null, null, previous.text);
    }
  } catch (err) {
    console.error(`Cannot start: ${err.message}`);
    stop(`it could not start: ${err.message}`);
    process.exitCode = 1;
    await app.close();
  }
  let stopping = false;
  // SIGHUP is Windows closing the window (it ends the process about ten seconds later) and SIGBREAK is Ctrl+Break;
  // each is recorded before the controller closes.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      stop(`it was asked to stop (${signal})`);
      await app.close();
      process.exit(0);
    });
}
