import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from './store.mjs';
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
} from './connectors/source-changes.mjs';
import { stopIntegrationProcess } from './connectors/source-integration.mjs';
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
import { chosenTestSandbox, testSandboxes } from './adapters/source-test-sandbox.mjs';
import { applyAgentPermissions, approveCommands, commandRule, taskAutoMode } from './core/agent-permissions.mjs';
import { employeeTestsAllowed, runEmployeeTests } from './connectors/employee-tests.mjs';
import { attemptTrace } from './core/attempt-trace.mjs';
import { storyActivity } from './core/story-activity.mjs';
import { validateReview } from './packs/game-production/contracts.mjs';
import { validatePlan } from './planning.mjs';
import { createRegistries } from './registry.mjs';
import { bootstrapFactory } from './core/bootstrap.mjs';
import { createProject } from './core/project-creation.mjs';
import { startIdeaIntake } from './core/idea-intake.mjs';
import { createFromTemplate, listTemplates, sampleIdeaFiles } from './core/project-templates.mjs';
import { deleteProject } from './core/project-deletion.mjs';
import { LEGACY_PROJECT, recordProject, assertProject, validateTaskProject } from './core/projects.mjs';
import {
  finishedRuns,
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
  startSprint,
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

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = path.join(root, 'public');
// The version Settings shows is the app's own, from its package.json.
const appVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
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
function fail(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  throw e;
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
  let runner;
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
  // A code-editing employee's test command calls back here (connectors/employee-tests.mjs).
  runner.controllerOrigin = origin;
  // A burst of writes reaches each tab as one change event, at most four a second, naming each changed
  // record of the tab's project and every shared one, with the store's version. Log lines are not
  // changes: they go only to the tabs watching their attempt. Recent changes stay in a capped list in
  // memory, so a reconnecting tab catches up (/api/changes); after a restart, or a gap beyond the list,
  // it reloads what it shows.
  const journal = [],
    journalLimit = 2000,
    relevant = (change, projectId) => !change.projectId || change.projectId === projectId;
  let pending = [];
  const broadcast = () => {
    broadcastTimer = null;
    lastBroadcast = Date.now();
    const batch = pending;
    pending = [];
    for (const client of clients) {
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
    runner.schedule();
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
      // Where the next candidate tests run: the director's choice, or Codex's sandbox where it is installed.
      testSandbox: chosenTestSandbox(store.organization(), runner.codexBinary),
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
  const json = (res, data, status = 200) =>
    send(
      res,
      status,
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      JSON.stringify(data),
    );
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      if (!allowedHosts.includes(req.headers.host)) fail('Use the loopback URL printed by the controller.', 403);
      if (req.headers.origin && ![origin(), `http://localhost:${actualPort}`].includes(req.headers.origin))
        fail('Cross-origin requests are not accepted.', 403);
      const url = new URL(req.url, origin()),
        parts = url.pathname.split('/').filter(Boolean);
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
      if (
        parts[0] === 'api' &&
        parts[1] === 'projects' &&
        parts[3] === 'runs' &&
        parts.length === 5 &&
        req.method === 'GET'
      )
        return json(res, oneRun(store, parts[2], parts[4]));
      if (parts[0] === 'api' && parts[1] === 'projects' && parts.length === 4 && req.method === 'GET') {
        const projectId = parts[2];
        if (parts[3] === 'shell') return json(res, { ...store.shell(projectId), ...common(projectId) });
        if (parts[3] === 'live') return json(res, liveRecords(store, projectId));
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
          return json(res, store.activity(projectId, { before: before === null ? null : Number(before) }));
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
      if (taskRoute && (parts.length === 3 || (parts.length === 4 && parts[3] === 'activity'))) {
        let record;
        try {
          record = store.task(parts[2]);
        } catch {
          fail('Task not found.', 404);
        }
        assertProject(store, record, queryProject);
        if (parts[3]) return json(res, storyActivity(store, record));
        return json(res, {
          task: { ...record, directorInputs: directorInputsOf(record) },
          attempts: store.dashboardAttempts(queryProject, record.id),
        });
      }
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
        if (req.headers['x-studio-token'] !== csrf || !['POST', 'PATCH'].includes(req.method))
          fail('Invalid controller request.', 403);
        if (closing) fail('Controller is stopping.', 503);
        // Idea intake: the Studio desk route, and the general one (1.0 item 11), which starts the
        // project's own intake: source checks and a breakdown for a source project, the planner for
        // a general-work project.
        const intake =
          ['/api/studio-development/intake', '/api/intake'].includes(url.pathname) && req.method === 'POST';
        const data = await body(req, intake ? ideaInputLimits.wireBytes : undefined);
        if (intake) {
          if (
            !data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            !Object.hasOwn(data, 'projectId') ||
            !Object.hasOwn(data, 'idea') ||
            Object.keys(data).some(key => !['projectId', 'idea', 'files', 'autoMode'].includes(key))
          )
            fail('Idea intake accepts projectId, idea, optional files and optional autoMode.');
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
        const projectId = data.projectId ?? LEGACY_PROJECT;
        store.project(projectId);
        if (url.pathname === '/api/sprints' && req.method === 'POST') {
          if (Object.keys(data).some(key => !['projectId', 'name', 'taskIds'].includes(key)))
            fail('Unsupported sprint fields.');
          return json(res, startSprint(store, runner, projectId, data.name, data.taskIds), 201);
        }
        if (url.pathname === '/api/tasks/close' && req.method === 'POST') {
          if (Object.keys(data).some(key => !['projectId', 'taskIds', 'reason'].includes(key)))
            fail('Unsupported close fields.');
          return json(res, closeWork(store, projectId, data.taskIds, data.reason ?? ''));
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
              saveProjectOrganization(store, registries, id, developmentOrganization(store.organization()), true);
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
          const { projectId: selected, ...policy } = data;
          return json(res, saveAutonomyPolicy(store, registries, projectId, policy));
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
            const config = developmentOrganization(store.organization());
            config.expectedRevision = data.expectedRevision;
            return json(res, saveProjectOrganization(store, registries, projectId, config));
          }
          const { projectId: selected, ...config } = data;
          return json(res, saveProjectOrganization(store, registries, projectId, config));
        }
        if (parts[1] === 'projects' && parts[2] && req.method === 'PATCH') {
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
          if (action === 'approve-work') {
            const approved = approveWork(store, registries, t);
            runner.autonomy.approved(t.id);
            return json(res, approved);
          }
          if (action === 'deny-work') return json(res, denyWork(store, t, data.reason || ''));
          if (action === 'close') {
            if (Object.keys(data).some(key => !['projectId', 'reason'].includes(key)))
              fail('Unsupported close fields.');
            if (runner.autonomy.pendingIntegration()?.taskId === t.id)
              fail('Integration is approved for this work and waiting to run; it cannot be closed now.', 409);
            return json(res, closeStartedWork(store, registries, t, data.reason ?? ''));
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
              'Proposed work is in Planned. Approve tasks individually or select a sprint; nothing was dispatched.',
            );
            return json(res, { taskIds: prepared.taskIds });
          }
          if (action === 'start') return json(res, runner.queueStart(t.id), 202);
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
              fail('Proposed work already has individual decisions. Use sprint selection.', 409);
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
            const accepted = acceptAttempt(store, registries, t);
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
          if (!w) fail('Employee not found.');
          if (Object.keys(data).some(key => !['projectId', 'look'].includes(key))) fail('A face is its look alone.');
          const slots = ['body', 'color', 'eyes', 'mouth', 'top', 'detail'],
            look = data.look;
          if (
            look !== null &&
            (!look ||
              typeof look !== 'object' ||
              Array.isArray(look) ||
              Object.keys(look).length !== slots.length ||
              slots.some(part => !Number.isInteger(look[part]) || look[part] < 0 || look[part] > 9))
          )
            fail('A face is six part numbers from 0 to 9: body, color, eyes, mouth, top and detail.');
          if (look === null) delete w.look;
          else w.look = Object.fromEntries(slots.map(part => [part, look[part]]));
          store.setOrganization(org);
          store.event('worker_look', null, null, `${w.displayName}: face changed.`);
          return json(res, { ok: true, look: w.look ?? null });
        }
        if (parts[1] === 'workers' && req.method === 'PATCH') {
          const org = store.organization(),
            w = org.workers.find(w => w.id === parts[2]);
          if (!w) fail('Employee not found.');
          if (data.expectedVersion !== (w.configVersion || 1))
            fail('Employee configuration changed. Refresh before saving.', 409);
          try {
            applyWorkerExecution(registries.adapters, w, data);
          } catch (error) {
            fail(error.message);
          }
          if (data.paused !== undefined) {
            if (typeof data.paused !== 'boolean') fail('Pause must be true or false.');
            w.paused = data.paused;
          }
          w.configVersion = (w.configVersion || 1) + 1;
          store.setOrganization(org);
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
          if (action === 'draft')
            doc.draft = {
              text: text(data.text, 'Instruction draft', 48000, true),
              baseRevision: doc.revision,
              savedAt: new Date().toISOString(),
            };
          else if (action === 'discard') doc.draft = null;
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
          // How many attempts run at once across every project. Each employee runs one attempt at a time, so a
          // limit above the number of employees would never be reached. Running attempts are never stopped by a
          // lower limit; new ones wait for a slot under it.
          if (data.maxParallel !== undefined) {
            if (!Number.isInteger(data.maxParallel) || data.maxParallel < 1 || data.maxParallel > org.workers.length)
              fail(`Choose from 1 to ${org.workers.length} attempts at the same time.`);
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
            if (!testSandboxes.includes(data.testSandbox)) fail('Choose codex or none for where candidate tests run.');
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
                      ? 'Candidate tests now run in the Codex CLI sandbox from the next attempt.'
                      : org.paused
                        ? 'New dispatch paused; active work continues.'
                        : 'Dispatch resumed.',
          );
          return json(res, { ok: true });
        }
        fail('Unknown controller route.', 404);
      }
      if (req.method !== 'GET') fail('Method not allowed.', 405);
      // Images may also come from blob: URLs, which only this page's own scripts create: the idea
      // composer's thumbnails of files the director selected or pasted.
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
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
      if (!res.headersSent) json(res, { error: err.message || 'Controller request failed.' }, err.status || 400);
      else res.end();
    }
  });
  // An idle connection stays open longer than Node's 5 seconds. A client reuses one it believes open; when the
  // controller's own work held the event loop past both sides' timers (a source check hashing its snapshot in the
  // suite), the request then met the server's close and failed with ECONNRESET. A loopback controller has few
  // connections to keep.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  return {
    store,
    runner,
    server,
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      actualPort = server.address().port;
      return origin();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await runner.shutdown();
        clearTimeout(broadcastTimer);
        for (const client of clients) client.res.end();
        await new Promise(resolve => server.close(resolve));
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
  const app = createStudio({
    directory: local.dataDirectory,
    runnerOptions: local.sourceRoot ? { sourceChangeRoot: local.sourceRoot } : {},
    restart: supervised ? () => app.close().then(() => process.exit(75)) : null,
  });
  try {
    const url = await app.start();
    console.log(
      `Studio desk: ${url}\nLocal records: ${app.store.directory}\nDeveloping: ${app.runner.sourceChangeRoot}${app.runner.selfHosted ? ' (this copy; integrations restart the controller)' : ' (separate development copy)'}\nOpen the URL in your browser. Press Ctrl+C to stop. Approve a pipeline or start assignments individually. Restarts pause queued dispatch.${supervised ? '' : '\nRun through npm start or start-studio to allow planned restarts after source integration.'}`,
    );
  } catch (err) {
    console.error(`Cannot start: ${err.message}`);
    process.exitCode = 1;
    await app.close();
  }
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    });
}
