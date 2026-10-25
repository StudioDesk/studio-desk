import { describe, expect, it } from 'vitest';
import type { LogEvent, StoryActivity } from './api';
import { clip, yourPart, type Names } from './your-part';

const names: Names = {
  noun: 'story',
  worker: id => ({ 'W-02': 'Eli', 'W-07': 'Morgan' })[id ?? ''] ?? String(id),
  team: id => ({ engineering: 'Engineering' })[id] ?? id,
  step: id => (id === 'attempt-review' ? 'review' : id ? 'build' : 'attempt'),
};
let seq = 0;
// An event as the controller records it, in its own words.
const event = (kind: string, message: string, minute: number, attempt: string | null = null): LogEvent => ({
  seq: ++seq,
  time: `2026-10-24T05:${String(minute).padStart(2, '0')}:00.000Z`,
  kind,
  message,
  task_id: 'T-1',
  attempt_id: attempt,
});
const story = (events: LogEvent[], more: Partial<StoryActivity> = {}): StoryActivity => ({
  events,
  idea: null,
  instructions: [],
  ...more,
});

describe("your part in a story's Activity", () => {
  it('names what you did and what a house rule did for you, oldest first, and leaves the controller its own', () => {
    const parts = yourPart(
      story(
        [
          event('work_approved', 'Director approved this work. Add it to a sprint or start it explicitly.', 1),
          event('started', 'Eli started Codex CLI.', 2, 'attempt-build'),
          event(
            'accepted',
            'Accepted by autonomy policy revision 6: Candidate scope and measured tests passed.',
            9,
            'attempt-build',
          ),
          event('review', 'Candidate review verdict: pass.', 12, 'attempt-review'),
          event(
            'integration_requested',
            'Autonomy policy revision 6 approved integration (Integrate after a passing review: independent review attempt-review passed). The controller integrates as soon as the source is free; other work continues.',
            13,
            'attempt-review',
          ),
        ],
        {
          idea: {
            runId: 'run-1',
            brief: 'Let story paths hold parentheses.\n\nNext.js route groups need them.',
            createdAt: '2026-10-24T04:59:00.000Z',
            files: ['routes.png'],
          },
        },
      ),
      names,
    );
    expect(parts.map(({ by, lead, words, integration }) => ({ by, lead, words, integration }))).toEqual([
      {
        by: 'you',
        lead: 'Sent the idea',
        words: 'Let story paths hold parentheses.\n\nNext.js route groups need them.',
        integration: undefined,
      },
      { by: 'you', lead: 'Approved this story', words: undefined, integration: undefined },
      {
        by: 'rule',
        lead: 'Accepted the build',
        words: 'Candidate scope and measured tests passed.',
        integration: undefined,
      },
      { by: 'rule', lead: 'Approved the integration', words: 'Integrate after a passing review', integration: true },
    ]);
    expect(parts[0]!.files).toEqual([{ path: 'routes.png', kind: 'file' }]);
    expect(parts[0]!.runId).toBe('run-1');
  });

  it('keeps your own words: the note you sent back, why you changed the files and the commands you allowed', () => {
    const parts = yourPart(
      story([
        event(
          'sent_back',
          'Director sent this work back for another attempt over a passing review. Note: Keep the old route names.',
          1,
          'attempt-review',
        ),
        event(
          'story_edited',
          "Director changed the story's files, approving the file request of attempt-build: It needs the router too. Files added: src/router.mjs, src/app/(frontend)/page.mjs. New files added: test/router.test.mjs. Delete removed: old.mjs. The next attempt continues from attempt-build.",
          2,
          'attempt-build',
        ),
        event(
          'commands_approved',
          'Approved for Claude employees: npm test, node --test test/router.test.mjs.',
          3,
          'attempt-build',
        ),
        event(
          'attempt_limit_override',
          'Director started attempt 3, past the 2-attempt limit for automatic runs.',
          4,
          'attempt-build',
        ),
        event('accepted', 'Director accepted the recorded result.', 5, 'attempt-review'),
        event('work_closed', 'Director closed this work: Not needed after all.', 6),
      ]),
      names,
    );
    expect(parts.map(({ lead, words }) => [lead, words])).toEqual([
      ['Sent it back for another attempt over a passing review', 'Keep the old route names.'],
      ['Gave it the files it asked for', 'It needs the router too. 1 path taken off.'],
      ['Allowed these commands for Claude agents', undefined],
      ['Started attempt 3, past its limit of 2', undefined],
      ['Accepted the review', undefined],
      ['Closed this story', 'Not needed after all.'],
    ]);
    expect(parts[1]!.files).toEqual([
      { path: 'src/router.mjs', kind: 'file' },
      { path: 'src/app/(frontend)/page.mjs', kind: 'file' },
      { path: 'test/router.test.mjs', kind: 'add' },
    ]);
    expect(parts[2]!.commands).toEqual(['npm test', 'node --test test/router.test.mjs']);
    // An attempt past the limit is recorded just after it starts; it goes before that attempt.
    expect(parts[3]!.opens).toBe('attempt-build');
    expect(parts.every(part => part.by === 'you')).toBe(true);
  });

  it('says what a house rule ran again, and why', () => {
    const parts = yourPart(
      story([
        event(
          'autonomy_retry',
          'Automatic retry: Candidate review must assess the exact candidate and label unperformed checks.',
          1,
          'attempt-review',
        ),
        event('autonomy_retry', 'Automatic retry of T-1 after review T-2.', 2),
      ]),
      names,
    );
    expect(parts.map(({ by, lead, words }) => [by, lead, words])).toEqual([
      [
        'rule',
        'Started the review again',
        'Candidate review must assess the exact candidate and label unperformed checks.',
      ],
      ['rule', 'Tried it again after the review', undefined],
    ]);
  });

  it('counts the instructions you published while the story ran, with your note, by whose they are', () => {
    const parts = yourPart(
      story([], {
        instructions: [
          {
            scope: 'team',
            id: 'engineering',
            revision: 4,
            note: 'Run the tests first.',
            publishedAt: '2026-10-24T05:20:00.000Z',
          },
          {
            scope: 'employee',
            id: 'W-02',
            revision: 2,
            note: 'Published by director',
            publishedAt: '2026-10-24T05:10:00.000Z',
          },
        ],
      }),
      names,
    );
    expect(parts.map(({ lead, words }) => [lead, words])).toEqual([
      ["Published Eli's instructions, revision 2", undefined],
      ["Published Engineering's instructions, revision 4", 'Run the tests first.'],
    ]);
  });

  it('shortens long words at a word, without the comma before the cut', () => {
    const short = clip('word '.repeat(200));
    expect(short.length).toBeLessThanOrEqual(481);
    expect(short.endsWith('word…')).toBe(true);
    expect(clip(`${'a'.repeat(470)} create, then more`).endsWith('create…')).toBe(true);
    expect(clip('Short enough.')).toBe('Short enough.');
  });

  it('is nothing while the record is read, or from a controller without it', () => {
    expect(yourPart(undefined, names)).toEqual([]);
  });
});
