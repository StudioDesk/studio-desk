// No projects yet (v1.0 item 24): a fresh install starts with no projects and five agents, offers the Code and Writing
// samples with the signed-in CLIs and git, makes a project from either, and deletes a project with what it recorded.
// The CLIs are the suite's fixtures; no model or real CLI runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStudio } from './model-free-studio.mjs';
import { packageBoundary } from '../src/connectors/package-installs.mjs';

const claudeFixture = fileURLToPath(new URL('./fixture-claude.mjs', import.meta.url)),
  codexFixture = fileURLToPath(new URL('./fixture-cli.mjs', import.meta.url));

// With `inApp`, the data folder sits inside a folder whose package.json makes .js files ES modules, as the default
// data folder sits inside the app.
async function fresh(t, { inApp = false } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-first-run-')),
    directory = inApp ? path.join(top, 'data') : top;
  if (inApp) fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify({ type: 'module' }));
  const app = createStudio({
    directory,
    port: 0,
    bootstrap: { organizationPreset: 'first-run', workflowPresets: [] },
    runnerOptions: { codexBinary: codexFixture, claudeBinary: claudeFixture },
  });
  const origin = await app.start(),
    token = (await (await fetch(origin)).text()).match(/name="studio-token" content="([^"]+)"/)[1];
  t.after(async () => {
    await app.close();
    fs.rmSync(top, { recursive: true, force: true });
  });
  const request = async (url, body = {}) => {
    const res = await fetch(origin + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const get = async url => {
    const res = await fetch(origin + url);
    return { status: res.status, data: await res.json() };
  };
  return { app, directory, request, get };
}
const directorFiles = run =>
  (run.directorInputs?.files ?? run.directorInputs ?? []).map(file => file.name ?? file.path);

test('a fresh install starts with no projects, and No projects yet lists the samples, the signed-in CLIs and git', async t => {
  const c = await fresh(t);
  assert.deepEqual((await c.get('/api/projects')).data, { projects: [] });
  assert.deepEqual(
    c.app.store.organization().workers.map(worker => [worker.id, worker.displayName, worker.jobTitle, worker.provider]),
    [
      ['W-01', 'Mara', 'Planner', 'claude'],
      ['W-02', 'Eli', 'Engineer', 'claude'],
      ['W-06', 'Avery', 'Checks', 'claude'],
      ['W-07', 'Morgan', 'Reviewer', 'claude'],
      ['W-09', 'Juno', 'Writer', 'claude'],
    ],
  );
  assert.equal(c.app.store.tasks().length, 0, 'No starter tasks.');
  const { status, data } = await c.get('/api/templates');
  assert.equal(status, 200);
  assert.equal(data.firstRun, true);
  assert.ok(data.clis.some(cli => cli.id === 'claude' && cli.label === 'Claude Code'));
  assert.equal(data.git.found, true);
  assert.deepEqual(
    data.templates.map(template => template.id),
    ['code', 'writing'],
  );
  const [code, writing] = data.templates;
  assert.deepEqual(
    code.files.map(file => file.path),
    ['README.md', 'package.json', 'src/todo.js', 'test/todo.test.js'],
  );
  assert.ok(code.files.every(file => file.bytes > 0));
  assert.deepEqual(
    code.team.map(member => [member.name, member.role, member.does]),
    [
      ['Mara', 'Planner', 'plans'],
      ['Eli', 'Engineer', 'builds'],
      ['Morgan', 'Reviewer', 'reviews'],
    ],
  );
  assert.deepEqual(
    writing.team.map(member => [member.name, member.role, member.look]),
    [
      ['Mara', 'Planner', null],
      ['Juno', 'Writer', null],
      ['Morgan', 'Reviewer', null],
    ],
  );
  assert.equal(code.needsGit, true);
  assert.equal(writing.needsGit, false);
  assert.equal(writing.suggestions.length, 2);
  assert.match(code.houseRules, /You approve the plan before any work starts/);
  // With no project, a tab still reads the changes that belong to no project.
  assert.equal((await c.get('/api/changes?after=0&start=none')).status, 200);
});

test('the Code sample is a git repository with one commit whose tests pass, its team on the chosen CLI with the recommended house rules', async t => {
  const c = await fresh(t),
    created = await c.request('/api/projects/from-template', {
      template: 'code',
      name: 'To-do list sample',
      cli: 'claude',
    });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { projectId, runId, folder } = created.data;
  assert.equal(runId, null);
  assert.equal(folder, path.join(c.directory, 'samples', 'to-do-list-sample'));
  for (const file of ['README.md', 'package.json', 'src/todo.js', 'test/todo.test.js'])
    assert.ok(fs.existsSync(path.join(folder, file)));
  const log = spawnSync('git', ['log', '--format=%s'], { cwd: folder, encoding: 'utf8' });
  assert.deepEqual(log.stdout.trim().split('\n'), ['To-do list sample, made by Studio desk']);
  const project = c.app.store.project(projectId);
  assert.equal(project.name, 'To-do list sample');
  assert.equal(project.source.root, fs.realpathSync.native(folder));
  assert.deepEqual(project.source.profile.tests, { directory: 'test', suffix: '.test.js' });
  assert.deepEqual(project.sample, { template: 'code', folder });
  // The sample's floor titles its team as No projects yet does, whatever the work.
  assert.deepEqual(
    c.app.store.setting('project-organization:' + projectId).members.map(member => [member.workerId, member.role]),
    [
      ['W-01', 'Planner'],
      ['W-02', 'Engineer'],
      ['W-06', 'Checks'],
      ['W-07', 'Reviewer'],
    ],
  );
  assert.match(
    c.app.store
      .events()
      .filter(event => event.kind === 'project_created')
      .at(-1).message,
    /its tests on [0-9a-f]{7}: /,
  );
  const policy = c.app.store.setting('project-autonomy:' + projectId);
  assert.equal(policy.enabled, true);
  assert.equal(policy.retries, 1);
  assert.equal(policy.kinds['studio-development:change'].integrate, 'auto');
  assert.equal(policy.kinds['studio-development:change'].approve, 'director');
  assert.equal((await c.get('/api/templates')).data.firstRun, false);
  // A name already taken is refused; another name that makes the same folder name is numbered.
  const taken = await c.request('/api/projects/from-template', {
    template: 'code',
    name: 'to-do list SAMPLE',
    cli: 'claude',
  });
  assert.equal(taken.status, 400);
  assert.equal(taken.data.error, 'Choose a distinct project name.');
  const second = await c.request('/api/projects/from-template', {
    template: 'code',
    name: 'To-do list sample!',
    cli: 'claude',
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  assert.equal(second.data.folder, path.join(c.directory, 'samples', 'to-do-list-sample-2'));
});

test("the Writing sample's files go to its first idea, sent with it or later from its New idea box", async t => {
  const c = await fresh(t);
  const withIdea = await c.request('/api/projects/from-template', {
    template: 'writing',
    name: 'Volunteer guide sample',
    cli: 'claude',
    idea: 'Turn the brief into a one-page welcome guide for new volunteers, friendly and under 400 words.',
  });
  assert.equal(withIdea.status, 201, JSON.stringify(withIdea.data));
  assert.ok(withIdea.data.runId);
  assert.deepEqual(directorFiles(c.app.store.run(withIdea.data.runId)).sort(), ['brief.md', 'notes.md', 'style.md']);
  const project = c.app.store.project(withIdea.data.projectId);
  assert.equal(project.sample.filesWaiting, false);
  assert.equal(project.source, undefined, 'Writing is general work.');
  assert.deepEqual(
    c.app.store
      .setting('project-organization:' + project.id)
      .members.map(member => [member.workerId, member.role, member.roles]),
    [
      ['W-01', 'Planner', ['planner']],
      ['W-09', 'Writer', ['worker']],
      ['W-07', 'Reviewer', ['reviewer']],
    ],
  );
  // Without an idea the files wait for the first one sent from the project, and only that one.
  const later = await c.request('/api/projects/from-template', {
    template: 'writing',
    name: 'Second guide',
    cli: 'claude',
  });
  assert.equal(later.status, 201, JSON.stringify(later.data));
  assert.equal(c.app.store.project(later.data.projectId).sample.filesWaiting, true);
  const first = await c.request('/api/intake', { projectId: later.data.projectId, idea: 'Write the welcome guide.' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.deepEqual(directorFiles(c.app.store.run(first.data.runId)).sort(), ['brief.md', 'notes.md', 'style.md']);
  const next = await c.request('/api/intake', { projectId: later.data.projectId, idea: 'Write the invitation email.' });
  assert.equal(next.status, 201, JSON.stringify(next.data));
  assert.deepEqual(directorFiles(c.app.store.run(next.data.runId)), []);
});

test('a sample asks for a known template, a name, a signed-in CLI and at most one idea', async t => {
  const c = await fresh(t),
    send = body => c.request('/api/projects/from-template', body);
  assert.match((await send({ template: 'game', name: 'X', cli: 'claude' })).data.error, /Code or the Writing sample/);
  assert.match((await send({ template: 'code', name: ' ', cli: 'claude' })).data.error, /Project name is missing/);
  assert.match((await send({ template: 'code', name: 'X', cli: 'kimi' })).data.error, /Choose a signed-in CLI/);
  assert.match(
    (await send({ template: 'code', name: 'X', cli: 'claude', idea: 'x'.repeat(4001) })).data.error,
    /at most 4000 characters/,
  );
  assert.match(
    (await send({ template: 'code', name: 'X', cli: 'claude', extra: 1 })).data.error,
    /template, name, CLI/,
  );
  assert.deepEqual(
    fs.existsSync(path.join(c.directory, 'samples')) ? fs.readdirSync(path.join(c.directory, 'samples')) : [],
    [],
  );
  assert.deepEqual((await c.get('/api/projects')).data, { projects: [] });
  // Create a project works with no project selected at all.
  const general = await c.request('/api/projects', { name: 'Notes' });
  assert.equal(general.status, 201, JSON.stringify(general.data));
  // Without a folder it is general work, with a team that takes ideas: Mara plans, the others do the steps and
  // Morgan reviews (found in the README-only fresh install, where it had no planner and so no idea box).
  const team = c.app.store.setting('project-organization:' + general.data.id);
  assert.deepEqual(team.taskKinds, ['general:plan', 'general:work', 'general:review', 'general']);
  assert.deepEqual(
    team.members.map(member => [member.workerId, member.role, member.roles]),
    [
      ['W-01', 'Planner', ['planner']],
      ['W-02', 'Engineer', ['engineer', 'worker']],
      ['W-06', 'Checks', ['checks', 'worker']],
      ['W-09', 'Writer', ['writer', 'worker']],
      ['W-07', 'Reviewer', ['reviewer']],
    ],
  );
  const idea = await c.request('/api/intake', { projectId: general.data.id, idea: 'Write a short welcome note.' });
  assert.equal(idea.status, 201, JSON.stringify(idea.data));
  assert.ok(c.app.store.tasks().some(task => task.projectId === general.data.id && task.kind === 'general:plan'));
});

test('a sample goes in a new folder inside a folder the director chose, outside the data folder, and stays there when its project is deleted', async t => {
  const c = await fresh(t),
    send = body => c.request('/api/projects/from-template', { template: 'writing', cli: 'claude', ...body }),
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-sample-location-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  // The screen shows where a sample goes unless another folder is chosen.
  assert.equal((await c.get('/api/templates')).data.samples, path.join(c.directory, 'samples'));
  fs.writeFileSync(path.join(outside, 'mine.txt'), 'Already here.\n');
  fs.mkdirSync(path.join(c.directory, 'jobs'), { recursive: true });
  for (const [location, error] of [
    ['samples', /absolute folder path/],
    [path.join(outside, 'missing'), /There is no folder at/],
    [path.join(outside, 'mine.txt'), /is not a folder/],
    [c.directory, /outside the Studio desk data folder/],
    [path.join(c.directory, 'jobs'), /outside the Studio desk data folder/],
  ])
    assert.match((await send({ name: 'Guide', location })).data.error, error, location);
  assert.deepEqual((await c.get('/api/projects')).data, { projects: [] });
  const created = await send({ name: 'Volunteer guide sample', location: outside });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const folder = path.join(fs.realpathSync(outside), 'volunteer-guide-sample');
  assert.equal(created.data.folder, folder);
  assert.deepEqual(fs.readdirSync(folder).sort(), ['brief.md', 'notes.md', 'style.md']);
  assert.deepEqual(fs.readdirSync(outside).sort(), ['mine.txt', 'volunteer-guide-sample']);
  assert.equal(fs.readFileSync(path.join(outside, 'mine.txt'), 'utf8'), 'Already here.\n');
  // A second sample whose name makes the same folder name gets a numbered folder beside it.
  const second = await send({ name: 'Volunteer guide sample!', location: outside });
  assert.equal(second.data.folder, path.join(fs.realpathSync(outside), 'volunteer-guide-sample-2'));
  const { projectId } = created.data,
    deleted = await c.request(`/api/projects/${projectId}/delete`, { projectId, name: 'Volunteer guide sample' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.deepEqual(deleted.data, { deleted: projectId, folderRemoved: false });
  assert.deepEqual(fs.readdirSync(folder).sort(), ['brief.md', 'notes.md', 'style.md']);
});

test("a repository without a package.json of its own is tested with Node's defaults, not the app's", async t => {
  const c = await fresh(t, { inApp: true }),
    boundary = path.join(c.directory, 'package.json');
  assert.equal(JSON.parse(fs.readFileSync(boundary, 'utf8')).type, undefined);
  // CommonJS tests, which fail if the app's "type": "module" reaches the copy they run in.
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plain-repository-')),
    git = (...args) => spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repository, 'test'));
  fs.writeFileSync(path.join(repository, 'test', 'plain.test.js'), "require('node:test')('runs', () => {});\n");
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-q', '-m', 'Plain tests');
  const created = await c.request('/api/projects', { name: 'Plain', repository: { root: repository } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  // A package.json already in a data folder is the person's, and stays as it is.
  fs.writeFileSync(boundary, '{"name":"mine"}\n');
  packageBoundary(c.directory);
  assert.equal(fs.readFileSync(boundary, 'utf8'), '{"name":"mine"}\n');
});

test('deleting a project removes it, what it recorded and a sample folder, and waits while its work runs', async t => {
  const c = await fresh(t);
  const created = await c.request('/api/projects/from-template', {
    template: 'writing',
    name: 'Volunteer guide sample',
    cli: 'claude',
  });
  const { projectId, folder } = created.data;
  // Paused first, so its idea's work waits instead of starting on its own.
  assert.equal((await c.request('/api/pipeline', { projectId, action: 'pause' })).status, 200);
  assert.equal((await c.request('/api/intake', { projectId, idea: 'Write the welcome guide.' })).status, 201);
  const tasks = c.app.store.tasks().filter(task => task.projectId === projectId);
  assert.ok(tasks.length);
  const running = {
    id: 'attempt-first-run-running',
    taskId: tasks[0].id,
    projectId,
    workerId: 'W-01',
    provider: 'claude',
    status: 'running',
    startedAt: new Date().toISOString(),
    artifacts: [],
    inputReferences: [],
  };
  c.app.store.insertAttempt(running, { hash: 'snapshot', text: 'Instructions.' });
  const wrong = await c.request(`/api/projects/${projectId}/delete`, { projectId, name: 'Volunteer guide' });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Type the project's name, Volunteer guide sample/);
  const busy = await c.request(`/api/projects/${projectId}/delete`, { projectId, name: 'Volunteer guide sample' });
  assert.equal(busy.status, 400);
  assert.match(busy.data.error, /still running/);
  c.app.store.updateAttempt({ ...running, status: 'failed', finishedAt: new Date().toISOString() });
  const deleted = await c.request(`/api/projects/${projectId}/delete`, { projectId, name: 'Volunteer guide sample' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.deepEqual(deleted.data, { deleted: projectId, folderRemoved: true });
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(path.join(c.directory, 'projects', projectId)), false);
  assert.deepEqual((await c.get('/api/projects')).data, { projects: [] });
  assert.equal(c.app.store.tasks().filter(task => task.projectId === projectId).length, 0);
  assert.equal(c.app.store.allAttempts().filter(attempt => attempt.projectId === projectId).length, 0);
  assert.equal(c.app.store.runs(projectId).length, 0);
  assert.equal(c.app.store.setting('project-organization:' + projectId), null);
  assert.match(c.app.store.events().at(-1).message, /Project deleted: Volunteer guide sample/);
  // No projects now, after one existed: not the first run.
  assert.equal((await c.get('/api/templates')).data.firstRun, false);
});
