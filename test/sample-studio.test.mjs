import './model-free-studio.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildArguments,
  sampleDirectory,
  sampleProjects,
  startSampleStudio,
  viteProgram,
} from '../scripts/sample-studio.mjs';

// The sample studio Studio desk development's visual check starts (October 30, 2026): the two projects at the addresses
// the planner names, ideas waiting, every agent the Simulator and the studio paused, so a capture never runs a model.
test('the sample studio holds both projects at their fixed addresses, paused, with only the Simulator', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sample-test-'));
  // A leftover from an earlier start is emptied.
  fs.mkdirSync(path.join(base, '.studio-sample'), { recursive: true });
  fs.writeFileSync(path.join(base, '.studio-sample', 'leftover.txt'), 'old');
  const studio = await startSampleStudio({ base, port: 0, build: false });
  // The studio closes its records before its folder goes.
  t.after(async () => {
    await studio.close();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  // By its real spelling, whichever one the temporary folder was reached by (a junction or symbolic link, a short name).
  assert.equal(studio.directory, fs.realpathSync.native(path.join(base, '.studio-sample')));
  assert.equal(studio.store.directory, studio.directory);
  assert.ok(!fs.existsSync(path.join(base, '.studio-sample', 'leftover.txt')));
  assert.ok(!fs.existsSync(path.join(base, 'data')), 'The sample never makes or uses the data folder.');
  const get = async url => (await fetch(studio.address + url)).json();
  const { projects } = await get('/api/projects');
  assert.deepEqual(projects.map(project => [project.id, project.name]).sort(), [
    [sampleProjects.work, 'Northbound Coffee'],
    [sampleProjects.code, 'Studio desk development'],
  ]);
  const code = await get(`/api/projects/${sampleProjects.code}/shell`);
  assert.equal(code.paused, true);
  assert.ok(code.project.source, 'The code project works on its own sample repository.');
  assert.ok(!path.relative(studio.directory, code.project.source.root).startsWith('..'));
  assert.deepEqual([...new Set(code.employeeDirectory.map(worker => worker.provider))], ['mock']);
  for (const projectId of Object.values(sampleProjects)) {
    // A library file in each, so library and Artifacts pictures have something to show.
    const library = await get(`/api/projects/${projectId}/library?projectId=${projectId}`);
    assert.equal((library.entries ?? []).length, 1, `${projectId} has one library file`);
    const state = await get(`/api/state?mode=dashboard&projectId=${projectId}`);
    assert.equal(state.runs.length, 2, `${projectId} holds two ideas`);
    assert.equal(state.attempts.length, 0, `${projectId} started nothing`);
    const shell = await get(`/api/projects/${projectId}/shell`);
    assert.equal(shell.paused, true);
    assert.ok(shell.employeeDirectory.every(worker => worker.provider === 'mock' && worker.cli === 'Simulator'));
    for (const run of state.runs) {
      const tasks = state.tasks.filter(task => (task.workflowReference?.runId ?? task.runReference?.runId) === run.id);
      const first = tasks.filter(task => task.dependencies.length === 0);
      assert.equal(first.length, 1, 'Each idea waits at its first step.');
      assert.equal(first[0].kind, projectId === sampleProjects.code ? 'studio-development:checks' : 'general:plan');
      assert.ok(
        tasks.every(task => task.status === 'blocked'),
        'The paused studio holds every step.',
      );
      assert.ok(tasks.every(task => !task.lastAttemptId && !task.acceptedAttemptId));
    }
  }
  const releases = await get(`/api/projects/${sampleProjects.code}/releases`),
    milestone = releases.milestones.find(item => item.version === '1.1.0');
  assert.equal(milestone.line, 'release/1.1');
  assert.equal(milestone.state, 'open');
  assert.equal(milestone.release, undefined);
  assert.equal(milestone.ideas.length, 2, 'Both initial ideas belong to the open release.');
  assert.equal(milestone.counts.waiting, 1, 'One waiting idea exposes the unfinished-work checkbox.');
  assert.equal(milestone.counts.stories, 0, 'The sample invents no completed production work.');
  const work = await get(`/api/projects/${sampleProjects.work}/releases`);
  assert.equal(work.available, false);
});

test("the sample studio's folder is never the data folder, and Vite is found from the copy", () => {
  assert.equal(sampleDirectory('/copy'), path.join('/copy', '.studio-sample'));
  assert.match(viteProgram(), /vite[\\/]bin[\\/]vite\.js$/);
  assert.ok(fs.existsSync(viteProgram()));
  // Vite's root is the dashboard folder, so the build names the copy's dist folder in full (November 1: a relative
  // one built into dashboard/dist, and the captures showed The dashboard is not built).
  const args = buildArguments();
  assert.equal(args[args.indexOf('--outDir') + 1], path.join(fileURLToPath(new URL('..', import.meta.url)), 'dist'));
});
