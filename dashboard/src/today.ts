// Today's words and figures (the canvas's Today, v1.0 item 23), from the records a project's tab already holds:
// the page's sentence and the line under it, each agent's face and what it last did, and what shipped today.
import type { AttemptSummary, Task, Worker } from './api';
import { CLASSIC, pickNew, type AgentLook } from './design/agent-kit.js';
import { openPhaseOf, reviewOf, testingPhases } from './evidence';
import { workerName } from './names';
import { active, type RunStory, type StudioState } from './studio-runs';

const numbers = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
// "Three", or 12; in a sentence's middle, "three".
export const counted = (count: number, lower = false) => {
  const word = numbers[count] ?? String(count);
  return lower ? word.toLowerCase() : word;
};
const plural = (count: number, one: string, many = one + 's') => (count === 1 ? one : many);

export const dayLine = (now = new Date()) =>
  now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
export const greeting = (now = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? 'Morning.' : hour < 18 ? 'Afternoon.' : 'Evening.';
};
// "Three calls are yours to make." On a phone the sentence is shorter: "Three calls are yours."
export function callsTitle(calls: number, short = false) {
  if (!calls) return 'Nothing needs you right now.';
  return `${counted(calls)} ${plural(calls, 'call is', 'calls are')} yours${short ? '' : ' to make'}.`;
}

// The time a call or a step happened: the clock today, the date before.
export function when(value: string | null | undefined, now = new Date()) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// An idea in the director's own words, cut at a word near the length given.
export function quoted(text: string, length = 72) {
  const line = text.trim().split('\n')[0] ?? '';
  if (line.length <= length) return line === text.trim() ? `“${line}”` : `“${line}…”`;
  const cut = line.slice(0, length).replace(/\s+\S*$/, '');
  return `“${cut || line.slice(0, length)}…”`;
}

// The idea a task belongs to, and where it sits among that idea's stories.
export function placeIn(stories: RunStory[], task: Task) {
  const run = stories.find(story => story.taskIds.includes(task.id));
  if (!run) return null;
  const stories_ = (run.graph?.stages.flat() ?? []).filter(node =>
    ['studio-development:change', 'general:work'].includes(node.kind ?? ''),
  );
  const index = stories_.findIndex(node => node.taskId === task.id);
  return { run, index: index + 1, total: stories_.length };
}

const doing: Record<string, string> = {
  'studio-development:checks': 'running the source checks for',
  'studio-development:breakdown': 'breaking down',
  'studio-development:change': 'working on',
  'studio-development:change-review': 'reviewing',
  'general:plan': 'planning',
  'general:work': 'working on',
  'general:review': 'reviewing',
};

// The line under Today's sentence: who is working on what and what waits behind it, then what shipped today.
export function floorSentence(state: StudioState, stories: RunStory[], shipped: number) {
  const running = state.tasks.filter(active),
    newest = [...stories].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0],
    sentences: string[] = [];
  const first = running[0];
  if (first) {
    const place = placeIn(stories, first),
      idea = !place
        ? null
        : place.run.id === newest?.id
          ? 'your latest idea'
          : `your idea ${quoted(place.run.brief, 40)}`,
      attempt = state.attempts.find(item => item.taskId === first.id && ['running', 'stopping'].includes(item.status)),
      verb = testingPhases.includes(openPhaseOf(attempt) ?? '')
        ? 'running the tests on'
        : (doing[first.kind] ?? 'working on'),
      what =
        place && idea
          ? place.index > 0 && verb !== 'breaking down'
            ? `story ${place.index} of ${idea}`
            : idea
          : `“${first.title}”`;
    let sentence = `${workerName(state, first.workerId)} is ${verb} ${what}`;
    const behind = place
      ? place.run.taskIds.filter(id => {
          const task = state.tasks.find(item => item.id === id);
          return task && task.id !== first.id && !active(task) && ['ready', 'backlog'].includes(task.status);
        }).length
      : 0;
    if (behind) sentence += `, and ${counted(behind, true)} ${plural(behind, 'story waits', 'stories wait')} behind it`;
    sentences.push(sentence + '.');
    if (running.length > 1)
      sentences.push(
        `${counted(running.length - 1)} more ${plural(running.length - 1, 'agent is', 'agents are')} working.`,
      );
  } else
    sentences.push(
      state.paused || state.project.dispatchPaused
        ? 'Nothing is running, and new work is paused.'
        : 'Nothing is running right now.',
    );
  if (shipped) sentences.push(`${counted(shipped)} ${plural(shipped, 'idea')} shipped today.`);
  return sentences.join(' ');
}

// Every agent's face: the look the director chose for it, otherwise the one it was given (today's agents by name,
// others picked by the agent kit from the project and the agent, at least three parts away from the agents before
// it). The picks are made from the given faces alone, so choosing one agent's face never changes another's.
export function agentLooks(projectId: string, workers: Worker[]) {
  const looks = new Map<string, AgentLook>(),
    taken: AgentLook[] = [];
  for (const worker of workers) {
    // A page may list an agent twice (the project's agents, then every agent on this computer); the first counts.
    if (looks.has(worker.id)) continue;
    const given =
      CLASSIC.find(agent => agent.name === worker.displayName)?.look ?? pickNew(`${projectId}#${worker.id}`, taken);
    looks.set(worker.id, worker.look ?? given);
    taken.push(given);
  }
  return looks;
}

// The face the kit gives an agent when the director has chosen none, which Use the picked face goes back to.
export function givenLook(projectId: string, workers: Worker[], workerId: string) {
  return agentLooks(
    projectId,
    workers.map(worker => ({ ...worker, look: undefined })),
  ).get(workerId);
}

const stoppedStatuses = ['failed', 'blocked', 'interrupted', 'quarantined', 'uncertain', 'cancelled'];

// What an agent last finished, in a few words, from the attempts the tab holds: "Passed story 1".
export function lastDone(state: StudioState, stories: RunStory[], worker: Worker) {
  const attempt = state.attempts
    .filter(item => item.workerId === worker.id && item.finishedAt && !['running', 'stopping'].includes(item.status))
    .sort((a, b) => Date.parse(String(b.finishedAt)) - Date.parse(String(a.finishedAt)))[0];
  if (!attempt) return null;
  const task = state.tasks.find(item => item.id === attempt.taskId),
    kind = (attempt.assignment as { kind?: string } | undefined)?.kind ?? task?.kind ?? '',
    totals = (attempt.testEvidence as { totals?: { tests?: number; pass?: number } } | undefined)?.totals,
    proposed = (task?.proposedTaskIds as string[] | undefined)?.length ?? 0,
    place = task ? placeIn(stories, task) : null,
    title = task?.title ?? attempt.taskId,
    story =
      place && place.index > 0
        ? `story ${place.index}`
        : `“${title.length > 36 ? title.slice(0, 35).replace(/\s+\S*$/, '') + '…' : title}”`,
    { verdict } = reviewOf(attempt);
  // An attempt that stopped, a restart's among them, did not finish anything.
  const words = stoppedStatuses.includes(attempt.status)
    ? `Stopped on ${story}`
    : kind === 'studio-development:checks' && totals?.tests
      ? `${totals.pass} of ${totals.tests} checks passed`
      : kind === 'studio-development:breakdown' && proposed
        ? `Planned your idea into ${proposed} ${plural(proposed, 'story', 'stories')}`
        : kind.endsWith('review') && verdict === 'pass'
          ? `Passed ${story}`
          : kind.endsWith('review') && verdict === 'needs-work'
            ? `Asked for changes to ${story}`
            : `Finished ${story}`;
  return { words, at: String(attempt.finishedAt) };
}

// The ideas that shipped today, newest first: a code idea when its last story integrated today (its outcome
// Integrated), other work when it finished and its last result was accepted today (the fresh install, October 24:
// an accepted guide never showed). `results` counts other work's accepted results, not its planning, checks or
// reviews; a code idea that finished without integrating shipped nothing.
const supporting = /:(plan|breakdown|checks|review|change-review)$/;
export function shippedToday(stories: RunStory[], attempts: AttemptSummary[], now = new Date()) {
  const seen = new Set<string>();
  return stories
    .filter(
      story =>
        !seen.has(story.id) &&
        seen.add(story.id) &&
        (story.outcome.tone === 'ok' || story.outcome.label === 'Finished'),
    )
    .map(story => {
      const integrations = attempts
        .filter(attempt => story.taskIds.includes(attempt.taskId) && attempt.sourceIntegration?.state === 'integrated')
        .map(attempt => attempt.sourceIntegration as { finishedAt?: string; repository?: { commit?: string } })
        .sort((a, b) => Date.parse(a.finishedAt ?? '') - Date.parse(b.finishedAt ?? ''));
      const accepted = attempts
          .filter(attempt => story.taskIds.includes(attempt.taskId) && attempt.acceptedAt)
          .sort((a, b) => Date.parse(a.acceptedAt ?? '') - Date.parse(b.acceptedAt ?? '')),
        commits = integrations
          .map(item => item.repository?.commit?.slice(0, 7))
          .filter((commit): commit is string => !!commit),
        kinds = accepted.map(attempt => String((attempt.assignment as { kind?: string } | undefined)?.kind)),
        code = kinds.some(kind => kind.startsWith('studio-development:')),
        made = new Set(accepted.filter((_, index) => !supporting.test(kinds[index]!)).map(attempt => attempt.taskId));
      return {
        story,
        commits,
        results: commits.length || code ? 0 : made.size,
        at: commits.length ? (integrations.at(-1)?.finishedAt ?? null) : (accepted.at(-1)?.acceptedAt ?? null),
      };
    })
    .filter(
      item =>
        (item.commits.length || item.results) && item.at && new Date(item.at).toDateString() === now.toDateString(),
    )
    .sort((a, b) => Date.parse(b.at ?? '') - Date.parse(a.at ?? ''));
}
