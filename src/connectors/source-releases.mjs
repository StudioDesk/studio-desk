// Releasing a milestone and pushing it (1.1 step 5, Decision MP-028). Release is offered on a milestone whose ideas are
// accepted; it offers to move ideas still open to the next milestone on its line, so nothing ships half-done. The
// project's planner (its breakdown owner) drafts the release notes from the milestone's integrated stories, in a task
// the director accepts or sends back. Accepting it releases: the controller writes the version where the project keeps
// one (package.json and its lockfile; otherwise the tag alone is the version) and the notes at the top of
// RELEASE-NOTES.md, verifies the release commit as it verifies an integration (formatting and the line's suite), moves
// the line and makes an annotated tag. Push sends the line and its tag to the repository's remote, only when the
// director confirms it, never for the policy or an agent, and never waiting for a sign-in.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { commitIntegration, git, integrationTrailer, stageFiles, verifyIntegration } from './source-integration.mjs';
import { testsSentence } from './source-checks.mjs';
import { createSourceWorktree, removeSourceWorktree, sourceWorktreeRoot } from './source-worktrees.mjs';
import { lineReached, lineRepository, moveLine, projectLine } from './source-lines.mjs';
import { compareVersions, makeMilestone, parseVersion, projectMilestones, releaseTags } from './source-milestones.mjs';
import { projectSource, sourceResources } from './source-projects.mjs';
import { chosenTestSandbox } from '../adapters/source-test-sandbox.mjs';
import { projectOrganization } from '../core/project-organization.mjs';
import { recordProject } from '../core/projects.mjs';
import { runIdOf } from '../core/graph.mjs';

const key = projectId => 'milestones:' + projectId;
// Reads and saves one milestone of a project.
function milestoneOf(store, projectId, milestoneId) {
  const milestones = projectMilestones(store, projectId),
    milestone = milestones.find(item => item.id === milestoneId);
  if (!milestone) throw new Error('Milestone not found.');
  return { milestones, milestone, save: () => store.putSetting(key(projectId), milestones) };
}
const lineOf = (store, projectId, milestone) => projectLine(store, projectId, milestone.line ?? undefined);
// A tag in the repository's own pattern: v1.1.0, or 1.1.0 when its release tags have no v.
export function tagFor(root, version) {
  const tags = releaseTags(root),
    bare = tags.length && tags.filter(tag => !tag.name.startsWith('v')).length > tags.length / 2;
  return `${bare ? '' : 'v'}${version}`;
}
const tagExists = (root, tag) => {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
};

// The work of a milestone: every task whose release it is, by its own release or its idea's.
function milestoneTasks(store, projectId, milestoneId) {
  return store
    .tasks()
    .filter(
      task =>
        recordProject(task) === projectId &&
        (task.release?.milestoneId ?? store.run(runIdOf(task))?.release?.milestoneId) === milestoneId,
    );
}
const integrated = task =>
  task.sourceStage?.current === 'integrated' || task.sourceStage?.integration?.state === 'integrated';
const settledTask = task =>
  task.kind === 'studio-development:change' && task.status === 'done'
    ? integrated(task) || task.sourceStage?.current === 'closed'
    : ['done', 'denied', 'cancelled'].includes(task.status);
// The next milestone on the same line, made when there is none: the next patch of a patch, the next minor otherwise.
function nextMilestone(store, projectId, runtime, milestone) {
  const version = parseVersion(milestone.version),
    later = projectMilestones(store, projectId)
      .filter(item => item.state === 'open' && item.line === milestone.line && item.id !== milestone.id)
      .filter(item => compareVersions(parseVersion(item.version), version) > 0)
      .sort((a, b) => compareVersions(parseVersion(a.version), parseVersion(b.version)))[0];
  if (later) return later;
  const next =
    version[2] > 0 || milestone.line !== null
      ? [version[0], version[1], version[2] + 1]
      : [version[0], version[1] + 1, 0];
  return makeMilestone(store, projectId, runtime, { version: next, by: { type: 'release', from: milestone.id } });
}

// Release on a milestone: refuses while its ideas are open unless moveOpen moves them to the next milestone on its line,
// then asks the planner for the notes. Returns the notes task.
export function startRelease(store, runtime, projectId, milestoneId, { moveOpen = false } = {}) {
  const { milestone } = milestoneOf(store, projectId, milestoneId),
    root = projectSource(store, projectId, runtime).root;
  if (milestone.state !== 'open') throw new Error(`Milestone ${milestone.version} is already released.`);
  if (milestone.release && !['rejected'].includes(milestone.release.state))
    throw new Error(`The release of ${milestone.version} is already ${milestone.release.state}.`);
  const tag = tagFor(root, milestone.version);
  if (tagExists(root, tag)) throw new Error(`The repository already has a tag named ${tag}.`);
  const tasks = milestoneTasks(store, projectId, milestoneId),
    open = tasks.filter(task => !settledTask(task));
  if (open.length && !moveOpen)
    throw Object.assign(
      new Error(
        `${open.length} ${open.length === 1 ? 'piece of work is' : 'pieces of work are'} still open on ${milestone.version}: ${open
          .slice(0, 5)
          .map(task => `${task.id} (“${task.title}”)`)
          .join(
            ', ',
          )}${open.length > 5 ? ' and more' : ''}. Release it after they settle, or move them to the next milestone.`,
      ),
      { status: 409, open: open.map(task => task.id) },
    );
  const stories = tasks.filter(task => task.kind === 'studio-development:change' && integrated(task));
  if (!stories.length)
    throw new Error(`Nothing on ${milestone.version} has been integrated yet, so there is nothing to release.`);
  if (open.length) {
    const next = nextMilestone(store, projectId, runtime, milestone),
      moved = { milestoneId: next.id, version: next.version };
    for (const task of open)
      if (task.release) store.putTask({ ...task, release: { ...task.release, ...moved } });
      else {
        const run = store.run(runIdOf(task));
        if (run?.release?.milestoneId === milestoneId) store.putRun({ ...run, release: { ...run.release, ...moved } });
      }
    store.event(
      'release_moved',
      null,
      null,
      `Open work on ${milestone.version} moved to ${next.version}: ${open.map(task => task.id).join(', ')}.`,
      projectId,
    );
  }
  const org = projectOrganization(store, projectId),
    planner = org.workers.find(
      worker => worker.id === org.kindOwners?.['studio-development:breakdown'] && worker.enabled,
    );
  if (!planner)
    throw new Error('Choose an enabled breakdown owner in Edit the teams; the planner drafts the release notes.');
  const line = lineOf(store, projectId, milestone),
    list = stories
      .map(
        story =>
          `- ${story.id}: ${story.title}${story.brief ? ` (${String(story.brief).split('\n').at(-1).slice(0, 300)})` : ''}`,
      )
      .join('\n');
  const notes = {
    id: 'T-' + randomUUID().slice(0, 8),
    projectId,
    title: `Draft the ${milestone.version} release notes`,
    brief: `Write release-notes.md: the release notes for ${milestone.version}${line ? ` (${line})` : ''}${milestone.goal ? `, whose goal is: ${milestone.goal}` : ''}. Start with the heading "## ${milestone.version}", then say in plain words what changed for the people who use it, from these integrated stories:\n${list}\nWrite for users: what they can now do or what was fixed, not how it was built, and no file names. The controller puts it at the top of RELEASE-NOTES.md when the director accepts it.`,
    acceptance: `release-notes.md starts with "## ${milestone.version}" and covers every story above in plain words.`,
    kind: 'general',
    workerId: planner.id,
    team: planner.team,
    teamId: planner.teamId,
    goalId: null,
    dependencies: [],
    resources: [],
    maxSeconds: 600,
    maxAttempts: 3,
    direction: '',
    status: 'ready',
    reason: '',
    hold: false,
    lastAttemptId: null,
    createdAt: new Date().toISOString(),
    organizationReference: org.projectOrganization,
    releaseOf: { milestoneId, version: milestone.version },
  };
  // The notes are drafted at once; a project the director paused drafts them when it resumes.
  store.tx(() => {
    store.putTask({ ...notes, queued: true });
    if (!store.project(projectId).dispatchPaused) runtime.enablePipeline(projectId);
  });
  runtime.schedule();
  const fresh = milestoneOf(store, projectId, milestoneId);
  fresh.milestone.release = {
    state: 'drafting',
    notesTaskId: notes.id,
    line: line ?? null,
    tag,
    stories: stories.map(story => story.id),
    at: new Date().toISOString(),
  };
  fresh.save();
  store.event(
    'release_started',
    notes.id,
    null,
    `Release of ${milestone.version} started: ${planner.displayName ?? planner.id} drafts its notes from ${stories.length} integrated ${stories.length === 1 ? 'story' : 'stories'}; accepting them tags ${tag}.`,
    projectId,
  );
  return store.task(notes.id);
}

// The director accepted a release's notes: the release waits for the project's source (the autonomy runtime runs it).
export function notesAccepted(store, task) {
  const { milestone, save } = milestoneOf(store, recordProject(task), task.releaseOf.milestoneId);
  if (milestone.release?.notesTaskId !== task.id || milestone.release.state !== 'drafting') return;
  milestone.release.state = 'ready';
  save();
}
// Release again, after a release stopped: one that stopped part-way on the checked-out branch needs the folder's
// changed files restored first.
export function releaseAgain(store, projectId, milestoneId) {
  const { milestone, save } = milestoneOf(store, projectId, milestoneId),
    release = milestone.release;
  if (!release || !['rejected', 'needs-reconciliation'].includes(release.state))
    throw new Error(`The release of ${milestone.version} has not stopped.`);
  if (release.state === 'needs-reconciliation') {
    const edited = git(release.root, [
      'status',
      '--porcelain',
      '--',
      ...(release.changes || []).map(item => item.path),
    ]);
    if (edited)
      throw new Error("Restore or commit the release's files in the project's folder, then release it again.");
  }
  release.previous = { state: release.state, error: release.error, finishedAt: release.finishedAt };
  release.state = 'ready';
  delete release.error;
  save();
  return structuredClone(release);
}
// The accepted notes, headed by their version.
function acceptedNotes(store, task, version) {
  const attempt = store.attempt(task.acceptedAttemptId),
    item = attempt.artifacts?.find(artifact => artifact.path === 'release-notes.md');
  if (!item) throw new Error('The accepted notes have no release-notes.md.');
  const text = fs.readFileSync(path.join(attempt.outputFolder, item.path), 'utf8').trim();
  if (!text || text.length > 64 * 1024) throw new Error('The release notes must be text of at most 64 KB.');
  return (text.startsWith(`## ${version}`) ? text : `## ${version}\n\n${text}`) + '\n';
}
// Writes the version and the notes into a worktree and returns the files changed. The version changes only the version
// lines of package.json and of its lockfile (the project's own, and its root package's), leaving their formatting alone.
function writeRelease(worktree, version, notes) {
  const changed = [],
    bump = (file, count) => {
      const target = path.join(worktree, file);
      if (!fs.existsSync(target)) return;
      const text = fs.readFileSync(target, 'utf8');
      let old;
      try {
        old = JSON.parse(text).version;
      } catch {
        return; // Not JSON: the file holds no version the release can write.
      }
      if (typeof old !== 'string') return;
      let seen = 0;
      const next = text.replace(/("version"\s*:\s*")([^"]*)(")/g, (match, before, value, after) =>
        seen < count && value === old ? (seen++, before + version + after) : match,
      );
      if (next === text) return;
      fs.writeFileSync(target, next);
      changed.push(file);
    };
  bump('package.json', 1);
  bump('package-lock.json', 2);
  const file = path.join(worktree, 'RELEASE-NOTES.md');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8'),
      lines = text.split('\n'),
      title = lines.findIndex(line => line.startsWith('# '));
    const at = title < 0 ? 0 : title + 1 + (lines[title + 1] === '' ? 1 : 0);
    fs.writeFileSync(file, [...lines.slice(0, at), ...notes.trimEnd().split('\n'), '', ...lines.slice(at)].join('\n'));
  } else fs.writeFileSync(file, `# Release notes\n\n${notes}`);
  changed.push('RELEASE-NOTES.md');
  return changed;
}

// The release, once its notes are accepted: verified as an integration is, then the line moved and tagged. Busy while an
// integration or carry runs or the project's source is held; the caller tries again when they settle.
export function runRelease(runtime, projectId, milestoneId, onSettled = () => {}) {
  const store = runtime.store,
    { milestone, save } = milestoneOf(store, projectId, milestoneId),
    release = milestone.release;
  if (milestone.state !== 'open' || !release || !['drafting', 'ready', 'rejected'].includes(release.state))
    throw new Error(`Milestone ${milestone.version} has no release waiting to run.`);
  const notesTask = store.task(release.notesTaskId);
  if (notesTask.status !== 'done' || !notesTask.acceptedAttemptId)
    throw new Error(`Accept the ${milestone.version} release notes (${notesTask.id}) first.`);
  const resources = sourceResources(store, notesTask);
  if (runtime.sourceIntegrationRun || store.leases().some(lease => resources.includes(lease.resource)))
    throw Object.assign(new Error('The project’s source is busy; the release starts when it is free.'), { busy: true });
  const root = projectSource(store, projectId, runtime).root,
    line = lineOf(store, projectId, milestone),
    repository = lineRepository(root, line);
  if (runtime.selfHosted && root === runtime.sourceChangeRoot && repository.live !== false)
    throw new Error(`${repository.branch} is the branch this controller runs from; release it by hand.`);
  if (tagExists(root, release.tag)) throw new Error(`The repository already has a tag named ${release.tag}.`);
  // The release's tests run where the next story's candidate tests would.
  const id = `source-release:${projectId}:${milestone.id}`,
    testSandbox = chosenTestSandbox(store.organization(), runtime.codexBinary);
  Object.assign(release, {
    id,
    state: 'verifying',
    phaseOccurrenceId: randomUUID(),
    reviewAttemptId: notesTask.acceptedAttemptId,
    reviewTaskId: notesTask.id,
    candidateAttemptId: notesTask.acceptedAttemptId,
    root,
    repository,
    worktree: path.join(sourceWorktreeRoot(runtime), `r-${milestone.id.slice(-8)}`),
    configuration: {
      testSandbox,
      ...(process.platform === 'win32' && testSandbox === 'codex'
        ? { windowsSandbox: runtime.codexWindowsSandbox }
        : {}),
    },
    startedAt: new Date().toISOString(),
  });
  store.tx(() => {
    store.claim(resources, id);
    save();
  });
  store.event(
    'release_verifying',
    notesTask.id,
    null,
    `Releasing ${milestone.version}: writing its version and notes onto ${repository.branch} at ${repository.head.slice(0, 7)} in its own worktree, then formatting and testing it; ${repository.branch} is unchanged until it passes.`,
    projectId,
  );
  const promise = finishRelease(runtime, projectId, milestone.id, acceptedNotes(store, notesTask, milestone.version))
    .catch(error => {
      const current = milestoneOf(store, projectId, milestone.id);
      Object.assign(current.milestone.release, { state: 'needs-reconciliation', error: error.message });
      current.save();
      return structuredClone(current.milestone.release);
    })
    .then(result => {
      if (runtime.sourceIntegrationRun?.id === id) runtime.sourceIntegrationRun = null;
      if (!runtime.closing) onSettled(result);
      return result;
    });
  runtime.sourceIntegrationRun = { id, promise };
  return structuredClone(release);
}

async function finishRelease(runtime, projectId, milestoneId, notes) {
  const store = runtime.store,
    current = () => milestoneOf(store, projectId, milestoneId),
    { milestone } = current(),
    release = milestone.release,
    root = release.root,
    profile = projectSource(store, projectId, runtime).profile,
    directory = path.join(store.directory, 'releases', milestone.id),
    draft = `${release.worktree}d`;
  // The release's fields live on its milestone, which other writes may have saved meanwhile.
  const persist = (fields = {}) => {
      const now = current();
      Object.assign(now.milestone.release, release, fields);
      now.save();
      return now;
    },
    close = (state, fields = {}) => {
      const now = current();
      Object.assign(now.milestone.release, release, fields, { state, finishedAt: new Date().toISOString() });
      if (state === 'released') now.milestone.state = 'released';
      store.tx(() => {
        now.save();
        store.release(release.id);
      });
      return structuredClone(now.milestone.release);
    },
    discard = () => {
      for (const worktree of [draft, release.worktree])
        try {
          removeSourceWorktree(root, worktree);
        } catch {}
    };
  let verification;
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    discard();
    // The release commit is drafted in one worktree and verified in another, as a candidate is built and integrated.
    createSourceWorktree(root, path.dirname(draft), path.basename(draft), release.repository.head, profile);
    const files = writeRelease(draft, milestone.version, notes);
    stageFiles(draft, files);
    git(draft, ['commit', '--quiet', '-m', `Release ${milestone.version} (draft)`, '--', ...files]);
    release.candidateCommit = git(draft, ['rev-parse', 'HEAD']);
    git(draft, ['update-ref', `refs/studio/releases/${milestone.id}`, release.candidateCommit]);
    release.changes = files.map(file => ({ path: file, afterHash: 'release' }));
    createSourceWorktree(
      root,
      path.dirname(release.worktree),
      path.basename(release.worktree),
      release.repository.head,
      profile,
    );
    verification = await verifyIntegration(runtime, release, directory, release.configuration, profile);
  } catch (error) {
    verification = { passed: false, error: error.message };
  }
  // A shutdown stops verification; the controller's next start reconciles the release.
  if (runtime.closing) return structuredClone(release);
  release.verification = verification;
  if (!verification.passed) {
    discard();
    const reason =
      verification.error ||
      (verification.totals
        ? `${verification.totals.pass}/${verification.totals.tests} tests passed on the release.`
        : 'The test run did not report complete totals.');
    const result = close('rejected', { error: reason });
    store.event(
      'release_rejected',
      release.reviewTaskId,
      null,
      `The release of ${milestone.version} stopped before changing ${release.repository.branch}: ${reason}`,
      projectId,
    );
    return result;
  }
  try {
    release.commit = commitIntegration(
      release.worktree,
      release.changes.map(item => item.path),
      [
        `Release ${milestone.version}`,
        '',
        `Released by Studio desk after the director accepted its notes (${release.reviewTaskId}).`,
        `Verification: ${verification.formatter === 'none' ? 'no formatter in the source profile' : `${verification.formatter} on changed files`}; ${testsSentence(verification.totals)} on ${release.repository.branch}${verification.fixture ? ' (protocol fixture)' : ''}.`,
        '',
        integrationTrailer(release),
        '',
      ].join('\n'),
      directory,
    );
  } catch (error) {
    discard();
    return close('rejected', { error: error.message });
  }
  // From here the line may move, so an interruption is reconciled from git history.
  release.state = 'committing';
  persist();
  try {
    moveLine(root, release);
    if (!lineReached(root, release))
      throw Object.assign(new Error(`${release.repository.branch} did not reach the release commit.`), {
        partial: true,
      });
  } catch (error) {
    if (error.partial) {
      discard();
      return structuredClone(persist({ state: 'needs-reconciliation', error: error.message }).milestone.release);
    }
    discard();
    return close('rejected', { error: error.message });
  }
  return tagRelease(store, projectId, milestoneId, release, close, discard);
}
// Tags the release commit, whose line already reached it, and closes the milestone.
function tagRelease(store, projectId, milestoneId, release, close, discard = () => {}) {
  const { milestone } = milestoneOf(store, projectId, milestoneId);
  if (!tagExists(release.root, release.tag))
    git(release.root, ['tag', '-a', release.tag, '-m', `Release ${milestone.version}`, release.commit]);
  const result = close('released');
  discard();
  store.event(
    'release_done',
    release.reviewTaskId,
    null,
    `Released ${milestone.version} on ${release.repository.branch} as commit ${release.commit.slice(0, 7)}, tagged ${release.tag}. Push it when you are ready.`,
    projectId,
  );
  return result;
}

// Releases the controller's stop cut off: one in verification waits to run again; one moving its line is tagged if the
// line reached its commit, waits again when the line is not checked out, and otherwise needs the director.
export function interruptedReleases(runtime) {
  const store = runtime.store;
  for (const project of store.projects()) {
    const milestones = projectMilestones(store, project.id);
    let changed = false;
    for (const milestone of milestones) {
      const release = milestone.release;
      if (!release || !['verifying', 'committing'].includes(release.state)) continue;
      changed = true;
      store.release(release.id);
      const was = release.state;
      if (was === 'committing' && release.commit && lineReached(release.root, release)) {
        if (!tagExists(release.root, release.tag))
          git(release.root, ['tag', '-a', release.tag, '-m', `Release ${milestone.version}`, release.commit]);
        Object.assign(release, { state: 'released', finishedAt: new Date().toISOString() });
        milestone.state = 'released';
      } else if (was === 'verifying' || release.repository?.live === false) release.state = 'ready';
      else
        Object.assign(release, {
          state: 'needs-reconciliation',
          error: 'The controller stopped while this release moved its line.',
        });
      release.interrupted = was;
      store.event(
        'release_interrupted',
        release.reviewTaskId,
        null,
        release.state === 'released'
          ? `Reconciled: the release of ${milestone.version} had reached ${release.repository.branch}; tagged ${release.tag}.`
          : release.state === 'ready'
            ? `The release of ${milestone.version} was stopped when the controller stopped (during ${was}); release it again.`
            : `The release of ${milestone.version} stopped part-way when the controller stopped; inspect the project's folder, then release it again.`,
        project.id,
      );
    }
    if (changed) store.putSetting(key(project.id), milestones);
  }
}

// The remote Push uses: origin, or the only one.
function remoteOf(root) {
  const remotes = git(root, ['remote']).split('\n').filter(Boolean);
  if (remotes.includes('origin')) return 'origin';
  if (remotes.length === 1) return remotes[0];
  throw new Error(
    remotes.length
      ? `The repository has several remotes and none is origin (${remotes.join(', ')}); name one origin to push there.`
      : 'The repository has no remote to push to. Add one with git remote add origin <address>.',
  );
}
// Push, after the director confirms: the released line and its tag to the repository's remote, with git never waiting
// for a sign-in. A push that would need one fails with git's reason and the command to run by hand.
export async function pushRelease(store, runtime, projectId, milestoneId, { confirm } = {}) {
  if (confirm !== true) throw new Error('Confirm the push: it sends the release to the repository’s remote.');
  const { milestone } = milestoneOf(store, projectId, milestoneId),
    release = milestone.release;
  if (milestone.state !== 'released' || release?.state !== 'released')
    throw new Error(`Milestone ${milestone.version} has not been released yet.`);
  const root = projectSource(store, projectId, runtime).root,
    remote = remoteOf(root),
    branch = release.repository.branch,
    refs = [`refs/heads/${branch}:refs/heads/${branch}`, `refs/tags/${release.tag}:refs/tags/${release.tag}`],
    environment = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }),
    };
  const result = await new Promise(resolve => {
    const child = spawn('git', ['push', '--porcelain', remote, ...refs], {
      cwd: root,
      env: environment,
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => (output += chunk));
    child.stderr.on('data', chunk => (output += chunk));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on('error', error => resolve({ code: -1, output: error.message }));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  if (result.code !== 0)
    throw new Error(
      `Git could not push ${branch} and ${release.tag} to ${remote}: ${result.output.trim().slice(0, 500) || 'no reason given'}. Run it yourself with git push ${remote} ${branch} ${release.tag}.`,
    );
  const now = milestoneOf(store, projectId, milestoneId);
  now.milestone.release.pushed = { remote, at: new Date().toISOString(), by: { type: 'director' } };
  now.save();
  store.event(
    'release_pushed',
    release.reviewTaskId,
    null,
    `Pushed ${branch} and ${release.tag} to ${remote}.`,
    projectId,
  );
  return structuredClone(now.milestone.release);
}
