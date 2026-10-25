// Today's words and figures: the title's count, quoted ideas, times, agents' faces and what shipped today.
import { expect, test } from 'vitest';
import type { AttemptSummary, Task, Worker } from './api';
import { CLASSIC } from './design/agent-kit.js';
import type { RunStory, StudioState } from './studio-runs';
import { agentLooks, callsTitle, lastDone, quoted, shippedToday, when } from './today';

test('the title counts the calls in words, shorter on a phone', () => {
  expect(callsTitle(0)).toBe('Nothing needs you right now.');
  expect(callsTitle(1)).toBe('One call is yours to make.');
  expect(callsTitle(3)).toBe('Three calls are yours to make.');
  expect(callsTitle(3, true)).toBe('Three calls are yours.');
  expect(callsTitle(12)).toBe('12 calls are yours to make.');
});

test('an idea is quoted in its own words, cut at a word', () => {
  expect(quoted('Show the runs page.')).toBe('“Show the runs page.”');
  expect(quoted("I can't read what a step produced without opening each file one at a time", 40)).toBe(
    "“I can't read what a step produced…”",
  );
  expect(quoted('First line\nmore detail')).toBe('“First line…”');
});

test('a time today is the clock, and an earlier one the date', () => {
  const now = new Date('2026-10-22T20:00:00');
  expect(when('2026-10-22T18:55:00', now)).toBe('6:55 PM');
  expect(when('2026-10-14T19:02:00', now)).toBe('Oct 14');
  expect(when(null, now)).toBe('');
});

test("today's agents keep their faces, and every other agent gets one of its own", () => {
  const looks = agentLooks('project-x', [
    { id: 'W-1', displayName: 'Mara' },
    { id: 'W-2', displayName: 'Pip' },
    { id: 'W-3', displayName: 'Rook' },
  ]);
  expect(looks.get('W-1')).toEqual(CLASSIC[0]!.look);
  expect(looks.get('W-2')).not.toEqual(looks.get('W-3'));
  // The same project and agents always give the same faces.
  expect(
    agentLooks('project-x', [
      { id: 'W-1', displayName: 'Mara' },
      { id: 'W-2', displayName: 'Pip' },
    ]).get('W-2'),
  ).toEqual(looks.get('W-2'));
});

test('an idea shipped today when its last integration finished today, with its commits in order', () => {
  const now = new Date('2026-10-22T20:00:00'),
    story = (id: string, taskIds: string[], tone: RunStory['outcome']['tone'] = 'ok') =>
      ({ id, brief: id, taskIds, outcome: { tone, label: '', text: '' } }) as unknown as RunStory,
    integrated = (taskId: string, commit: string, finishedAt: string) =>
      ({
        id: `a-${taskId}`,
        taskId,
        status: 'accepted',
        sourceIntegration: { state: 'integrated', finishedAt, repository: { commit } },
      }) as unknown as AttemptSummary;
  const shipped = shippedToday(
    [story('today', ['T-1', 'T-2']), story('yesterday', ['T-3']), story('stopped', ['T-4'], 'bad')],
    [
      integrated('T-2', 'bbbbbbbbbb', '2026-10-22T15:00:00'),
      integrated('T-1', 'aaaaaaaaaa', '2026-10-22T09:00:00'),
      integrated('T-3', 'cccccccccc', '2026-10-21T15:00:00'),
      integrated('T-4', 'dddddddddd', '2026-10-22T16:00:00'),
    ],
    now,
  );
  expect(shipped.map(item => [item.story.id, item.commits])).toEqual([['today', ['aaaaaaa', 'bbbbbbb']]]);
});

// Graph test 0a (October 25): On the floor said an agent "Finished story 4" for the attempt a restart cut off, and
// other work's review that asked for changes read as finished.
test("an agent's last work says how it ended: stopped, a review's verdict, or finished", () => {
  const work = { id: 'T-1', title: 'Write the guide', kind: 'general:work', status: 'blocked' } as Task,
    stories = [
      { id: 'run', taskIds: ['T-1'], graph: { stages: [[{ taskId: 'T-1', kind: 'general:work' }]] } },
    ] as unknown as RunStory[],
    worker = { id: 'W-1', displayName: 'Jules' } as Worker,
    last = (fields: Partial<AttemptSummary>) =>
      lastDone(
        {
          tasks: [work],
          attempts: [{ id: 'a', taskId: 'T-1', workerId: 'W-1', finishedAt: '2026-10-25T18:11:30Z', ...fields }],
        } as unknown as StudioState,
        stories,
        worker,
      )?.words;
  expect(last({ status: 'interrupted' })).toBe('Stopped on story 1');
  expect(last({ status: 'failed' })).toBe('Stopped on story 1');
  expect(last({ status: 'accepted', assignment: { kind: 'general:work' } })).toBe('Finished story 1');
  expect(last({ status: 'accepted', assignment: { kind: 'general:review' }, workReviewVerdict: 'needs-work' })).toBe(
    'Asked for changes to story 1',
  );
  expect(last({ status: 'accepted', assignment: { kind: 'general:review' }, workReviewVerdict: 'pass' })).toBe(
    'Passed story 1',
  );
});

test('other work shipped today when its last result was accepted today, counted without its plan or review', () => {
  const now = new Date('2026-10-24T20:00:00'),
    // As the shared run rules word them: other work that finished reads Finished, not Integrated.
    story = (id: string, taskIds: string[], label = 'Finished') =>
      ({
        id,
        brief: id,
        taskIds,
        outcome: { tone: 'muted', label, text: 'Nothing is waiting.' },
      }) as unknown as RunStory,
    accepted = (taskId: string, kind: string, acceptedAt: string, id = `a-${taskId}-${kind}`) =>
      ({ id, taskId, status: 'accepted', acceptedAt, assignment: { kind } }) as unknown as AttemptSummary;
  const shipped = shippedToday(
    [
      story('guide', ['T-plan', 'T-guide']),
      story('older', ['T-old']),
      story('code-unintegrated', ['T-change']),
      story('running', ['T-run'], 'In progress'),
    ],
    [
      accepted('T-plan', 'general:plan', '2026-10-24T10:00:00'),
      accepted('T-guide', 'general:work', '2026-10-24T10:20:00'),
      accepted('T-guide', 'general:review', '2026-10-24T10:30:00'),
      accepted('T-old', 'general:work', '2026-10-23T18:00:00'),
      // A code story whose review asked for changes finished without integrating: nothing shipped.
      accepted('T-change', 'studio-development:change', '2026-10-24T11:00:00'),
      accepted('T-run', 'general:work', '2026-10-24T12:00:00'),
    ],
    now,
  );
  expect(shipped.map(item => [item.story.id, item.commits, item.results, item.at])).toEqual([
    ['guide', [], 1, '2026-10-24T10:30:00'],
  ]);
});
