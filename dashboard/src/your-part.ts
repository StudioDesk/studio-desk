// Your part in a story's Activity (the build plan's area 16; the director, October 24: "The activity stream
// doesn't show any of the user input so right now it feels very static"): the idea you sent, what you approved,
// sent back, changed, allowed and accepted, as your own messages, and what a house rule did for you, as quiet
// lines, from the events the controller recorded for the story and the instructions you published while it ran.
// Most of these kinds only the director records; where a house rule can act too, its wording names it ("…
// autonomy policy revision N …"). The controller's own events (started, integrated) stay out of these.
import type { LogEvent, StoryActivity } from './api';

export interface Part {
  key: string;
  at: string;
  by: 'you' | 'rule';
  // What happened, in a few words: "Sent it back for another attempt".
  lead: string;
  // Your own words with it (a note, a reason, the idea), or the house rule's reason.
  words?: string;
  files?: { path: string; kind: 'file' | 'add' | 'del' }[];
  commands?: string[];
  // Under the story's Integration heading rather than among its attempts.
  integration?: boolean;
  // The idea's page, for the idea you sent.
  runId?: string;
  // The attempt it started, which it goes before: an attempt past the limit is recorded just after it starts.
  opens?: string;
}

export interface Names {
  // What the page calls the work: a story, or a task.
  noun: string;
  worker: (id?: string) => string;
  team: (id: string) => string;
  // What an attempt was: a story's build or its review, or the attempt of other work.
  step: (attemptId: string | null) => 'build' | 'review' | 'attempt';
}

const rule = /autonomy policy revision \d+/i;
// The policy's reason after its name: "Accepted by autonomy policy revision 6: Independent review passed."
const reasonOf = (message: string) => message.replace(/^.*?autonomy policy revision \d+:?\s*/i, '').trim();
const pathLists: [string, 'file' | 'add' | 'del'][] = [
  ['Files', 'file'],
  ['New files', 'add'],
  ['Delete', 'del'],
];

// A story edit's message: your reason, then the paths each list gained or lost, then where the next attempt
// starts. Paths hold dots, so a list runs to the next list's label or the end, not to the first full stop.
function storyEdit(message: string) {
  const rest = message.slice(message.indexOf(': ') + 2).replace(/\s*The next attempt continues from \S+\.$/, ''),
    label = / (?=(?:Files|New files|Delete) (?:added|removed): )/,
    [reason = '', ...lists] = (' ' + rest).split(label),
    files: Part['files'] = [];
  let removed = 0;
  for (const list of lists) {
    const match = /^(Files|New files|Delete) (added|removed): (.*)\.$/.exec(list.trim());
    if (!match) continue;
    const paths = match[3]!.split(', ').filter(Boolean);
    if (match[2] === 'removed') removed += paths.length;
    else files.push(...paths.map(path => ({ path, kind: pathLists.find(([name]) => name === match[1])![1] })));
  }
  const words = [reason.trim(), removed ? `${removed} ${removed === 1 ? 'path' : 'paths'} taken off.` : '']
    .filter(Boolean)
    .join(' ');
  return { words: words || undefined, files };
}

function fromEvent(event: LogEvent, names: Names): Omit<Part, 'key' | 'at'> | null {
  const { kind, message } = event,
    policy = rule.test(message),
    step = names.step(event.attempt_id);
  switch (kind) {
    case 'created':
      // "Assigned the title to Eli.", which only the director does.
      return { by: 'you', lead: `Assigned it to ${/^.* to ([^.]+)\.$/.exec(message)?.[1] ?? 'an agent'}` };
    case 'plan_requested':
      return { by: 'you', lead: 'Asked for a plan' };
    case 'plan_approved': {
      const count = /approved (\d+)/.exec(message)?.[1];
      return { by: 'you', lead: count ? `Approved the plan's ${count} assignments` : 'Approved the plan' };
    }
    case 'work_approved':
      if (policy) return { by: 'rule', lead: `Approved this ${names.noun}`, words: reasonOf(message) };
      return {
        by: 'you',
        lead: /passed the gate/.test(message) ? 'Let the run go on past its gate' : `Approved this ${names.noun}`,
      };
    case 'work_denied':
      return {
        by: 'you',
        lead: `Turned this ${names.noun} down`,
        words: message === 'Director denied this work.' ? undefined : message,
      };
    case 'work_closed':
      return {
        by: 'you',
        lead: `Closed this ${names.noun}`,
        words: message.replace(/^Director closed this work:\s*/, '') || undefined,
      };
    case 'sent_back': {
      const note = / Note: ([\s\S]*)$/.exec(message)?.[1]?.trim();
      return {
        by: 'you',
        lead: `Sent it back for another attempt${/over a passing review/.test(message) ? ' over a passing review' : ''}`,
        words: note || undefined,
      };
    }
    case 'revision':
      return { by: 'you', lead: 'Asked for changes', words: message.trim() || undefined };
    case 'story_edited': {
      const edit = storyEdit(message);
      if (policy) return { by: 'rule', lead: 'Gave it the files it asked for', files: edit.files };
      return {
        by: 'you',
        lead: /approving the file request/.test(message)
          ? 'Gave it the files it asked for'
          : "Changed the story's files",
        ...edit,
      };
    }
    case 'accepted': {
      const what = step === 'build' ? 'the build' : step === 'review' ? 'the review' : 'the result';
      if (policy) return { by: 'rule', lead: `Accepted ${what}`, words: reasonOf(message) };
      return { by: 'you', lead: `Accepted ${what}` };
    }
    case 'integration_requested':
      if (policy)
        return {
          by: 'rule',
          lead: 'Approved the integration',
          // The rule by its name: "(Integrate after a passing review: independent review … passed)".
          words: /\(([^:()]+)/.exec(message)?.[1]?.trim(),
          integration: true,
        };
      return { by: 'you', lead: 'Approved the integration', integration: true };
    case 'integration_created':
      return { by: 'you', lead: 'Asked for this integration', integration: true };
    case 'commands_approved': {
      const list = message.replace(/^[^:]*:\s*/, '').replace(/\.$/, '');
      return {
        by: 'you',
        lead: 'Allowed these commands for Claude agents',
        commands: list.split(', ').filter(Boolean),
      };
    }
    case 'attempt_limit_override': {
      const [, number, limit] = /attempt (\d+), past the (\d+)-attempt limit/.exec(message) ?? [];
      return {
        by: 'you',
        lead: number
          ? `Started attempt ${number}, past its limit of ${limit}`
          : 'Started another attempt past its limit',
        opens: event.attempt_id ?? undefined,
      };
    }
    case 'task_updated':
      return { by: 'you', lead: 'Changed how its next attempts run' };
    case 'autonomy_retry': {
      // An attempt that did not pass, run again with the reason ("Automatic retry: …"), or a new task that
      // retries work an independent review sent back ("Automatic retry of T-1 after review T-2.").
      const reason = /^Automatic retry: ([\s\S]+)$/.exec(message)?.[1]?.trim();
      if (!reason) return { by: 'rule', lead: 'Tried it again after the review' };
      return {
        by: 'rule',
        lead:
          step === 'review'
            ? 'Started the review again'
            : step === 'build'
              ? 'Started the build again'
              : 'Tried it again',
        words: reason,
      };
    }
    default:
      return null;
  }
}

// Long words in a few lines, cut at a word and without the stop or comma before the cut.
export function clip(text: string, length = 480) {
  const whole = text.trim();
  if (whole.length <= length) return whole;
  return `${(whole.slice(0, length).replace(/\s+\S*$/, '') || whole.slice(0, length)).replace(/[\s,;:.]+$/, '')}…`;
}

const scopeName = (item: StoryActivity['instructions'][number], names: Names) =>
  item.scope === 'company'
    ? "the company's instructions"
    : item.scope === 'team'
      ? `${names.team(item.id)}'s instructions`
      : `${names.worker(item.id)}'s instructions`;

// Your part and the house rules', oldest first.
export function yourPart(activity: StoryActivity | undefined, names: Names): Part[] {
  if (!activity) return [];
  const parts: Part[] = [];
  if (activity.idea?.createdAt)
    parts.push({
      key: `idea-${activity.idea.runId}`,
      at: activity.idea.createdAt,
      by: 'you',
      lead: 'Sent the idea',
      words: activity.idea.brief.trim() || undefined,
      files: activity.idea.files.map(path => ({ path, kind: 'file' })),
      runId: activity.idea.runId,
    });
  for (const event of activity.events) {
    const part = fromEvent(event, names);
    if (part) parts.push({ key: `e${event.seq}`, at: event.time, ...part });
  }
  for (const item of activity.instructions)
    parts.push({
      key: `i-${item.scope}-${item.id}-${item.revision}`,
      at: item.publishedAt,
      by: 'you',
      lead: `Published ${scopeName(item, names)}, revision ${item.revision}`,
      words: item.note && item.note !== 'Published by director' ? item.note : undefined,
    });
  return parts.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
