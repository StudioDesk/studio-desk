// The planner's call on releases (1.1 step 2b, Decision MP-028). A breakdown may give each story the release it belongs
// on. When the director did not choose the idea's release, the planner's call wins, and linked stories share one. A
// story whose release is another milestone on the line its idea was checked on moves to that milestone. Stories whose
// release is on another line leave this idea: the controller denies their proposals here, with the reason, and starts a
// new intake on that line, checked and planned there. A release the director chose, or one the planner chose for a
// follow-up intake, is never moved; a different suggestion is only noted. The controller makes a release that does not
// exist yet, with its line.
import fs from 'node:fs';
import { artifactPath } from './artifacts.mjs';
import { recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';
import { denyWork } from './proposals.mjs';
import { startIdeaIntake } from './idea-intake.mjs';
import {
  makeMilestone,
  milestoneTarget,
  parseVersion,
  projectMilestones,
  releaseTags,
} from '../connectors/source-milestones.mjs';
import { projectLine, projectLines } from '../connectors/source-lines.mjs';

// Linked stories, as groups joined by their dependencies either way, in the breakdown's order.
function linkedGroups(stories) {
  const group = new Map(stories.map(story => [story.key, story.key])),
    find = key => (group.get(key) === key ? key : find(group.get(key)));
  for (const story of stories) for (const key of story.dependencies) group.set(find(story.key), find(key));
  const groups = new Map();
  for (const story of stories) groups.set(find(story.key), [...(groups.get(find(story.key)) || []), story]);
  return [...groups.values()];
}
const titles = group => group.map(story => `“${story.title}”`).join(', ');
// The planner's reason as a clause, without its closing stop, so a sentence ends once.
const said = reason => (reason ? `: ${reason.trim().replace(/[.!?]+$/, '')}` : '');
// The new intake's words: the idea, and the part of it the planner moved.
function movedBrief(original, group, version, reason) {
  const part = group.map(story => `- ${story.title}: ${story.scope.slice(0, 600)}`).join('\n');
  return `${String(original).slice(0, 1500)}\n\nThe planner moved this part of the idea to release ${version}${
    reason ? ` (${reason.slice(0, 300)})` : ''
  }. Plan only this part:\n${part}`.slice(0, 4000);
}

// Called when a breakdown is accepted, before the policy approves what it proposed. Each accepted attempt is routed
// once (releasesRouted), so a repeated acceptance call starts no second intake.
export function routeBreakdownReleases(store, runtime, task) {
  const attempt = store.attempt(task.acceptedAttemptId),
    projectId = recordProject(task),
    report = JSON.parse(fs.readFileSync(artifactPath(store, attempt, 'source-breakdown.json'))),
    suggested = report.stories.filter(story => story.release !== undefined);
  if (!suggested.length || task.releasesRouted === attempt.id) return;
  store.putTask({ ...store.task(task.id), releasesRouted: attempt.id });
  const run = store.run(runIdOf(task)),
    chosen = run?.release,
    note = message => store.event('release_planned', task.id, attempt.id, message, projectId);
  if (['director', 'planner'].includes(chosen?.by?.type)) {
    for (const story of suggested.filter(story => story.release !== chosen.version))
      note(
        `The planner suggested ${story.release} for “${story.title}”${said(story.releaseReason)}. ${
          chosen.by.type === 'director' ? 'The director chose' : 'The planner had already chosen'
        } ${chosen.version} for this idea, which stays.`,
      );
    return;
  }
  const checks = store.attempt(attempt.sourceBreakdown.attemptId).sourceCheck,
    root = checks.root,
    staged = new Map(
      store
        .tasks()
        .filter(item => item.proposalReference?.attemptId === attempt.id && recordProject(item) === projectId)
        .map(item => [item.proposalReference.key, item]),
    );
  const stays = chosen ? `stay on ${chosen.version}` : "stay on the idea's release";
  for (const group of linkedGroups(report.stories)) {
    const releases = [...new Set(group.filter(story => story.release !== undefined).map(story => story.release))],
      reason = group.find(story => story.releaseReason)?.releaseReason;
    if (!releases.length || (releases.length === 1 && releases[0] === chosen?.version)) continue;
    if (releases.length > 1) {
      note(
        `The planner put linked stories ${titles(group)} on ${releases.join(' and ')}; linked stories share a release, so they ${stays}.`,
      );
      continue;
    }
    const version = releases[0];
    let target;
    try {
      const existing = projectMilestones(store, projectId).find(item => item.version === version);
      if (existing && existing.state !== 'open') throw new Error(`${version} is released.`);
      target = existing
        ? { line: existing.line }
        : milestoneTarget(root, projectLines(store.project(projectId)), parseVersion(version), releaseTags(root));
    } catch (error) {
      note(
        `The planner suggested ${version} for ${titles(group)}, which cannot be used: ${error.message} They ${stays}.`,
      );
      continue;
    }
    // Both lines are read after the milestone is made, which may have added the project's first lines.
    const by = { type: 'planner', taskId: task.id, ...(reason ? { reason } : {}) },
      milestone = makeMilestone(store, projectId, runtime, { version, by }),
      line = projectLine(store, projectId, target.line ?? undefined),
      ideaLine = projectLine(store, projectId, checks.base?.branch);
    if (line === ideaLine) {
      for (const story of group) {
        const item = staged.get(story.key);
        if (!item || item.release || store.attempts(item.id).length) continue;
        item.release = {
          milestoneId: milestone.id,
          version,
          by,
          at: new Date().toISOString(),
          ...(line !== undefined ? { line } : {}),
        };
        store.putTask(item);
      }
      note(`The planner put ${titles(group)} on ${version}${said(reason)}.`);
      continue;
    }
    // Another line: these stories leave this idea for a new intake there, checked and planned on that line.
    const started = startIdeaIntake(store, runtime.registries, runtime, {
      projectId,
      idea: movedBrief(run?.brief ?? report.summary, group, version, reason),
      milestone: milestone.id,
      releaseBy: { ...by, ...(run ? { runId: run.id } : {}) },
    });
    for (const story of group) {
      const item = staged.get(story.key);
      if (item?.status !== 'backlog' || item.approval?.status !== 'pending') continue;
      denyWork(
        store,
        item,
        `Moved to ${version} by the planner${said(reason)}. Idea run ${started.runId} checks and plans it on ${line}.`,
      );
      store.putTask({ ...store.task(item.id), movedTo: { version, line, runId: started.runId } });
    }
    note(
      `The planner moved ${titles(group)} to ${version} on ${line}${said(reason)}. Idea run ${started.runId} checks and plans ${
        group.length === 1 ? 'it' : 'them'
      } there.`,
    );
  }
}
