// The planner's suggestions on releases (1.1 step 2b, Decision MP-028, narrowed by MP-032 on October 26). A breakdown
// may say a story belongs on another release, with its reason. Only the director picks a release, so the controller
// moves no story, makes no milestone or line and starts no intake: it notes each suggestion on the breakdown, and the
// director may move the story from its release chip until it starts.
import fs from 'node:fs';
import { artifactPath } from './artifacts.mjs';
import { recordProject } from './projects.mjs';
import { runIdOf } from './graph.mjs';

// The planner's reason as a clause, without its closing stop, so a sentence ends once.
const said = reason => (reason ? `: ${reason.trim().replace(/[.!?]+$/, '')}` : '');

// Called when a breakdown is accepted. Each accepted attempt is noted once (releasesRouted), so a repeated acceptance
// call notes nothing twice.
export function noteReleaseSuggestions(store, task) {
  const attempt = store.attempt(task.acceptedAttemptId),
    release = store.run(runIdOf(task))?.release,
    report = JSON.parse(fs.readFileSync(artifactPath(store, attempt, 'source-breakdown.json'))),
    suggested = report.stories.filter(story => story.release !== undefined && story.release !== release?.version);
  if (!suggested.length || task.releasesRouted === attempt.id) return;
  store.putTask({ ...store.task(task.id), releasesRouted: attempt.id });
  const stays = release ? `${release.version}, this idea's release` : "this idea's line";
  for (const story of suggested)
    store.event(
      'release_planned',
      task.id,
      attempt.id,
      `The planner suggested ${story.release} for “${story.title}”${said(story.releaseReason)}. It stays on ${stays}; only the director moves a story to another release, from its release chip.`,
      recordProject(task),
    );
}
