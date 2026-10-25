// An idea's journey (the canvas's Idea board, v1.0 item 23): the stages from the director's idea to what shipped,
// its stories in order, what happened told in a few plain sentences a story, who worked on it and what landed, from
// the run's own tasks and attempts. Nothing here sends anything.
import type { AttemptSummary, Task } from './api';
import { plural, reviewOf, spoken, totalsOf } from './evidence';
import { workerName } from './names';
import { cliName, isSourceStory, standing, storySteps } from './story';
import { active, type GraphNode, type RunStory, type StudioState } from './studio-runs';

export type Tone = 'ok' | 'live' | 'you' | 'bad' | 'wait';
const checkKinds = ['studio-development:checks'];
const planKinds = ['studio-development:breakdown', 'general:plan'];
// Every step but the checks and the plan is one of the idea's stories: a source story, a work item, or any
// workflow's step.
const isStory = (kind?: string) => !checkKinds.includes(kind ?? '') && !planKinds.includes(kind ?? '');
const kindOf = (attempt?: AttemptSummary) => (attempt?.assignment as { kind?: string } | undefined)?.kind;
const isReview = (attempt?: AttemptSummary) =>
  ['studio-development:change-review', 'general:review'].includes(kindOf(attempt) ?? '');
const ms = (attempt: AttemptSummary, now = Date.now()) => {
  const recorded = attempt.executionTiming?.durationMs;
  if (typeof recorded === 'number' && recorded >= 0) return recorded;
  const start = Date.parse(String(attempt.startedAt ?? '')),
    end = attempt.finishedAt ? Date.parse(attempt.finishedAt) : now;
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
};
const commitOf = (attempt?: AttemptSummary) =>
  (attempt?.sourceIntegration as { repository?: { commit?: string } } | undefined)?.repository?.commit?.slice(0, 7);

// The run's records: its graph's nodes in order, the stories among them, and each task's attempts.
export function runRecords(run: RunStory, state: StudioState) {
  const nodes = (run.graph?.stages.flat() ?? []) as GraphNode[],
    tasks = new Map(state.tasks.filter(task => run.taskIds.includes(task.id)).map(task => [task.id, task])),
    attempts = (taskId: string) =>
      state.attempts
        .filter(attempt => attempt.taskId === taskId)
        .sort((a, b) => Date.parse(String(a.startedAt ?? '')) - Date.parse(String(b.startedAt ?? ''))),
    stories = nodes.filter(node => isStory(node.kind)).map(node => tasks.get(node.taskId)!);
  return { nodes, tasks, attempts, stories: stories.filter(Boolean) };
}

// A story is done when it is integrated, or for other work, accepted.
const storyDone = (task: Task) =>
  isSourceStory(task) ? task.sourceStage?.current === 'integrated' : task.status === 'done';

export interface JourneyStage {
  label: string;
  note: string;
  state: 'done' | 'live' | 'you' | 'bad' | 'todo';
  icon: 'check' | 'build' | 'flag' | 'send';
}

// Sent, then each kind of work in the order it ran, then Shipped.
export function journeyStages(run: RunStory, state: StudioState): JourneyStage[] {
  const { nodes, tasks, attempts, stories } = runRecords(run, state),
    stageOf = (kinds: string[]) =>
      nodes.filter(node => kinds.includes(node.kind ?? '')).map(node => tasks.get(node.taskId)!),
    stateOf = (group: Task[]): JourneyStage['state'] =>
      !group.length
        ? 'todo'
        : group.every(task => (isStory(task.kind) ? storyDone(task) : task.status === 'done'))
          ? 'done'
          : group.some(task => standing(task, state).tone === 'you')
            ? 'you'
            : group.some(task => active(task) || task.status === 'review')
              ? 'live'
              : group.some(task => ['failed', 'cancelled'].includes(task.status))
                ? 'bad'
                : group.some(task => task.lastAttemptId)
                  ? 'live'
                  : 'todo';
  const out: JourneyStage[] = [{ label: 'Sent', note: `You · ${clockOf(run.startedAt)}`, state: 'done', icon: 'send' }];
  const checks = stageOf(checkKinds).filter(Boolean);
  if (checks.length) {
    const attempt = attempts(checks[0]!.id).find(item => item.status === 'accepted') ?? attempts(checks[0]!.id).at(-1),
      totals = totalsOf(attempt);
    out.push({
      label: 'Checked',
      note: [workerName(state, checks[0]!.workerId), totals?.tests ? `${totals.pass} of ${totals.tests} passed` : '']
        .filter(Boolean)
        .join(' · '),
      state: stateOf(checks),
      icon: 'check',
    });
  }
  const plans = stageOf(planKinds).filter(Boolean);
  if (plans.length)
    out.push({
      label: 'Planned',
      note: [
        workerName(state, plans[0]!.workerId),
        stories.length ? `${stories.length} ${plural(stories.length, 'story', 'stories')}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      state: stateOf(plans),
      icon: 'check',
    });
  if (stories.length) {
    const done = stories.filter(storyDone).length,
      source = stories.some(isSourceStory);
    out.push({
      label: source ? 'Building' : 'Working',
      note: `${done} of ${stories.length} ${source ? 'integrated' : 'accepted'}`,
      state: stateOf(stories),
      icon: 'build',
    });
    const shipped = done === stories.length;
    out.push({
      label: source ? 'Shipped' : 'Done',
      note: shipped
        ? clockOf(lastFinish(stories.flatMap(task => attempts(task.id))))
        : stories.length > 1
          ? `when story ${stories.length} ${source ? 'integrates' : 'is accepted'}`
          : `when it ${source ? 'integrates' : 'is accepted'}`,
      state: shipped ? 'done' : 'todo',
      icon: 'flag',
    });
  }
  return out;
}

const lastFinish = (attempts: AttemptSummary[]) =>
  attempts
    .map(item =>
      String((item.sourceIntegration as { finishedAt?: string } | undefined)?.finishedAt ?? item.finishedAt ?? ''),
    )
    .filter(Boolean)
    .sort()
    .at(-1);

// The idea's title: its first sentence in the director's words, quoted, cut at a word if it runs long.
export function firstSentence(brief: string, length = 180) {
  const line = brief.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return '';
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line,
    text = sentence.length > length ? `${sentence.slice(0, length).replace(/\s+\S*$/, '')}…` : sentence;
  return `“${text}”`;
}

// "7:20 PM" today, the date before.
export function clockOf(value?: string | null, now = new Date()) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface JourneyStory {
  number: number;
  task: Task;
  chip: { tone: Tone; label: string };
  segments: ('done' | 'live' | 'you' | 'bad' | 'todo')[];
  foot: string;
  commit?: string;
  current: boolean;
}

// The idea's stories in order: each one's chip, its steps as segments, and a line about where it is.
export function journeyStories(run: RunStory, state: StudioState): JourneyStory[] {
  const { stories, attempts } = runRecords(run, state),
    current = stories.find(task => !storyDone(task) && !task.closed);
  let seenCurrent = false;
  return stories.map((task, index) => {
    const steps = storySteps(task, state),
      stand = standing(task, state),
      own = attempts(task.id),
      builds = own.filter(item => !isReview(item)),
      review = own.filter(isReview).at(-1),
      commit = commitOf(review),
      running = own.find(item => ['running', 'stopping'].includes(item.status)),
      isCurrent = task === current,
      after = index > 0 ? `Starts after story ${index}` : 'Starts first';
    if (isCurrent) seenCurrent = true;
    const live = steps.find(step => step.state === 'live');
    const chip: JourneyStory['chip'] = storyDone(task)
      ? { tone: 'ok', label: isSourceStory(task) ? 'Integrated' : 'Accepted' }
      : task.closed
        ? { tone: 'wait', label: 'Closed' }
        : stand.tone === 'you'
          ? { tone: 'you', label: stand.chip ?? 'Your call' }
          : live
            ? { tone: 'live', label: live.label.replace(/ ·.*$/, '') }
            : steps.some(step => step.state === 'bad')
              ? { tone: 'bad', label: 'Stopped' }
              : isCurrent || !seenCurrent
                ? { tone: 'wait', label: 'Next' }
                : { tone: 'wait', label: 'Later' };
    const foot = storyDone(task)
      ? clockOf(lastFinish(own))
      : running
        ? `Attempt ${builds.indexOf(running) + 1 || 1} of ${workerName(state, running.workerId)}'s · ${Math.max(1, Math.round(ms(running) / 60000))} min in`
        : stand.tone === 'you'
          ? 'Waiting for you'
          : task.lastAttemptId
            ? chip.label === 'Stopped'
              ? 'Stopped'
              : 'Waiting'
            : after;
    return {
      number: index + 1,
      task,
      chip,
      segments: steps.map(step => step.state),
      foot,
      ...(commit ? { commit } : {}),
      current: isCurrent,
    };
  });
}

export interface HappenedEntry {
  at: string;
  icon: 'send' | 'check' | 'merge' | 'pause' | 'play' | 'stop' | 'test' | 'note';
  tone: Tone;
  lead: string;
  text?: string;
  quote?: string;
  failures?: string[];
  links?: { label: string; attemptId: string; path: string }[];
  taskId?: string;
  // The commit an integration made, shown as a file chip.
  commit?: string;
  // A stop (a failure, a hold, a retry) or a decision (an approval, an integration, a close): what the
  // "Only stops and decisions" view keeps.
  stop?: boolean;
  decision?: boolean;
  live?: boolean;
}
export interface HappenedGroup {
  key: string;
  title: string;
  chip?: { tone: Tone; label: string };
  entries: HappenedEntry[];
}

const byTime = (a: HappenedEntry, b: HappenedEntry) => Date.parse(a.at) - Date.parse(b.at);
// Why an attempt stopped, in its own first line, cut at a word if it runs long.
const reason = (attempt: AttemptSummary) =>
  clip(
    String(attempt.error || attempt.result?.summary || attempt.status)
      .split('\n')[0]!
      .replace(/\.+$/, ''),
    220,
  );

// What happened, grouped: the checks and plan, then each story, each told in plain sentences.
export function happened(run: RunStory, state: StudioState): HappenedGroup[] {
  const { nodes, tasks, attempts, stories } = runRecords(run, state),
    storyList = journeyStories(run, state),
    first: HappenedEntry[] = [{ at: run.startedAt, icon: 'send', tone: 'wait', lead: 'You sent the idea.' }];
  for (const node of nodes.filter(item => !isStory(item.kind))) {
    const task = tasks.get(node.taskId);
    if (!task) continue;
    const who = workerName(state, task.workerId);
    for (const attempt of attempts(task.id)) {
      if (!attempt.finishedAt) {
        first.push({
          at: String(attempt.startedAt),
          icon: 'test',
          tone: 'live',
          lead: `${who} is working on it now.`,
          live: true,
        });
        continue;
      }
      if (!['accepted', 'review'].includes(attempt.status)) {
        first.push({
          at: attempt.finishedAt,
          icon: 'stop',
          tone: 'bad',
          lead: `${who} stopped:`,
          text: `${reason(attempt)}.`,
          stop: true,
          taskId: task.id,
        });
        continue;
      }
      const time = spoken(ms(attempt));
      if (checkKinds.includes(task.kind)) {
        const totals = totalsOf(attempt),
          files = (attempt.artifacts ?? []).filter(item =>
            ['check-report.json', 'test-output.txt'].includes(item.path),
          );
        first.push({
          at: attempt.finishedAt,
          icon: 'check',
          tone: 'ok',
          lead: `${who} checked the source:`,
          text: totals?.tests ? `${totals.pass} of ${totals.tests} tests passed in ${time}.` : `done in ${time}.`,
          links: files.map(item => ({
            label: item.path === 'check-report.json' ? 'Check report' : 'Test output',
            attemptId: attempt.id,
            path: item.path,
          })),
          taskId: task.id,
        });
      } else if (planKinds.includes(task.kind)) {
        const serial = stories.every(
          (story, index) => index === 0 || (story.dependencies ?? []).includes(stories[index - 1]!.id),
        );
        first.push({
          at: attempt.finishedAt,
          icon: 'check',
          tone: 'ok',
          lead: `${who} planned it as ${stories.length} ${plural(stories.length, 'story', 'stories')}`,
          text: `${stories.length > 1 && serial ? 'that run one after another, ' : ''}in ${time}.`,
          quote: attempt.result?.summary ? clip(attempt.result.summary, 320) : undefined,
          taskId: task.id,
        });
      } else
        first.push({
          at: attempt.finishedAt,
          icon: 'check',
          tone: 'ok',
          lead: `${who} finished`,
          text: `in ${time}.`,
          taskId: task.id,
        });
    }
  }
  // The stories' approvals, together when the director approved them at once.
  const approvals = stories
    .map(task => task.approval as { status?: string; decidedAt?: string; by?: { type?: string } } | undefined)
    .filter(approval => approval?.status === 'approved' && approval.decidedAt);
  if (approvals.length) {
    const byRules = approvals.every(approval => approval!.by?.type === 'policy');
    first.push({
      at: approvals
        .map(approval => approval!.decidedAt!)
        .sort()
        .at(-1)!,
      icon: 'check',
      tone: 'ok',
      lead:
        approvals.length === 1
          ? `The story was approved${byRules ? ' by your house rules' : ''}.`
          : `The ${approvals.length} stories were approved${byRules ? ' by your house rules' : ''}.`,
      decision: true,
    });
  }
  const groups: HappenedGroup[] = [{ key: 'plan', title: 'Checks and plan', entries: first.sort(byTime) }];
  for (const story of storyList) {
    const task = story.task,
      entries: HappenedEntry[] = [],
      own = attempts(task.id),
      builds = own.filter(item => !isReview(item));
    let previousCli = '';
    for (const attempt of own) {
      const who = workerName(state, attempt.workerId),
        number = builds.indexOf(attempt) + 1,
        cli = cliName(state, attempt);
      if (isReview(attempt)) {
        if (!attempt.finishedAt) {
          entries.push({
            at: String(attempt.startedAt),
            icon: 'test',
            tone: 'live',
            lead: `${who} is reviewing it now.`,
            live: true,
            taskId: task.id,
          });
          continue;
        }
        const { findings, notes, verdict } = reviewOf(attempt);
        entries.push(
          verdict === 'needs-work' || verdict === 'revise'
            ? {
                at: attempt.finishedAt,
                icon: 'stop',
                tone: 'you',
                lead: `${who} asked for changes:`,
                text: findings[0] ? clip(String(findings[0]), 200) : 'see the review.',
                stop: true,
                taskId: task.id,
              }
            : !['accepted', 'review'].includes(attempt.status)
              ? {
                  at: attempt.finishedAt,
                  icon: 'stop',
                  tone: 'bad',
                  lead: `${who}'s review stopped:`,
                  text: `${reason(attempt)}.`,
                  stop: true,
                  taskId: task.id,
                }
              : {
                  at: attempt.finishedAt,
                  icon: 'check',
                  tone: 'ok',
                  lead: `${who} passed the review`,
                  text: findings.length
                    ? `with ${findings.length} blocking ${plural(findings.length, 'finding')}.`
                    : notes.length
                      ? `with no blocking findings and ${notes.length} ${plural(notes.length, 'note')}.`
                      : 'with no blocking findings.',
                  taskId: task.id,
                },
        );
        const journal = attempt.sourceIntegration as
          | {
              state?: string;
              finishedAt?: string;
              startedAt?: string;
              error?: string;
              approvedBy?: { type?: string };
              repository?: { commit?: string };
            }
          | null
          | undefined;
        if (journal?.state === 'integrated')
          entries.push({
            at: String(journal.finishedAt ?? attempt.finishedAt),
            icon: 'merge',
            tone: 'ok',
            lead: 'Integrated',
            text: `${journal.approvedBy?.type === 'policy' ? 'by your house rules, after the passing review' : 'with your approval'}.`,
            decision: true,
            taskId: task.id,
          });
        else if (journal && ['rejected', 'abandoned', 'needs-reconciliation', 'restored'].includes(journal.state ?? ''))
          entries.push({
            at: String(journal.finishedAt ?? journal.startedAt ?? attempt.finishedAt),
            icon: 'stop',
            tone: 'bad',
            lead: `The integration ${String(journal.state).replace('-', ' ')}:`,
            text: journal.error ? `${clip(journal.error, 200)}` : 'nothing changed.',
            stop: true,
            taskId: task.id,
          });
        else if (journal && !journal.finishedAt)
          entries.push({
            at: String(journal.startedAt ?? attempt.finishedAt),
            icon: 'merge',
            tone: 'live',
            lead: 'Integrating now:',
            text: 'merging, formatting and running the full suite.',
            live: true,
            taskId: task.id,
          });
        continue;
      }
      if (number > 1)
        entries.push({
          at: String(attempt.startedAt),
          icon: 'play',
          tone: 'wait',
          lead: `Attempt ${number} started`,
          text: cli && cli !== previousCli && previousCli ? `on ${cli}.` : '',
          taskId: task.id,
        });
      previousCli = cli || previousCli;
      if (!attempt.finishedAt) {
        entries.push({
          at: String(attempt.startedAt),
          icon: 'test',
          tone: 'live',
          lead: `${who} is working on it now.`,
          live: true,
          taskId: task.id,
        });
        continue;
      }
      const hold = attempt.subscriptionHold as string | undefined;
      if (hold) {
        const reset = attempt.subscriptionReset as string | undefined;
        entries.push({
          at: attempt.finishedAt,
          icon: 'pause',
          tone: 'wait',
          lead: `Paused for ${cliName(state, undefined, hold) || hold}'s usage limit.`,
          text: `${reset ? `It resets at ${clockOf(reset)}; ` : ''}this attempt doesn't count against the story.`,
          stop: true,
          taskId: task.id,
        });
        continue;
      }
      if (['accepted', 'review'].includes(attempt.status)) {
        const totals = totalsOf(attempt);
        entries.push({
          at: attempt.finishedAt,
          icon: 'check',
          tone: 'ok',
          lead: `${who} ${isSourceStory(task) ? 'built' : 'finished'} it`,
          text: `in ${spoken(ms(attempt))}${totals?.tests ? `, and ${totals.pass} of ${totals.tests} tests passed` : ''}.`,
          taskId: task.id,
        });
        continue;
      }
      const tests = ((attempt.failedTests as { name?: string; file?: string }[] | undefined) ?? []).map(
        test => `${test.file ? `${test.file}: ` : ''}${test.name ?? ''}`,
      );
      entries.push({
        at: attempt.finishedAt,
        icon: 'stop',
        tone: 'bad',
        lead: `Attempt ${number} stopped:`,
        text: `${reason(attempt)}.`,
        failures: tests.slice(0, 3),
        stop: true,
        taskId: task.id,
      });
    }
    if (story.commit) {
      const merged = entries.find(entry => entry.lead === 'Integrated');
      if (merged) merged.commit = story.commit;
    }
    if (task.closed)
      entries.push({
        at: String((task.closed as { at?: string }).at ?? run.startedAt),
        icon: 'stop',
        tone: 'wait',
        lead: 'You closed it',
        text: 'without taking it further.',
        decision: true,
      });
    groups.push({ key: task.id, title: `Story ${story.number}`, chip: story.chip, entries: entries.sort(byTime) });
  }
  return groups;
}

const clip = (text: string, length: number) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1).replace(/\s+\S*$/, '')}…` : line;
};

export interface Worked {
  workerId: string;
  name: string;
  did: string;
  time: string;
}

// Who worked on the idea, what each did and for how long, in the order they first worked.
export function whoWorked(run: RunStory, state: StudioState): Worked[] {
  const { nodes, tasks, attempts, stories } = runRecords(run, state),
    work = new Map<string, { ms: number; live: boolean; did: Set<string>; first: number }>();
  const storyNumber = (taskId: string) => stories.findIndex(task => task.id === taskId) + 1;
  for (const node of nodes) {
    const task = tasks.get(node.taskId);
    if (!task) continue;
    for (const attempt of attempts(task.id)) {
      const id = attempt.workerId ?? task.workerId ?? '',
        entry = work.get(id) ?? {
          ms: 0,
          live: false,
          did: new Set<string>(),
          first: Date.parse(String(attempt.startedAt)),
        };
      entry.ms += ms(attempt);
      entry.live ||= !attempt.finishedAt;
      const kind = kindOf(attempt) ?? task.kind;
      entry.did.add(
        checkKinds.includes(kind)
          ? 'checks'
          : planKinds.includes(kind)
            ? 'plan'
            : isReview(attempt)
              ? `review:${storyNumber(task.id)}`
              : isStory(kind)
                ? `story:${storyNumber(task.id)}`
                : 'work',
      );
      work.set(id, entry);
    }
  }
  const numbers = (did: Set<string>, prefix: string) =>
    [...did]
      .filter(item => item.startsWith(prefix))
      .map(item => Number(item.slice(prefix.length)))
      .sort((a, b) => a - b);
  const list = (values: number[]) =>
    values.length > 1 ? `${values.slice(0, -1).join(', ')} and ${values.at(-1)}` : String(values[0] ?? '');
  return [...work.entries()]
    .sort((a, b) => a[1].first - b[1].first)
    .map(([workerId, entry]) => {
      const builds = numbers(entry.did, 'story:'),
        reviews = numbers(entry.did, 'review:');
      return {
        workerId,
        name: workerName(state, workerId),
        did: [
          entry.did.has('checks') ? 'checks' : '',
          entry.did.has('plan') ? 'plan' : '',
          builds.length ? `${plural(builds.length, 'story', 'stories')} ${list(builds)}` : '',
          reviews.length
            ? `${plural(reviews.length, 'review')} of ${plural(reviews.length, 'story', 'stories')} ${list(reviews)}`
            : '',
          entry.did.has('work') ? 'work' : '',
        ]
          .filter(Boolean)
          .join(', '),
        time: `${spoken(entry.ms)}${entry.live ? ' so far' : ''}`,
      };
    });
}

// The head's chip: what the idea is doing now.
export function journeyChip(run: RunStory, state: StudioState): { tone: Tone; label: string } {
  const stories = journeyStories(run, state),
    current = stories.find(story => story.current),
    open = !['Integrated', 'Finished', 'Stopped', 'Cancelled', 'Closed'].includes(run.outcome.label);
  if (!open)
    return {
      tone: run.outcome.tone === 'ok' ? 'ok' : run.outcome.tone === 'bad' ? 'bad' : 'wait',
      label: run.outcome.label,
    };
  if (run.needsYou.some(item => item.requiresDirector))
    return { tone: 'you', label: current ? `Your call · story ${current.number} of ${stories.length}` : 'Your call' };
  if (current)
    return {
      tone: current.chip.tone === 'live' ? 'live' : 'wait',
      label: `${stories.some(story => isSourceStory(story.task)) ? 'Building' : 'Working'} · story ${current.number} of ${stories.length}`,
    };
  return { tone: run.outcome.tone === 'busy' ? 'live' : 'wait', label: run.outcome.label };
}
