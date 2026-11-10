// What a project's Releases page shows (1.1 step 6, Decision MP-028), read without changing anything: each release line
// with its last release and what landed on it since, each milestone with its ideas, their stories and the ideas waiting
// in it, the director's own copy, and what the remote is known to have. Only the controller's records and the local
// repository are read; nothing reaches the remote, so "on the remote" means as of the last fetch or push.
// It asks git about two dozen things for a project with three lines, about 3 s on one thread when the computer is busy
// (measured November 2), so git answers without holding the controller's thread (C-20), a few at a time.
import { gitAsync } from './source-integration.mjs';
import { branchCommitAsync, checkedOutAsync, projectLines } from './source-lines.mjs';
import {
  compareVersions,
  nextRelease,
  projectMilestones,
  releaseTagsAsync,
  versionLinesReadiness,
  versionText,
} from './source-milestones.mjs';
import { projectSource } from './source-projects.mjs';
import { projectCatalog } from '../core/project-organization.mjs';
import { runIdOf } from '../core/graph.mjs';
import { recordProject } from '../core/projects.mjs';

const story = 'studio-development:change';
// How many commits a line's "landed since" lists; the counts cover them all, up to the scan limit.
const listedCommits = 20,
  scannedCommits = 500;

const tries = fn => {
  try {
    return fn();
  } catch {
    return null;
  }
};
// A git answer, or null where git refuses.
const answer = asked => asked.catch(() => null);
// A remote's address without any user name or token in it.
const safeUrl = url => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');

// The newest release tag the line's tip contains.
async function lastRelease(root, tags, head) {
  for (const tag of [...tags].reverse())
    if (await answer(gitAsync(root, ['merge-base', '--is-ancestor', `${tag.name}^{commit}`, head]).then(() => true)))
      return { name: tag.name, version: versionText(tag.version) };
  return null;
}
// The commits on a line since its last release, newest first: the studio's (integrations, carries and releases, which
// carry its trailer) and the rest, made by hand.
async function landed(root, since, head) {
  const range = since ? `${since}^{commit}..${head}` : head,
    out = await gitAsync(root, ['log', `-${scannedCommits}`, '--format=%H%x1f%s%x1f%cI%x1f%b%x1e', range], {
      raw: true,
    });
  const commits = out
    .split('\x1e')
    .map(record => record.replace(/^\s+/, ''))
    .filter(Boolean)
    .map(record => {
      const [commit, subject, at, body = ''] = record.split('\x1f');
      return { commit: commit.slice(0, 12), subject, at, studio: /^Studio-Integration: /m.test(body) };
    });
  return {
    studio: commits.filter(item => item.studio).length,
    hand: commits.filter(item => !item.studio).length,
    more: commits.length >= scannedCommits,
    commits: commits.slice(0, listedCommits),
  };
}
// The remote Push would use (origin, or the only one), with what it is known to have of each line.
async function remoteOf(root) {
  const remotes = (await gitAsync(root, ['remote'])).split('\n').filter(Boolean),
    name = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  if (!name) return null;
  return { name, url: safeUrl((await answer(gitAsync(root, ['remote', 'get-url', name]))) ?? '') };
}
async function lineOnRemote(root, remote, branch, head) {
  if (!remote) return null;
  const tracked = await answer(
    gitAsync(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote.name}/${branch}`]),
  );
  if (!tracked) return { known: false };
  const count = async range => Number(await gitAsync(root, ['rev-list', '--count', range]));
  const [ahead, behind] = await Promise.all([count(`${tracked}..${head}`), count(`${head}..${tracked}`)]);
  return { known: true, ahead, behind };
}

// A story as the page lists it: where it stands, whether it has started, its integration and carries, forward or
// brought back (`back`), with the stories whose carry to the same line one waits for (`after`).
function storyOf(store, task) {
  const review = task.sourceStage?.review?.attemptId
    ? tries(() => store.attempt(task.sourceStage.review.attemptId))
    : null;
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    started: store.attempts(task.id).some(attempt => (attempt.assignment?.kind || task.kind) === story),
    integration: review?.sourceIntegration?.state ?? null,
    carries: (review?.sourceCarries || []).map(carry => ({
      line: carry.line,
      state: carry.state,
      ...(carry.back ? { back: true } : {}),
      ...(carry.after?.length ? { after: carry.after.map(item => item.storyId) } : {}),
    })),
  };
}

export async function releaseOverview(store, projectId, runtime) {
  const project = store.project(projectId);
  if (!projectCatalog(store, runtime.registries, projectId).some(item => item.kind === story))
    return { available: false, reason: 'Only a project on the source workflow has releases.' };
  const root = projectSource(store, projectId, runtime).root;
  if (!root) return { available: false, reason: 'This project has no repository.' };
  // What git knows comes first, asked side by side; the records are read after it, at once, so they describe one moment.
  const [tags, copy, remote, status] = await Promise.all([
    releaseTagsAsync(root),
    checkedOutAsync(root),
    remoteOf(root),
    gitAsync(root, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const recorded = projectLines(project);
  // The branch releases ship to under version lines, beside the lines work lands on.
  const shipping = async () => {
    const head = await answer(branchCommitAsync(root, project.shipsTo));
    if (!head) return { branch: project.shipsTo, head: null, lastRelease: null, onRemote: null };
    const [last, onRemote] = await Promise.all([
      lastRelease(root, tags, head),
      lineOnRemote(root, remote, project.shipsTo, head),
    ]);
    return { branch: project.shipsTo, head: head.slice(0, 12), lastRelease: last, onRemote };
  };
  const [lines, shipsTo] = await Promise.all([
    Promise.all(
      (recorded.length ? recorded : copy ? [{ branch: copy, state: 'maintained' }] : [])
        .filter(line => line.branch !== project.shipsTo)
        .map(async (line, index, all) => {
          const head = await answer(branchCommitAsync(root, line.branch)),
            last = head ? await lastRelease(root, tags, head) : null,
            version = project.shipsTo ? /^release\/(\d+)\.(\d+)$/.exec(line.branch)?.slice(1) : null,
            [landedSince, onRemote] = head
              ? await Promise.all([landed(root, last?.name, head), lineOnRemote(root, remote, line.branch, head)])
              : [null, null];
          return {
            branch: line.branch,
            state: line.state ?? 'maintained',
            newest: index === all.length - 1,
            ...(line.from ? { from: line.from } : {}),
            ...(version
              ? {
                  version: version.join('.'),
                  released: tags.some(tag => compareVersions(tag.version, [...version.map(Number), 0]) === 0),
                }
              : {}),
            head: head ? head.slice(0, 12) : null,
            lastRelease: last,
            landed: landedSince,
            onRemote,
          };
        }),
    ),
    project.shipsTo ? shipping() : null,
  ]);
  const newest = lines.at(-1)?.branch ?? null,
    runs = store.runs(projectId),
    stories = store.tasks().filter(task => task.kind === story && recordProject(task) === projectId),
    runOf = task => runs.find(run => run.id === runIdOf(task)),
    milestoneOf = task => task.release?.milestoneId ?? runOf(task)?.release?.milestoneId ?? null;
  // The next release, by intake's own rule on the milestones as recorded, before the page fills in their lines.
  const recordedMilestones = projectMilestones(store, projectId),
    next = nextRelease(recordedMilestones, project.shipsTo);
  const milestones = recordedMilestones
    .slice()
    .sort((a, b) => compareVersions(a.version.split('.').map(Number), b.version.split('.').map(Number)))
    .map(milestone => {
      const ideas = runs
        .filter(run => run.release?.milestoneId === milestone.id)
        .map(run => {
          const own = stories.filter(task => runIdOf(task) === run.id);
          return {
            runId: run.id,
            idea: run.brief,
            at: run.createdAt ?? run.at ?? null,
            by: run.release.by?.type ?? null,
            stories: own.filter(task => milestoneOf(task) === milestone.id).map(task => storyOf(store, task)),
            movedOut: own
              .filter(task => milestoneOf(task) !== milestone.id)
              .map(task => ({ id: task.id, title: task.title, version: task.release?.version ?? null })),
          };
        });
      const movedIn = stories
        .filter(
          task => task.release?.milestoneId === milestone.id && runOf(task)?.release?.milestoneId !== milestone.id,
        )
        .map(task => storyOf(store, task));
      const all = [...ideas.flatMap(idea => idea.stories), ...movedIn];
      return {
        id: milestone.id,
        version: milestone.version,
        line:
          milestone.line ?? (milestone.state === 'released' ? milestone.release?.repository?.branch : null) ?? newest,
        goal: milestone.goal,
        state: milestone.state,
        ...(milestone.id === next?.id ? { next: true } : {}),
        waiting: milestone.waiting,
        ...(milestone.release ? { release: milestone.release } : {}),
        ideas,
        movedIn,
        counts: {
          ideas: ideas.length,
          waiting: milestone.waiting.length,
          stories: all.length,
          integrated: all.filter(item => item.integration === 'integrated').length,
          started: all.filter(item => item.started && item.integration !== 'integrated').length,
        },
      };
    });
  const readiness = project.shipsTo ? null : versionLinesReadiness(store, projectId, runtime, { copy });
  return {
    available: true,
    copy: {
      branch: copy,
      clean: !status,
    },
    remote,
    ...(project.shipsTo
      ? { shipsTo }
      : { versionLines: { shipsTo: readiness.shipsTo, ready: readiness.ready, needs: readiness.needs } }),
    lines,
    milestones,
    tags: tags
      .slice(-20)
      .reverse()
      .map(tag => tag.name),
  };
}
