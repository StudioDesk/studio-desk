// A project's source profile (1.0 item 8): Studio desk's values are its profile, and every source
// operation follows another profile's folders, root files, path rules, context documents, test files,
// formatter and limits. Model-free: a disposable git repository and the process fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Reuse the candidate-local temp policy: MXC's redirected OS temp denies Git writes.
import './model-free-studio.mjs';
import {
  studioDeskProfile,
  studioDeskProfileRevision1,
  validateSourceProfile,
  storyPathAllowed,
  storyPathScope,
  profileOf,
  recordedProfile,
  installsPackages,
} from '../src/connectors/source-profile.mjs';
import {
  sourcePlan,
  copySource,
  verifyCopy,
  sourceContext,
  ensureSourceDirectories,
} from '../src/connectors/source-checks.mjs';
import { validateStoryPaths } from '../src/connectors/source-changes.mjs';
import {
  sourceBase,
  snapshotCommit,
  createSourceWorktree,
  cleanSourceWorktrees,
  worktreeRepository,
} from '../src/connectors/source-worktrees.mjs';
import { git, verifyIntegration } from '../src/connectors/source-integration.mjs';
import { Store } from '../src/core/store.mjs';

const checkFixture = fileURLToPath(new URL('./fixture-source-check.mjs', import.meta.url));

// A neutral repository shape that shares no folder, test convention or formatter with Studio desk.
const notesProfile = Object.freeze({
  id: 'field-notes',
  directories: ['lib', 'spec', 'notes'],
  files: ['README.md', 'Makefile'],
  extensions: ['js', 'md', 'txt'],
  protectedNames: ['Makefile', 'SECRETS.md'],
  contextFiles: ['README.md', 'notes/overview.md'],
  tests: { directory: 'spec', suffix: '.spec.mjs' },
  formatter: null,
  limits: { files: 20, fileBytes: 64 * 1024, totalBytes: 512 * 1024 },
});

function repository(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-profile-'))),
    root = path.join(directory, 'r');
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  ensureSourceDirectories(root, notesProfile);
  const files = {
    'README.md': '# Field notes\n',
    Makefile: 'all:\n',
    'lib/notes.js': 'export const notes = [];\n',
    'notes/overview.md': 'How the notes are kept.\n',
    'spec/notes.spec.mjs': "import test from 'node:test';\ntest('notes', () => {});\n",
    'spec/helpers/setup.mjs': '// Not a test file: it sits in a subfolder.\n',
    // Outside the profile: never measured, copied or offered to a story.
    'src/app.mjs': 'export {};\n',
    'test/app.test.mjs': "import test from 'node:test';\ntest('outside', () => {});\n",
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  git(root, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'Fixture director']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'Fixture baseline']);
  return { directory, root };
}

test("Studio desk's first profile revision keeps the path rules stories had before profiles", () => {
  assert.equal(validateSourceProfile(structuredClone(studioDeskProfileRevision1)).id, 'studio-desk');
  // A record without a profile was measured with revision 1, whatever the current profile is (MP-026).
  assert.equal(profileOf({}), studioDeskProfileRevision1);
  assert.deepEqual(recordedProfile(studioDeskProfileRevision1), {});
  for (const [file, allowed] of [
    ['src/core/workflows.mjs', true],
    ['public/app.js', true],
    ['docs/v1.0.md', true],
    ['test/new.test.mjs', true],
    ['scripts/tool.mjs', true],
    ['src/data.json', true],
    ['AGENTS.md', false],
    ['README.md', false],
    ['src/AGENTS.md', false],
    ['docs/claude.md', false],
    ['src/package.json', false],
    ['scripts/prettier.config.mjs', false],
    ['src/.hidden/a.mjs', false],
    ['.github/workflow.md', false],
    ['src/a.ts', false],
    ['data/studio.json', false],
    ['src/../AGENTS.md', false],
    ['src/a b.mjs', false],
    [42, false],
    // Route folders with parentheses and square brackets, under the same folders, types and protected names.
    ['src/app/(frontend)/[member]/page.mjs', true],
    ['src/[[...slug]]/route.mjs', true],
    ['test/[id].test.mjs', true],
    ['dashboard/src/[...slug]/page.tsx', false],
    ['src/[A]GENTS.md', false],
    ['docs/(claude).md', false],
    ['src/(package).json', false],
    ['scripts/[prettier].config.mjs', false],
    ['src/app/[..]/page.mjs', false],
    ['src/app/[slug]./page.mjs', false],
    ['src/app/nul.mjs', false],
    ['src/app/[slug]:x.mjs', false],
  ])
    assert.equal(storyPathAllowed(file, studioDeskProfileRevision1), allowed, String(file));
  // The error a story sees for a new file it may not create reads as it did.
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['AGENTS.md'] }, [], undefined, studioDeskProfileRevision1),
    new RegExp(
      'new files go under src, public, test, scripts or docs as \\.mjs, \\.js, \\.json, \\.css, \\.html or \\.md, never in a dot-folder or as AGENTS\\.md, CLAUDE\\.md, package\\.json or Prettier configuration',
    ),
  );
});

test("Studio desk's second revision adds the new dashboard and TypeScript and protects tool configuration (MP-026)", () => {
  assert.equal(validateSourceProfile(structuredClone(studioDeskProfile)).id, 'studio-desk');
  // New plans record it in full, so they keep its rules after any later revision.
  assert.deepEqual(recordedProfile(studioDeskProfile), { profile: structuredClone(studioDeskProfile) });
  assert.deepEqual(profileOf(recordedProfile(studioDeskProfile)), studioDeskProfile);
  for (const file of ['package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'eslint.config.js'])
    assert.ok(studioDeskProfile.files.includes(file), file);
  assert.equal(studioDeskProfile.directories.includes('dashboard'), true);
  // Studio desk's tested copies get installed packages whichever revision planned them; another project's only on request.
  assert.equal(installsPackages(studioDeskProfile), true);
  assert.equal(installsPackages(studioDeskProfileRevision1), true);
  assert.equal(installsPackages(notesProfile), false);
  assert.equal(installsPackages({ ...notesProfile, install: 'npm-ci' }), true);
  for (const [file, allowed] of [
    ['dashboard/src/app.tsx', true],
    ['dashboard/src/records.ts', true],
    ['dashboard/index.html', true],
    ['src/core/workflows.mjs', true],
    ['public/app.js', true],
    ['src/a.ts', true],
    // Tool configuration under any name a tool reads, at any depth: ESLint uses the one nearest each file.
    ['dashboard/eslint.config.js', false],
    ['dashboard/src/eslint.config.mjs', false],
    ['dashboard/vite.config.ts', false],
    ['dashboard/vitest.config.mts', false],
    ['dashboard/tsconfig.json', false],
    ['dashboard/tsconfig.app.json', false],
    ['dashboard/package.json', false],
    ['dashboard/package-lock.json', false],
    ['scripts/npm-shrinkwrap.json', false],
    // Root files stay protected; build output is not source.
    ['tsconfig.json', false],
    ['vite.config.mjs', false],
    ['eslint.config.js', false],
    ['package-lock.json', false],
    ['dist/index.html', false],
    ['dashboard/.vite/cache.json', false],
    // Route folders: parentheses and square brackets anywhere in a segment, including first.
    ['src/app/(frontend)/[member]/page.mjs', true],
    ['src/app/(frontend)/layout.mjs', true],
    ['dashboard/src/[...slug]/page.tsx', true],
    ['src/[[...slug]]/route.mjs', true],
    ['src/app/(..)photo/page.mjs', true],
    ['src/app/(.)photo/page.mjs', true],
    ['test/[id].test.mjs', true],
    ['src/app/console.mjs', true],
    // Not relative, or a character outside ASCII letters, digits, _ . - / ( ) [ ].
    ['/src/app/[slug]/page.mjs', false],
    ['src\\app\\[slug]\\page.mjs', false],
    ['src/app/[slug]:x.mjs', false],
    ['src/app/[slug]?.mjs', false],
    ['src/app/[slug]*.mjs', false],
    ['src/app/<slug>/page.mjs', false],
    ['src/app/"slug"/page.mjs', false],
    ['src/app/[slug]|x.mjs', false],
    ['src/app/[slug] /page.mjs', false],
    ['src/app/[slug]\t/page.mjs', false],
    // Fullwidth square brackets, which only look like [ and ].
    ['src/app/［slug］/page.mjs', false],
    // A segment Windows reads as another name, or that reads like a dot segment.
    ['src/app/[slug]./page.mjs', false],
    ['src/app/[..]/page.mjs', false],
    ['src/app/(.)/page.mjs', false],
    ['src/app/[.]/page.mjs', false],
    ['src/app/(...)/page.mjs', false],
    ['src/app/../[slug]/page.mjs', false],
    ['src/.next/[slug].mjs', false],
    ['src/app/nul.mjs', false],
    ['src/app/[slug]/CON.page.mjs', false],
    ['src/Aux/page.mjs', false],
    ['src/app/com1.mjs', false],
    ['src/app/LPT9/page.mjs', false],
    // Protected names stay protected with their brackets removed.
    ['src/[A]GENTS.md', false],
    ['src/(package).json', false],
    ['dashboard/[t]sconfig.json', false],
    ['dashboard/(eslint.config).js', false],
    ['dashboard/src/vite.[config].ts', false],
    // Outside the profile's folders or types.
    ['data/[slug]/page.mjs', false],
    ['src/app/[slug]/page.exe', false],
  ])
    assert.equal(storyPathAllowed(file, studioDeskProfile), allowed, file);
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['dashboard/eslint.config.js'] }, []),
    /never in a dot-folder or as AGENTS.md, CLAUDE.md, package.json, package-lock.json, npm-shrinkwrap.json, Prettier configuration, ESLint configuration, Vite configuration, Vitest configuration or TypeScript configuration/,
  );
  assert.match(
    (() => {
      try {
        validateSourceProfile({ ...structuredClone(notesProfile), install: 'yarn' });
      } catch (error) {
        return error.message;
      }
    })(),
    /install must be null or npm-ci/,
  );
});

test('a source profile is checked before use and names each problem', () => {
  assert.equal(validateSourceProfile(structuredClone(notesProfile)).id, 'field-notes');
  const problems = profile => {
    try {
      validateSourceProfile(profile);
      return '';
    } catch (error) {
      return error.message;
    }
  };
  const broken = {
    ...structuredClone(notesProfile),
    id: 'Field Notes',
    directories: ['lib', '../outside', '.git'],
    contextFiles: ['docs/missing.md'],
    tests: { directory: 'tests', suffix: '.spec.mjs' },
    formatter: { package: 'prettier', args: ['--write'] },
    limits: { files: 0, fileBytes: 1024, totalBytes: 2048 },
    shell: 'npm test',
  };
  const message = problems(broken);
  for (const expected of [
    'unknown field shell',
    'id must be lowercase letters, digits and dashes',
    'directories must list 1 to 50 valid entries',
    'contextFiles must be files the snapshot covers',
    'tests must name a snapshot directory and a file suffix',
    'formatter must be null or a pinned npm package',
    'limits must hold positive whole numbers',
  ])
    assert.match(message, new RegExp(expected), message);
  assert.match(
    problems({ ...structuredClone(notesProfile), formatter: { package: 'x@1', args: ['; rm'] } }),
    /formatter/,
  );
  assert.match(problems(null), /must be an object/);
});

test("snapshots, copies, context, story paths and a story's base follow another profile", t => {
  const { directory, root } = repository(t);
  const plan = sourcePlan(root, notesProfile);
  assert.deepEqual(
    plan.files.map(item => item.path),
    ['lib/notes.js', 'Makefile', 'notes/overview.md', 'README.md', 'spec/helpers/setup.mjs', 'spec/notes.spec.mjs'],
  );
  // Only <directory>/*<suffix> are test files; the runner's arguments name them.
  assert.deepEqual(plan.command.args.slice(-1), ['spec/notes.spec.mjs']);
  assert.deepEqual(plan.profile, notesProfile, "A plan names a profile that is not Studio desk's.");
  // The copy holds exactly the profile's paths and is verified against them.
  const copy = path.join(directory, 'copy');
  copySource(plan, copy);
  assert.equal(fs.existsSync(path.join(copy, 'src')), false);
  assert.equal(fs.readFileSync(path.join(copy, 'notes/overview.md'), 'utf8'), 'How the notes are kept.\n');
  verifyCopy(plan, copy);
  fs.writeFileSync(path.join(copy, 'lib/extra.js'), 'export {};\n');
  assert.throws(() => verifyCopy(plan, copy), /added or removed copied source files/);
  // The breakdown and reviews read the profile's context documents.
  assert.deepEqual(
    sourceContext(plan, copy).documents.map(doc => [doc.path, doc.text]),
    [
      ['README.md', '# Field notes\n'],
      ['notes/overview.md', 'How the notes are kept.\n'],
    ],
  );
  assert.throws(
    () => sourceContext({ ...plan, profile: { ...notesProfile, contextFiles: ['notes/missing.md'] } }, copy),
    /The context document notes\/missing\.md is not in the measured source/,
  );
  // Stories may change the profile's folders and types, never its protected names or other folders.
  validateStoryPaths({ files: ['lib/notes.js'], newFiles: ['notes/today.txt'] }, plan.files, 'Story', notesProfile);
  assert.throws(
    () => validateStoryPaths({ files: ['src/app.mjs'] }, plan.files, 'Story', notesProfile),
    /unsupported or unrecorded source file src\/app\.mjs/,
  );
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['lib/Makefile'] }, plan.files, 'Story', notesProfile),
    /new files go under lib, spec or notes as \.js, \.md or \.txt, never in a dot-folder or as Makefile or SECRETS\.md/,
  );
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['src/new.mjs'] }, plan.files, 'Story', notesProfile),
    /cannot create src\/new\.mjs/,
  );
  // Its limits apply.
  fs.writeFileSync(path.join(root, 'lib/large.txt'), 'x'.repeat(64 * 1024 + 1));
  assert.throws(
    () => sourcePlan(root, notesProfile),
    /lib\/large\.txt is larger than the 64 KB a file a story may edit can be/,
  );
  fs.rmSync(path.join(root, 'lib/large.txt'));
  // A file of a type no story edits (a photo) is only copied, so the per-file limit leaves it alone.
  fs.writeFileSync(path.join(root, 'lib/photo.jpg'), Buffer.alloc(64 * 1024 + 1));
  assert.ok(sourcePlan(root, notesProfile).files.some(item => item.path === 'lib/photo.jpg'));
  fs.rmSync(path.join(root, 'lib/photo.jpg'));
  // Untracked files block a story only inside the profile's paths.
  fs.writeFileSync(path.join(root, 'src/untracked.mjs'), 'export {};\n');
  assert.equal(sourceBase(root, notesProfile).branch, 'main');
  fs.writeFileSync(path.join(root, 'lib/untracked.js'), 'export {};\n');
  assert.throws(
    () => sourceBase(root, notesProfile),
    /files that git does not track before a source story starts: lib\/untracked\.js/,
  );
  fs.rmSync(path.join(root, 'lib/untracked.js'));
  fs.rmSync(path.join(root, 'src/untracked.mjs'));
  // A commit's snapshot is measured and copied with the profile.
  const snapshot = snapshotCommit(
    root,
    path.join(directory, 'wt'),
    'c-profile',
    { commit: git(root, ['rev-parse', 'HEAD']) },
    path.join(directory, 'snapshot'),
    notesProfile,
  );
  assert.equal(snapshot.sourceHash, plan.sourceHash);
  assert.deepEqual(profileOf(snapshot), notesProfile);
  assert.equal(fs.existsSync(path.join(directory, 'snapshot', 'test')), false);
});

test("integration verification runs the profile's tests and skips formatting when it names no formatter", async t => {
  const { directory, root } = repository(t),
    store = new Store(path.join(directory, 'records'), () => ({ organization: {}, tasks: [] }));
  // The candidate: one edited file, committed on the base.
  const base = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'lib/notes.js'), 'export const notes = ["first"];\n');
  git(root, ['commit', '--quiet', '-am', 'Candidate']);
  const candidate = git(root, ['rev-parse', 'HEAD']);
  git(root, ['reset', '--quiet', '--hard', base]);
  const worktree = createSourceWorktree(root, path.join(directory, 'wt'), 'i-profile', base, notesProfile),
    journal = {
      id: 'source-integration:profile-review',
      phaseOccurrenceId: 'occurrence',
      reviewAttemptId: 'profile-review',
      reviewTaskId: 'profile-story',
      candidateAttemptId: 'profile-candidate',
      candidateCommit: candidate,
      worktree,
      changes: [{ path: 'lib/notes.js', afterHash: 'edited', beforeHash: 'before' }],
    },
    output = path.join(directory, 'integration'),
    runtime = {
      store,
      sourceCheckCommand: { executable: process.execPath, args: [checkFixture, 'pass'] },
    };
  fs.mkdirSync(output);
  let verified, phases;
  try {
    verified = await verifyIntegration(runtime, journal, output, undefined, notesProfile);
    phases = store.phaseEvents('profile-review');
  } finally {
    // Close the records before the temporary folder is removed (Windows keeps open files locked).
    store.close();
  }
  assert.equal(verified.passed, true, JSON.stringify(verified));
  assert.equal(verified.formatter, 'none');
  assert.equal(
    fs.readFileSync(path.join(output, 'format-output.txt'), 'utf8'),
    "The project's source profile names no formatter.\n",
  );
  assert.equal(verified.sourceHash, sourcePlan(worktree, notesProfile).sourceHash);
  assert.deepEqual(
    phases.filter(event => event.payload.boundary === 'start').map(event => event.payload.phaseId),
    ['integration.merge', 'integration.verification'],
    'No formatting phase is recorded when nothing formats.',
  );
});

test('integration verification runs the plain test command when the candidate recorded no test sandbox', async t => {
  const { directory, root } = repository(t),
    store = new Store(path.join(directory, 'records'), () => ({ organization: {}, tasks: [] }));
  const base = git(root, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(root, 'lib/notes.js'), 'export const notes = ["first"];\n');
  git(root, ['commit', '--quiet', '-am', 'Candidate']);
  const candidate = git(root, ['rev-parse', 'HEAD']);
  git(root, ['reset', '--quiet', '--hard', base]);
  const worktree = createSourceWorktree(root, path.join(directory, 'wt'), 'i-plain', base, notesProfile),
    journal = {
      id: 'source-integration:plain-review',
      phaseOccurrenceId: 'occurrence',
      reviewAttemptId: 'plain-review',
      reviewTaskId: 'plain-story',
      candidateAttemptId: 'plain-candidate',
      candidateCommit: candidate,
      worktree,
      changes: [{ path: 'lib/notes.js', afterHash: 'edited', beforeHash: 'before' }],
    },
    output = path.join(directory, 'integration');
  fs.mkdirSync(output);
  // No Codex and no test fixture: the profile's own spec runs as the plain Node test command.
  const previousContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  let verified;
  try {
    verified = await verifyIntegration({ store }, journal, output, { testSandbox: 'none' }, notesProfile);
  } finally {
    if (previousContext !== undefined) process.env.NODE_TEST_CONTEXT = previousContext;
    store.close();
  }
  assert.equal(verified.passed, true, JSON.stringify(verified));
  assert.equal(verified.fixture, false);
  assert.equal(verified.totals.tests, 1);
  assert.match(verified.checks[0].evidence, /; ran without a sandbox.$/);
  assert.match(fs.readFileSync(path.join(output, 'test-output.txt'), 'utf8'), /^ok 1 - notes$/m);
});

test('leftover worktrees are removed through the repository each belongs to', t => {
  const first = repository(t),
    second = repository(t),
    parent = path.join(first.directory, 'wt');
  for (const [{ root }, name] of [
    [first, 'left-a'],
    [second, 'left-b'],
  ])
    createSourceWorktree(root, parent, name, git(root, ['rev-parse', 'HEAD']), notesProfile);
  assert.equal(worktreeRepository(path.join(parent, 'left-b')), fs.realpathSync(second.root));
  assert.equal(worktreeRepository(first.root), null, 'A repository root is not a linked worktree.');
  cleanSourceWorktrees({ store: { allAttempts: () => [] }, active: new Map(), sourceChangeRoot: first.root }, parent);
  assert.deepEqual(fs.readdirSync(parent), []);
  for (const { root } of [first, second])
    assert.equal(git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm).length, 1);
});

// Found in the README-only fresh install (v1.0 criterion 6): nanoid keeps its code in index.js, a top-level file.
test("a repository's listed top-level files are a story's to edit or delete, never Studio desk's own", () => {
  const profile = validateSourceProfile({
    id: 'library',
    directories: ['test'],
    files: ['index.js', 'README.md', 'LICENSE', 'package.json', 'eslint.config.js'],
    extensions: ['js', 'md'],
    protectedNames: ['AGENTS.md', 'CLAUDE.md', 'package.json', 'eslint.config.js'],
    contextFiles: ['README.md'],
    tests: { directory: 'test', suffix: '.test.js' },
    formatter: null,
    limits: studioDeskProfile.limits,
  });
  for (const [file, allowed] of [
    ['index.js', true],
    ['README.md', true],
    ['test/index.test.js', true],
    // Protected, of another type, or not listed.
    ['package.json', false],
    ['eslint.config.js', false],
    ['LICENSE', false],
    ['other.js', false],
  ])
    assert.equal(storyPathAllowed(file, profile), allowed, file);
  const manifest = ['index.js', 'README.md', 'test/index.test.js'].map(path => ({ path, hash: 'h', bytes: 1 }));
  validateStoryPaths({ files: ['index.js'], newFiles: [], deleteFiles: ['README.md'] }, manifest, 'The story', profile);
  // A top-level file is never new: one the profile lists already exists, and any other is refused.
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['index.js'], deleteFiles: [] }, manifest, 'The story', profile),
    /cannot create index\.js/,
  );
  assert.throws(
    () => validateStoryPaths({ files: [], newFiles: ['other.js'], deleteFiles: [] }, manifest, 'The story', profile),
    /cannot create other\.js: new files go under test/,
  );
  assert.match(
    storyPathScope(profile),
    /or any dot-path\. A story may also edit or delete the top-level files index\.js or README\.md\.$/,
  );
  // Studio desk's root files change only by hand.
  assert.equal(storyPathAllowed('README.md', studioDeskProfile), false);
  assert.doesNotMatch(storyPathScope(studioDeskProfile), /top-level/);
});
