// The lifecycle property test (test/lifecycle-harness.mjs) really catches a bug: a known mistake is put back into a
// throwaway copy of the controller, where a restart let go of an interrupted attempt's reservations, and the seeded
// search against that copy must find it, break the reservation rule, and shrink it to a short sequence that holds a
// start of work still running and a restart. The same shrunk sequence replayed on the real controller passes, which
// shows the failure comes from the bug. The repository is only read: the copy lives in a temporary folder, which is
// removed after the test. Its shrunk sequence is kept in test/lifecycle-regressions.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { replay, shrink, foldApprovals } from './lifecycle-harness.mjs';
import { removeFolder } from './fixture-cleanup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// What the copy holds: the controller, the page rules it serves, the scripts it imports (src/adapters/codex.mjs reads
// scripts/check-codex-sandbox.mjs), its package.json byte for byte (the server reads the
// app version from it at import) and the test helpers the harness imports, in their own relative layout.
const folders = ['src', 'public', 'scripts'];
const files = [
  'package.json',
  'test/model-free-studio.mjs',
  'test/fixture-general-work.mjs',
  'test/fixture-npm.mjs',
  'test/fixture-gitconfig',
  'test/wait-for.mjs',
  'test/fixture-cleanup.mjs',
  'test/lifecycle-harness.mjs',
];
const orchestrator = 'src/core/orchestrator.mjs';

// The known bug's place: the restart recovery's loop, under 'An unacknowledged process may still be alive. Retain its
// reservations until reconciled.', where each attempt is marked interrupted. The bug releases the attempt's leases
// right after that. The target holds the lines after the mark too, since Reconcile marks attempts interrupted as well.
export const bugTarget = [
  "        a.status = 'interrupted';",
  '        a.finishedAt = new Date().toISOString();',
  "        // Its process ran in a job of its own (C-07), whose only handle the previous controller's wrapper held: the",
];
// Puts the bug back into the orchestrator's text, after checking that its target is there exactly once, so a later
// change to that code fails here by name instead of passing without the bug.
export function reintroduceBug(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n',
    target = bugTarget.join(eol),
    found = text.split(target).length - 1;
  if (found !== 1)
    throw new Error(
      `The known-bug patch expects this text in ${orchestrator} exactly once, and found it ${found} times:\n${bugTarget.join('\n')}`,
    );
  const [mark, ...rest] = bugTarget;
  return text.split(target).join([mark, '        store.release(a.id);', ...rest].join(eol));
}

// A digest of every file under the given paths of a folder, to show the repository is unchanged by the test.
function digest(base, paths) {
  const sum = crypto.createHash('sha256');
  const visit = relative => {
    const full = path.join(base, relative),
      stat = fs.statSync(full);
    if (stat.isDirectory()) for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    else sum.update(relative.replaceAll('\\', '/')).update('\0').update(fs.readFileSync(full)).update('\0');
  };
  for (const item of paths) visit(item);
  return sum.digest('hex');
}

function buildCopy(directory) {
  for (const folder of folders) fs.cpSync(path.join(root, folder), path.join(directory, folder), { recursive: true });
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(directory, file));
  }
  const target = path.join(directory, orchestrator);
  fs.writeFileSync(target, reintroduceBug(fs.readFileSync(target, 'utf8')));
}

const seed = 20261103;

test('the shrinker folds an approval into its add when no single step can go', async () => {
  const steps = [
    { kind: 'add', task: 'w1', result: 'write', maxSeconds: 5 },
    { kind: 'add', task: 'w2', result: 'write', maxSeconds: 6 },
    { kind: 'act', task: 'w2', action: 'approve', result: 'block' },
    { kind: 'act', task: 'w2', action: 'start', result: 'hang' },
    { kind: 'restart', crash: true },
  ];
  // One fold for each approval of work added before it; never for work it does not add, or adds approved.
  assert.deepEqual(foldApprovals(steps), [[{ ...steps[0] }, { ...steps[1], approved: true }, steps[3], steps[4]]]);
  assert.deepEqual(foldApprovals([steps[2], steps[1]]), []);
  assert.deepEqual(foldApprovals([{ ...steps[1], approved: true }, steps[2]]), []);
  // A stand-in for the studio: the rule breaks while w2 is started, before a restart, from Ready.
  const fails = async list => {
    const add = list.find(step => step.kind === 'add' && step.task === 'w2'),
      at = kind => list.findIndex(step => step.kind === kind || step.action === kind);
    const ready = add && (add.approved || at('approve') >= 0);
    return ready && at('start') >= 0 && at('restart') > at('start') ? 'reservation' : null;
  };
  assert.deepEqual(await shrink(steps, fails), [steps[1], steps[2], steps[3], steps[4]]);
  assert.deepEqual(await shrink(steps, fails, undefined, foldApprovals), [
    { ...steps[1], approved: true },
    steps[3],
    steps[4],
  ]);
});

test('the known-bug patch fails by name when its target text is missing or appears more than once', () => {
  const named = error =>
    error instanceof Error &&
    error.message.includes(`expects this text in ${orchestrator} exactly once`) &&
    error.message.includes(bugTarget.join('\n'));
  assert.throws(() => reintroduceBug('const nothing = 0;\n'), named);
  assert.throws(() => reintroduceBug(`${bugTarget.join('\n')}\n${bugTarget.join('\n')}\n`), named);
  // Once, it adds the release right after the mark, in either line ending.
  for (const eol of ['\n', '\r\n']) {
    const patched = reintroduceBug(`before${eol}${bugTarget.join(eol)}${eol}after`);
    assert.equal(
      patched,
      `before${eol}${bugTarget[0]}${eol}        store.release(a.id);${eol}${bugTarget.slice(1).join(eol)}${eol}after`,
    );
  }
  // And the repository's orchestrator holds it today, without the bug.
  const real = fs.readFileSync(path.join(root, orchestrator), 'utf8');
  assert.doesNotThrow(() => reintroduceBug(real));
  assert.ok(!real.includes(`${bugTarget[0]}\n        store.release(a.id);`));
});

test(`the search finds a reservation released at a restart, put back in a copy, and shrinks it (seed ${seed})`, async t => {
  const watched = [...folders, ...files],
    before = digest(root, watched),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-bug-'));
  let failure;
  try {
    buildCopy(directory);
    assert.notEqual(digest(directory, watched), before, 'The copy holds the bug.');
    const harness = await import(pathToFileURL(path.join(directory, 'test/lifecycle-harness.mjs')).href),
      { createStudio: factory } = await import(pathToFileURL(path.join(directory, 'test/model-free-studio.mjs')).href);
    ({ failure } = await harness.exploreLifecycles({
      seed,
      runs: 12,
      length: 20,
      factory,
      log: line => t.diagnostic(line),
    }));
    assert.ok(failure, 'The search against the copy found no broken promise.');
    t.diagnostic(
      `Broke ${failure.rule}: ${failure.message}\nShrunk to ${failure.steps.length} steps:\n${failure.test}`,
    );
    assert.equal(failure.rule, 'reservation', failure.message);
    assert.ok(failure.steps.length <= 3, `The shrunk sequence has ${failure.steps.length} steps.`);
    assert.ok(
      failure.steps.some(step => step.kind === 'act' && step.action === 'start' && step.result === 'hang'),
      'The shrunk sequence starts work that is still running.',
    );
    assert.ok(
      failure.steps.some(step => step.kind === 'restart'),
      'The shrunk sequence restarts the controller.',
    );
    // It still fails when replayed on the copy.
    await assert.rejects(harness.replay(failure.steps, { factory }), /Lifecycle promise broken \(reservation\)/);
  } finally {
    await removeFolder(directory);
  }
  assert.equal(fs.existsSync(directory), false, `The copy ${directory} was not removed.`);
  assert.equal(digest(root, watched), before, 'The repository was changed.');
  // The same steps on the real controller keep every promise: the failure comes from the bug.
  await replay(failure.steps);
});
