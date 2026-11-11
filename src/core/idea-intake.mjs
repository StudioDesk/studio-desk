// A director's idea entering a project (the New idea box, v1.0 item 11): a general-work project's planner plans it, and
// a project on the source workflow gets fresh checks and a breakdown. The intake routes and a sample created with a
// first idea (item 24) share it. A sample whose files are waiting gives them to its first idea.
import { projectOrganization } from './project-organization.mjs';
import { taskAutoMode } from './agent-permissions.mjs';
import { directorInputsOf, stageIdeaInputs, validateIdeaFiles } from './idea-inputs.mjs';
import { materializeWorkflow } from './workflows.mjs';
import { intakeSteps } from '../packs/studio-development/index.mjs';
import { generalIntakeSteps } from '../packs/general-work/index.mjs';
import { ideaRelease, restoreWaitingIdea, takeWaitingIdea } from '../connectors/source-milestones.mjs';
import { libraryOf } from './library.mjs';
import { closeRefusal, closeStartedWork } from './proposals.mjs';
import { runIdOf } from './graph.mjs';
import { recordProject } from './projects.mjs';
import { proposedStory } from '../connectors/source-changes.mjs';
import { taskRelease } from '../connectors/source-milestones.mjs';

// `general` is true on the general intake route, which also takes a source project's ideas; the Studio desk route
// only checks and breaks down. `sampleFiles` reads a sample's waiting files as wire files when the idea takes them. A
// source idea lands on a milestone or line the director picked (`milestone`, `line`), or the current working release
// (1.1 steps 1 and 2a, MP-032); `waiting` names the waiting idea it was sent from.
export function startIdeaIntake(
  store,
  registries,
  runner,
  { projectId, idea, files, autoMode, general, line, milestone, waiting, libraryLeftOut },
  sampleFiles,
) {
  store.project(projectId);
  if (typeof idea !== 'string' || !idea.trim() || idea.trim().length > 4000)
    throw new Error('Idea must be nonempty text of at most 4000 characters after trimming.');
  // Auto mode for every task of the idea's run, including the stories planned from it (the redesign's idea
  // box, v1.0 item 23); null or absent follows the Settings.
  if (autoMode !== undefined) taskAutoMode(autoMode);
  // Library entries the director leaves out of this idea's work from its first step (1.2 step 6).
  if (libraryLeftOut !== undefined) {
    const entries = libraryOf(store, projectId).entries;
    if (
      !Array.isArray(libraryLeftOut) ||
      new Set(libraryLeftOut).size !== libraryLeftOut.length ||
      libraryLeftOut.some(id => !entries.some(entry => entry.id === id))
    )
      throw Object.assign(new Error("Leave out only entries of this project's library, each once."), { status: 400 });
  }
  const org = projectOrganization(store, projectId),
    planned =
      general && !org.taskKinds?.includes('studio-development:breakdown') && org.taskKinds?.includes('general:plan');
  if (general && !planned && !org.taskKinds?.includes('studio-development:breakdown'))
    throw new Error(
      'This project has no idea intake. Enable Plan the work and Do the work, or the Studio desk source workflow, in Edit the teams (Agents, then Teams).',
    );
  if (planned && (line !== undefined || milestone !== undefined))
    throw new Error('Only a project on the source workflow has release lines and milestones.');
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
  // A source idea's release and line (1.1 step 2a): the director's pick, or the current working release. A milestone
  // the director names by a version that has none yet is made here, after everything else about the idea has been
  // checked.
  const { line: branch, release } = planned ? {} : ideaRelease(store, projectId, runner, { milestone, line });
  if (branch !== undefined) run.line = branch;
  if (release) run.release = { ...release, ...(waiting ? { waiting } : {}) };
  if (libraryLeftOut?.length) run.libraryLeftOut = [...libraryLeftOut];
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
  const by = run.release?.by,
    lands = run.release
      ? ` It is for ${run.release.version}${run.line !== undefined ? ` on ${run.line}` : ''}${
          by.type === 'default' ? ', the next release' : run.release.waiting ? ', the milestone it waited in' : ''
        }.`
      : run.line !== undefined
        ? ` It lands on ${run.line}.`
        : '';
  store.event(
    'workflow_started',
    tasks[0].id,
    null,
    (planned
      ? 'Director queued idea intake with a run brief. The planner proposes tasks; each requires separate work approval.'
      : 'Director queued idea intake with a run brief. Checks require acceptance before breakdown; proposed stories require separate work approval.') +
      lands,
    projectId,
  );
  return {
    runId,
    taskIds: tasks.map(task => task.id),
    budget,
    directorInputs: directorInputsOf(run),
    ...(run.line !== undefined ? { line: run.line } : {}),
    ...(run.release ? { release: run.release } : {}),
  };
}
// Sends an idea that waited in a milestone (1.1 step 2a), by the director or by the autonomy setting that sends the
// next one (`by`). The director chose its milestone when writing it there, so the planner does not move it. An idea that
// cannot be sent goes back where it waited.
export function sendWaitingIdea(store, registries, runner, projectId, milestoneId, waitingId, by) {
  const { milestone, waiting, index } = takeWaitingIdea(store, projectId, milestoneId, waitingId);
  try {
    return startIdeaIntake(store, registries, runner, {
      projectId,
      idea: waiting.idea,
      ...(waiting.autoMode !== undefined ? { autoMode: waiting.autoMode } : {}),
      milestone: milestone.id,
      waiting: { id: waiting.id, by },
    });
  } catch (error) {
    restoreWaitingIdea(store, projectId, milestoneId, waiting, index);
    throw error;
  }
}

// What Close and send as a new idea says it continues, in the idea's text and on the story it closes.
export const sentAsIdeaReason = 'Sent as a new idea: the code moved on since this story was planned.';
const continues = 'It continues work an earlier story planned, which the code has since moved past.';
// The idea a story whose plan is out of date sends in: the director's words when given, otherwise the story's title,
// its plain planned summary when it has one and that it continues work the code moved past; never its files, scope or
// identifiers.
function storyIdea(store, task) {
  let summary;
  try {
    const planned = task.proposalReference?.path === 'source-breakdown.json' ? proposedStory(store, task) : undefined;
    if (typeof planned?.summary === 'string' && planned.summary.trim()) summary = planned.summary.trim();
  } catch {}
  return [task.title.trim(), summary, continues].filter(Boolean).join('\n\n');
}
// Close and send as a new idea: a source story whose plan the code moved past (sourceStage.outdated) is closed, and its
// remaining work enters as a new idea on the story's own project, line and milestone, which gets fresh checks and a new
// plan. Only a story close would take is accepted, and `refuse` (the controller's own refusal, such as an integration
// approved and waiting to run) is asked first. The idea is started before the story is closed, so a refused idea
// leaves the story as it was; nothing yields between the two, so close's conditions still hold once it starts.
export function sendStoryAsIdea(store, registries, runner, task, { idea, refuse } = {}, sampleFiles) {
  if (task.kind !== 'studio-development:change' || !task.sourceStage?.outdated)
    throw Object.assign(
      new Error('Only a story whose plan the code has moved past can be sent as a new idea. Close it instead.'),
      { status: 409 },
    );
  const refusal = refuse?.(task) || closeRefusal(store, registries, task);
  if (refusal) throw Object.assign(refusal, { status: refusal.status ?? 409 });
  const projectId = recordProject(task),
    release = taskRelease(store, task),
    line = task.release?.line ?? store.run(runIdOf(task))?.line;
  const started = startIdeaIntake(
    store,
    registries,
    runner,
    {
      projectId,
      idea: idea === undefined ? storyIdea(store, task) : idea,
      ...(release?.milestoneId ? { milestone: release.milestoneId } : line !== undefined ? { line } : {}),
    },
    sampleFiles,
  );
  const sent = { runId: started.runId, at: new Date().toISOString() };
  closeStartedWork(store, registries, store.task(task.id), sentAsIdeaReason, { sentAsIdea: sent });
  store.event(
    'sent_as_idea',
    task.id,
    null,
    'Director sent the rest of this story in as a new idea, since the code moved on since it was planned. The new idea gets fresh checks and a new plan.',
    projectId,
  );
  return { ok: true, closed: task.id, runId: started.runId, idea: started };
}
