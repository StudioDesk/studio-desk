// Proposing and checking another repository's source profile before a project records it (1.0 step 4b).
// Model-free: temporary git repositories and the installed Node test runner only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies Git writes.
import './model-free-studio.mjs';
import { inspectRepository, proposeSourceProfile, recordProjectSource } from '../src/connectors/source-projects.mjs';
import { sourcePlan, testTotals } from '../src/connectors/source-checks.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { git } from '../src/connectors/source-integration.mjs';

function repository(t, files) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-inspect-'))),
    root = path.join(directory, 'site');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [file, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), contents);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture baseline']);
  return root;
}
const site = {
  'README.md': '# A site\n',
  'package.json': '{ "name": "site" }\n',
  'tsconfig.json': '{}\n',
  'AGENTS.md': 'Instructions written for agents are content here.\n',
  '.github/workflows/ci.yml': 'on: push\n',
  // Tracked by mistake: a proposal never offers dependency or build output to a story.
  'node_modules/left-pad/index.js': 'module.exports = {};\n',
  'dist/app.js': 'built\n',
  'lib/contact.ts': 'export const isEmail = (value: string): boolean => /^[^\\s@]+@[^\\s@]+$/.test(value);\n',
  'app/page.tsx': 'export default function Page() { return null; }\n',
  'public/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  // A photo larger than a file a story may edit: copied, never edited.
  'public/photo.jpg': Buffer.alloc(studioDeskProfile.limits.fileBytes + 1),
};
const runtime = root => ({ sourceChangeRoot: path.join(path.dirname(root), 'controller') });

test('a proposed profile covers what the repository tracks, minus dot, dependency and build folders', t => {
  const root = repository(t, site),
    profile = proposeSourceProfile(root);
  assert.deepEqual(profile, {
    id: 'site',
    directories: ['app', 'lib', 'public', 'tests'],
    files: ['AGENTS.md', 'README.md', 'package.json', 'tsconfig.json'],
    // The top-level files' types too, since a story may edit those; their tool configuration stays the director's.
    extensions: ['json', 'md', 'svg', 'ts', 'tsx'],
    protectedNames: [
      'AGENTS.md',
      'CLAUDE.md',
      'package.json',
      'package-lock.json',
      'npm-shrinkwrap.json',
      'tsconfig.json',
    ],
    contextFiles: ['README.md'],
    // No tests yet, and TypeScript is tracked: Node's runner on tests/*.test.ts, which needs no packages.
    tests: { directory: 'tests', suffix: '.test.ts' },
    formatter: null,
    limits: {
      files: studioDeskProfile.limits.files,
      fileBytes: studioDeskProfile.limits.fileBytes,
      totalBytes: studioDeskProfile.limits.totalBytes,
    },
  });
  // A repository that already keeps Node tests in a test folder gets that folder and suffix. A tracked bin holds
  // the package's command-line scripts, which its tests may run, so it is offered too (nanoid's CLI tests).
  const tested = repository(t, {
    'bin/cli.mjs': "#!/usr/bin/env node\nimport '../src/index.mjs';\n",
    'src/index.mjs': 'export {};\n',
    'test/a.test.mjs': "import test from 'node:test';\ntest('a', () => {});\n",
    'test/b.test.mjs': "import test from 'node:test';\ntest('b', () => {});\n",
  });
  assert.deepEqual(proposeSourceProfile(tested).tests, { directory: 'test', suffix: '.test.mjs' });
  assert.deepEqual(proposeSourceProfile(tested).directories, ['bin', 'src', 'test']);
});

test('inspection lists problems instead of recording, and a repository may have no tests yet', t => {
  const root = repository(t, site),
    store = { projects: () => [] },
    clean = inspectRepository(store, root, runtime(root));
  assert.equal(clean.branch, 'main');
  assert.deepEqual(clean.problems, []);
  assert.equal(clean.testFiles, 0);
  assert.equal(clean.files, 8);
  // With no test files the runner gets the profile's own pattern, never an empty list that would make
  // it search the whole copy, and it measures no tests rather than failing.
  const plan = sourcePlan(root, clean.profile);
  assert.equal(plan.command.args.at(-1), 'tests/*.test.ts');
  fs.writeFileSync(path.join(root, 'app/stray.test.mjs'), "throw new Error('Outside the tests folder.');\n");
  // Without NODE_TEST_CONTEXT, which would make the nested runner report to this one instead of in TAP.
  const { NODE_TEST_CONTEXT, ...env } = process.env,
    run = spawnSync(plan.command.executable, plan.command.args, { cwd: root, encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(testTotals(run.stdout).tests, 0);
  fs.rmSync(path.join(root, 'app/stray.test.mjs'));
  // Studio desk itself still needs its tests.
  const desk = path.join(path.dirname(root), 'desk');
  for (const directory of studioDeskProfile.directories) fs.mkdirSync(path.join(desk, directory), { recursive: true });
  for (const file of studioDeskProfile.files) fs.writeFileSync(path.join(desk, file), '');
  assert.throws(() => sourcePlan(desk), /No registered source tests were found/);

  fs.writeFileSync(path.join(root, 'lib/contact.ts'), 'export {};\n');
  assert.deepEqual(inspectRepository(store, root, runtime(root)).problems, [
    'Commit or stash the tracked changes first: stories start from a clean tree.',
  ]);
  git(root, ['checkout', '--', 'lib/contact.ts']);
  // An edited profile is checked as given.
  assert.match(
    inspectRepository(store, root, runtime(root), {
      ...clean.profile,
      extensions: [...clean.profile.extensions, 'jpg'],
    }).problems[0],
    /public\/photo\.jpg is larger than the 1024 KB a file a story may edit can be/,
  );
  assert.throws(
    () => inspectRepository(store, root, runtime(root), { ...clean.profile, tests: { directory: 'spec' } }),
    /tests must name a snapshot directory and a file suffix/,
  );
  // Not the controller's own source, and not a repository another project already works on.
  assert.throws(() => inspectRepository(store, root, { sourceChangeRoot: root }), /controller's default source/);
  const taken = { projects: () => [{ id: 'project-other', name: 'Other site', source: { root } }] };
  assert.throws(() => inspectRepository(taken, root, runtime(root)), /Other site already works on this repository/);
  assert.throws(() => inspectRepository(store, path.join(root, 'lib'), runtime(root)), /root of its git repository/);
  assert.throws(() => inspectRepository(store, 'relative/site', runtime(root)), /absolute path/);
  // Recording uses the same checks.
  const project = { id: 'project-site', name: 'Site' },
    projects = { projects: () => [project], project: () => project, putProject: () => {} };
  assert.equal(recordProjectSource(projects, project.id, { root, profile: clean.profile }, runtime(root)).root, root);
});

test('a folder that is not a git repository is refused in plain words', t => {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-plain-'))),
    folder = path.join(directory, 'notes'),
    ceiling = process.env.GIT_CEILING_DIRECTORIES;
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'list.txt'), 'Work that is not code.\n');
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // The candidate's temporary folder sits inside a git checkout: stop git from looking above the fixture.
  process.env.GIT_CEILING_DIRECTORIES = directory;
  assert.throws(() => inspectRepository({ projects: () => [] }, folder, runtime(folder)), {
    message:
      'This folder is not a git repository. This version of Studio desk works on git repositories; ' +
      'leave the folder empty to make a project for work that is not code.',
  });
  // A missing folder keeps its own message.
  assert.throws(
    () => inspectRepository({ projects: () => [] }, path.join(directory, 'missing'), runtime(folder)),
    /The repository folder does not exist/,
  );
});
