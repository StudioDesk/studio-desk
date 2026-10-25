// Which repository a project's source pipeline works on (1.0 item 9). A project records its own
// repository as project.source = { root, profile }. A project without one works on the controller's
// source root (runtime.sourceChangeRoot) with Studio desk's profile and source resource names, as
// before, which is how Studio desk runs today. Each repository has its own source resources, so a
// story in one project never waits for another project's story or integration.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { recordProject } from '../core/projects.mjs';
import { subscriptionEnvironment } from '../adapters/process.mjs';
import { snapshotCommit } from '../adapters/source-snapshot.mjs';
import { failedTests, sourcePlan, testTotals } from './source-checks.mjs';
import { git, repositoryState } from './source-integration.mjs';
import { maxProfileEntries, studioDeskProfile, validateSourceProfile } from './source-profile.mjs';
import { sourceWorktreeRoot } from './source-worktrees.mjs';

// The resources a Studio desk story and its integration hold (MP-016's names, unchanged).
export const studioDeskSourceResources = Object.freeze(['source:studio-desk-integration', 'source:studio-desk-tests']);

// { root, profile, resources, own }; root is undefined for a project without its own repository
// when no runtime is given.
export function projectSource(store, projectId, runtime) {
  const recorded = store.project(projectId).source;
  if (!recorded)
    return {
      root: runtime?.sourceChangeRoot,
      profile: studioDeskProfile,
      resources: studioDeskSourceResources,
      own: false,
    };
  return {
    root: recorded.root,
    profile: recorded.profile,
    resources: [`source:${projectId}:integration`, `source:${projectId}:tests`],
    own: true,
  };
}
// The source resources a record's project holds while a story edits, tests and integrates. Without a
// store (task type descriptions, staffing), Studio desk's.
export const sourceResources = (store, record) =>
  store ? projectSource(store, recordProject(record)).resources : studioDeskSourceResources;
export const sourceRoot = (store, record, runtime) => projectSource(store, recordProject(record), runtime).root;

// The real path of a repository a project may work on: the root of a git repository on a branch, which
// no other project and not the controller's own default source uses. Returns { root, branch, head }.
export function projectRepository(store, projectId, root, runtime) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('The repository must be an absolute path.');
  let real;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    throw new Error('The repository folder does not exist.');
  }
  // A folder git finds no repository in is refused in plain words; a subfolder of one is refused below.
  try {
    git(real, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(
      'This folder is not a git repository. This version of Studio desk works on git repositories; ' +
        'leave the folder empty to make a project for work that is not code.',
    );
  }
  const state = repositoryState(real, 'adding a project', { clean: false });
  const same = other =>
    other && (process.platform === 'win32' ? other.toLowerCase() === real.toLowerCase() : other === real);
  if (same(runtime?.sourceChangeRoot)) throw new Error("This repository is the controller's default source.");
  const taken = store.projects().find(project => project.id !== projectId && same(project.source?.root));
  if (taken) throw new Error(`Project ${taken.name || taken.id} already works on this repository.`);
  return { root: real, ...state };
}
// Records a project's own repository with a valid profile. Adding a project from the dashboard
// first checks that the tree is clean and its tests run (step 4b).
export function recordProjectSource(store, projectId, { root, profile }, runtime) {
  const { root: real } = projectRepository(store, projectId, root, runtime);
  validateSourceProfile(profile);
  const project = store.project(projectId);
  project.source = { root: real, profile: structuredClone(profile) };
  store.putProject(project);
  return project.source;
}

// What a proposed profile leaves out: dependency, build and tool output, even when git tracks it. Not bin, whose
// tracked files are a package's command-line scripts (a build's bin is not tracked), which its tests run: the copy
// a project's tests run on holds only the proposed folders (found in the fresh install, on nanoid).
const skippedFolders = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'obj',
  'tmp',
  'temp',
]);
// File types a story may edit when the repository has them: text a review can read in a diff.
const textTypes = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs json css scss sass less html htm md mdx txt csv yml yaml toml ini xml svg ' +
    'graphql gql sql sh ps1 py rb go rs java kt swift cs php vue svelte astro'
  ).split(' '),
);
// Names a story leaves to the director: instructions written for agents, which are content and never
// instructions here (MP-024), and the files that decide what the repository installs.
const directorNames = ['AGENTS.md', 'CLAUDE.md', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json'];
const lockNames = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
// A repository's top-level tool configuration, which a story may otherwise edit as one of its top-level files:
// left to the director, as Studio desk's own is (MP-026).
const toolConfiguration = /^tsconfig.*\.json$|\.config\.[a-z]+$/i;
const segment = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
const testFolders = ['test', 'tests', '__tests__'],
  testSuffixes = ['.test.ts', '.test.mts', '.test.mjs', '.test.js', '.test.cjs'];

// A profile proposed from what the repository tracks, for the director to edit (1.0 step 4's
// decision): its tracked top-level folders except dot, dependency and build folders, its tracked
// top-level files, README.md as context, Node's test runner on the test folder it already uses (or
// tests/*.test.ts, or .test.mjs without TypeScript), no formatter, and totals sized from the repository.
export function proposeSourceProfile(root) {
  const tracked = git(root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean),
    { limits } = studioDeskProfile,
    folders = new Set(),
    files = [];
  for (const file of tracked) {
    const [first, ...rest] = file.split('/');
    if (!segment.test(first)) continue;
    if (rest.length) {
      if (!skippedFolders.has(first.toLowerCase())) folders.add(first);
    } else if (fs.statSync(path.join(root, first)).size <= limits.fileBytes) files.push(first);
  }
  let tests = null,
    most = 0;
  for (const directory of testFolders)
    for (const suffix of testSuffixes) {
      const count = tracked.filter(
        file =>
          file.startsWith(directory + '/') && !file.slice(directory.length + 1).includes('/') && file.endsWith(suffix),
      ).length;
      if (count > most) [tests, most] = [{ directory, suffix }, count];
    }
  tests ||= { directory: 'tests', suffix: tracked.some(file => /\.tsx?$/.test(file)) ? '.test.ts' : '.test.mjs' };
  folders.add(tests.directory);
  const directories = [...folders].sort().slice(0, maxProfileEntries),
    extensions = [
      ...new Set(
        tracked
          .filter(file => directories.includes(file.split('/')[0]) || files.includes(file))
          .map(file => path.extname(file).slice(1).toLowerCase())
          .filter(extension => textTypes.has(extension))
          .concat(tests.suffix.split('.').at(-1)),
      ),
    ]
      .sort()
      .slice(0, maxProfileEntries),
    readme = files.find(file => file.toLowerCase() === 'readme.md'),
    // Limits follow what breaks: copying a snapshot for every attempt takes time and disk, which grows
    // with the repository, so the totals leave twice today's size of room rather than a fixed number.
    covered = tracked.filter(file => directories.includes(file.split('/')[0]) || files.includes(file)),
    measured = covered.reduce((total, file) => total + fs.statSync(path.join(root, file)).size, 0),
    id =
      path
        .basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63) || 'repository';
  return validateSourceProfile({
    id: id === studioDeskProfile.id ? 'repository' : id,
    directories,
    files: files.sort().slice(0, maxProfileEntries),
    extensions,
    protectedNames: [
      ...directorNames,
      ...lockNames.filter(name => files.includes(name)),
      ...files.filter(name => toolConfiguration.test(name) && !directorNames.includes(name)),
    ],
    contextFiles: readme ? [readme] : [],
    tests,
    formatter: null,
    limits: {
      files: Math.max(limits.files, covered.length * 2),
      fileBytes: limits.fileBytes,
      totalBytes: Math.max(limits.totalBytes, Math.ceil((measured * 2) / 1024 / 1024) * 1024 * 1024),
    },
  });
}

const unclean = 'Commit or stash the tracked changes first: stories start from a clean tree.';
// What adding a repository would record, for the director to confirm or edit: its branch, whether the
// tree is clean, a proposed profile (or the one given) and what its snapshot measures. Problems are
// listed rather than thrown, so the dashboard can show all of them at once. With a project, it is that
// project's own repository, inspected again.
export function inspectRepository(store, root, runtime, profile, projectId = null) {
  const repository = projectRepository(store, projectId, root, runtime),
    clean = !git(repository.root, ['status', '--porcelain', '--untracked-files=no']),
    problems = clean ? [] : [unclean];
  profile = profile ? validateSourceProfile(structuredClone(profile)) : proposeSourceProfile(repository.root);
  let plan = null;
  try {
    plan = sourcePlan(repository.root, profile);
  } catch (error) {
    problems.push(error.message);
  }
  const tests = plan ? plan.command.args.filter(arg => !arg.startsWith('--')) : [];
  return {
    root: repository.root,
    branch: repository.branch,
    head: repository.head,
    profile,
    files: plan?.files.length ?? null,
    bytes: plan ? plan.files.reduce((total, file) => total + file.bytes, 0) : null,
    testFiles: plan && !tests.some(arg => arg.includes('*')) ? tests.length : 0,
    clean,
    problems,
  };
}

// A project's own repository as it is now, with its recorded profile or an edited one, for Settings' Check
// again and Edit the profile. Nothing is recorded.
export function inspectProjectSource(store, projectId, runtime, profile) {
  const recorded = store.project(projectId).source;
  if (!recorded)
    throw new Error("This project works on the controller's own source, with its built-in repository settings.");
  // The profile keeps its identity: Studio desk's own profile id means different checks.
  const edited = profile ? { ...profile, id: recorded.profile.id } : recorded.profile;
  return { ...inspectRepository(store, recorded.root, runtime, edited, projectId), revision: recorded.revision ?? 1 };
}

// Records an edited profile for a project's own repository as its next revision, once the project's tests
// run and pass with it on a copy of the branch's commit, as when the project was added. Nothing in the
// project may run or hold its source before or after the tests, so no story is edited, tested or integrated
// under two profiles; a story waiting to integrate does so under the new one. The tree need not be clean:
// the tests run on the commit.
export async function editProjectProfile(store, projectId, runtime, { expectedRevision, profile }) {
  const current = () => {
    if (expectedRevision !== (store.project(projectId).source?.revision ?? 1))
      throw Object.assign(new Error('The repository settings changed. Refresh before saving.'), { status: 409 });
  };
  const idle = () => {
    const { resources } = projectSource(store, projectId);
    if (
      store.leases().some(lease => resources.includes(lease.resource)) ||
      store
        .allAttempts()
        .some(
          attempt =>
            recordProject(attempt) === projectId &&
            (['running', 'stopping', 'quarantined'].includes(attempt.status) ||
              (attempt.status === 'interrupted' && !attempt.reconciledAt)),
        )
    )
      throw Object.assign(
        new Error('Wait until nothing in this project is running, then save the repository settings.'),
        {
          status: 409,
        },
      );
  };
  const check = () => {
    const inspected = inspectProjectSource(store, projectId, runtime, profile),
      problems = inspected.problems.filter(problem => problem !== unclean);
    if (problems.length) throw new Error(problems.join(' '));
    return inspected;
  };
  current();
  idle();
  const inspected = check(),
    tests = await repositoryTests(runtime, inspected, {
      before: 'these settings are saved',
      again: 'save the settings again',
    });
  // The tests ran without holding anything; check again what may have changed meanwhile, in the transaction
  // that records the profile, so nothing can start between the check and the record.
  return store.tx(() => {
    current();
    idle();
    if (check().head !== inspected.head)
      throw new Error('The branch moved while the tests ran. Save the settings again to test its new commit.');
    const project = store.project(projectId);
    project.source = {
      ...project.source,
      profile: inspected.profile,
      revision: inspected.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    store.putProject(project);
    return { source: project.source, tests };
  });
}

// How long adding a project waits for the repository's tests: as long as intake source checks may run.
export const repositoryTestSeconds = 420;
// Runs the repository's tests once on a copy of its inspected commit, as intake source checks do, before a
// project records it. They must run and pass; a repository with no tests yet passes with none run.
// Resolves with the totals; rejects with a reason the director can act on.
export async function repositoryTests(
  runtime,
  inspection,
  { before = 'it is added', again = 'create the project again' } = {},
) {
  const id = randomUUID().slice(0, 8),
    parent = sourceWorktreeRoot(runtime),
    destination = path.join(runtime.store.directory, 'repository-checks', id);
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    const plan = snapshotCommit(
        inspection.root,
        parent,
        'p-' + id,
        { commit: inspection.head, branch: inspection.branch },
        destination,
        undefined,
        inspection.profile,
      ),
      environment = subscriptionEnvironment();
    // Snapshot tests must not inherit live provider overrides, or report to a parent test runner.
    for (const key of Object.keys(environment))
      if (/^STUDIO_/i.test(key) || key === 'NODE_TEST_CONTEXT') delete environment[key];
    const run = await new Promise((resolve, reject) => {
      const child = spawn(plan.command.executable, plan.command.args, {
          cwd: destination,
          env: environment,
          windowsHide: true,
        }),
        output = { stdout: '', stderr: '' },
        limit = 192 * 1024,
        timer = setTimeout(() => {
          output.timedOut = true;
          child.kill();
        }, repositoryTestSeconds * 1000);
      for (const name of ['stdout', 'stderr'])
        child[name].on('data', chunk => {
          if (output[name].length < limit) output[name] += chunk;
        });
      child.on('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ ...output, code, signal });
      });
    });
    if (run.timedOut)
      throw new Error(
        `The repository's tests ran longer than ${repositoryTestSeconds} seconds. Make them finish within ` +
          `${repositoryTestSeconds / 60} minutes, or narrow where the tests live or their name ending in the ` +
          `repository settings, then ${again}.`,
      );
    let totals;
    try {
      totals = testTotals(run.stdout);
    } catch {
      const errors = run.stderr.trim().slice(0, 300);
      throw new Error(
        `The repository's tests stopped without a report (exit ${run.code ?? run.signal}). ${errors ? errors + ' ' : ''}` +
          "Check that the tests run with Node's test runner (node --test) from the repository folder, commit, " +
          `then ${again}.`,
      );
    }
    if (run.code !== 0 || totals.fail || totals.cancelled) {
      const names = failedTests(run.stdout)
        .slice(0, 5)
        .map(item => item.name);
      throw new Error(
        `The repository's tests must pass before ${before}: ${totals.pass} of ${totals.tests} passed${names.length ? ` (failing: ${names.join('; ')})` : ''}. ` +
          'They run on a copy holding only the folders and top-level files in the repository settings. ' +
          `If they pass in the repository itself, add the folders they need to those settings and ${again}; otherwise fix the failing tests, commit, then ${again}.`,
      );
    }
    return totals;
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}
