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
  assert.equal(studio.directory, path.join(base, '.studio-sample'));
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
    const state = await get(`/api/state?mode=dashboard&projectId=${projectId}`);
    assert.equal(state.runs.length, 2, `${projectId} holds two ideas`);
    assert.equal(state.attempts.length, 0, `${projectId} started nothing`);
  }
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
