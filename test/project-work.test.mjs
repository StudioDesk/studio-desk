// What a project's work made, for the Artifacts page (src/core/project-work.mjs): its files with their versions and
// why each was made, a code story's pictures, and its records counted, never listed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWork, versionWhy } from '../src/core/project-work.mjs';

const project = 'project-coffee';
function stand(tasks, attempts, library = { entries: [] }) {
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  return {
    tasks: () => tasks,
    attempt: id => {
      if (!byId.has(id)) throw new Error('Attempt not found.');
      return byId.get(id);
    },
    attempts: taskId => attempts.filter(attempt => attempt.taskId === taskId),
    setting: id => (id === `library:${project}` ? library : null),
  };
}
const task = (id, fields) => ({ id, projectId: project, status: 'done', title: `Task ${id}`, ...fields });
const attempt = (id, taskId, fields) => ({ id, taskId, status: 'accepted', workerId: 'W-02', ...fields });

test("a project's work lists its files with their versions, a story's pictures, and counts its records", () => {
  const store = stand(
    [
      task('T-plan', { kind: 'general:plan', acceptedAttemptId: 'A-plan' }),
      task('T-menu', {
        kind: 'general:work',
        acceptedAttemptId: 'A-menu-2',
        workflowReference: { runId: 'run-1' },
      }),
      task('T-glossary', { kind: 'general:work', acceptedAttemptId: 'A-glossary' }),
      task('T-story', {
        kind: 'studio-development:change',
        acceptedAttemptId: 'A-review',
        sourceStage: { phase: 'integration', candidate: { attemptId: 'A-candidate' } },
      }),
      task('T-open', { kind: 'general:work', status: 'running', acceptedAttemptId: null }),
      {
        ...task('T-elsewhere', { kind: 'general:work', acceptedAttemptId: 'A-elsewhere' }),
        projectId: 'project-other',
      },
    ],
    [
      attempt('A-plan', 'T-plan', { artifacts: [{ path: 'plan.json', kind: 'graph-proposal', hash: 'p' }] }),
      attempt('A-menu-1', 'T-menu', {
        startedAt: '2026-10-29T15:30:00Z',
        acceptedAt: '2026-10-29T15:31:00Z',
        assignment: { direction: 'Six drinks, one line each.' },
        artifacts: [{ path: 'menu-card.md', kind: 'work-file', hash: 'm1' }],
      }),
      // The review's own files are its stage's, never a version of the menu.
      attempt('A-menu-review', 'T-menu', {
        startedAt: '2026-10-29T15:40:00Z',
        artifacts: [{ path: 'review.json', kind: 'review', hash: 'r' }],
      }),
      attempt('A-menu-2', 'T-menu', {
        startedAt: '2026-10-29T15:50:00Z',
        acceptedAt: '2026-10-29T16:12:00Z',
        assignment: {
          direction: "Follow the guidelines' voice rules.\n\nDirector's note: shorter descriptions, please.",
        },
        artifacts: [{ path: 'menu-card.md', kind: 'work-file', hash: 'm2' }],
      }),
      attempt('A-glossary', 'T-glossary', {
        acceptedAt: '2026-10-29T14:00:00Z',
        artifacts: [
          { path: 'glossary.md', kind: 'work-file', hash: 'g' },
          { path: 'library-proposal.json', kind: 'library-proposal', hash: 'l' },
        ],
      }),
      attempt('A-review', 'T-story', {
        acceptedAt: '2026-10-29T17:00:00Z',
        artifacts: [{ path: 'source-change-review.json', kind: 'source-change-review', hash: 's' }],
      }),
      attempt('A-candidate', 'T-story', {
        acceptedAt: '2026-10-29T16:55:00Z',
        artifacts: [
          { path: 'change.diff', kind: 'source-change-diff', hash: 'd' },
          { path: 'visual/01-today-1440-dark.png', kind: 'visual-capture', hash: 'v1' },
          { path: 'visual/01-today-390-dark.png', kind: 'visual-capture', hash: 'v2' },
        ],
      }),
      attempt('A-elsewhere', 'T-elsewhere', { artifacts: [{ path: 'other.md', kind: 'work-file', hash: 'o' }] }),
    ],
    {
      entries: [
        {
          id: 'lib-00000000-0000-4000-8000-000000000001',
          revisions: [{ revision: 1, source: { type: 'accepted', taskId: 'T-glossary', path: 'glossary.md' } }],
        },
      ],
    },
  );
  const { work, pictures, records } = projectWork(store, project);
  assert.deepEqual(
    work.map(file => [file.taskId, file.path, file.versions.length, file.libraryEntryId]),
    [
      ['T-menu', 'menu-card.md', 2, null],
      ['T-glossary', 'glossary.md', 1, 'lib-00000000-0000-4000-8000-000000000001'],
    ],
  );
  // Newest version first, each with why it was made in the record's own words.
  assert.deepEqual(
    work[0].versions.map(version => [version.n, version.hash, version.current, version.why]),
    [
      [2, 'm2', true, "Follow the guidelines' voice rules."],
      [1, 'm1', false, null],
    ],
  );
  assert.equal(work[0].runId, 'run-1');
  assert.deepEqual(
    pictures.map(group => [group.taskId, group.attemptId, group.images.map(image => image.path)]),
    [['T-story', 'A-candidate', ['visual/01-today-1440-dark.png', 'visual/01-today-390-dark.png']]],
  );
  // The plan, the library proposal and the story's review are records: counted, never listed.
  assert.deepEqual(records, {
    count: 3,
    kinds: { 'graph-proposal': 1, 'library-proposal': 1, 'source-change-review': 1 },
  });
});

test("a version's why is what its direction added, or its new direction, cut at the first paragraph", () => {
  assert.equal(versionWhy('', 'The first brief.'), 'The first brief.');
  assert.equal(versionWhy('Same.', 'Same.'), null);
  assert.equal(
    versionWhy('Write the note.', 'Write the note.\n\nAutomatic retry 1: the previous attempt did not pass.'),
    'Automatic retry 1: the previous attempt did not pass.',
  );
  assert.equal(versionWhy('Write the note.', `${'x'.repeat(400)}\n\nMore.`).length, 280);
});
