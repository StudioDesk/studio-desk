import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceDiff, verifySourceDiff } from '../src/connectors/source-diff.mjs';
import { hash } from '../src/core/contracts.mjs';

const recorded = changes =>
  changes.map(({ path, before, after }) => ({
    path,
    beforeHash: before === null ? null : hash(before),
    afterHash: after === null ? null : hash(after),
  }));
const verify = (diff, changes) =>
  verifySourceDiff(diff, recorded(changes), file => changes.find(item => item.path === file).after);
const base = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n';

test('a candidate diff shows edits in unified hunks with context, and verifies against the files', () => {
  const after = base
      .replace('line 10\n', 'line ten\n')
      .replace('line 50\n', '')
      .replace('line 59\n', 'line 59\nadded\n'),
    changes = [{ path: 'src/a.mjs', before: base, after }],
    diff = sourceDiff(changes);
  assert.equal(
    diff,
    [
      'diff --git a/src/a.mjs b/src/a.mjs',
      '--- a/src/a.mjs',
      '+++ b/src/a.mjs',
      '@@ -6,11 +6,11 @@',
      ...[5, 6, 7, 8, 9].map(i => ` line ${i}`),
      '-line 10',
      '+line ten',
      ...[11, 12, 13, 14, 15].map(i => ` line ${i}`),
      '@@ -46,15 +46,15 @@',
      ...[45, 46, 47, 48, 49].map(i => ` line ${i}`),
      '-line 50',
      ...[51, 52, 53, 54, 55, 56, 57, 58, 59].map(i => ` line ${i}`),
      '+added',
      '',
    ].join('\n'),
  );
  verify(diff, changes);
});

test('created, deleted, CRLF and unterminated files round-trip through their diff', () => {
  const changes = [
    { path: 'docs/gone.md', before: 'old\ntext\n', after: null },
    { path: 'docs/empty.md', before: '', after: null },
    { path: 'docs/crlf.md', before: 'one\r\ntwo\r\n', after: null },
    { path: 'docs/tail.md', before: 'first\r\nlast', after: null },
    { path: 'src/crlf.mjs', before: 'one\r\ntwo\r\nthree\r\n', after: 'one\r\nTWO\r\nthree' },
    { path: 'src/empty.mjs', before: null, after: '' },
    { path: 'src/new.mjs', before: null, after: 'first\nlast' },
    { path: 'src/tail.mjs', before: 'a\nb', after: 'a\nb\n' },
  ];
  const diff = sourceDiff(changes);
  assert.ok(
    diff.includes('deleted file mode 100644\n--- a/docs/gone.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-old\n-text\n'),
  );
  assert.ok(diff.includes('--- a/docs/empty.md\n+++ /dev/null\ndiff --git'), 'An empty deletion has no hunk.');
  assert.ok(diff.includes('--- a/docs/crlf.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\r\n-two\r\n'));
  assert.ok(
    diff.includes(
      '--- a/docs/tail.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\r\n-last\n\\ No newline at end of file\n',
    ),
  );
  assert.ok(diff.includes(' one\r\n-two\r\n-three\r\n+TWO\r\n+three\n\\ No newline at end of file\n'), diff);
  assert.ok(diff.includes('+++ b/src/empty.mjs\ndiff --git'), 'An empty new file has no hunk.');
  assert.ok(diff.includes('@@ -0,0 +1,2 @@\n+first\n+last\n\\ No newline at end of file\n'));
  verify(diff, changes);
});

test('random edits always produce a diff that verifies, including rewrites beyond the edit search', () => {
  let seed = 11;
  const random = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let round = 0; round < 200; round++) {
    const rows = base.split('\n');
    for (let edit = 0; edit < 1 + random(12); edit++) {
      const at = random(rows.length);
      [() => rows.splice(at, 0, 'added ' + round), () => rows.splice(at, 1), () => (rows[at] = 'changed')][random(3)]();
    }
    const after = rows.join('\n');
    if (after !== base)
      verify(sourceDiff([{ path: 'src/a.mjs', before: base, after }]), [{ path: 'src/a.mjs', before: base, after }]);
  }
  // A rewrite with more line edits than the search allows is shown as removed, then added.
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n'),
    after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n'),
    changes = [{ path: 'src/big.mjs', before, after }];
  verify(sourceDiff(changes), changes);
});

test('a diff that does not show exactly the recorded change is refused', () => {
  const after = base.replace('line 30\n', 'line thirty\n'),
    changes = [
      { path: 'src/a.mjs', before: base, after },
      { path: 'src/b.mjs', before: null, after: 'new\n' },
    ],
    diff = sourceDiff(changes),
    refused = (text, reason) =>
      assert.throws(() => verify(text, changes), {
        message: new RegExp(`does not match the recorded change: ${reason}`),
      });
  verify(diff, changes);
  refused(diff.replace('+line thirty', '+line 30'), 'src/a.mjs: line \\d+ differs from the candidate file');
  refused(diff.replace('-line 30', '-line 31'), 'src/a.mjs does not change the recorded original');
  refused(
    diff.replace('@@ -26,11 +26,11 @@', '@@ -27,11 +26,11 @@'),
    "src/a.mjs: a hunk's original line number is wrong",
  );
  refused(diff.replace('@@ -26,11 +26,11 @@', '@@ -26,12 +26,11 @@'), 'hunk 1 of src/a.mjs ends early');
  refused(diff.replace('b/src/b.mjs', 'b/src/c.mjs'), 'expected the header of src/b.mjs');
  refused(diff.replace('new file mode 100644\n', ''), 'expected src/b.mjs marked as new');
  refused(diff.slice(0, diff.indexOf('diff --git a/src/b.mjs')), 'expected the header of src/b.mjs');
  refused(diff + ' trailing\n', 'unexpected text');
  refused(diff.slice(0, -1), 'it must end with a newline');
});

test('deletion evidence reconstructs every original byte without an after-file and refuses incomplete or malformed content', () => {
  const changes = [{ path: 'docs/gone.md', before: 'old\r\ntext\nlast', after: null }],
    diff = sourceDiff(changes),
    header = diff.slice(0, diff.indexOf('@@')),
    noAfterFile = () => {
      assert.fail('A deleted file has no staged after-file.');
    },
    verifyDeleted = text => verifySourceDiff(text, recorded(changes), noAfterFile);
  assert.equal(diff, header + '@@ -1,3 +0,0 @@\n-old\r\n-text\n-last\n\\ No newline at end of file\n');
  const removed = diff
    .slice(header.length)
    .split('\n')
    .slice(1, -2)
    .map(row => row.slice(1))
    .join('\n');
  assert.equal(hash(removed), recorded(changes)[0].beforeHash);
  verifyDeleted(diff);
  for (const malformed of [
    header, // All removed text missing.
    diff.replace('-text\n', ''),
    diff.replace('-text\n', '-altered\n'),
    diff.replace('-text\n', '-text\n-extra\n'),
    diff.replace('@@ -1,3 +0,0 @@', '@@ -2,3 +0,0 @@'),
    diff.replace('@@ -1,3 +0,0 @@', '@@ -1,3 +1,0 @@'),
    diff.replace('@@ -1,3 +0,0 @@', '@@ -1,no +0,0 @@'),
    diff.replace('-text\n', '+text\n'),
    diff.replace('-old\r\n', '-old\n'),
    diff.replace('\\ No newline at end of file\n', ''),
    diff + '-extra\n',
  ])
    assert.throws(() => verifyDeleted(malformed), /candidate diff does not match the recorded change/);

  // A marker in the middle can join two diff rows into the right bytes, but it is not a valid line split.
  const joined = [{ path: 'docs/gone.md', before: 'oldtext\n', after: null }];
  assert.throws(
    () =>
      verifySourceDiff(
        header + '@@ -1,2 +0,0 @@\n-old\n\\ No newline at end of file\n-text\n',
        recorded(joined),
        noAfterFile,
      ),
    /malformed deletion lines/,
  );
  assert.throws(
    () =>
      verifySourceDiff(
        header + '@@ -1 +0,0 @@\n-\n\\ No newline at end of file\n',
        recorded([{ path: 'docs/gone.md', before: '', after: null }]),
        noAfterFile,
      ),
    /malformed deletion lines/,
  );
});

test('historical header-only deletions retain their explicit legacy verification path', () => {
  const changes = [{ path: 'docs/gone.md', before: 'old\n', after: null }],
    diff = sourceDiff(changes),
    header = diff.slice(0, diff.indexOf('@@')),
    noAfterFile = () => assert.fail('A deleted file is never read.');
  verifySourceDiff(header, recorded(changes), noAfterFile, { completeDeletions: false });
  assert.throws(() => verify(header, changes), /does not change the recorded original/);
  assert.throws(
    () => verifySourceDiff(diff, recorded(changes), noAfterFile, { completeDeletions: false }),
    /deleted file docs\/gone\.md must show no lines/,
  );
});
