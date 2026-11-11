// Kept lifecycle sequences, as ordinary tests: each replays a literal step list on the real controller through the
// lifecycle harness (test/lifecycle-harness.mjs) and fails with the promise it breaks.
//
// To keep a newly shrunk sequence: a failing run of test/lifecycle-invariants.test.mjs (or of the known-bug test,
// test/lifecycle-shrink.test.mjs) prints the shrunk steps as a ready-to-paste test, named for the rule it broke and
// its sequence's seed. Paste it below, give it a name that says what the sequence does, and leave the steps exactly as
// printed: a task is named by the order it was added (w1, w2, ...), a director action by the listed action it sent,
// and `approved: true` adds work already approved. A sequence that breaks a promise on today's controller is kept with
// { todo: 'what it shows' } as the test's second argument until the controller is fixed; then the todo is removed.
//
// The first story kept no to-do sequence: its fixed-seed run found no broken promise on the controller. Neither did
// the code-story run's fixed seed (test/lifecycle-source-invariants.test.mjs, seed 20261104).
//
// Code-story sequences (test/lifecycle-source-invariants.test.mjs) replay with replaySource, on a fresh disposable
// repository: a story is named s1, s2 in the order it was added, and a director action may carry the verdict the
// review fixture gives when it accepts an edit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { replay, replaySource } from './lifecycle-harness.mjs';

// The known bug of test/lifecycle-shrink.test.mjs, shrunk there from seed 20261103: a restart while work is still
// running must keep the interrupted attempt's reservations until it is reconciled.
test('lifecycle: a crash restart keeps a running attempt reserved until it is reconciled (seed 1466884)', async () => {
  await replay([
    { kind: 'add', task: 'w2', result: 'write', maxSeconds: 6, approved: true },
    { kind: 'act', task: 'w2', action: 'start', result: 'hang' },
    { kind: 'restart', crash: true },
  ]);
});

// A restart while an integration is still verifying: the integration is not run again on its own, the story offers
// Reconcile source integration as its way forward, and the main branch takes exactly one integration commit, from the
// Integrate again the director sends after reconciling.
test('lifecycle: a restart during an integration is reconciled, not repeated, and the story integrates once', async () => {
  const seen = [];
  await replaySource(
    [
      { kind: 'add', task: 's1' },
      { kind: 'act', task: 's1', action: 'start' },
      { kind: 'act', task: 's1', action: 'accept', verdict: 'pass' },
      { kind: 'act', task: 's1', action: 'accept' },
      { kind: 'integrate-restart', task: 's1' },
      { kind: 'act', task: 's1', action: 'restore' },
      { kind: 'act', task: 's1', action: 'integrate' },
    ],
    {
      onStep: ({ step, view }) => {
        const story = view.tasks[0],
          journal = Object.values(view.journals).find(item => item.taskId === story.id);
        seen.push({
          step: step.kind === 'act' ? step.action : step.kind,
          skipped: !!step.skipped,
          busy: step.busy,
          journal: journal?.state ?? null,
          commits: view.commits,
          actions: (view.actions[story.id] || []).map(action => action.key),
        });
      },
    },
  );
  assert.deepEqual(
    seen.map(item => item.step),
    ['add', 'start', 'accept', 'accept', 'integrate-restart', 'restore', 'integrate'],
  );
  assert.ok(
    seen.every(item => !item.skipped),
    JSON.stringify(seen),
  );
  const [, , , reviewed, restarted, reconciled, integrated] = seen;
  // The baseline commit alone, until the director integrates again.
  assert.equal(reviewed.commits, 1);
  assert.equal(restarted.busy, true, 'The restart came while the integration was verifying.');
  assert.equal(restarted.journal, 'needs-reconciliation');
  assert.equal(restarted.commits, 1);
  assert.ok(restarted.actions.includes('restore'), `After the restart the story lists ${restarted.actions}.`);
  assert.equal(reconciled.journal, 'abandoned');
  assert.equal(reconciled.commits, 1);
  assert.equal(integrated.journal, 'integrated');
  assert.equal(integrated.commits, 2, 'One integration commit.');
});
