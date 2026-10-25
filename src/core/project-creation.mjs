// Creating a project (v1.0 items 10 and 24): Create a project's route and the samples on No projects yet share it.
// A git repository is checked first, a clean tree on a branch with a valid profile whose tests run and pass on a copy
// of its commit (step 4b), and nothing is recorded if any check fails. A project without one is for general work.
import { randomUUID } from 'node:crypto';
import { inspectRepository, recordProjectSource, repositoryTests } from '../connectors/source-projects.mjs';
import { testsSentence } from '../connectors/source-checks.mjs';
import { genericProjectConfiguration, saveProjectOrganization } from './project-organization.mjs';
import { applyRecommendedHouseRules } from './autonomy.mjs';
import { repositoryOrganization } from '../organizations/studio-development/project.mjs';

const text = (value, field, max = 24000, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error(`${field} is missing or too long.`);
  return value.trim();
};

// Returns the new project, with its tests' result when it works on a repository. `configuration` may replace the
// default team (a repository's software team, or every enabled employee for general work); `fields` adds project
// fields the routes do not take, such as a sample's record. With houseRules 'recommended' (as Add a project sends) the
// project starts on the recommended house rules; otherwise every step waits for the director.
export async function createProject(store, registries, runner, data, { configuration, fields } = {}) {
  if (
    Object.keys(data).some(key => !['projectId', 'name', 'goal', 'direction', 'repository', 'houseRules'].includes(key))
  )
    throw new Error('Unsupported project fields.');
  if (data.houseRules !== undefined && !['recommended', 'off'].includes(data.houseRules))
    throw new Error("House rules are 'recommended' or 'off'.");
  if (store.projects().length >= 50) throw new Error('Project limit reached.');
  const project = {
    id: 'project-' + randomUUID().slice(0, 12),
    name: text(data.name, 'Project name', 100, true),
    goal: text(data.goal || '', 'Project goal'),
    direction: text(data.direction || '', 'Project direction'),
    revision: 1,
    dispatchPaused: false,
    createdAt: new Date().toISOString(),
    ...fields,
  };
  const distinct = () => {
    if (store.projects().some(item => item.name.toLowerCase() === project.name.toLowerCase()))
      throw new Error('Choose a distinct project name.');
  };
  distinct();
  let repository = null,
    tests = null;
  if (data.repository !== undefined) {
    const given = data.repository;
    if (
      !given ||
      typeof given !== 'object' ||
      Array.isArray(given) ||
      Object.keys(given).some(key => !['root', 'profile'].includes(key))
    )
      throw new Error('A repository gives its root and, optionally, an edited profile.');
    repository = inspectRepository(store, given.root, runner, given.profile);
    if (repository.problems.length) throw new Error(repository.problems.join(' '));
    tests = await repositoryTests(runner, repository);
    // The tests ran without holding anything; check again what may have changed meanwhile.
    distinct();
    const problems = inspectRepository(store, repository.root, runner, repository.profile).problems;
    if (problems.length) throw new Error(problems[0]);
  }
  store.tx(() => {
    store.putProject(project);
    if (repository)
      recordProjectSource(store, project.id, { root: repository.root, profile: repository.profile }, runner);
    const org = store.organization();
    saveProjectOrganization(
      store,
      registries,
      project.id,
      configuration
        ? configuration(org)
        : repository
          ? repositoryOrganization(org)
          : genericProjectConfiguration(org, registries),
      true,
    );
    // No projects yet's welcome is for a data folder that has never had a project.
    store.putSetting('projectCreated', true);
  });
  store.event(
    'project_created',
    null,
    null,
    repository
      ? `Project created: ${project.name}, working on ${repository.root} (${repository.branch}); its tests on ${repository.head.slice(0, 7)}: ${testsSentence(tests)}.`
      : `Project created: ${project.name}.`,
    project.id,
  );
  if (data.houseRules === 'recommended') applyRecommendedHouseRules(store, registries, project.id);
  return repository ? { ...store.project(project.id), tests } : project;
}
