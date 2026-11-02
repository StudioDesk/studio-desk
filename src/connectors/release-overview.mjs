// What a project's Releases page shows (1.1 step 6, Decision MP-028), read without changing anything: each release line
// with its last release and what landed on it since, each milestone with its ideas, their stories and the ideas waiting
// in it, the director's own copy, and what the remote is known to have. Only the controller's records and the local
// repository are read; nothing reaches the remote, so "on the remote" means as of the last fetch or push.
import { git } from './source-integration.mjs';
import { branchCommit, checkedOut, projectLines } from './source-lines.mjs';
import {
  compareVersions,
  projectMilestones,
  releaseTags,
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
// A remote's address without any user name or token in it.
const safeUrl = url => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');

// The newest release tag the line's tip contains.
function lastRelease(root, tags, head) {
  for (const tag of [...tags].reverse())
    if (tries(() => (git(root, ['merge-base', '--is-ancestor', `${tag.name}^{commit}`, head]), true)))
      return { name: tag.name, version: versionText(tag.version) };
  return null;
}
// The commits on a line since its last release, newest first: the studio's (integrations, carries and releases, which
// carry its trailer) and the rest, made by hand.
function landed(root, since, head) {
  const range = since ? `${since}^{commit}..${head}` : head,
    out = git(root, ['log', `-${scannedCommits}`, '--format=%H%x1f%s%x1f%cI%x1f%b%x1e', range], { raw: true });
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
function remoteOf(root) {
  const remotes = git(root, ['remote']).split('\n').filter(Boolean),
    name = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null;
  if (!name) return null;
  return { name, url: safeUrl(tries(() => git(root, ['remote', 'get-url', name])) ?? '') };
}
function lineOnRemote(root, remote, branch, head) {
  if (!remote) return null;
  const tracked = tries(() => git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote.name}/${branch}`]));
  if (!tracked) return { known: false };
  const count = range => Number(git(root, ['rev-list', '--count', range]));
  return { known: true, ahead: count(`${tracked}..${head}`), behind: count(`${head}..${tracked}`) };
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

export function releaseOverview(store, projectId, runtime) {
  const project = store.project(projectId);
  if (!projectCatalog(store, runtime.registries, projectId).some(item => item.kind === story))
    return { available: false, reason: 'Only a project on the source workflow has releases.' };
  const root = projectSource(store, projectId, runtime).root;
  if (!root) return { available: false, reason: 'This project has no repository.' };
  const tags = releaseTags(root),
    copy = checkedOut(root),
    remote = remoteOf(root),
    recorded = projectLines(project),
    lines = (recorded.length ? recorded : copy ? [{ branch: copy, state: 'maintained' }] : [])
      .filter(line => line.branch !== project.shipsTo)
      .map((line, index, all) => {
        const head = tries(() => branchCommit(root, line.branch)),
          last = head ? lastRelease(root, tags, head) : null,
          version = project.shipsTo ? /^release\/(\d+)\.(\d+)$/.exec(line.branch)?.slice(1) : null;
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
          landed: head ? landed(root, last?.name, head) : null,
          onRemote: head ? lineOnRemote(root, remote, line.branch, head) : null,
        };
      });
  const newest = lines.at(-1)?.branch ?? null,
    runs = store.runs(projectId),
    stories = store.tasks().filter(task => task.kind === story && recordProject(task) === projectId),
    runOf = task => runs.find(run => run.id === runIdOf(task)),
    milestoneOf = task => task.release?.milestoneId ?? runOf(task)?.release?.milestoneId ?? null;
  const milestones = projectMilestones(store, projectId)
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
  const shippingHead = project.shipsTo ? tries(() => branchCommit(root, project.shipsTo)) : null,
    readiness = project.shipsTo ? null : versionLinesReadiness(store, projectId, runtime);
  return {
    available: true,
    copy: {
      branch: copy,
      clean: !git(root, ['status', '--porcelain', '--untracked-files=no']),
    },
    remote,
    ...(project.shipsTo
      ? {
          shipsTo: {
            branch: project.shipsTo,
            head: shippingHead ? shippingHead.slice(0, 12) : null,
            lastRelease: shippingHead ? lastRelease(root, tags, shippingHead) : null,
            onRemote: shippingHead ? lineOnRemote(root, remote, project.shipsTo, shippingHead) : null,
          },
        }
      : { versionLines: { shipsTo: readiness.shipsTo, ready: readiness.ready, needs: readiness.needs } }),
    lines,
    milestones,
    tags: tags
      .slice(-20)
      .reverse()
      .map(tag => tag.name),
  };
}
