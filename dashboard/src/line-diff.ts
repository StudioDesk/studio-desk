// A line comparison of two texts, for showing what an edit changes before it is saved: the rows of both texts in
// reading order, each the same in both, removed from the first or added in the second, with the added and removed
// counts. Windows (\r\n) and Unix (\n) line endings read alike, so a file saved on Windows compares line for line with
// the same file saved elsewhere; a text that ends without a newline differs from one that ends with it only on its
// last line, which is marked `noNewlineAtEnd`. Pure: no DOM, React or I/O.
export interface LineDiffRow {
  type: 'same' | 'added' | 'removed';
  text: string;
  noNewlineAtEnd?: true;
}

export interface LineDiff {
  rows: LineDiffRow[];
  added: number;
  removed: number;
  // False when the changed middle was too large to compare line by line and reads as removed, then added.
  exact: boolean;
}

// The most pairs of lines compared one with another, after the lines both texts share at their start and end are set
// aside: one 16-bit cell each, 8 MB at most. A library file is at most 5 MiB, so its middle can hold far more pairs
// than this; above it the middle reads as every old line removed, then every new line added, so the page never hangs.
// Under this bound the shorter middle has at most 2,000 lines, so no common run is too long for a 16-bit cell.
export const lineDiffMaxPairs = 4_000_000;

// Each line keeps a "\n" when the text has a newline after it. Lines never hold one otherwise, so a last line without
// a newline differs from the same words with one, and only that line does.
function linesOf(text: string): string[] {
  const parts = text.split(/\r?\n/),
    last = parts.pop() ?? '';
  const lines = parts.map(part => part + '\n');
  if (last !== '') lines.push(last);
  return lines;
}

function rowOf(type: LineDiffRow['type'], line: string): LineDiffRow {
  return line.endsWith('\n') ? { type, text: line.slice(0, -1) } : { type, text: line, noNewlineAtEnd: true };
}

// The longest common run of lines, by a table of how many lines each pair of remaining lines still has in common.
function compare(before: string[], after: string[], push: (type: LineDiffRow['type'], line: string) => void) {
  const n = before.length,
    m = after.length;
  const ids = new Map<string, number>(),
    idOf = (line: string) => {
      let id = ids.get(line);
      if (id === undefined) ids.set(line, (id = ids.size));
      return id;
    };
  const a = Int32Array.from(before, idOf),
    b = Int32Array.from(after, idOf);
  const table = new Uint16Array(n * m),
    at = (i: number, j: number) => (i < n && j < m ? (table[i * m + j] ?? 0) : 0);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * m + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', before[i++] ?? '');
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) push('removed', before[i++] ?? '');
    else push('added', after[j++] ?? '');
  }
  while (i < n) push('removed', before[i++] ?? '');
  while (j < m) push('added', after[j++] ?? '');
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = linesOf(before),
    b = linesOf(after);
  let head = 0,
    tail = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const middleBefore = a.slice(head, a.length - tail),
    middleAfter = b.slice(head, b.length - tail);
  const result: LineDiff = {
    rows: [],
    added: 0,
    removed: 0,
    exact: middleBefore.length * middleAfter.length <= lineDiffMaxPairs,
  };
  const push = (type: LineDiffRow['type'], line: string) => {
    result.rows.push(rowOf(type, line));
    if (type !== 'same') result[type]++;
  };
  a.slice(0, head).forEach(line => push('same', line));
  if (result.exact) compare(middleBefore, middleAfter, push);
  else {
    middleBefore.forEach(line => push('removed', line));
    middleAfter.forEach(line => push('added', line));
  }
  a.slice(a.length - tail).forEach(line => push('same', line));
  return result;
}
