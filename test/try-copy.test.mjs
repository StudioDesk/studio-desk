// Trying a story yourself (1.2 step 7): the project's try copy moves to a story's candidate merged onto its line, or to
// the candidate as built when that conflicts; it refuses to move over the director's own edits; Run starts the
// project's start command there and Stop ends it; and a controller that stops while it runs records it as ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { realPath } from '../src/core/real-path.mjs';
import path from 'node:path';
import { setup } from './studio-setup.mjs';
import { git } from '../src/connectors/source-integration.mjs';
import {
  addressIn,
  recoverTryRuns,
  runTry,
  saveTrySettings,
  stopTry,
  tryCopy,
  tryOutput,
  tryStory,
  tryView,
  validateTrySettings,
} from '../src/connectors/try-copy.mjs';

const profile = {
  id: 'try-fixture',
  directories: ['lib'],
  files: ['README.md', 'serve.mjs', 'package.json', 'package-lock.json'],
  extensions: ['js', 'mjs', 'md', 'json'],
  protectedNames: [],
  contextFiles: ['README.md'],
  tests: { directory: 'lib', suffix: '.test.mjs' },
  formatter: null,
  limits: { files: 50, fileBytes: 64 * 1024, totalBytes: 1024 * 1024 },
};
// A small app the start command runs: it prints its address as dev servers do, colors included, and stays up.
const server = `import http from 'node:http';
import fs from 'node:fs';
const greeting = fs.readFileSync('lib/greeting.js', 'utf8').trim();
const app = http.createServer((request, response) => response.end(greeting));
app.listen(0, '127.0.0.1', () => console.log('\\x1b[32m  Local:\\x1b[0m   http://127.0.0.1:' + app.address().port + '/'));
`;

async function studio(t) {
  const c = await setup(t),
    { store, runner } = c.app,
    root = path.join(c.dir, 'app');
  for (const [file, text] of Object.entries({
    'README.md': '# Try fixture\n',
    'serve.mjs': server,
    'lib/greeting.js': 'hello\n',
    '.gitignore': 'node_modules/\n',
  })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Try fixture']);
  const project = { id: 'project-try', name: 'Try fixture', source: { root: realPath(root), profile } };
  store.putProject(project);
  // The suite never runs the real sandbox: Run runs on this computer once confirmed.
  runner.tryLetsPortsThrough = false;
  let stories = 0;
  // A story whose candidate (a commit beside main, as an editor's worktree makes one) passed its tests.
  const story = (files, base = 'HEAD') => {
    const id = `T-try-${++stories}`,
      candidateId = `attempt-try-${stories}`;
    git(root, ['checkout', '--quiet', '--detach', base]);
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file), text);
    git(root, ['add', '-A']);
    git(root, ['commit', '--quiet', '-m', `Candidate ${stories}`]);
    const commit = git(root, ['rev-parse', 'HEAD']);
    git(root, ['checkout', '--quiet', 'main']);
    store.putTask({
      id,
      projectId: project.id,
      kind: 'studio-development:change',
      title: `Story ${stories}`,
      status: 'done',
      dependencies: [],
      sourceStage: { candidate: { taskId: id, attemptId: candidateId } },
    });
    store.insertAttempt(
      {
        id: candidateId,
        taskId: id,
        projectId: project.id,
        workerId: 'W-01',
        status: 'accepted',
        result: { outcome: 'completed' },
        sourceCandidate: { commit },
        sourceChange: { base: { branch: 'main' } },
        artifacts: [],
      },
      { text: 'Fixture', hash: 'fixture' },
    );
    return store.task(id);
  };
  const land = (file, text) => {
    fs.writeFileSync(path.join(root, file), text);
    git(root, ['commit', '--quiet', '-am', `Landed ${file}`]);
  };
  const folder = `${realPath(root)}-try`;
  t.after(async () => {
    for (const entry of runner.tryRuns?.values() || []) entry.child?.kill('SIGKILL');
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return { c, store, runner, root: realPath(root), project, story, land, folder };
}

const read = (folder, file) => fs.readFileSync(path.join(folder, file), 'utf8');

test("Try it puts the copy beside the project's folder on the story's change merged onto its line", async t => {
  const { store, runner, story, land, folder, project, root } = await studio(t);
  const first = story({ 'lib/greeting.js': 'hello from story one\n' });
  // Work that landed since the candidate was built is in the copy too: the same merge integrating makes.
  land('README.md', '# Try fixture, landed since\n');
  const record = await tryStory(runner, first);
  assert.equal(record.folder, folder);
  assert.equal(record.merged, true);
  assert.equal(read(folder, 'lib/greeting.js'), 'hello from story one\n');
  assert.equal(read(folder, 'README.md'), '# Try fixture, landed since\n');
  assert.equal(record.tip, git(root, ['rev-parse', 'main']));
  // The copy holds a detached commit, so it never holds a branch integration moves.
  assert.throws(() => git(folder, ['symbolic-ref', 'HEAD']));
  assert.equal(git(folder, ['rev-parse', 'HEAD']), record.commit);
  assert.match(
    store.taskEvents(first).at(-1).message,
    /merged onto main at [0-9a-f]{7}, as integrating it would merge it/,
  );
  // Another story moves the same copy.
  const second = story({ 'lib/greeting.js': 'hello from story two\n' });
  const moved = await tryStory(runner, second);
  assert.equal(moved.taskId, second.id);
  assert.equal(read(folder, 'lib/greeting.js'), 'hello from story two\n');
  assert.deepEqual(tryView(store, project.id, runner, false).copy.taskId, second.id);
});

test('a candidate that conflicts with its line is tried as built, and the copy says so', async t => {
  const { runner, story, land, folder, store } = await studio(t);
  const conflicting = story({ 'lib/greeting.js': 'hello from the story\n' });
  land('lib/greeting.js', 'hello from main\n');
  const record = await tryStory(runner, conflicting);
  assert.equal(record.merged, false);
  assert.deepEqual(record.conflicts, ['lib/greeting.js']);
  assert.equal(record.commit, record.candidateCommit);
  assert.equal(read(folder, 'lib/greeting.js'), 'hello from the story\n');
  assert.equal(git(folder, ['status', '--porcelain']), '', 'Nothing of the failed merge is left in the copy.');
  assert.match(
    store.taskEvents(conflicting).at(-1).message,
    /conflicts with main .* in lib\/greeting\.js, so the try copy holds the candidate as built/,
  );
});

test("the copy refuses to move over the director's own edits, naming them, until they are discarded", async t => {
  const { c, runner, story, folder, project } = await studio(t);
  const first = story({ 'lib/greeting.js': 'one\n' }),
    second = story({ 'lib/greeting.js': 'two\n' });
  await tryStory(runner, first);
  fs.writeFileSync(path.join(folder, 'lib/greeting.js'), 'my own edit\n');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'what I saw\n');
  // Installed packages are ignored files, not edits, and stay between tries.
  fs.mkdirSync(path.join(folder, 'node_modules', 'kept'), { recursive: true });
  await assert.rejects(tryStory(runner, second), error => {
    assert.equal(error.status, 409);
    assert.deepEqual(error.edits.sort(), ['lib/greeting.js', 'notes.txt']);
    assert.match(error.message, /holds your own edits: .*Keep them, or discard them and try this story/);
    return true;
  });
  assert.equal(read(folder, 'lib/greeting.js'), 'my own edit\n', 'Keeping them leaves the copy where it was.');
  // The route answers with the files, for the page's Keep them and Discard them.
  const refused = await c.request(`/api/tasks/${second.id}/try`, { projectId: project.id });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.data.edits.sort(), ['lib/greeting.js', 'notes.txt']);
  const discarded = await c.request(`/api/tasks/${second.id}/try`, { projectId: project.id, discard: true });
  assert.equal(discarded.status, 200, JSON.stringify(discarded.data));
  assert.equal(read(folder, 'lib/greeting.js'), 'two\n');
  assert.equal(fs.existsSync(path.join(folder, 'notes.txt')), false);
  assert.equal(fs.existsSync(path.join(folder, 'node_modules', 'kept')), true);
});

test('Try it is offered only on a code story whose candidate passed, and the copy keeps out of the project folder', async t => {
  const { store, runner, story, project, root } = await studio(t);
  const tried = story({ 'lib/greeting.js': 'one\n' });
  const waiting = { ...tried, id: 'T-no-candidate', sourceStage: {} };
  await assert.rejects(tryStory(runner, waiting), /once the story has a candidate whose tests passed/);
  const failed = store.attempt(tried.sourceStage.candidate.attemptId);
  store.updateAttempt({ ...failed, status: 'failed' });
  await assert.rejects(tryStory(runner, tried), /once the story has a candidate whose tests passed/);
  assert.throws(
    () => saveTrySettings(store, project.id, { folder: path.join(root, 'try') }, runner),
    /a folder of its own, outside the project's folder/,
  );
  // A folder that holds something else is never taken over.
  const other = path.join(path.dirname(root), 'other');
  fs.mkdirSync(other);
  saveTrySettings(store, project.id, { folder: other }, runner);
  store.updateAttempt({ ...failed, status: 'accepted' });
  await assert.rejects(tryStory(runner, tried), /holds something other than this project's try copy/);
});

test('the settings take a start command without a shell, a local address, a folder and where Run runs', () => {
  assert.deepEqual(validateTrySettings({ start: ['npm', 'run', 'dev'] }), {
    start: ['npm', 'run', 'dev'],
    address: null,
    folder: null,
    runIn: 'built-in',
  });
  assert.equal(validateTrySettings({ address: 'http://localhost:5173/' }).address, 'http://localhost:5173/');
  for (const [settings, problem] of [
    [{ start: ['npm run dev'] }, /start command must be a program's name/],
    [{ start: ['node', 'a\nb'] }, /start command/],
    [{ start: [] }, /start command/],
    [{ address: 'http://example.com/' }, /address must be an http address on this computer/],
    [{ address: 'file:///C:/x' }, /address/],
    [{ folder: 'relative/try' }, /absolute path/],
    [{ runIn: 'docker' }, /Run in must be/],
    [{ shell: true }, /unknown field shell/],
  ])
    assert.throws(() => validateTrySettings(settings), problem);
  // The address an app printed, with its colors, and 0.0.0.0 opening as localhost.
  assert.equal(addressIn('\x1b[32m  Local:\x1b[0m   http://127.0.0.1:5173/\n'), 'http://127.0.0.1:5173/');
  assert.equal(addressIn('Listening on http://0.0.0.0:3000.'), 'http://localhost:3000');
  assert.equal(addressIn('Docs at https://example.com/ and nothing local'), null);
});

test('Run starts the start command in the copy, asks once before running outside the sandbox, and Stop ends it', async t => {
  const { c, store, runner, story, project } = await studio(t);
  const tried = story({ 'lib/greeting.js': 'hello from the tried story\n' });
  await tryStory(runner, tried);
  assert.throws(() => runTry(runner, project.id), /Name a start command in the project's settings first/);
  saveTrySettings(store, project.id, { start: ['node', 'serve.mjs'] }, runner);
  // Outside the sandbox the director confirms once for the project.
  const asked = await c.request(`/api/projects/${project.id}/try/run`, { projectId: project.id });
  assert.equal(asked.status, 409);
  assert.equal(asked.data.confirm, 'outside');
  assert.match(asked.data.error, /runs the agents' code on this computer, outside the sandbox/);
  const started = await c.request(`/api/projects/${project.id}/try/run`, {
    projectId: project.id,
    confirmOutside: true,
  });
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.place, 'computer');
  assert.ok(store.project(project.id).trying.outsideConfirmedAt);
  await c.until(() => tryCopy(store, project.id).run?.address, 'the address the app printed');
  const run = tryCopy(store, project.id).run;
  assert.equal(run.state, 'running');
  assert.match(run.address, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(await (await fetch(run.address)).text(), 'hello from the tried story');
  assert.match(tryOutput(store, project.id), /^> node serve\.mjs\n.*Local:/s);
  // One Run at a time per project.
  assert.throws(() => runTry(runner, project.id), /already running/);
  const stopped = await c.request(`/api/projects/${project.id}/try/stop`, { projectId: project.id });
  assert.equal(stopped.data.run.state, 'ended');
  assert.equal(tryCopy(store, project.id).run.stopped, 'You stopped it.');
  await assert.rejects(fetch(run.address, { signal: AbortSignal.timeout(3000) }));
  // Confirmed once: the next Run needs no confirmation.
  runTry(runner, project.id);
  await c.until(() => tryCopy(store, project.id).run?.address, 'the second run');
  // Trying another story stops the running app first.
  const next = story({ 'lib/greeting.js': 'next\n' });
  await tryStory(runner, next);
  assert.equal(tryCopy(store, project.id).run.state, 'ended');
  assert.equal(tryCopy(store, project.id).run.stopped, 'Trying another story stopped it.');
  assert.ok(store.taskEvents(tried).some(event => event.kind === 'try_run'));
  // The output reads as inert plain text.
  const output = await fetch(`${c.origin}/api/projects/${project.id}/try/output`);
  assert.equal(output.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.match(await output.text(), /Local:/);
});

test('packages are installed before the first Run and again only when the lockfile changes', async t => {
  const { store, runner, story, project, c, root } = await studio(t);
  project.source.profile = { ...profile, install: 'npm-ci' };
  store.putProject(project);
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"try-fixture","private":true}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Packages']);
  const tried = story({ 'lib/greeting.js': 'with packages\n' });
  await tryStory(runner, tried);
  saveTrySettings(store, project.id, { start: ['node', 'serve.mjs'] }, runner);
  runTry(runner, project.id, { confirmOutside: true });
  await c.until(() => tryCopy(store, project.id).run?.address, 'the app after its install');
  assert.match(
    tryOutput(store, project.id),
    /^> npm ci .*added 1 package from the model-free fixture.*> node serve\.mjs/s,
  );
  assert.ok(tryCopy(store, project.id).packages);
  await stopTry(runner, project.id);
  runTry(runner, project.id);
  await c.until(() => tryCopy(store, project.id).run?.address, 'the app without an install');
  assert.doesNotMatch(tryOutput(store, project.id), /npm ci/);
  await stopTry(runner, project.id);
});

test('a controller that stops while the app runs ends it, and its next start records it as ended', async t => {
  const { store, runner, story, project, c } = await studio(t);
  const tried = story({ 'lib/greeting.js': 'until the restart\n' });
  await tryStory(runner, tried);
  saveTrySettings(store, project.id, { start: ['node', 'serve.mjs'] }, runner);
  runTry(runner, project.id, { confirmOutside: true });
  await c.until(() => tryCopy(store, project.id).run?.address, 'the running app');
  const { address } = tryCopy(store, project.id).run,
    entry = runner.tryRuns.get(project.id);
  // The controller's own stop: the app ends with it, and nothing is recorded while the store closes.
  runner.closing = true;
  const { endTryRuns } = await import('../src/connectors/try-copy.mjs');
  endTryRuns(runner);
  await entry.ended;
  runner.closing = false;
  await assert.rejects(fetch(address, { signal: AbortSignal.timeout(3000) }));
  assert.equal(tryCopy(store, project.id).run.state, 'running', 'Recorded as running until the next start.');
  recoverTryRuns(store);
  const run = tryCopy(store, project.id).run;
  assert.equal(run.state, 'ended');
  assert.equal(run.stopped, 'The controller stopped.');
  assert.match(store.taskEvents(tried).at(-1).message, /ended when the controller stopped/);
});
