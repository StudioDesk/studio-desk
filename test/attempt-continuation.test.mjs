import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import './model-free-studio.mjs'; // uses the suite's workspace-local MXC temporary directory
import { hash } from '../src/core/contracts.mjs';
import {
  captureContinuation,
  readContinuation,
  prepareSourceContinuation,
  continuationLimits,
  generalWorkContinuation,
  continuationFile,
} from '../src/core/attempt-continuation.mjs';

function layout(t, source = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const a = {
    id: 'attempt-fixture',
    taskId: 'T-fixture',
    status: 'failed',
    pid: null,
    assignment: {
      id: 'T-fixture',
      kind: source ? 'studio-development:change' : 'general:work',
      stageState: { current: 'work' },
    },
    artifacts: [],
  };
  const store = { directory, task: () => ({ id: a.taskId }) },
    job = path.join(directory, 'jobs', a.id),
    output = path.join(job, 'output');
  fs.mkdirSync(path.join(output, 'changes/src'), { recursive: true });
  fs.mkdirSync(path.join(job, 'source/src'), { recursive: true });
  fs.writeFileSync(path.join(job, 'assignment.json'), JSON.stringify(a.assignment));
  const put = (relative, bytes) => {
    fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
    fs.writeFileSync(path.join(output, relative), bytes);
  };
  if (source) {
    const baseline = ['src/edit.mjs', 'src/deleted.mjs'].map(file => {
      const bytes = Buffer.from('// Base ' + file + '\n');
      fs.writeFileSync(path.join(job, 'source', file), bytes);
      return { path: file, bytes: bytes.length, hash: hash(bytes) };
    });
    a.sourceChange = {
      allowedFiles: ['src/edit.mjs'],
      newFiles: ['src/new.mjs'],
      deleteFiles: ['src/deleted.mjs'],
      continueFrom: { files: [{ path: 'src/new.mjs', hash: hash('old') }] },
      source: { files: baseline, sourceHash: hash(JSON.stringify(baseline)) },
      base: { commit: 'fixture-base' },
      proposalReference: {
        taskId: 'proposal',
        attemptId: 'proposal-attempt',
        path: 'proposal.json',
        hash: hash('proposal'),
      },
    };
    put('changes/src/edit.mjs', '// Retained edit.\n');
    prepareSourceContinuation(store, a);
  }
  return { store, a, job, output, put };
}

test('source checkpoints retain complete bytes, baseline identities and distinct deletion/removal intent', t => {
  const c = layout(t);
  c.put('unrelated.txt', 'excluded');
  c.put('scope-request.json', '{}');
  const result = captureContinuation(c.store, c.a);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(result.identity, {
    projectId: 'project-legacy',
    taskId: 'T-fixture',
    attemptId: c.a.id,
    kind: 'studio-development:change',
    stage: 'work',
  });
  assert.deepEqual(result.deletions, ['src/deleted.mjs']);
  assert.deepEqual(result.removedNewFiles, ['src/new.mjs']);
  assert.equal(result.source.baseCommit, 'fixture-base');
  assert.deepEqual(result.baseline, c.a.sourceChange.source.files);
  assert.deepEqual(result.files, [{ path: 'changes/src/edit.mjs', bytes: 18, hash: hash('// Retained edit.\n') }]);
  const bytes = fs.readFileSync(path.join(c.job, 'continuation/files/changes/src/edit.mjs'));
  assert.equal(bytes.toString(), '// Retained edit.\n');
  assert.equal(readContinuation(c.store, c.a).status, 'complete');
  assert.deepEqual(c.a.artifacts, [], 'Recovery evidence never registers a deliverable.');
});

test('capture never trusts a live, unknown or unconfirmed process', t => {
  const c = layout(t);
  for (const status of ['running', 'stopping', 'quarantined']) {
    c.a.status = status;
    assert.equal(captureContinuation(c.store, c.a).status, 'unavailable');
  }
  c.a.status = 'failed';
  c.a.pid = 12345;
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('unknown'), { code: 'EPERM' });
  });
  assert.equal(captureContinuation(c.store, c.a).status, 'unavailable');
  assert.equal(fs.existsSync(path.join(c.job, 'continuation')), false);
});

test('tampered, missing, traversing and foreign checkpoint evidence is unavailable without legacy fallback', async t => {
  for (const damage of ['bytes', 'missing', 'traversal', 'foreign', 'baseline'])
    await t.test(damage, t => {
      const c = layout(t);
      const captured = captureContinuation(c.store, c.a);
      assert.equal(captured.status, 'complete', JSON.stringify(captured));
      const root = path.join(c.job, 'continuation'),
        manifestFile = path.join(root, 'manifest.json'),
        manifest = JSON.parse(fs.readFileSync(manifestFile));
      if (damage === 'bytes') fs.appendFileSync(path.join(root, 'files/changes/src/edit.mjs'), 'tampered');
      if (damage === 'missing') fs.rmSync(path.join(root, 'files/changes/src/edit.mjs'));
      if (damage === 'traversal') manifest.files[0].path = '../outside';
      if (damage === 'foreign') manifest.identity.taskId = 'T-other';
      if (damage === 'baseline') fs.writeFileSync(path.join(root, 'base/src/edit.mjs'), 'tampered');
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
      assert.equal(captureContinuation(c.store, c.a).status, 'unavailable', 'Never replace damaged evidence.');
    });
});

test('symlink boundaries are refused without requiring OS symlink privileges', t => {
  const c = layout(t),
    lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (filename, ...args) => {
    const stat = lstat(filename, ...args);
    if (String(filename).endsWith(path.join('changes', 'src', 'edit.mjs')))
      return new Proxy(stat, {
        get: (target, key) => (key === 'isSymbolicLink' ? () => true : Reflect.get(target, key)),
      });
    return stat;
  });
  const result = captureContinuation(c.store, c.a);
  assert.equal(result.status, 'unavailable');
  assert.match(result.issues.join(' '), /symlink/);
  assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
});

test('oversized and missing source edits are explicit failures, never inferred source deletions', async t => {
  for (const mode of ['oversized', 'missing', 'plan', 'base'])
    await t.test(mode, t => {
      const c = layout(t);
      if (mode === 'oversized') c.put('changes/src/edit.mjs', Buffer.alloc(continuationLimits.fileBytes + 1));
      if (mode === 'missing') fs.rmSync(path.join(c.output, 'changes/src/edit.mjs'));
      if (mode === 'plan') fs.writeFileSync(path.join(c.job, 'continuation-source.json'), '{}');
      if (mode === 'base') fs.writeFileSync(path.join(c.job, 'source/src/edit.mjs'), 'tampered base');
      assert.equal(captureContinuation(c.store, c.a).status, 'unavailable');
      assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
    });
});

test('general work capture excludes controls, inputs, provider files and unrelated source paths', t => {
  const c = layout(t, false);
  for (const file of [
    'AGENTS.md',
    'instructions.json',
    'assignment.json',
    'result.json',
    'result-schema.json',
    'scope-request.json',
    'source-scope.json',
    'review.json',
    'check-report.json',
    'codex-config.json',
    'claude-mcp.json',
    '.codex/config.toml',
    'inputs/evidence.txt',
    'changes/src/code.mjs',
    'source/context.txt',
  ])
    c.put(file, 'excluded');
  c.put('draft/notes.md', 'Recoverable work.\n');
  const result = captureContinuation(c.store, c.a);
  assert.equal(result.status, 'complete', JSON.stringify(result));
  assert.deepEqual(
    result.files.map(item => item.path),
    ['draft/notes.md'],
  );
  assert.equal(readContinuation(c.store, c.a).status, 'complete');
});

test('general file, byte and traversal limits produce incomplete/unavailable evidence', async t => {
  for (const mode of ['count', 'bytes', 'binary', 'traversal'])
    await t.test(mode, t => {
      const c = layout(t, false);
      if (mode === 'count') for (let i = 0; i <= continuationLimits.files; i++) c.put(`file-${i}.txt`, 'work');
      if (mode === 'bytes') c.put('huge.txt', Buffer.alloc(continuationLimits.workFileBytes + 1));
      if (mode === 'binary') c.put('binary.txt', Buffer.from([0, 255]));
      if (mode === 'traversal') {
        c.a.sourceChange = { allowedFiles: ['../outside'], newFiles: [], source: {} };
      }
      assert.notEqual(captureContinuation(c.store, c.a).status, 'complete');
      assert.notEqual(readContinuation(c.store, c.a).status, 'complete');
    });
});

test('legacy work requires independent registered hashes and is clearly labelled', t => {
  const c = layout(t);
  const bytes = fs.readFileSync(path.join(c.output, 'changes/src/edit.mjs'));
  c.a.artifacts = [
    { path: 'changes/src/edit.mjs', kind: 'source-file', bytes: bytes.length, hash: hash(bytes) },
    { path: 'scope-request.json', kind: 'source-scope-request', bytes: 2, hash: hash('{}') },
  ];
  const legacy = readContinuation(c.store, c.a);
  assert.equal(legacy.status, 'complete');
  assert.equal(legacy.evidence, 'legacy');
  assert.equal(legacy.files.length, 1);
  assert.match(legacy.issues.join(' '), /Historical checkpoint missing/);
  fs.rmSync(path.join(c.job, 'continuation-source.json'));
  const reconciledLegacy = captureContinuation(c.store, c.a);
  assert.equal(reconciledLegacy.evidence, 'legacy');
  assert.equal(reconciledLegacy.status, 'complete');
  assert.equal(
    fs.existsSync(path.join(c.job, 'continuation')),
    false,
    'Historical evidence is never relabelled as a new checkpoint.',
  );
  c.put('changes/src/edit.mjs', 'tampered');
  assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
});

test('registered artifact tampering cannot be relabelled as fresh recovery evidence', t => {
  const c = layout(t);
  c.a.artifacts = [{ path: 'changes/src/edit.mjs', kind: 'source-file', bytes: 8, hash: hash('recorded') }];
  assert.equal(captureContinuation(c.store, c.a).status, 'unavailable');
  assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
});

test('partial capture and refused atomic publication expose no trusted file set', async t => {
  for (const mode of ['partial', 'publish'])
    await t.test(mode, t => {
      const c = layout(t);
      if (mode === 'partial') c.put('changes/src/new.mjs', Buffer.alloc(continuationLimits.fileBytes + 1));
      else
        t.mock.method(fs, 'renameSync', () => {
          throw Object.assign(new Error('Fixture publication refused'), { code: 'EACCES' });
        });
      const result = captureContinuation(c.store, c.a);
      assert.equal(result.status, 'incomplete');
      assert.equal(result.files.length, 1, 'Already copied bytes remain explicitly partial evidence.');
      const checked = readContinuation(c.store, c.a);
      assert.notEqual(checked.status, 'complete');
      assert.deepEqual(checked.files, []);
      assert.equal(
        fs.readdirSync(c.job).some(file => /^continuation-[a-f0-9]/.test(file)),
        false,
        'No temporary publication is exposed.',
      );
    });
});

test('aggregate byte limits and bounded chunk reads hold for complete regular work files', t => {
  const c = layout(t, false),
    bytes = Buffer.alloc(continuationLimits.workFileBytes, 'x'),
    readSync = fs.readSync;
  for (let i = 0; i <= continuationLimits.totalBytes / bytes.length; i++)
    c.put(`work-${String(i).padStart(3, '0')}.txt`, bytes);
  let largestRead = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    largestRead = Math.max(largestRead, length);
    return readSync(fd, buffer, offset, length, position);
  });
  const result = captureContinuation(c.store, c.a);
  assert.equal(result.status, 'incomplete');
  assert.equal(
    result.files.reduce((total, item) => total + item.bytes, 0),
    continuationLimits.totalBytes,
  );
  assert.ok(largestRead <= 64 * 1024);
  assert.deepEqual(readContinuation(c.store, c.a).files, []);
});

test('a short publication interruption still preserves a complete checkpoint', t => {
  const c = layout(t),
    rename = fs.renameSync;
  let interrupted = false;
  t.mock.method(fs, 'renameSync', (...args) => {
    if (!interrupted) {
      interrupted = true;
      throw Object.assign(new Error('Temporary sharing lock'), { code: 'EBUSY' });
    }
    return rename(...args);
  });
  assert.equal(captureContinuation(c.store, c.a).status, 'complete');
  assert.equal(readContinuation(c.store, c.a).status, 'complete');
});

test('safe Unicode and hyphenated work paths retain their exact identities', t => {
  const c = layout(t, false);
  c.put('draft/résumé.md', 'Unicode work.');
  c.put('-notes.txt', 'Notes.');
  const checkpoint = captureContinuation(c.store, c.a);
  assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
  assert.deepEqual(
    checkpoint.files.map(item => item.path),
    ['-notes.txt', 'draft/résumé.md'],
  );
  assert.equal(readContinuation(c.store, c.a).status, 'complete');
});

test('route-folder paths with parentheses and square brackets carry into the next attempt', async t => {
  await t.test('carried', t => {
    const c = layout(t),
      file = 'changes/src/app/(frontend)/[member]/page.mjs',
      bytes = Buffer.from('// Member page.\n');
    c.a.sourceChange.newFiles.push('src/app/(frontend)/[member]/page.mjs');
    prepareSourceContinuation(c.store, c.a);
    c.put(file, bytes);
    const checkpoint = captureContinuation(c.store, c.a);
    assert.equal(checkpoint.status, 'complete', JSON.stringify(checkpoint));
    const carried = checkpoint.files.find(item => item.path === file);
    assert.deepEqual(carried, { path: file, bytes: bytes.length, hash: hash(bytes) });
    assert.equal(readContinuation(c.store, c.a).status, 'complete');
    // The next attempt receives the checkpoint's bytes only when they match the recorded hash.
    assert.deepEqual(continuationFile(c.store, c.a, file, hash(bytes)), bytes);
    assert.throws(() => continuationFile(c.store, c.a, file, hash('other')), /changed after it was recorded/);
  });
  for (const file of ['src/app/[slug]./page.mjs', 'src/app/con.mjs'])
    await t.test(file, t => {
      const c = layout(t);
      assert.throws(() => continuationFile(c.store, c.a, 'changes/' + file, hash('')), /Unsafe continuation path/);
      c.a.sourceChange.newFiles.push(file);
      const checkpoint = captureContinuation(c.store, c.a);
      assert.equal(checkpoint.status, 'unavailable');
      assert.match(checkpoint.issues.join(' '), /Invalid continuation source scope/);
    });
});

// A general work step's attempts as the store lists them, oldest first.
function workStep(t) {
  const c = layout(t, false),
    attempts = [];
  c.store.attempts = taskId => attempts.filter(a => a.taskId === taskId);
  c.task = { id: c.a.taskId };
  c.review = { ...c.a, id: 'attempt-review', assignment: { ...c.a.assignment, kind: 'general:review' } };
  return { ...c, attempts };
}

test('a general work step continues from its latest work attempt and ignores review attempts', t => {
  const c = workStep(t);
  c.put('draft/notes.md', 'Work to continue.\n');
  assert.equal(captureContinuation(c.store, c.a).status, 'complete');
  c.attempts.push(c.a);
  const carried = {
    attemptId: c.a.id,
    files: [{ path: 'draft/notes.md', hash: hash('Work to continue.\n'), bytes: 18 }],
  };
  assert.deepEqual(generalWorkContinuation(c.store, c.task), carried);
  // A later review, even one still running, is never the work to continue.
  c.attempts.push({ ...c.review, status: 'running' });
  assert.deepEqual(generalWorkContinuation(c.store, c.task), carried);
  // More files than a result may return start fresh with the reason.
  assert.deepEqual(generalWorkContinuation(c.store, c.task, null, { maxFiles: 0 }), {
    attemptId: c.a.id,
    files: [],
    fresh: { reason: 'it recorded 1 work files, more than the 0 a result may return' },
  });
  // The latest work attempt must have stopped, and been reconciled after an interruption.
  for (const status of ['running', 'stopping', 'interrupted', 'quarantined']) {
    c.a.status = status;
    assert.throws(() => generalWorkContinuation(c.store, c.task), /has not stopped and been reconciled/, status);
  }
  c.a.reconciledAt = new Date().toISOString();
  assert.equal(generalWorkContinuation(c.store, c.task).attemptId, c.a.id);
});

test('a general work step with no earlier work attempt has nothing to continue from', t => {
  const c = workStep(t);
  assert.equal(generalWorkContinuation(c.store, c.task), null);
  c.attempts.push(c.review);
  assert.equal(generalWorkContinuation(c.store, c.task), null, 'An earlier review is not earlier work.');
  c.attempts.push(c.a);
  assert.equal(generalWorkContinuation(c.store, c.task, c.a.id), null, 'The starting attempt is not earlier work.');
});

test('an incomplete or foreign general work checkpoint starts fresh with a readable reason', async t => {
  await t.test('incomplete', t => {
    const c = workStep(t);
    c.put('a.md', 'Copied before the failure.\n');
    c.put('b.md', Buffer.from([0, 255]));
    assert.equal(captureContinuation(c.store, c.a).status, 'incomplete');
    c.attempts.push(c.a);
    assert.deepEqual(generalWorkContinuation(c.store, c.task), {
      attemptId: c.a.id,
      files: [],
      fresh: { reason: 'its recorded work could not be verified (General continuation work must be UTF-8 text.)' },
    });
  });
  await t.test('another project', t => {
    const c = workStep(t);
    c.put('notes.md', 'Work.\n');
    assert.equal(captureContinuation(c.store, c.a).status, 'complete');
    const manifestFile = path.join(c.job, 'continuation/manifest.json'),
      manifest = JSON.parse(fs.readFileSync(manifestFile));
    fs.writeFileSync(
      manifestFile,
      JSON.stringify({ ...manifest, identity: { ...manifest.identity, projectId: 'project-other' } }),
    );
    c.attempts.push(c.a);
    const fresh = generalWorkContinuation(c.store, c.task);
    assert.deepEqual(fresh.files, []);
    assert.equal(fresh.fresh.reason, 'its recorded work could not be verified (Foreign continuation identity.)');
  });
});

test('a dangling checkpoint link cannot enable fallback to legacy output', t => {
  const c = layout(t),
    lstat = fs.lstatSync,
    exists = fs.existsSync;
  const bytes = fs.readFileSync(path.join(c.output, 'changes/src/edit.mjs'));
  c.a.artifacts = [{ path: 'changes/src/edit.mjs', kind: 'source-file', bytes: bytes.length, hash: hash(bytes) }];
  const checkpointRoot = path.join(c.job, 'continuation');
  fs.mkdirSync(checkpointRoot);
  t.mock.method(fs, 'existsSync', filename => (String(filename) === checkpointRoot ? false : exists(filename)));
  t.mock.method(fs, 'lstatSync', (filename, ...args) => {
    const stat = lstat(filename, ...args);
    return String(filename) === checkpointRoot
      ? new Proxy(stat, {
          get: (target, key) => (key === 'isSymbolicLink' ? () => true : Reflect.get(target, key)),
        })
      : stat;
  });
  assert.equal(readContinuation(c.store, c.a).status, 'unavailable');
  assert.equal(captureContinuation(c.store, c.a).status, 'unavailable');
});
