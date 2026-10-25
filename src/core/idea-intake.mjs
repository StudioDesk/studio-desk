// A director's idea entering a project (the New idea box, v1.0 item 11): a general-work project's planner plans it, and
// a project on the source workflow gets fresh checks and a breakdown. The intake routes and a sample created with a
// first idea (item 24) share it. A sample whose files are waiting gives them to its first idea.
import { projectOrganization } from './project-organization.mjs';
import { taskAutoMode } from './agent-permissions.mjs';
import { directorInputsOf, stageIdeaInputs, validateIdeaFiles } from './idea-inputs.mjs';
import { materializeWorkflow } from './workflows.mjs';
import { intakeSteps } from '../packs/studio-development/index.mjs';
import { generalIntakeSteps } from '../packs/general-work/index.mjs';

// `general` is true on the general intake route, which also takes a source project's ideas; the Studio desk route
// only checks and breaks down. `sampleFiles` reads a sample's waiting files as wire files when the idea takes them.
export function startIdeaIntake(store, registries, runner, { projectId, idea, files, autoMode, general }, sampleFiles) {
  store.project(projectId);
  if (typeof idea !== 'string' || !idea.trim() || idea.trim().length > 4000)
    throw new Error('Idea must be nonempty text of at most 4000 characters after trimming.');
  // Auto mode for every task of the idea's run, including the stories planned from it (the redesign's idea
  // box, v1.0 item 23); null or absent follows the Settings.
  if (autoMode !== undefined) taskAutoMode(autoMode);
  const org = projectOrganization(store, projectId),
    planned =
      general && !org.taskKinds?.includes('studio-development:breakdown') && org.taskKinds?.includes('general:plan');
  if (general && !planned && !org.taskKinds?.includes('studio-development:breakdown'))
    throw new Error(
      'This project has no idea intake. Enable Plan the work and Do the work, or the Studio desk source workflow, in Edit the teams (Agents, then Teams).',
    );
  const sample = store.project(projectId).sample,
    given = sample?.filesWaiting && sampleFiles ? [...sampleFiles(sample), ...(files ?? [])] : files;
  const ideaFiles = validateIdeaFiles(given),
    brief = idea.trim(),
    steps = planned ? generalIntakeSteps(org, registries) : intakeSteps(org, registries.adapters),
    workflow = planned
      ? { id: 'workflow-general-intake', projectId, name: 'Plan a director idea', version: 1, steps }
      : {
          id: 'workflow-studio-development-intake',
          projectId,
          name: 'Check source and break down a director idea',
          version: 1,
          steps,
        },
    { runId, tasks, budget, run } = materializeWorkflow(store, registries, workflow, { brief, ideaFiles });
  if (typeof autoMode === 'boolean') {
    run.autoMode = autoMode;
    for (const task of tasks) task.autoMode = autoMode;
  }
  // Durable bytes precede the atomic database commit. A crash before
  // commit leaves only unreachable storage; dispatch cannot see half a run.
  const discard = stageIdeaInputs(store, run, ideaFiles);
  try {
    store.tx(() => {
      tasks.forEach(task => store.putTask(task));
      store.putRun(run);
      if (given !== files)
        store.putProject({ ...store.project(projectId), sample: { ...sample, filesWaiting: false } });
      // Only an explicit resume may clear a project pause.
      if (!store.project(projectId).dispatchPaused) runner.enablePipeline(projectId);
    });
  } catch (error) {
    try {
      discard();
    } catch {}
    throw error;
  }
  store.event(
    'workflow_started',
    tasks[0].id,
    null,
    planned
      ? 'Director queued idea intake with a run brief. The planner proposes tasks; each requires separate work approval.'
      : 'Director queued idea intake with a run brief. Checks require acceptance before breakdown; proposed stories require separate work approval.',
    projectId,
  );
  return { runId, taskIds: tasks.map(task => task.id), budget, directorInputs: directorInputsOf(run) };
}
