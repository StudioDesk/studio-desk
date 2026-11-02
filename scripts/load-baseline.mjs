// Development tool (C-18): the controller's measures under a fixture load, for a baseline before a change and the
// same numbers after it. Seeds a throwaway studio, shaped like a project that has run for weeks, with finished code
// stories, waiting ones and attempts of a realistic size, then runs scheduler passes and every read the dashboard's
// pages make for a project (dashboard/src/api.ts), timing each, and prints what GET /api/health/load answers. It never reads or writes a real data folder, and it deletes its own.
// Usage: node scripts/load-baseline.mjs [tasks=2000] [attempts=1200] [passes=200] [reads=100]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStudio } from '../src/server.mjs';
import { createProject } from '../src/core/project-creation.mjs';

const [tasks = 2000, attempts = 1200, passes = 200, reads = 100] = process.argv.slice(2).map(Number);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-load-'));
const app = createStudio({
  directory,
  port: 0,
  access: 'open',
  bootstrap: { organizationPreset: 'first-run', workflowPresets: [] },
});
const origin = await app.start();
try {
  const { store, runner } = app;
  // A project of work that isn't code, made as the dashboard makes one, holds the fixture's records.
  const created = await createProject(store, runner.registries, runner, { name: 'Load fixture' }),
    project = created.project?.id ?? created.projectId ?? created.id;
  const words = (text, n) => `${text} `.repeat(n).trim();
  // Finished stories with their review and integration, as the live project's thousands are, and the newest few
  // waiting on one that is still being built, queued, so every pass weighs them.
  store.tx(() => {
    for (let i = 0; i < tasks; i++) {
      const waiting = i >= tasks - 50;
      store.putTask({
        id: `T-${i}`,
        projectId: project,
        kind: 'studio-development:change',
        title: `A story title number ${i}`,
        brief: words('Scope words', 150),
        acceptance: words('Acceptance words', 80),
        status: waiting ? 'blocked' : 'done',
        queued: waiting,
        reason: '',
        workerId: 'W-02',
        team: 'Engineering',
        resources: [],
        maxAttempts: 3,
        maxSeconds: 600,
        createdAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
        dependencies: waiting ? [`T-${tasks - 51}`] : i ? [`T-${i - 1}`] : [],
        sourceStage: {
          version: 'source-story-stages-v1',
          phase: waiting ? 'implementing' : 'integration',
          current: waiting ? 'waiting' : 'integrated',
        },
      });
    }
  });
  store.tx(() => {
    for (let i = 0; i < attempts; i++)
      store.insertAttempt(
        {
          id: `attempt-${i}`,
          taskId: `T-${i % (tasks - 50)}`,
          projectId: project,
          status: 'accepted',
          workerId: 'W-02',
          startedAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(),
          finishedAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000 + 300_000).toISOString(),
          result: { summary: words('What the attempt did', 40), issues: [] },
          instructions: { layers: [{ title: 'Bounded source change', text: words('An instruction', 4000) }] },
        },
        { text: words('Snapshot text', 2000) },
      );
  });
  const org = store.organization();
  org.pipelineEnabled = true;
  store.setOrganization(org);
  // The reads must answer what a page gets, not an error that returns at once.
  const check = async read => {
    const response = await fetch(origin + read);
    if (!response.ok) throw new Error(`${read} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.text();
  };
  // Each read the dashboard's pages make for the project, named as readMs reports it. The next page of finished ideas
  // starts after the run the first page names; a first page that names none (this fixture records no idea) has no
  // next page, so that read asks for the first page again and the output says so.
  const projectRead = page => `/api/projects/${project}/${page}`,
    firstIdeas = projectRead('runs?limit=5'),
    { next } = JSON.parse(await check(firstIdeas));
  const pageReads = [
    ['compactState', `/api/state?mode=dashboard&projectId=${project}`],
    ['finishedIdeas', firstIdeas],
    ['finishedIdeasNextPage', next ? `${firstIdeas}&before=${encodeURIComponent(next)}` : firstIdeas],
    ['shell', projectRead('shell')],
    ['live', projectRead('live')],
    ['settledAccepted', projectRead('settled?kind=accepted&limit=12')],
    ['settledCounts', projectRead('settled?kind=closed&limit=0')],
    ['people', projectRead('people')],
    ['activity', projectRead('activity')],
    ['taskPage', `/api/tasks/T-0?projectId=${project}`],
  ];
  for (const [, read] of pageReads) await check(read);
  const began = performance.now();
  for (let i = 0; i < passes; i++) runner.dispatchQueued();
  const passTime = performance.now() - began;
  // Writes no task's readiness depends on, each in its own turn as a running attempt makes them: an event row and the
  // attempt's speech bubble (C-19). Counts the scheduler passes they cause.
  const passCount = async () => (await (await fetch(`${origin}/api/health/load`)).json()).schedulerPassMs.count;
  const quietBefore = await passCount(),
    talking = store.attempt('attempt-0');
  for (let i = 0; i < passes; i++) {
    store.event('note', talking.taskId, talking.id, `A line the attempt said, number ${i}.`);
    await new Promise(resolve => setImmediate(resolve));
    talking.lastSay = { text: `Still working, step ${i}.`, at: new Date().toISOString() };
    store.updateAttempt(talking, { trace: true });
    await new Promise(resolve => setImmediate(resolve));
  }
  const quietWrites = { writes: passes * 2, passes: (await passCount()) - quietBefore };
  // Each read's own times, as a page waits for them, beside the controller's measure of all requests.
  const timed = {};
  for (let i = 0; i < reads; i++)
    for (const [name, read] of pageReads) {
      const start = performance.now();
      await (await fetch(origin + read)).text();
      (timed[name] ??= []).push(performance.now() - start);
    }
  const percentile = (values, share) =>
    Math.round([...values].sort((a, b) => a - b)[Math.floor(share * (values.length - 1))] * 10) / 10;
  const readMs = Object.fromEntries(
    Object.entries(timed).map(([name, values]) => [
      name,
      { p50: percentile(values, 0.5), p95: percentile(values, 0.95) },
    ]),
  );
  const measures = await (await fetch(`${origin}/api/health/load`)).json();
  console.log(
    JSON.stringify(
      {
        fixture: { tasks, attempts, passes, reads, passesTotalMs: Math.round(passTime) },
        quietWrites,
        readMs,
        ...(next
          ? {}
          : {
              notes: [
                'The first page of finished ideas names no next page, so finishedIdeasNextPage asks for the first page again.',
              ],
            }),
        measures,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
}
