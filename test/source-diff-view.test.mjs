import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { sourceDiff, sourceDiffStat } from '../src/connectors/source-diff.mjs';
import { hash } from '../src/core/contracts.mjs';
import { dashboardAttempt } from '../src/core/dashboard-state.mjs';

// The helper executes with no document, window, fetch, filesystem or controller.
// Only the trusted helper code is evaluated; diff and staged content stay data.
const context = vm.createContext({ TextEncoder, crypto: webcrypto });
vm.runInContext(fs.readFileSync(new URL('../public/source-diff.js', import.meta.url), 'utf8'), context);
const api = context.StudioSourceDiff;
const plain = value => JSON.parse(JSON.stringify(value));
const instant = minute => `2026-10-21T10:${String(minute).padStart(2, '0')}:00.000Z`;
const staged = changes =>
  changes.map(({ path, before, after }) => ({
    path,
    beforeHash: before === null ? null : hash(before),
    afterHash: after === null ? null : hash(after),
    bytes: after === null ? 0 : Buffer.byteLength(after),
    ...(after === null ? {} : { artifact: `changes/${path}` }),
  }));

function fixture(changes, { id = 'implementation-1', minute = 1, legacy = false } = {}) {
  const manifest = {
    schemaVersion: 'source-change-v1',
    proposal: { taskId: 'planning' },
    baseHash: hash('base'),
    candidateHash: hash(id),
    changes: staged(changes),
    ...(legacy ? {} : { diffFormat: 'unified-full-deletions-v1' }),
  };
  const value = { manifest, manifestText: JSON.stringify(manifest), diffText: sourceDiff(changes) };
  const attempt = {
    id,
    taskId: 'story',
    projectId: 'project',
    workerId: 'engineer',
    status: 'accepted',
    startedAt: instant(minute),
    finishedAt: instant(minute + 1),
    assignment: { kind: 'studio-development:change' },
    sourceCandidate: { sourceHash: manifest.candidateHash, files: [{ detail: 'not in summary' }] },
    result: { outcome: 'completed', summary: 'Fixture implementation', checks: [], issues: [] },
  };
  const task = {
    id: 'story',
    projectId: 'project',
    kind: 'studio-development:change',
    lastAttemptId: id,
    sourceStage: {
      version: 'source-story-stages-v1',
      phase: 'candidate-review',
      current: 'candidate-review',
      history: [],
    },
  };
  const refresh = () => {
    value.manifestText = JSON.stringify(value.manifest);
    attempt.artifacts = [
      { path: 'source-change.json', kind: 'source-change', hash: hash(value.manifestText) },
      { path: 'change.diff', kind: 'source-change-diff', hash: hash(value.diffText) },
      ...value.manifest.changes
        .filter(c => c.artifact)
        .map(c => ({
          path: c.artifact,
          kind: 'source-file',
          hash: c.afterHash,
        })),
    ];
    task.sourceStage.candidate = {
      taskId: 'story',
      attemptId: id,
      workerId: 'engineer',
      path: 'source-change.json',
      hash: attempt.artifacts[0].hash,
      candidateHash: attempt.sourceCandidate.sourceHash,
    };
    value.selection = api.selectCandidate(task, [attempt]);
  };
  Object.assign(value, { changes, attempt, task, refresh });
  refresh();
  value.parse = () => api.parseDiff(value);
  value.register = (model, path, text = changes.find(c => c.path === path).after, extra = {}) =>
    api.registerAfterText(model, path, { key: value.selection.key, artifact: `changes/${path}`, text, ...extra });
  return value;
}

function reviewFor(f, { id = 'review-1', status = 'accepted', verdict = 'pass', minute = 5 } = {}) {
  const ref = f.task.sourceStage.candidate;
  const review = {
    id,
    taskId: 'story',
    projectId: 'project',
    workerId: 'reviewer',
    status,
    startedAt: instant(minute),
    finishedAt: status === 'running' ? null : instant(minute + 1),
    assignment: { kind: 'studio-development:change-review', acceptedInputs: [{ detail: 'full only' }] },
    candidateReview: {
      taskId: ref.taskId,
      attemptId: ref.attemptId,
      path: ref.path,
      hash: ref.hash,
      candidateHash: ref.candidateHash,
      passed: true,
    },
    inputReferences: [
      {
        taskId: 'story',
        attemptId: ref.attemptId,
        summary: 'Full-detail-only input summary',
        artifacts: f.attempt.artifacts
          .filter(a => a.kind !== 'source-file')
          .map((a, i) => ({
            ...a,
            path: `../inputs/story/${i}-${a.path.split('/').at(-1)}`,
          })),
      },
    ],
    ...(status === 'running'
      ? { artifacts: [] }
      : {
          artifacts: [{ path: 'source-change-review.json', kind: 'source-change-review', hash: hash(id) }],
          result: { outcome: 'completed', summary: 'Independent fixture review', checks: [], issues: [] },
          candidateReviewVerdict: verdict,
        }),
  };
  return review;
}

function allSlices(model, path, { rowBudget = 7, textByteBudget = 31, rangeId } = {}) {
  const chunks = [];
  let cursor,
    pages = 0;
  do {
    const page = rangeId
      ? api.rangeSlice(model, path, rangeId, { cursor, rowBudget, textByteBudget })
      : api.fileSlice(model, path, { cursor, rowBudget, textByteBudget });
    assert.equal(page.status, 'available', page.reason);
    assert.ok(page.rows.length <= rowBudget);
    assert.ok(page.textBytes <= textByteBudget);
    assert.equal(
      page.textBytes,
      page.rows.reduce((n, row) => n + Buffer.byteLength(row.text + row.lineEnding), 0),
    );
    assert.ok(page.rows.length > 0 || page.nextCursor === null, 'Every nonterminal page makes progress');
    if (page.nextCursor) assert.notDeepEqual(plain(page.nextCursor), cursor && plain(cursor));
    chunks.push(...page.rows);
    cursor = page.nextCursor;
    assert.ok(++pages < 200000, 'All content remains reachable');
  } while (cursor);
  const rows = [];
  for (const chunk of chunks) {
    const last = rows.at(-1);
    if (last && last.index === chunk.index) {
      assert.equal(last.textEnd, chunk.textOffset);
      assert.equal(last.complete, false);
      last.text += chunk.text;
      last.textEnd = chunk.textEnd;
      last.complete = chunk.complete;
      last.lineEnding = chunk.lineEnding;
      last.noFinalNewline = chunk.noFinalNewline;
    } else rows.push({ ...chunk });
  }
  assert.ok(rows.every(row => row.complete));
  return rows;
}

test('generated multi-file evidence preserves operations, counts, line numbers, CRLF, EOF and inert source', async () => {
  const base = Array.from({ length: 80 }, (_, i) => `line ${i}\n`).join('');
  const hostile =
    'diff --git a/fake b/fake\n--- a/pretend\n+++ b/pretend\n@@ -99 +99 @@\n' +
    '<script>globalThis.executed = true</script>\n<style>@import "https://invalid.example/a.css";</style>\n' +
    '<svg onload="fetch(\'https://invalid.example\')"></svg>\nhttps://invalid.example/path\n';
  const changes = [
    { path: 'src/edit.js', before: base, after: base.replace('line 10\n', 'TEN\n').replace('line 60\n', '') },
    { path: 'src/new.js', before: null, after: hostile },
    { path: 'docs/deleted.md', before: hostile + 'last', after: null },
    { path: 'empty-created', before: null, after: '' },
    { path: 'empty-deleted', before: '', after: null },
    { path: 'crlf', before: 'a\r\nb\r\nc\r\n', after: 'a\r\nB\r\nc' },
    { path: '__proto__', before: null, after: 'constructor\nprototype\n' },
    { path: '<img onerror=throw>.txt', before: 'old', after: '<b>literal</b>' },
  ];
  const f = fixture(changes),
    model = await f.parse();
  assert.equal(model.status, 'available', model.reason);
  assert.equal(model.files.length, changes.length);
  assert.deepEqual(plain(model.files.map(x => [x.path, x.operation, x.added, x.removed])), [
    ['src/edit.js', 'edited', 1, 2],
    ['src/new.js', 'created', 8, 0],
    ['docs/deleted.md', 'deleted', 0, 9],
    ['empty-created', 'created', 0, 0],
    ['empty-deleted', 'deleted', 0, 0],
    ['crlf', 'edited', 2, 2],
    ['__proto__', 'created', 2, 0],
    ['<img onerror=throw>.txt', 'edited', 1, 1],
  ]);
  const edited = allSlices(model, 'src/edit.js');
  assert.deepEqual(
    edited.filter(r => ['added', 'removed'].includes(r.kind)).map(r => [r.kind, r.oldLine, r.newLine, r.text]),
    [
      ['removed', 11, null, 'line 10'],
      ['added', null, 11, 'TEN'],
      ['removed', 61, null, 'line 60'],
    ],
  );
  assert.ok(model.files[0].ranges.length >= 3, 'Before, between and trailing omitted ranges');
  assert.equal(
    allSlices(model, 'src/new.js')
      .map(r => r.text + r.lineEnding)
      .join(''),
    hostile,
  );
  const removed = allSlices(model, 'docs/deleted.md');
  assert.equal(removed.at(-1).noFinalNewline, true);
  assert.equal(removed.at(-1).oldLine, 9);
  const crlf = allSlices(model, 'crlf');
  assert.equal(crlf.find(r => r.text === 'a').lineEnding, '\r\n');
  assert.equal(crlf.at(-1).lineEnding, '');
  assert.equal(crlf.at(-1).noFinalNewline, true);
  assert.equal(context.executed, undefined);
  assert.equal(context.fetch, undefined);
  assert.equal(context.document, undefined);
  for (const c of changes.filter(c => c.after !== null)) {
    const expanded = await f.register(model, c.path);
    assert.equal(expanded.status, 'available', `${c.path}: ${expanded.reason}`);
  }
});

test('unchanged ranges expand only from exact registered candidate text, including the previously unknown tail', async () => {
  const before = Array.from({ length: 100 }, (_, i) => `${i}: old\r\n`).join('') + 'tail';
  const after = before.replace('20: old', 'twenty').replace('70: old\r\n', '');
  const f = fixture([{ path: 'large', before, after }]),
    model = await f.parse();
  assert.equal(model.files[0].ranges.at(-1).count, null);
  assert.equal(api.rangeSlice(model, 'large', model.files[0].ranges[0].id).status, 'unavailable');
  const expanded = await f.register(model, 'large');
  assert.equal(expanded.status, 'available', expanded.reason);
  assert.equal(model.files[0].afterText, 'not-loaded', 'Registration does not mutate a previously published model');
  assert.equal(expanded.files[0].afterText, 'registered');
  const ordinary = allSlices(expanded, 'large'),
    all = [];
  for (const row of ordinary) {
    if (row.kind === 'omitted')
      all.push(...allSlices(expanded, 'large', { rangeId: row.id, rowBudget: 3, textByteBudget: 11 }));
    else all.push(row);
  }
  assert.equal(
    all
      .filter(r => r.kind !== 'removed')
      .map(r => r.text + r.lineEnding)
      .join(''),
    after,
  );
  assert.equal(
    all
      .filter(r => r.kind !== 'added')
      .map(r => r.text + r.lineEnding)
      .join(''),
    before,
  );
  assert.equal(all.at(-1).oldLine, 101);
  assert.equal(all.at(-1).newLine, 100);
  assert.equal(all.at(-1).noFinalNewline, true);
  for (const input of [
    { text: after.replace('tail', 'live') },
    { text: before },
    { key: 'other-candidate' },
    { artifact: '../source/large' },
    { artifact: 'changes/another' },
  ]) {
    const invalid = await f.register(model, 'large', after, input);
    assert.equal(invalid.status, 'invalid', JSON.stringify(input));
  }
});

test('registration reverse-checks omitted data against beforeHash instead of fabricating old context', async () => {
  const before = Array.from({ length: 50 }, (_, i) => `${i}\n`).join('');
  const f = fixture([{ path: 'file', before, after: before.replace('20\n', 'NEW\n') }]);
  f.diffText = f.diffText.replace('-20\n', '-unrecorded\n');
  f.refresh();
  const model = await f.parse();
  assert.equal(model.status, 'available');
  const invalid = await f.register(model, 'file');
  assert.equal(invalid.status, 'invalid');
  assert.match(invalid.reason, /recorded original/);
});

test('unchanged long lines expand incrementally, and omitted tails cannot follow an original EOF marker', async () => {
  const long = '😀'.repeat(60000),
    before = long + '\n' + 'same\n'.repeat(20) + 'old\n' + 'same\n'.repeat(20);
  const f = fixture([{ path: 'file', before, after: before.replace('old\n', 'new\n') }]);
  const parsed = await f.parse(),
    registered = await f.register(parsed, 'file');
  assert.equal(registered.status, 'available', registered.reason);
  const expanded = allSlices(registered, 'file', {
    rangeId: registered.files[0].ranges[0].id,
    rowBudget: 2,
    textByteBudget: 1024,
  });
  assert.equal(expanded[0].text, long);
  assert.equal(expanded[0].oldLine, 1);
  assert.equal(expanded[0].newLine, 1);

  // These bytes would hash to the original if concatenated blindly, but a
  // no-newline marker cannot precede another original logical line.
  const invalid = fixture([{ path: 'file', before: 'ab\n', after: 'b\n' }]);
  invalid.diffText =
    'diff --git a/file b/file\n--- a/file\n+++ b/file\n' + '@@ -1 +0,0 @@\n-a\n\\ No newline at end of file\n';
  invalid.refresh();
  const malformed = await invalid.parse();
  assert.equal(malformed.status, 'available');
  const refused = await invalid.register(malformed, 'file');
  assert.equal(refused.status, 'invalid');
  assert.match(refused.reason, /original final line/);
});

test('generated edit sequences round-trip both sides with additions, removals and changes at EOF', async () => {
  let seed = 17;
  const random = n => (seed = (seed * 48271) % 2147483647) % n;
  for (let round = 0; round < 80; round++) {
    const eol = round % 2 ? '\r\n' : '\n';
    const rows = Array.from({ length: 45 }, (_, i) => `line ${i}${eol}`);
    if (round % 3 === 0) rows[rows.length - 1] = 'unterminated';
    const before = rows.join('');
    for (let i = 0; i < 8; i++) {
      const at = random(rows.length);
      if (random(3) === 0) rows.splice(at, 1);
      else rows.splice(at, random(2), `@@ -fake +fake @@ ${round}${eol}`);
    }
    if (round % 4 === 0) rows.push('new final line');
    const after = rows.join('');
    const f = fixture([{ path: 'random', before, after }]);
    const model = await f.parse();
    assert.equal(model.status, 'available', `round ${round}: ${model.reason}`);
    const expanded = await f.register(model, 'random');
    assert.equal(expanded.status, 'available', `round ${round}: ${expanded.reason}`);
    const complete = [];
    for (const row of allSlices(expanded, 'random', { textByteBudget: 13 })) {
      if (row.kind === 'omitted') complete.push(...allSlices(expanded, 'random', { rangeId: row.id }));
      else complete.push(row);
    }
    assert.equal(
      complete
        .filter(r => r.kind !== 'removed')
        .map(r => r.text + r.lineEnding)
        .join(''),
      after,
    );
    assert.equal(
      complete
        .filter(r => r.kind !== 'added')
        .map(r => r.text + r.lineEnding)
        .join(''),
      before,
    );
  }
});

test('near-limit diffs, many short rows and a single Unicode long line are entirely reachable in finite slices', async () => {
  const many = 'x\n'.repeat(54000),
    long = '😀é漢'.repeat(3500) + 'END';
  const f = fixture([
    { path: 'many', before: null, after: many },
    { path: 'long', before: null, after: long },
  ]);
  assert.ok(Buffer.byteLength(f.diffText) > 180 * 1024);
  assert.ok(Buffer.byteLength(f.diffText) <= api.limits.diffBytes);
  const model = await f.parse();
  assert.equal(model.status, 'available', model.reason);
  assert.equal(model.files[0].added, 54000);
  const shortRows = allSlices(model, 'many', { rowBudget: 97, textByteBudget: 1000 });
  assert.equal(shortRows.length, 54000);
  assert.equal(shortRows.at(-1).newLine, 54000);
  assert.equal(shortRows.map(r => r.text + r.lineEnding).join(''), many);
  const longRows = allSlices(model, 'long', { rowBudget: 2, textByteBudget: 7 });
  assert.equal(longRows.length, 1);
  assert.equal(longRows[0].text, long);
  assert.equal(longRows[0].noFinalNewline, true);
});

test('finite budget and cursor validation prevents unbounded calls or broken surrogate chunks', async () => {
  const f = fixture([{ path: 'long', before: null, after: '😀abc\n' }]),
    model = await f.parse();
  for (const options of [
    { rowBudget: Infinity },
    { rowBudget: 0 },
    { rowBudget: 501 },
    { textByteBudget: Infinity },
    { textByteBudget: 3 },
    { textByteBudget: 65537 },
    { cursor: { row: -1, offset: 0 } },
    { cursor: { row: 0, offset: 1 } },
    { cursor: { row: 0, offset: 100 } },
    { cursor: { row: 99, offset: 0 } },
  ])
    assert.throws(() => api.fileSlice(model, 'long', options));
  const page = api.fileSlice(model, 'long', { textByteBudget: 4 });
  assert.equal(page.rows[0].text, '😀');
  assert.equal(page.rows[0].complete, false);
  assert.deepEqual(plain(page.nextCursor), { row: 0, offset: 2 });
  const endings = fixture([{ path: 'crlf', before: null, after: 'abcd\r\n\r\n\r\n' }]);
  const endingModel = await endings.parse();
  assert.equal(
    allSlices(endingModel, 'crlf', { textByteBudget: 4 })
      .map(r => r.text + r.lineEnding)
      .join(''),
    'abcd\r\n\r\n\r\n',
    'Terminators also consume the text-byte budget and remain reachable',
  );
});

test('legacy header-only deletions explicitly lack counts/content; full empty deletions remain exact', async () => {
  const f = fixture(
    [
      { path: 'gone', before: 'lost\ntext\n', after: null },
      { path: 'kept', before: null, after: 'present\n' },
    ],
    { legacy: true },
  );
  f.diffText = f.diffText.replace('@@ -1,2 +0,0 @@\n-lost\n-text\n', '');
  f.refresh();
  const model = await f.parse();
  assert.equal(model.status, 'incomplete');
  assert.equal(model.files[0].operation, 'deleted');
  assert.equal(model.files[0].removed, null);
  assert.equal(model.files[0].added, null);
  assert.match(model.files[0].reason, /header-only/);
  assert.equal(api.fileSlice(model, 'gone').status, 'unavailable');
  assert.equal(allSlices(model, 'kept')[0].text, 'present');
  const modern = fixture([{ path: 'empty', before: '', after: null }]);
  const full = await modern.parse();
  assert.equal(full.status, 'available');
  assert.equal(full.files[0].removed, 0);
  assert.equal(api.fileSlice(full, 'empty').rows.length, 0);
  f.manifest.diffFormat = 'unified-full-deletions-v1';
  f.refresh();
  assert.equal((await f.parse()).status, 'invalid', 'New format cannot silently omit nonempty deletion evidence');
});

test('malformed or mismatched hunks and manifests fail visibly, even with correctly re-recorded artifact hashes', async () => {
  const changes = [
    { path: 'a', before: 'one\ntwo\n', after: 'one\nTWO\n' },
    { path: 'b', before: null, after: 'new\n' },
  ];
  const mutations = [
    f => {
      f.diffText = f.diffText.slice(0, -1);
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -1,9 +1,2 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -2,2 +1,2 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -0,2 +0,2 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -9007199254740992,2 +1,2 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -999,2 +999,2 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ -0,0 +0,0 @@');
    },
    f => {
      f.diffText = f.diffText.replace('@@ -1,2 +1,2 @@', '@@ bad @@');
    },
    f => {
      f.diffText = f.diffText.replace(' one\n', ' one\n\\ No newline at end of file\n');
    },
    f => {
      f.diffText += '+extra\n';
    },
    f => {
      f.diffText = f.diffText.replace('+new\n', '+wrong\n');
    },
    f => {
      f.manifest.changes.reverse();
    },
    f => {
      f.manifest.changes.push(f.manifest.changes[0]);
    },
    f => {
      f.manifest.changes[0].afterHash = null;
    },
    f => {
      f.manifest.changes[0].path = '../a';
    },
    f => {
      f.manifest.changes[0].path = 'a\nmalicious';
    },
    f => {
      f.manifest.changes[0].beforeHash = 'bad';
    },
    f => {
      f.manifest.changes[1].bytes = 999;
    },
    f => {
      f.manifest.changes[1].artifact = 'current-source/b';
    },
    f => {
      f.manifest.candidateHash = hash('another');
    },
  ];
  for (const [i, mutate] of mutations.entries()) {
    const f = fixture(changes);
    mutate(f);
    f.refresh();
    const model = await f.parse();
    assert.equal(model.status, 'invalid', `mutation ${i}: ${model.reason}`);
    assert.ok(model.reason);
    assert.equal(model.files.length, 0);
  }
  const deleted = fixture([{ path: 'd', before: 'old\n', after: null }]);
  deleted.diffText = deleted.diffText.replace('-old\n', '-other\n');
  deleted.refresh();
  assert.equal((await deleted.parse()).status, 'invalid');
});

test('hash mismatches, unsupported history, missing registrations and oversized UTF-8 inputs fail explicitly', async () => {
  const f = fixture([{ path: 'a', before: null, after: 'new\n' }]);
  assert.equal((await api.parseDiff({ ...f, diffText: f.diffText.replace('new', 'bad') })).status, 'invalid');
  assert.equal((await api.parseDiff({ ...f, manifestText: f.manifestText + ' ' })).status, 'invalid');
  const missing = plain(f.selection);
  missing.artifacts = missing.artifacts.filter(a => a.kind !== 'source-file');
  assert.equal((await api.parseDiff({ ...f, selection: missing })).status, 'invalid');
  f.manifest.schemaVersion = 'change-context-v0';
  f.refresh();
  assert.equal((await f.parse()).status, 'unavailable');
  f.manifest.schemaVersion = 'source-change-v1';
  f.manifest.diffFormat = 'future';
  f.refresh();
  assert.equal((await f.parse()).status, 'unavailable');
  for (const diffText of ['x'.repeat(api.limits.diffBytes + 1), '漢'.repeat(api.limits.diffBytes / 3 + 1)]) {
    const result = await api.parseDiff({ ...f, diffText });
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /byte limit/);
  }
  const oversized = await api.parseDiff({ ...f, manifestText: ' '.repeat(api.limits.manifestBytes + 1) });
  assert.equal(oversized.status, 'invalid');
  const broken = await api.parseDiff({ ...f, diffText: '\ud800' });
  assert.equal(broken.status, 'invalid');
});

test('controller summary and full shapes select the implementation while the latest attempt is a review', () => {
  const f = fixture([{ path: 'file', before: 'old\n', after: 'new\n' }]),
    review = reviewFor(f);
  Object.assign(f.task, { lastAttemptId: review.id, acceptedAttemptId: review.id });
  Object.assign(f.task.sourceStage, {
    current: 'waiting-for-integration',
    review: {
      taskId: 'story',
      attemptId: review.id,
      workerId: review.workerId,
      path: review.artifacts[0].path,
      hash: review.artifacts[0].hash,
      verdict: 'pass',
    },
  });
  const before = JSON.stringify({ task: f.task, attempts: [f.attempt, review] });
  for (const attempts of [[f.attempt, review], [f.attempt, review].map(a => dashboardAttempt(a, []))]) {
    const selected = api.selectCandidate(f.task, attempts);
    assert.equal(selected.status, 'available');
    assert.equal(selected.identity.attemptId, f.attempt.id);
    assert.equal(selected.review.state, 'reviewed');
    assert.equal(selected.review.verdict, 'pass');
    assert.equal(selected.key, f.selection.key);
    assert.equal(api.identityKey(selected.identity), selected.key);
    assert.equal(api.selectCandidate(f.task, attempts, { selectedAttemptId: review.id }).key, selected.key);
    assert.equal(api.selectCandidate(f.task, attempts, { reviewAttemptId: review.id }).review.state, 'reviewed');
  }
  assert.equal(JSON.stringify({ task: f.task, attempts: [f.attempt, review] }), before);
});

test('candidate-ready, running review, awaiting acceptance and integration states do not overstate review', () => {
  const f = fixture([{ path: 'file', before: null, after: 'new\n' }]);
  assert.equal(f.selection.review.state, 'awaiting-review');
  f.attempt.status = 'review';
  assert.equal(api.selectCandidate(f.task, [f.attempt]).review.state, 'awaiting-review');
  const running = reviewFor(f, { status: 'running' });
  assert.equal(api.selectCandidate(f.task, [running, f.attempt]).review.state, 'review-in-progress');
  const review = reviewFor(f);
  for (const current of ['waiting-for-integration', 'integrated']) {
    f.task.sourceStage.current = current;
    review.sourceIntegration = {
      state: current === 'integrated' ? 'integrated' : 'verifying',
      changes: [{ integratedHash: hash('formatted after integration') }],
    };
    const selected = api.selectCandidate(f.task, [review, f.attempt]);
    assert.equal(selected.review.state, 'reviewed');
    assert.equal(selected.identity.diff.hash, hash(f.diffText));
    assert.equal(selected.identity.candidateHash, f.manifest.candidateHash);
  }
});

test('replacement defaults to new completed implementation, with historical candidates and their exact reviews accessible', () => {
  const old = fixture([{ path: 'f', before: 'a\n', after: 'b\n' }]),
    review = reviewFor(old, { verdict: 'needs-work' });
  const next = fixture([{ path: 'f', before: 'a\n', after: 'c\n' }], { id: 'implementation-2', minute: 10 });
  const oldPin = old.task.sourceStage.candidate;
  old.task.sourceStage.history = [
    {
      candidate: oldPin,
      review: {
        taskId: 'story',
        attemptId: review.id,
        path: review.artifacts[0].path,
        hash: review.artifacts[0].hash,
        verdict: 'needs-work',
      },
    },
  ];
  // The replacement is complete but has not yet been accepted/pinned by the controller.
  next.attempt.status = 'review';
  let attempts = [next.attempt, review, old.attempt];
  let selected = api.selectCandidate(old.task, attempts);
  assert.equal(selected.identity.attemptId, next.attempt.id);
  assert.equal(selected.review.state, 'awaiting-review');
  assert.notEqual(selected.key, old.selection.key);
  old.task.sourceStage.candidate = next.task.sourceStage.candidate;
  const historical = api.selectCandidate(old.task, attempts, { selectedAttemptId: old.attempt.id });
  assert.equal(historical.historical, true);
  assert.equal(historical.review.state, 'reviewed');
  assert.equal(historical.review.verdict, 'needs-work');
  assert.equal(
    api.selectCandidate(old.task, attempts, { selectedAttemptId: review.id }).identity.attemptId,
    old.attempt.id,
  );
  const replacementReview = reviewFor(next, { id: 'review-2', status: 'running', minute: 12 });
  attempts = [replacementReview, ...attempts];
  assert.equal(api.selectCandidate(old.task, attempts).review.state, 'review-in-progress');
  assert.equal(api.selectCandidate(old.task, attempts.slice().reverse()).key, selected.key);
});

test('exact review identity, independent employee and forwarded manifest AND diff hashes are required', () => {
  const f = fixture([{ path: 'file', before: null, after: 'new\n' }]);
  const mutations = [
    r => {
      r.candidateReview.hash = hash('other manifest');
    },
    r => {
      r.candidateReview.candidateHash = hash('other candidate');
    },
    r => {
      r.candidateReview.attemptId = 'other-attempt';
    },
    r => {
      r.candidateReview.taskId = 'other-task';
    },
    r => {
      r.candidateReview.passed = false;
    },
    r => {
      r.inputReferences[0].attemptId = 'other-attempt';
    },
    r => {
      r.inputReferences[0].artifacts.find(a => a.kind === 'source-change-diff').hash = hash('other diff');
    },
    r => {
      r.inputReferences[0].artifacts = r.inputReferences[0].artifacts.filter(a => a.kind !== 'source-change');
    },
    r => {
      r.workerId = f.attempt.workerId;
    },
    r => {
      r.result.outcome = 'blocked';
    },
    r => {
      r.candidateReviewVerdict = undefined;
    },
    r => {
      r.artifacts = [];
    },
  ];
  for (const mutate of mutations) {
    const review = reviewFor(f);
    mutate(review);
    const result = api.selectCandidate(f.task, [f.attempt, review]);
    assert.notEqual(result.review.state, 'reviewed');
    assert.equal(result.review.verdict, null);
  }
  const review = reviewFor(f);
  f.task.sourceStage.review = {
    taskId: 'story',
    attemptId: review.id,
    path: 'source-change-review.json',
    hash: hash('tampered pin'),
    verdict: 'pass',
  };
  assert.notEqual(api.selectCandidate(f.task, [f.attempt, review]).review.state, 'reviewed');
});

test('selection is deterministic, project-scoped and explicitly unavailable for unsupported historical evidence', () => {
  const f = fixture([{ path: 'file', before: null, after: 'new\n' }]);
  const review = reviewFor(f);
  assert.equal(api.selectCandidate(f.task, [review]).status, 'unavailable');
  assert.equal(api.selectCandidate(f.task, [f.attempt], { selectedAttemptId: 'missing' }).status, 'unavailable');
  assert.equal(api.selectCandidate(f.task, [{ ...f.attempt, projectId: 'another' }]).status, 'unavailable');
  const older = { ...f.attempt, artifacts: f.attempt.artifacts.filter(a => a.path !== 'change.diff') };
  assert.equal(api.selectCandidate(f.task, [older]).status, 'unavailable');
  const failed = { ...f.attempt, id: 'partial', status: 'failed', finishedAt: instant(50) };
  assert.equal(api.selectCandidate(f.task, [failed, f.attempt]).identity.attemptId, f.attempt.id);
  const tied = fixture([{ path: 'f', before: null, after: 'tied\n' }], { id: 'implementation-z' });
  assert.equal(api.selectCandidate(f.task, [tied.attempt, f.attempt]).identity.attemptId, tied.attempt.id);
  assert.equal(api.selectCandidate(f.task, [f.attempt, tied.attempt]).identity.attemptId, tied.attempt.id);
  const legacyReviewTask = { id: 'separate-review', projectId: 'project', kind: 'studio-development:change-review' };
  review.taskId = legacyReviewTask.id;
  assert.equal(api.selectCandidate(legacyReviewTask, [review, f.attempt]).identity.attemptId, f.attempt.id);
  const wrongPin = plain(f.task);
  wrongPin.sourceStage.candidate.hash = hash('wrong');
  assert.equal(api.selectCandidate(wrongPin, [f.attempt]).status, 'unavailable');
});

test("a diff's size counts its files and changed lines, never its headers", () => {
  const diff = sourceDiff([
    { path: 'a.txt', before: 'one\ntwo\n', after: 'one\nthree\nfour\n' },
    { path: 'b.txt', before: null, after: 'new\n' },
    // Removed, this line reads "--- dash", like a header.
    { path: 'c.txt', before: 'gone\n-- dash\n', after: null },
  ]);
  assert.deepEqual(sourceDiffStat(diff), { files: 3, added: 3, removed: 3 });
  assert.deepEqual(sourceDiffStat(''), { files: 0, added: 0, removed: 0 });
  // The dashboard's compact attempt keeps the size with the candidate's hash, and nothing else of it.
  const compact = dashboardAttempt({
    id: 'sized',
    status: 'succeeded',
    sourceCandidate: { sourceHash: hash('candidate'), diffStat: sourceDiffStat(diff), files: [{ path: 'a.txt' }] },
  });
  assert.deepEqual(compact.sourceCandidate, {
    sourceHash: hash('candidate'),
    diffStat: { files: 3, added: 3, removed: 3 },
  });
});
