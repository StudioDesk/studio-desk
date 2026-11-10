// A sample studio for Studio desk's own visual check (October 30, 2026): the start command Studio desk development's
// Trying a story yourself settings name, so a story's capture has a studio to show. It builds the dashboard, then
// seeds a fresh studio in the copy's own .studio-sample folder, never the root's data folder (in a development copy that
// is the live records): a code project with the ID project-studio-desk on the To-do list sample's repository, and a
// general-work project with the ID project-sample-work, each with ideas, so pages at the addresses the planner names
// have something to draw. Every agent is the Simulator and the studio is paused, so nothing runs and no model is
// called. Only then does it listen, so a capture never sees a half-made studio. Usage: node scripts/sample-studio.mjs
// [--port 4319].
import { createStudio } from '../src/server.mjs';
import { createRegistries } from '../src/registry.mjs';
import { createProject } from '../src/core/project-creation.mjs';
import { startIdeaIntake } from '../src/core/idea-intake.mjs';
import { addLibraryEntry } from '../src/core/library.mjs';
import { inspectRepository, recordProjectSource } from '../src/connectors/source-projects.mjs';
import { addWaitingIdea, makeMilestone, useVersionLines } from '../src/connectors/source-milestones.mjs';
import { repositoryOrganization } from '../src/organizations/studio-development/project.mjs';
import { projectTemplate, templateFiles } from '../src/templates/index.mjs';
import { isEntryPoint } from '../src/core/entry-point.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { realPath } from '../src/core/real-path.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const sampleProjects = Object.freeze({ code: 'project-studio-desk', work: 'project-sample-work' });
export const samplePort = 4319;

// The ideas each project holds, sent while the studio is paused, so they wait at their checks.
const ideas = {
  [sampleProjects.code]: [
    'Add a way to mark every item on the list done at once, with a test that shows it works.',
    'Let items have a due date, and list overdue items first.',
  ],
  [sampleProjects.work]: [
    'Write a two-line sign for the counter saying we now have oat milk.',
    'Plan a Saturday pop-up: a short menu with one signature drink, a stand sign and a post announcing it.',
  ],
};

// One file in each project's library, so library and Artifacts pictures have a card and a panel to show (November 2:
// the first Artifacts captures found none). Finished work in The work is still to come: it needs an attempt run and
// accepted while seeding, before the studio listens.
const libraries = {
  [sampleProjects.work]: {
    name: 'Brand guidelines',
    purpose: 'How Northbound Coffee looks and sounds: its colors, its type and its voice.',
    file: 'brand-guidelines.md',
    text: '# Northbound Coffee brand guidelines\n\n## Voice\n\nWarm and plain. Say what the drink is, then why it is good.\n\n## Colors\n\n- Pine #1F4D3A for headings\n- Oat #F3EBDD for backgrounds\n- Ember #C8572B for one thing per page\n\n## Type\n\nHeadings in a rounded serif; everything else in a clean sans.\n',
  },
  [sampleProjects.code]: {
    name: 'How the app talks',
    purpose: 'The copy rules every page follows: plain words, roles not names, and a button that says what it does.',
    file: 'how-the-app-talks.md',
    text: '# How the app talks\n\n- Plain words, the way a person would say them.\n- Name things by what people recognize, not how the system is built.\n- A button says exactly what happens: Publish, then a note that says Published.\n- An error says what went wrong and how to fix it.\n',
  },
};

// The sample's folder: inside the copy, emptied at each start. Refused if it is or holds the copy's data folder.
export function sampleDirectory(base = root) {
  const directory = path.join(base, '.studio-sample'),
    data = path.join(base, 'data');
  if (path.relative(directory, data) === '' || !path.relative(directory, data).startsWith('..'))
    throw new Error('The sample studio must never use the data folder.');
  return directory;
}

// Vite as Node finds it from the copy: its own node_modules, or one in a folder above it, where the pipeline installs
// the packages each tested copy uses.
export function viteProgram(base = root) {
  const manifest = createRequire(path.join(base, 'package.json')).resolve('vite/package.json');
  return path.join(path.dirname(manifest), 'bin', 'vite.js');
}

// The build's arguments. Vite's root is the dashboard folder (vite.config.mjs), so the output folder is named in full:
// a relative one would land in dashboard/dist, where the controller never looks.
export function buildArguments(base = root) {
  const outDir = path.join(base, 'dist');
  return [
    viteProgram(base),
    'build',
    '--configLoader',
    'native',
    '--outDir',
    outDir,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ];
}

function buildDashboard(base) {
  const built = spawnSync(process.execPath, buildArguments(base), { cwd: base, stdio: 'inherit', windowsHide: true });
  if (built.status !== 0) throw new Error(`The dashboard did not build (exit code ${built.status}).`);
}

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
};

// The To-do list sample's files as a repository of its own on main, as Studio desk's first-run sample makes it.
function sampleRepository(directory) {
  const folder = path.join(directory, 'repositories', 'todo-list');
  for (const file of templateFiles(projectTemplate('code'))) {
    const target = path.join(folder, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  git(folder, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  git(folder, ['add', '-A']);
  const identity = [
    '-c',
    'user.name=Studio desk',
    '-c',
    'user.email=studio-desk@localhost',
    '-c',
    'commit.gpgsign=false',
  ];
  git(folder, [...identity, 'commit', '--quiet', '-m', 'To-do list sample, made by Studio desk']);
  return folder;
}

// Seeds the studio's records before it listens. The studio is paused first; intake needs model CLIs for its planning
// steps, so every agent becomes the Simulator only after the ideas are sent, and anything ever started stays model-free.
export async function seedSampleStudio({ store, runner, registries, directory }) {
  store.setOrganization({ ...store.organization(), paused: true });
  await createProject(
    store,
    registries,
    runner,
    { name: 'Studio desk development', houseRules: 'recommended' },
    { fields: { id: sampleProjects.code }, configuration: repositoryOrganization },
  );
  // The repository is recorded without running its tests, which a sample never needs.
  const repository = sampleRepository(directory),
    inspected = inspectRepository(store, repository, runner, undefined, sampleProjects.code);
  recordProjectSource(store, sampleProjects.code, { root: repository, profile: inspected.profile }, runner);
  // An unshipped version with unfinished work for the Release dialog's visual check. These are sample records only:
  // no integrated story, notes acceptance or real release is fabricated. The two intake runs still wait at checks.
  const milestone = makeMilestone(store, sampleProjects.code, runner, { version: '1.1.0' });
  useVersionLines(store, sampleProjects.code, runner, { shipsTo: 'main' });
  addWaitingIdea(store, sampleProjects.code, {
    milestoneId: milestone.id,
    idea: 'Keep completed items out of the way until they are needed again.',
  });
  await createProject(
    store,
    registries,
    runner,
    { name: 'Northbound Coffee', houseRules: 'recommended' },
    { fields: { id: sampleProjects.work } },
  );
  for (const [projectId, entry] of Object.entries(libraries))
    addLibraryEntry(store, projectId, {
      name: entry.name,
      purpose: entry.purpose,
      file: { name: entry.file, mediaType: 'text/markdown', data: Buffer.from(entry.text).toString('base64') },
    });
  for (const [projectId, list] of Object.entries(ideas))
    for (const idea of list) startIdeaIntake(store, registries, runner, { projectId, idea, general: true });
  const org = store.organization();
  for (const worker of org.workers)
    Object.assign(worker, { provider: 'mock', cli: 'Simulator', model: '', effort: '', mode: '' });
  store.setOrganization(org);
}

export async function startSampleStudio({ base = root, port = samplePort, build = true } = {}) {
  const given = sampleDirectory(base);
  fs.rmSync(given, { recursive: true, force: true });
  fs.mkdirSync(given, { recursive: true });
  // By its real spelling, as the studio keeps its data folder, so the sample repository made inside it is inside it.
  const directory = realPath(given);
  if (build) buildDashboard(base);
  const registries = createRegistries(),
    studio = createStudio({
      directory,
      port,
      runnerOptions: { registries },
      bootstrap: { organizationPreset: 'first-run', workflowPresets: [] },
      // Seeded sample data only, photographed by the visual check, which has no session to sign in with (C-01).
      access: 'open',
    });
  await seedSampleStudio({ store: studio.store, runner: studio.runner, registries, directory });
  const address = await studio.start();
  return { ...studio, address, directory };
}

if (isEntryPoint(import.meta)) {
  const at = process.argv.indexOf('--port'),
    port = at > 0 ? Number(process.argv[at + 1]) : samplePort;
  const studio = await startSampleStudio({ port });
  console.log(`Sample studio at ${studio.address}`);
  const stop = () => {
    studio.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
