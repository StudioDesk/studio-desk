// No projects yet's samples (v1.0 item 24): what the screen shows before any project exists (the samples, the
// signed-in CLIs, whether git is here, and whether this is the first run), and making a project from a sample. A
// sample's folder is under the data folder, so nothing else on the computer changes, or in a folder the director
// chose; Code is a git repository with one commit and its tests, Writing is general work whose three files go to
// its first idea.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { houseRules, projectTemplate, projectTemplates, templateFiles } from '../templates/index.mjs';
import { createProject } from './project-creation.mjs';
import { repositoryOrganization } from '../organizations/studio-development/project.mjs';
import { startIdeaIntake } from './idea-intake.mjs';
import { autonomyPolicy, recommendedKinds, saveAutonomyPolicy } from './autonomy.mjs';
import { chosenTestSandbox } from '../adapters/source-test-sandbox.mjs';

const cliLabels = { claude: 'Claude Code', codex: 'Codex CLI' };
const mediaTypes = { md: 'text/markdown', js: 'text/plain', txt: 'text/plain' };
// Detection runs a CLI's own sign-in check, so Check again and a burst of requests share one result for a moment.
const statusLifetimeMs = 2000;
let detected = null;

function gitVersion() {
  const result = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return result.status === 0 ? result.stdout.trim().replace(/^git version\s*/, '') : null;
}

// The signed-in subscription CLIs and git. A CLI counts only when its adapter confirms the subscription login.
export function setupStatus(runner, { fresh = false } = {}) {
  if (!fresh && detected && Date.now() - detected.at < statusLifetimeMs) return detected.value;
  const clis = Object.keys(cliLabels)
    .filter(id => {
      const adapter = runner.adapters.find(id);
      try {
        return !!adapter && adapter.blockReason(runner, true) === '';
      } catch {
        return false;
      }
    })
    .map(id => ({ id, label: cliLabels[id] }));
  const version = gitVersion(),
    value = { clis, git: { found: version !== null, version } };
  detected = { at: Date.now(), value };
  return value;
}

// GET /api/templates.
export function listTemplates(store, runner) {
  const org = store.organization(),
    agent = id => org.workers.find(worker => worker.id === id);
  return {
    firstRun: store.projects().length === 0 && !store.setting('projectCreated', false),
    ...setupStatus(runner),
    // Where a code project's candidate tests will run, which the screen says when it is not a sandbox (item 25).
    testSandbox: chosenTestSandbox(org),
    builtInSandbox: runner.builtInSandbox?.status() ?? { state: 'unsupported' },
    // Where a sample's folder is made unless the director chooses another folder.
    samples: path.join(store.directory, 'samples'),
    templates: projectTemplates.map(template => ({
      id: template.id,
      kind: template.kind,
      name: template.name,
      description: template.description,
      files: templateFiles(template).map(({ path: file, bytes }) => ({ path: file, bytes })),
      team: template.team.map(member => ({
        ...member,
        name: agent(member.agentId)?.displayName ?? member.agentId,
        look: agent(member.agentId)?.look ?? null,
      })),
      needsGit: template.needsGit,
      suggestions: [...template.suggestions],
      houseRules,
    })),
  };
}

// Where the sample's folder is made: the data folder's samples folder, or an existing folder the director chose
// outside the data folder (the director, October 24: "show path and let user choose a folder").
function sampleLocation(store, location) {
  const samples = path.join(store.directory, 'samples');
  if (location === undefined) return samples;
  if (typeof location !== 'string' || !path.isAbsolute(location))
    throw new Error('Choose an absolute folder path for the sample.');
  let real;
  try {
    real = fs.realpathSync(location);
  } catch {
    throw new Error(`There is no folder at ${location}.`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${location} is not a folder.`);
  const inside = path.relative(fs.realpathSync(store.directory), real);
  if (inside === 'samples') return samples;
  if (inside !== '..' && !inside.startsWith('..' + path.sep) && !path.isAbsolute(inside))
    throw new Error('Choose a folder outside the Studio desk data folder, or keep the one shown.');
  return real;
}

// The sample's folder: <location>/<name as a slug>, numbered when taken. It is always a new folder, so nothing
// already in the location changes.
function sampleFolder(root, name, fallback) {
  const slug =
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || fallback;
  fs.mkdirSync(root, { recursive: true });
  for (let number = 1; ; number++) {
    const folder = path.join(root, number === 1 ? slug : `${slug}-${number}`);
    try {
      fs.mkdirSync(folder);
      return folder;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

function git(folder, args) {
  const result = spawnSync('git', args, { cwd: folder, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.status !== 0)
    throw new Error(`Git could not set up the sample: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`);
}

// A writing sample's three files as the idea box sends files, for its first idea.
export function sampleIdeaFiles(sample) {
  if (sample?.template !== 'writing') return [];
  return projectTemplate('writing').files.map(file => {
    const data = fs.readFileSync(path.join(sample.folder, file));
    return { name: file, mediaType: mediaTypes[file.split('.').at(-1)] ?? 'text/plain', data: data.toString('base64') };
  });
}

// The code sample's team is a repository's software team, titled as No projects yet names them; Avery runs the checks.
const sampleTitles = { 'product-owner': 'Planner', engineer: 'Engineer', tester: 'Checks', reviewer: 'Reviewer' };
const codeTeam = org => {
  const config = repositoryOrganization(org);
  for (const member of config.members) member.role = sampleTitles[member.roles?.[0]] ?? member.role;
  return config;
};

// The writing sample's team: Mara plans, Juno writes, Morgan reviews, with the general planning, work and review types.
const writingTeam = () => ({
  expectedRevision: 0,
  teams: [{ id: 'project-team', name: 'Writing team', purpose: 'Plan, write and review what the director asks for.' }],
  members: [
    {
      workerId: 'W-01',
      role: 'Planner',
      responsibility: 'Plans each idea into steps the director approves.',
      roles: ['planner'],
    },
    {
      workerId: 'W-09',
      role: 'Writer',
      responsibility: 'Writes what the plan asks for from the sample files.',
      roles: ['worker'],
    },
    {
      workerId: 'W-07',
      role: 'Reviewer',
      responsibility: 'Reviews each piece before the director accepts it.',
      roles: ['reviewer'],
    },
  ].map(member => ({ ...member, teamId: 'project-team' })),
  taskKinds: ['general:plan', 'general:work', 'general:review'],
  kindOwners: {},
});

// POST /api/projects/from-template: { template, name, cli, location?, idea? } → { projectId, runId, folder }.
export async function createFromTemplate(store, registries, runner, data) {
  const takes = 'A sample takes its template, name, CLI, and optionally a folder to go in and a first idea.';
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(takes);
  if (Object.keys(data).some(key => !['projectId', 'template', 'name', 'cli', 'location', 'idea'].includes(key)))
    throw new Error(takes);
  const template = projectTemplate(data.template);
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 100)
    throw new Error('Project name is missing or too long.');
  const name = data.name.trim();
  if (store.projects().some(item => item.name.toLowerCase() === name.toLowerCase()))
    throw new Error('Choose a distinct project name.');
  if (data.idea !== undefined && (typeof data.idea !== 'string' || !data.idea.trim() || data.idea.trim().length > 4000))
    throw new Error('Idea must be nonempty text of at most 4000 characters after trimming.');
  const status = setupStatus(runner, { fresh: true });
  if (!status.clis.some(cli => cli.id === data.cli))
    throw new Error(
      status.clis.length
        ? `Choose a signed-in CLI: ${status.clis.map(cli => cli.label).join(' or ')}.`
        : 'Sign in to Claude Code or Codex CLI first, then check again.',
    );
  if (template.needsGit && !status.git.found)
    throw new Error('The Code sample needs Git. Install Git, then check again.');
  const folder = sampleFolder(sampleLocation(store, data.location), name, template.id);
  let project;
  try {
    for (const file of templateFiles(template)) {
      const target = path.join(folder, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data);
    }
    if (template.needsGit) {
      git(folder, ['-c', 'init.defaultBranch=main', 'init', '--quiet']);
      git(folder, ['add', '-A']);
      git(folder, [
        '-c',
        'user.name=Studio desk',
        '-c',
        'user.email=studio-desk@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        `${template.name}, made by Studio desk`,
      ]);
    }
    // The sample's agents run on the chosen CLI. Agents are shared by the whole studio.
    const org = store.organization(),
      agents = new Set(template.team.map(member => member.agentId));
    for (const worker of org.workers)
      if (agents.has(worker.id)) Object.assign(worker, { provider: data.cli, cli: cliLabels[data.cli] });
    store.setOrganization(org);
    const sample = { template: template.id, folder, ...(template.kind === 'writing' ? { filesWaiting: true } : {}) };
    project = await createProject(
      store,
      registries,
      runner,
      template.needsGit ? { name, repository: { root: folder } } : { name },
      { fields: { sample }, configuration: template.kind === 'writing' ? writingTeam : codeTeam },
    );
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  // The recommended house rules: the director approves plans; work that passes its review goes in on its own.
  saveAutonomyPolicy(store, registries, project.id, {
    expectedRevision: autonomyPolicy(store, project.id).revision,
    enabled: true,
    retries: 1,
    kinds: recommendedKinds(store, registries, project.id),
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
  const run =
    data.idea === undefined
      ? null
      : startIdeaIntake(
          store,
          registries,
          runner,
          { projectId: project.id, idea: data.idea, general: true },
          sampleIdeaFiles,
        );
  return { projectId: project.id, runId: run?.runId ?? null, folder };
}
