// A line comparison of two texts: unchanged lines stay in place, a changed line reads as its old line removed and its
// new one added, line endings do not count as changes, and a middle too large to compare reads as removed then added.
import { expect, test } from 'vitest';
import { lineDiff, lineDiffMaxPairs, type LineDiff } from './line-diff';

const same = (text: string) => ({ type: 'same', text }),
  added = (text: string) => ({ type: 'added', text }),
  removed = (text: string) => ({ type: 'removed', text });

// The lines of each text, read back from the rows: the same and removed rows are the first text's, the same and added
// rows the second's.
const sides = (diff: LineDiff) => ({
  before: diff.rows.filter(row => row.type !== 'added').map(row => row.text),
  after: diff.rows.filter(row => row.type !== 'removed').map(row => row.text),
});

const numbered = (from: number, to: number, label: string) =>
  Array.from({ length: to - from }, (_, k) => `${label} ${from + k}`);

test('identical texts have no added or removed lines', () => {
  const text = '# Plan\n\nShip the editor.\n';
  expect(lineDiff(text, text)).toEqual({
    rows: [same('# Plan'), same(''), same('Ship the editor.')],
    added: 0,
    removed: 0,
    exact: true,
  });
  expect(lineDiff('', '')).toEqual({ rows: [], added: 0, removed: 0, exact: true });
});

test('one changed line in a Markdown text reads as its old line removed and its new one added, in place', () => {
  const before = '# Release notes\n\n- Faster boards\n- Quieter logs\n\nThanks!\n',
    after = '# Release notes\n\n- Faster boards\n- Clearer logs\n\nThanks!\n';
  expect(lineDiff(before, after)).toEqual({
    rows: [
      same('# Release notes'),
      same(''),
      same('- Faster boards'),
      removed('- Quieter logs'),
      added('- Clearer logs'),
      same(''),
      same('Thanks!'),
    ],
    added: 1,
    removed: 1,
    exact: true,
  });
});

test('an appended line and a deleted line are each reported once', () => {
  expect(lineDiff('one\ntwo\n', 'one\ntwo\nthree\n')).toEqual({
    rows: [same('one'), same('two'), added('three')],
    added: 1,
    removed: 0,
    exact: true,
  });
  expect(lineDiff('one\ntwo\nthree\n', 'one\nthree\n')).toEqual({
    rows: [same('one'), removed('two'), same('three')],
    added: 0,
    removed: 1,
    exact: true,
  });
});

test('changes apart from each other are found in place among the unchanged lines', () => {
  const diff = lineDiff('a\nb\nc\nd\ne\nf\n', 'a\nB\nc\nd\nf\ng\n');
  expect(diff.rows).toEqual([
    same('a'),
    removed('b'),
    added('B'),
    same('c'),
    same('d'),
    removed('e'),
    same('f'),
    added('g'),
  ]);
  expect([diff.added, diff.removed, diff.exact]).toEqual([2, 2, true]);
});

test('Windows and Unix line endings compare as the same text', () => {
  const unix = '# Notes\n\nFirst line\nSecond line\n',
    windows = unix.replace(/\n/g, '\r\n');
  const diff = lineDiff(windows, unix);
  expect(diff).toEqual({
    rows: [same('# Notes'), same(''), same('First line'), same('Second line')],
    added: 0,
    removed: 0,
    exact: true,
  });
  // A real change still shows, and only on its own line.
  expect(lineDiff(windows, unix.replace('Second', '2nd')).rows).toEqual([
    same('# Notes'),
    same(''),
    same('First line'),
    removed('Second line'),
    added('2nd line'),
  ]);
});

test('an empty first text reports every line of the second as added', () => {
  expect(lineDiff('', 'name,count\nboards,3\nlogs,7\n')).toEqual({
    rows: [added('name,count'), added('boards,3'), added('logs,7')],
    added: 3,
    removed: 0,
    exact: true,
  });
  expect(lineDiff('kept\n', '')).toEqual({ rows: [removed('kept')], added: 0, removed: 1, exact: true });
});

test('a newline missing at the end changes only the last line, which says so', () => {
  expect(lineDiff('one\ntwo\n', 'one\ntwo')).toEqual({
    rows: [same('one'), removed('two'), { type: 'added', text: 'two', noNewlineAtEnd: true }],
    added: 1,
    removed: 1,
    exact: true,
  });
  expect(lineDiff('one\r\ntwo', 'one\ntwo')).toEqual({
    rows: [same('one'), { type: 'same', text: 'two', noNewlineAtEnd: true }],
    added: 0,
    removed: 0,
    exact: true,
  });
  // An empty last line is a line of its own.
  expect(lineDiff('one\n', 'one\n\n')).toEqual({ rows: [same('one'), added('')], added: 1, removed: 0, exact: true });
});

test('a changed middle up to the bound is compared line by line', () => {
  // Every other line changes, the first and last among them, so nothing is set aside: 2,000 by 2,000 lines, exactly
  // the bound.
  const lines = numbered(0, 2000, 'line'),
    after = lines.map((line, k) => (k % 2 && k < 1999 ? line : `changed ${line}`));
  expect(2000 * 2000).toBe(lineDiffMaxPairs);
  const diff = lineDiff(lines.join('\n') + '\n', after.join('\n') + '\n');
  expect(diff.exact).toBe(true);
  expect([diff.added, diff.removed]).toEqual([1001, 1001]);
  expect(diff.rows.slice(0, 4)).toEqual([
    removed('line 0'),
    added('changed line 0'),
    same('line 1'),
    removed('line 2'),
  ]);
  expect(sides(diff)).toEqual({ before: lines, after });
});

test('a changed middle above the bound reads as its old lines removed, then its new lines added', () => {
  const head = numbered(0, 50, 'head'),
    tail = numbered(0, 50, 'tail'),
    oldMiddle = numbered(0, 2001, 'old'),
    newMiddle = numbered(0, 2001, 'new');
  expect(2001 * 2001).toBeGreaterThan(lineDiffMaxPairs);
  const before = [...head, ...oldMiddle, ...tail],
    after = [...head, ...newMiddle, ...tail];
  const diff = lineDiff(before.join('\n') + '\n', after.join('\n') + '\n');
  expect(diff.exact).toBe(false);
  expect([diff.added, diff.removed]).toEqual([2001, 2001]);
  expect(diff.rows).toEqual([...head.map(same), ...oldMiddle.map(removed), ...newMiddle.map(added), ...tail.map(same)]);
  // Middles of unequal length still count each of their lines once.
  const longer = lineDiff([...head, ...oldMiddle, 'old 0', ...tail].join('\n'), after.join('\n'));
  expect([longer.exact, longer.added, longer.removed]).toEqual([false, 2001, 2002]);
  expect(sides(longer)).toEqual({ before: [...head, ...oldMiddle, 'old 0', ...tail], after });
});

test('a library-sized file with changes spread through it answers with the right counts', () => {
  // About 5 MiB: 100,000 lines of 50 characters, every 20th line from 10,000 to 89,980 changed.
  const before = Array.from({ length: 100_000 }, (_, k) => `line ${String(k).padStart(6, '0')} `.padEnd(50, '.')),
    after = before.map((line, k) => (k >= 10_000 && k < 90_000 && k % 20 === 0 ? line.replace('line', 'LINE') : line));
  const diff = lineDiff(before.join('\n'), after.join('\r\n'));
  // The middle runs from the first changed line to the last: 79,981 lines on each side.
  expect(diff.exact).toBe(false);
  expect([diff.added, diff.removed]).toEqual([79_981, 79_981]);
  expect(diff.rows).toHaveLength(100_000 + 79_981);
  expect(diff.rows[9_999]).toEqual({ type: 'same', text: before[9_999] });
  expect(diff.rows[10_000]).toEqual({ type: 'removed', text: before[10_000] });
  expect(sides(diff)).toEqual({ before, after });
});
