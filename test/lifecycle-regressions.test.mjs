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
// The first story kept no to-do sequence: its fixed-seed run found no broken promise on the controller.
import test from 'node:test';
import { replay } from './lifecycle-harness.mjs';

// The known bug of test/lifecycle-shrink.test.mjs, shrunk there from seed 20261103: a restart while work is still
// running must keep the interrupted attempt's reservations until it is reconciled.
test('lifecycle: a crash restart keeps a running attempt reserved until it is reconciled (seed 1466884)', async () => {
  await replay([
    { kind: 'add', task: 'w2', result: 'write', maxSeconds: 6, approved: true },
    { kind: 'act', task: 'w2', action: 'start', result: 'hang' },
    { kind: 'restart', crash: true },
  ]);
});
