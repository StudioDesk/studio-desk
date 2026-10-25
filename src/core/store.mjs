import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEGACY_PROJECT, projectIdentity, recordProject } from './projects.mjs';
import { projectOrganization, organizationConfiguration } from './project-organization.mjs';
import { directoryFor } from './project-agents.mjs';
import { assertUnchangedDirectorInputs, directorInputsOf } from './idea-inputs.mjs';
import { dashboardAttempt, dashboardOpenPhases, dashboardTimings } from './dashboard-state.mjs';

const attemptChange = a => ({ type: 'attempt', id: a.id, taskId: a.taskId, projectId: recordProject(a) });
// A setting's change names a run or workflow as its own record, and its project when the setting has one:
// in its data, or after a colon in its key (project-organization:<id>, run-archive:<id>:<run>).
function settingChange(id, data) {
  const type = id.startsWith('run:')
      ? 'run'
      : id.startsWith('workflow:')
        ? 'workflow'
        : id === 'projects'
          ? 'projects'
          : 'setting',
    projectId =
      typeof data?.projectId === 'string'
        ? data.projectId
        : (/:(project-[a-zA-Z0-9_-]{1,80})(?::|$)/.exec(id)?.[1] ?? null);
  return {
    type,
    id: type === 'run' || type === 'workflow' ? id.slice(type.length + 1) : id,
    ...(projectId ? { projectId } : {}),
  };
}

const phaseNames = {
  attempt: 'Attempt',
  'source.edit': 'Source editing',
  install: 'Installing packages',
  'candidate.commit': 'Candidate commit',
  test: 'Tests',
  'integration.prepare': 'Integration preparation',
  'integration.merge': 'Integration merge',
  'integration.format': 'Integration formatting',
  'integration.verification': 'Integration verification',
  'integration.commit': 'Integration commit',
  'integration.fast-forward': 'Development fast-forward',
};

export class Store {
  constructor(directory, profile) {
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, 'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, snapshot TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, token INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (resource TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, attempt_id TEXT, message TEXT NOT NULL);`);
    // Every write raises the version and calls onChange with what changed (MP-026): the dashboard's
    // cache tags and change events follow it, and the scheduler runs on it. Each event also reaches
    // onEvent, so a tab watching an attempt receives its lines. A log line is not a change: the compact
    // state leaves log lines out, and they stream only to the tabs watching their attempt.
    this.version = 0;
    this.onChange = () => {};
    this.onEvent = () => {};
    try {
      this.tx(() => {
        if (!this.db.prepare('SELECT id FROM settings WHERE id=?').get('organization')) {
          const { organization, tasks, projects } = profile();
          this.setOrganization(organization);
          tasks.forEach(task => this.putTask(task));
          if (projects) this.putSetting('projects', projects);
        }
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  // change names the record: { type, id, taskId, projectId }, with the fields that apply.
  changed(change) {
    this.version++;
    this.onChange({ seq: this.version, ...change });
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  organization() {
    return JSON.parse(this.db.prepare('SELECT data FROM settings WHERE id=?').get('organization').data);
  }
  setOrganization(org) {
    this.db
      .prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run('organization', JSON.stringify(org));
    this.changed({ type: 'organization' });
  }
  setting(id, fallback = null) {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : fallback;
  }
  putSetting(id, data) {
    this.db
      .prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(id, JSON.stringify(data));
    this.changed(settingChange(id, data));
  }
  projects() {
    const company = this.organization().company;
    return this.setting('projects', [
      {
        id: LEGACY_PROJECT,
        name: 'Studio prototype',
        goal: company.milestone || '',
        direction: company.outcome || '',
        revision: 1,
        dispatchPaused: false,
        legacy: true,
      },
    ]);
  }
  project(id = LEGACY_PROJECT) {
    projectIdentity(id);
    const project = this.projects().find(project => project.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  putProject(project) {
    const projects = this.projects(),
      index = projects.findIndex(item => item.id === project.id);
    if (index < 0) projects.push(project);
    else projects[index] = project;
    this.putSetting('projects', projects);
  }
  // Removes a project and every record kept under it (deleting a project, v1.0 item 24): its tasks and attempts, the
  // events of either, its runs, workflows, teams, house rules and run archives, and its resource counters. The
  // caller checks nothing of it runs and removes its folders after the commit.
  deleteProjectRecords(projectId, taskIds, attemptIds) {
    const each = (sql, ids) => {
      const statement = this.db.prepare(sql);
      for (const id of ids) statement.run(id);
    };
    each('DELETE FROM events WHERE task_id=?', taskIds);
    each('DELETE FROM events WHERE attempt_id=?', attemptIds);
    each('DELETE FROM attempts WHERE id=?', attemptIds);
    each('DELETE FROM tasks WHERE id=?', taskIds);
    each(
      'DELETE FROM settings WHERE id=?',
      this.runs(projectId).map(run => 'run:' + run.id),
    );
    each(
      'DELETE FROM settings WHERE id=?',
      this.workflows(projectId).map(workflow => 'workflow:' + workflow.id),
    );
    for (const prefix of ['project-organization:', 'project-autonomy:', 'project-autonomy-runs:'])
      this.db.prepare('DELETE FROM settings WHERE id=?').run(prefix + projectId);
    this.db.prepare('DELETE FROM settings WHERE id LIKE ?').run(`run-archive:${projectId}:%`);
    this.db.prepare('DELETE FROM counters WHERE resource LIKE ?').run(`source:${projectId}:%`);
    this.putSetting(
      'projects',
      this.projects().filter(project => project.id !== projectId),
    );
    this.changed({ type: 'project', projectId });
  }
  workflows(projectId) {
    return this.db
      .prepare('SELECT data FROM settings WHERE id LIKE ? ORDER BY rowid')
      .all('workflow:%')
      .map(row => JSON.parse(row.data))
      .filter(workflow => projectId === undefined || workflow.projectId === projectId);
  }
  workflow(id) {
    const workflow = this.setting('workflow:' + id);
    if (!workflow) throw new Error('Workflow not found.');
    return workflow;
  }
  putWorkflow(workflow) {
    this.putSetting('workflow:' + workflow.id, workflow);
  }
  // Run records (MP-015 G2): the graph each run executes, with numbered revisions.
  runs(projectId) {
    return this.db
      .prepare('SELECT data FROM settings WHERE id LIKE ? ORDER BY rowid')
      .all('run:%')
      .map(row => JSON.parse(row.data))
      .filter(run => projectId === undefined || run.projectId === projectId);
  }
  run(id) {
    return this.setting('run:' + id);
  }
  putRun(run) {
    assertUnchangedDirectorInputs(this.run(run.id), run);
    this.putSetting('run:' + run.id, run);
  }
  // A task's project, or null when there is no such task.
  taskProject(taskId) {
    if (!taskId) return null;
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(taskId);
    return row ? recordProject(JSON.parse(row.data)) : null;
  }
  tasks() {
    return this.db
      .prepare('SELECT data FROM tasks ORDER BY rowid')
      .all()
      .map(r => JSON.parse(r.data));
  }
  // When each task's attempts last finished, read without parsing any attempt, to list settled work newest first.
  lastFinished() {
    return new Map(
      this.db
        .prepare(
          "SELECT task_id AS taskId, MAX(json_extract(data, '$.finishedAt')) AS at FROM attempts GROUP BY task_id",
        )
        .all()
        .map(row => [row.taskId, row.at]),
    );
  }
  task(id) {
    const r = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!r) throw new Error('Assignment not found.');
    return JSON.parse(r.data);
  }
  putTask(t) {
    const previous = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(t.id);
    assertUnchangedDirectorInputs(previous && JSON.parse(previous.data), t);
    this.db
      .prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(t.id, JSON.stringify(t));
    this.changed({ type: 'task', id: t.id, projectId: recordProject(t) });
  }
  attempts(taskId) {
    return this.db
      .prepare('SELECT id, snapshot, data FROM attempts WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map(r => ({ ...JSON.parse(r.data), instructions: JSON.parse(r.snapshot) }));
  }
  allAttempts() {
    return this.db
      .prepare('SELECT snapshot,data FROM attempts ORDER BY rowid')
      .all()
      .map(r => ({ ...JSON.parse(r.data), instructions: JSON.parse(r.snapshot) }));
  }
  attempt(id) {
    const r = this.db.prepare('SELECT snapshot,data FROM attempts WHERE id=?').get(id);
    if (!r) throw new Error('Attempt not found.');
    return { ...JSON.parse(r.data), instructions: JSON.parse(r.snapshot) };
  }
  insertAttempt(a, snapshot) {
    this.db
      .prepare('INSERT INTO attempts VALUES (?,?,?,?)')
      .run(a.id, a.taskId, JSON.stringify(snapshot), JSON.stringify(a));
    this.changed(attemptChange(a));
  }
  updateAttempt(a) {
    const { instructions, ...data } = a;
    this.db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(data), a.id);
    this.changed(attemptChange(a));
  }
  leases() {
    return this.db.prepare('SELECT resource, attempt_id AS attemptId,token FROM leases ORDER BY resource').all();
  }
  resourceConflict(resource, ownerAttemptId) {
    const integration = ownerAttemptId.startsWith('source-integration:');
    let reason = `Waiting for resource ${resource} to become available.`;
    // Diagnostics must remain useful for historical or incomplete records without
    // changing ownership or treating a synthetic integration owner as an employee.
    try {
      const attempt = this.attempt(integration ? ownerAttemptId.slice('source-integration:'.length) : ownerAttemptId),
        task = this.task(integration ? attempt.candidateReview?.taskId || attempt.taskId : attempt.taskId);
      if (task.id && typeof task.title === 'string' && task.title.trim()) {
        if (integration) {
          // Staged reviews share the source story; legacy reviews reference it.
          if (task.kind === 'studio-development:change')
            reason = `Waiting for source integration of ${task.id} (${task.title}) to finish.`;
        } else {
          reason = `Waiting for work on ${task.id} (${task.title}) to finish.`;
          const worker =
            attempt.workerId && this.organization().workers?.find(worker => worker?.id === attempt.workerId);
          if (typeof worker?.displayName === 'string' && worker.displayName.trim())
            reason = `Waiting for ${worker.displayName}'s work on ${task.id} (${task.title}) to finish.`;
        }
      }
    } catch {
      // Keep the exact resource and lease provenance when its records are missing.
    }
    return { reason, resource, ownerAttemptId };
  }
  recordResourceConflict(taskId, conflict, force = false) {
    const message = `${conflict.reason} [${conflict.resource} held by ${conflict.ownerAttemptId}]`,
      previous = this.db
        .prepare("SELECT message FROM events WHERE kind='resource_conflict' AND task_id=? ORDER BY seq DESC LIMIT 1")
        .get(taskId);
    // Use persisted history, rather than the bounded dashboard event window.
    let unchanged = previous?.message === message;
    if (!force && previous && !unchanged) {
      try {
        const legacy = JSON.parse(previous.message);
        unchanged =
          legacy?.reason === conflict.reason &&
          legacy?.resource === conflict.resource &&
          legacy?.ownerAttemptId === conflict.ownerAttemptId;
      } catch {
        // Readable messages are compared directly; historical JSON stays untouched.
      }
    }
    if (force || !unchanged) this.event('resource_conflict', taskId, null, message);
  }
  claim(resources, attemptId) {
    for (const r of [...new Set(resources)].sort()) {
      const held = this.db.prepare('SELECT attempt_id FROM leases WHERE resource=?').get(r);
      if (held) {
        const conflict = this.resourceConflict(r, held.attempt_id);
        throw Object.assign(new Error(conflict.reason), { conflict });
      }
      this.db.prepare('INSERT INTO counters VALUES (?,1) ON CONFLICT(resource) DO UPDATE SET value=value+1').run(r);
      const token = this.db.prepare('SELECT value FROM counters WHERE resource=?').get(r).value;
      this.db.prepare('INSERT INTO leases VALUES (?,?,?)').run(r, attemptId, token);
    }
    if (resources.length) this.changed({ type: 'leases' });
  }
  release(id) {
    // An integration settles by releasing its resources with no event of its own; the change
    // lets the scheduler start the work that waited on them.
    if (this.db.prepare('DELETE FROM leases WHERE attempt_id=?').run(id).changes) this.changed({ type: 'leases' });
  }
  event(kind, taskId, attemptId, message, projectId = null, time = new Date().toISOString()) {
    const event = {
      time,
      kind,
      task_id: taskId || null,
      attempt_id: attemptId || null,
      message: String(message).slice(0, 6000),
    };
    const row = this.db
      .prepare('INSERT INTO events(time,kind,task_id,attempt_id,message) VALUES (?,?,?,?,?)')
      .run(event.time, event.kind, event.task_id, event.attempt_id, event.message);
    // The event's project is part of the event's own change, not a change of its own.
    if (projectId)
      this.db
        .prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
        .run('event-project:' + row.lastInsertRowid, JSON.stringify(projectId));
    if (kind !== 'log')
      this.changed({
        type: 'event',
        id: Number(row.lastInsertRowid),
        kind,
        ...(taskId ? { taskId } : {}),
        ...(attemptId ? { attemptId } : {}),
        projectId: projectId || this.taskProject(taskId),
      });
    this.onEvent({ seq: Number(row.lastInsertRowid), ...event });
  }
  // An attempt's events after a sequence number, for a tab that resumes watching its log. The
  // sequence is the row ID, so a recent cursor reads only the table's tail.
  eventsAfter(attemptIds, after, limit) {
    if (!attemptIds.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM events WHERE seq>? AND attempt_id IN (${attemptIds.map(() => '?').join(',')}) ORDER BY seq LIMIT ?`,
      )
      .all(after, ...attemptIds, limit);
  }
  events(attemptId = null, { logs = true } = {}) {
    return (
      attemptId
        ? this.db.prepare('SELECT * FROM events WHERE attempt_id=? ORDER BY seq DESC LIMIT 300').all(attemptId)
        : this.db.prepare(`SELECT * FROM events ${logs ? '' : "WHERE kind<>'log'"} ORDER BY seq DESC LIMIT 150`).all()
    ).reverse();
  }
  // A project's recorded events without agent output, newest first, a page at a time (the Activity page): an
  // event of the project's tasks, one tagged with the project, or an untagged one with no task, as the
  // compact state reads them. The sequence is the row ID, so each page reads only back from its cursor.
  activity(projectId, { before = null, limit = 50 } = {}) {
    const ids = new Set(
        this.tasks()
          .filter(task => recordProject(task) === projectId)
          .map(task => task.id),
      ),
      read = this.db.prepare("SELECT * FROM events WHERE kind<>'log' AND seq<? ORDER BY seq DESC LIMIT 200"),
      events = [];
    let cursor = before ?? Number.MAX_SAFE_INTEGER,
      more = true;
    while (events.length < limit && more) {
      const rows = read.all(cursor);
      more = rows.length === 200;
      for (const event of rows) {
        cursor = event.seq;
        const tagged = event.task_id ? null : this.setting('event-project:' + event.seq);
        if (event.task_id ? ids.has(event.task_id) : !tagged || tagged === projectId) events.push(event);
        if (events.length === limit) break;
      }
    }
    const next =
      events.length === limit &&
      this.db.prepare("SELECT 1 FROM events WHERE kind<>'log' AND seq<? LIMIT 1").get(events.at(-1).seq)
        ? events.at(-1).seq
        : null;
    return { events, next };
  }
  // A task's recorded events without agent output or phases, oldest first (a story's Activity). Events have no
  // index on their task, so the read starts at the first event recorded a few minutes before the task was created,
  // found by a search on the sequence (whose times only grow), rather than at the start of the history.
  taskEvents(task) {
    const since = Date.parse(task.createdAt ?? '') - 5 * 60_000,
      first = this.db.prepare('SELECT seq, time FROM events WHERE seq>=? ORDER BY seq LIMIT 1');
    // The first sequence from `low` on is at or after `since`; `high` starts one past the last event.
    let low = 0,
      high = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM events').get().last + 1;
    while (Number.isFinite(since) && low < high) {
      const middle = Math.floor((low + high) / 2),
        row = first.get(middle);
      if (row && Date.parse(row.time) < since) low = row.seq + 1;
      else high = middle;
    }
    return this.db
      .prepare("SELECT * FROM events WHERE seq>=? AND task_id=? AND kind NOT IN ('log','phase') ORDER BY seq")
      .all(low, task.id);
  }
  // Structured observations use the existing message payload; no historical backfill.
  phaseEvents(attemptId) {
    return this.db
      .prepare("SELECT * FROM events WHERE attempt_id=? AND kind='phase' ORDER BY seq")
      .all(attemptId)
      .map(event => ({ ...event, payload: JSON.parse(event.message) }));
  }
  // Every attempt's phase observations from one pass over the events table. events has no index on
  // attempt_id, so a query per attempt scans the whole table each time: on October 21, 2026, 184
  // attempts over 46 MB of mostly log events took about 7 s per dashboard refresh.
  phaseEventsByAttempt() {
    const byAttempt = new Map();
    for (const event of this.db.prepare("SELECT * FROM events WHERE kind='phase' ORDER BY seq").all()) {
      if (!byAttempt.has(event.attempt_id)) byAttempt.set(event.attempt_id, []);
      byAttempt.get(event.attempt_id).push({ ...event, payload: JSON.parse(event.message) });
    }
    return byAttempt;
  }
  // A project's attempt summaries, or those of one task or a list of tasks.
  dashboardAttempts(projectId, taskId) {
    const tasks = taskId === undefined ? null : [taskId].flat();
    // Neither this query nor the timing query selects the snapshot column. Only
    // data is parsed, and no full attempt or phase history is constructed.
    const rows = this.db
      .prepare(
        `SELECT data FROM attempts
      WHERE CASE WHEN json_type(data, '$.projectId') IS NULL THEN ?
        ELSE json_extract(data, '$.projectId') END = ?${tasks ? ` AND task_id IN (${tasks.map(() => '?').join(',')})` : ''} ORDER BY rowid`,
      )
      .all(LEGACY_PROJECT, projectId, ...(tasks || []))
      .map(row => JSON.parse(row.data));
    // The same pass reads a working attempt's inner phases, so Today can say what it is doing.
    const working = rows.filter(data => ['running', 'stopping'].includes(data.status)).map(data => data.id),
      phases = this.db
        .prepare(
          `SELECT attempt_id, task_id,
      json_extract(message, '$.schemaVersion') AS schemaVersion,
      json_extract(message, '$.attemptId') AS attemptId,
      json_extract(message, '$.taskId') AS taskId,
      json_extract(message, '$.phaseId') AS phaseId,
      json_extract(message, '$.occurrenceId') AS occurrenceId,
      json_extract(message, '$.integrationOccurrenceId') AS integrationOccurrenceId,
      json_extract(message, '$.boundary') AS boundary,
      json_extract(message, '$.timestamp') AS timestamp,
      CASE WHEN json_type(message, '$.durationMs') IN ('integer', 'real')
        THEN json_extract(message, '$.durationMs') END AS durationMs,
      json_extract(message, '$.timing') AS timing
      FROM events WHERE kind='phase' AND (json_extract(message, '$.phaseId')='attempt'${working.length ? ` OR attempt_id IN (${working.map(() => '?').join(',')})` : ''})
      ORDER BY seq`,
        )
        .all(...working),
      timings = dashboardTimings(phases),
      open = dashboardOpenPhases(phases);
    return rows.map(data => {
      const owner = JSON.stringify([data.id, data.taskId]);
      return dashboardAttempt(data, timings.get(owner), open.get(owner) ?? null);
    });
  }
  startPhase(attempt, phaseId, context = {}) {
    const payload = {
      schemaVersion: 'source-phase-v1',
      taskId: attempt.taskId,
      attemptId: attempt.id,
      phaseId,
      occurrenceId: randomUUID(),
      integrationOccurrenceId: null,
      ...context,
      boundary: 'start',
      timestamp: new Date().toISOString(),
      outcome: null,
      durationMs: null,
      message: `${phaseNames[phaseId] || phaseId} started.`,
    };
    this.event('phase', attempt.taskId, attempt.id, JSON.stringify(payload), null, payload.timestamp);
    return { payload, clock: performance.now(), closed: false };
  }
  finishPhase(phase, outcome, details = {}) {
    if (phase.closed) return;
    const payload = {
      ...phase.payload,
      ...details,
      boundary: 'finish',
      timestamp: new Date().toISOString(),
      outcome,
      durationMs: Math.max(0, performance.now() - phase.clock),
      message: `${phaseNames[phase.payload.phaseId] || phase.payload.phaseId} ${outcome}.`,
    };
    if (payload.error) payload.error = String(payload.error).slice(0, 1000);
    if (['test', 'integration.verification'].includes(payload.phaseId)) payload.elapsedMs = payload.durationMs;
    this.event('phase', payload.taskId, payload.attemptId, JSON.stringify(payload), null, payload.timestamp);
    phase.closed = true;
  }
  // Sequence cursors are exclusive. Carry snapshot unchanged between pages: it
  // is the last event of this attempt at the first read, not a moving live tail.
  // Events are append-only, so this upper bound also keeps the total stable.
  attemptEventPage(attemptId, { limit = 500, after = 0, snapshot } = {}) {
    for (const [name, value, minimum, maximum] of [
      ['limit', limit, 1, 500],
      ['after', after, 0, Number.MAX_SAFE_INTEGER],
      ['snapshot', snapshot, 0, Number.MAX_SAFE_INTEGER],
    ]) {
      if (name === 'snapshot' && value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
        throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
    }
    const summary = this.db
      .prepare('SELECT COUNT(*) AS total, COALESCE(MAX(seq), 0) AS last FROM events WHERE attempt_id=? AND seq<=?')
      .get(attemptId, snapshot ?? Number.MAX_SAFE_INTEGER);
    if (snapshot !== undefined && snapshot !== summary.last)
      throw new Error('snapshot must be zero or an existing event sequence for this attempt.');
    snapshot ??= summary.last;
    if (after > snapshot) throw new Error('after must not exceed snapshot.');
    const events = this.db
      .prepare('SELECT * FROM events WHERE attempt_id=? AND seq>? AND seq<=? ORDER BY seq ASC LIMIT ?')
      .all(attemptId, after, snapshot, limit);
    const last = events.at(-1)?.seq;
    return { events, total: summary.total, snapshot, nextCursor: last < snapshot ? last : null };
  }
  // What every page of a project shares (MP-026): no tasks, attempts, events or instruction text.
  shell(projectId = LEGACY_PROJECT) {
    const project = this.project(projectId),
      org = { ...projectOrganization(this, projectId) },
      configuration = organizationConfiguration(this, projectId);
    delete org.instructions;
    let compact = configuration;
    if (configuration) {
      compact = { ...configuration };
      delete compact.instructions;
      delete compact.history;
    }
    return {
      ...org,
      organizationConfiguration: compact,
      employeeDirectory: directoryFor(this.organization(), projectId),
      pipelineEnabled: !!org.pipelineEnabled && !project.dispatchPaused,
      projects: this.projects(),
      project,
      workflows: this.workflows(projectId),
      sprints: this.db
        .prepare('SELECT data FROM settings WHERE id LIKE ? ORDER BY rowid')
        .all('sprint-%')
        .map(row => JSON.parse(row.data))
        .filter(sprint => sprint.projectId === projectId),
      leases: this.leases(),
    };
  }
  state(projectId = LEGACY_PROJECT, { mode = 'full' } = {}) {
    if (!['full', 'dashboard'].includes(mode)) throw new Error('State mode must be full or dashboard.');
    const project = this.project(projectId),
      tasks = this.tasks()
        .filter(task => recordProject(task) === projectId)
        .map(task => ({ ...task, directorInputs: directorInputsOf(task) })),
      ids = new Set(tasks.map(task => task.id)),
      org = projectOrganization(this, projectId);
    // The compact state leaves agent output out (MP-026); an attempt's lines stream to a tab watching it.
    const events = this.events(null, { logs: mode !== 'dashboard' }).filter(event =>
      event.task_id
        ? ids.has(event.task_id)
        : !this.setting('event-project:' + event.seq) || this.setting('event-project:' + event.seq) === projectId,
    );
    const sprints = this.db
      .prepare('SELECT data FROM settings WHERE id LIKE ? ORDER BY rowid')
      .all('sprint-%')
      .map(row => JSON.parse(row.data))
      .filter(sprint => sprint.projectId === projectId);
    const phases = mode === 'full' ? this.phaseEventsByAttempt() : null;
    return {
      ...org,
      organizationConfiguration: organizationConfiguration(this, projectId),
      employeeDirectory: directoryFor(this.organization(), projectId),
      pipelineEnabled: !!org.pipelineEnabled && !project.dispatchPaused,
      projects: this.projects(),
      project,
      workflows: this.workflows(projectId),
      sprints,
      tasks,
      attempts:
        mode === 'dashboard'
          ? this.dashboardAttempts(projectId)
          : this.allAttempts()
              .filter(attempt => recordProject(attempt) === projectId)
              .map(attempt => ({ ...attempt, phaseEvents: phases.get(attempt.id) || [] })),
      leases: this.leases(),
      events,
    };
  }
  close() {
    this.db.close();
  }
}
