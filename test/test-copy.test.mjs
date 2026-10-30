// The copy an editor's own test run uses is made in a process of its own (src/connectors/test-copy.mjs): the
// controller keeps answering while it is made, it carries the staged edits, a source changed since its snapshot is
// refused with the same message as before, and stopping the editor ends a copy still in progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceRepository } from './source-repository.mjs';
import { sourcePlan } from '../src/connectors/source-checks.mjs';
import { studioDeskProfile } from '../src/connectors/source-profile.mjs';
import { makeTestCopy } from '../src/connectors/test-copy.mjs';

function folders(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-tc-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { output: path.join(base, 'o'), directory: path.join(base, 'c') };
}

const stage = (output, file, text) => {
  const target = path.join(output, 'changes', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
};

test("an editor's test copy is made in its own process with the staged edits applied", async t => {
  const worktree = sourceRepository(),
    source = sourcePlan(worktree, studioDeskProfile),
    { output, directory } = folders(t);
  stage(output, 'src/core/workflows.mjs', '// edited\n');
  stage(output, 'src/core/brand-new.mjs', '// new\n');
  // A leftover from an earlier run is cleared first.
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'leftover.txt'), 'old');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const holder = {},
    copying = makeTestCopy(
      {
        source,
        worktree,
        output,
        directory,
        allowedFiles: ['src/core/workflows.mjs'],
        newFiles: ['src/core/brand-new.mjs'],
        deleteFiles: ['src/core/rules.mjs'],
      },
      holder,
    );
  assert.ok(holder.copying, 'The copy runs as a process the editor stopping can end.');
  const plan = await copying;
  clearInterval(timer);
  assert.ok(ticks > 0, 'The controller kept answering while the copy was made.');
  assert.equal(holder.copying, null);
  assert.equal(fs.readFileSync(path.join(directory, 'src/core/workflows.mjs'), 'utf8'), '// edited\n');
  assert.equal(fs.readFileSync(path.join(directory, 'src/core/brand-new.mjs'), 'utf8'), '// new\n');
  assert.equal(fs.existsSync(path.join(directory, 'src/core/rules.mjs')), false, 'An unkept deleted file is removed.');
  assert.equal(fs.existsSync(path.join(directory, 'leftover.txt')), false);
  // The plan is the copy's own, as the test command needs it.
  assert.equal(plan.sourceHash, sourcePlan(directory, studioDeskProfile).sourceHash);
  assert.ok(plan.command.args.includes('test/rules.test.mjs'));
});

test("an editor's test copy refuses a source changed since its snapshot, and a stopped copy ends", async t => {
  const worktree = sourceRepository(),
    source = sourcePlan(worktree, studioDeskProfile),
    request = { worktree, allowedFiles: [], ...folders(t) };
  await assert.rejects(
    makeTestCopy({ ...request, source: { ...source, sourceHash: 'changed' } }),
    /Source changed after its attempt snapshot\. Start a newly scoped attempt\./,
  );
  const holder = {},
    copying = makeTestCopy({ ...request, source }, holder);
  holder.copying.kill();
  await assert.rejects(copying, /Copying the source for the tests stopped\./);
  assert.equal(holder.copying, null);
});
