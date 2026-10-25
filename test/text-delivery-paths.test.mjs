import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './model-free-studio.mjs'; // uses the suite's workspace-local MXC temporary directory
import { stageTextDelivery } from '../src/adapters/text-delivery.mjs';

// A text-mode delivery staged into a fresh output folder, with a valid common result
// whose artifacts match the delivered files.
function staging(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'text-delivery-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const entry = { attempt: { taskId: 'T-fixture' }, output, protectedFiles: new Map() };
  const stage = (files, options) =>
    stageTextDelivery(
      {
        files,
        result: {
          taskId: 'T-fixture',
          outcome: 'completed',
          summary: 'Staged route files.',
          artifacts: files.map(file => ({ path: file.path, kind: 'source-file' })),
          checks: [],
          issues: [],
          handoff: 'Review the candidate.',
        },
      },
      entry,
      options,
    );
  return { output, stage };
}

test('text delivery stages route-folder paths with parentheses and square brackets', t => {
  const c = staging(t),
    files = [
      'changes/src/app/(frontend)/[member]/page.mjs',
      'changes/dashboard/src/[...slug]/page.tsx',
      'changes/src/[[...slug]]/route.mjs',
    ].map(file => ({ path: file, content: `// Delivered ${file}\n` }));
  assert.equal(c.stage(files).taskId, 'T-fixture');
  for (const file of files) assert.equal(fs.readFileSync(path.join(c.output, file.path), 'utf8'), file.content);
});

test('a bracketed file that exists is replaced only when it was offered as editable', t => {
  const c = staging(t),
    file = 'changes/src/app/(frontend)/[member]/page.mjs';
  fs.mkdirSync(path.dirname(path.join(c.output, file)), { recursive: true });
  fs.writeFileSync(path.join(c.output, file), '// Before.\n');
  assert.throws(() => c.stage([{ path: file, content: '// Not offered.\n' }]), {
    message: 'The model proposed a duplicate or existing artifact path.',
  });
  assert.equal(fs.readFileSync(path.join(c.output, file), 'utf8'), '// Before.\n');
  c.stage([{ path: file, content: '// After.\n' }], { editable: [file] });
  assert.equal(fs.readFileSync(path.join(c.output, file), 'utf8'), '// After.\n');
});

test('unsafe spellings of bracketed paths are still refused and nothing of the delivery is written', async t => {
  for (const file of [
    'changes/src/app/[slug]./page.mjs',
    'changes/src/app/nul.mjs',
    'changes/src/app/(x)/AGENTS.md',
    'changes/src/app/[slug]\\page.mjs',
    'changes/src/app/[slug]:x.mjs',
    'changes/src/app/［slug］/page.mjs',
    'changes/../[slug].mjs',
  ])
    await t.test(file, t => {
      const c = staging(t);
      assert.throws(
        () =>
          c.stage([
            { path: 'changes/src/app/(frontend)/page.mjs', content: '// Safe.\n' },
            { path: file, content: '// Unsafe.\n' },
          ]),
        { message: 'The model proposed an invalid or protected artifact path.' },
      );
      assert.deepEqual(fs.readdirSync(c.output), [], 'Not even the delivery’s safe file is written.');
    });
});
