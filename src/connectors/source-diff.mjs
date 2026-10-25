// Unified diffs of source candidates (MP-016 slice 2). The independent reviewer reads a candidate's
// diff rather than full before/after copies, so what a review reads grows with the change, not with
// the files it touches. The controller computes the diff from the exact bytes it staged, so it does
// not depend on git's configuration, and validation checks it by applying it in reverse to the
// candidate's files: the result must hash to each file's recorded original.
import { hash } from '../core/contracts.mjs';

// A review receives the diff plus at most 192 KB of test logs and the manifests, which keeps it
// inside text delivery's 512 KB input limit.
export const sourceDiffLimit = 192 * 1024;
export const sourceDiffFormat = 'unified-full-deletions-v1';
const contextLines = 5,
  // Beyond this many line edits a changed region is shown as removed, then added, in full.
  maxEdits = 2000;

// Lines keep their terminators, so a missing final newline is a difference like any other.
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];

// The shortest edit script between two line arrays (Myers), or null beyond maxEdits.
function shortestEdits(a, b) {
  const n = a.length,
    m = b.length,
    max = n + m,
    offset = max + 1,
    v = new Int32Array(2 * max + 3),
    trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxEdits) return null;
    // Moves in round d read diagonals -d-1 to d+1 of the previous round.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace);
    }
  }
  return null;
}
function backtrack(a, b, trace) {
  const ops = [];
  let x = a.length,
    y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d],
      at = k => v[k + d + 1],
      k = x - y,
      previous = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1,
      px = at(previous),
      py = px - previous;
    while (x > px && y > py) {
      ops.push({ op: ' ', text: a[--x] });
      y--;
    }
    if (d > 0) ops.push(x === px ? { op: '+', text: b[--y] } : { op: '-', text: a[--x] });
  }
  return ops.reverse();
}
function editScript(a, b) {
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const removed = a.slice(start, a.length - end),
    added = b.slice(start, b.length - end),
    same = text => ({ op: ' ', text });
  return [
    ...a.slice(0, start).map(same),
    ...(shortestEdits(removed, added) ?? [
      ...removed.map(text => ({ op: '-', text })),
      ...added.map(text => ({ op: '+', text })),
    ]),
    ...a.slice(a.length - end).map(same),
  ];
}
const range = (start, count) => (count === 1 ? `${start}` : `${count ? start : start - 1},${count}`);
const row = ({ op, text }) => op + (text.endsWith('\n') ? text : text + '\n\\ No newline at end of file\n');
function hunks(before, after) {
  const ops = editScript(lines(before), lines(after)),
    changed = ops.flatMap((item, index) => (item.op === ' ' ? [] : [index])),
    out = [];
  for (let i = 0; i < changed.length; ) {
    let last = i;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * contextLines + 1) last++;
    const from = Math.max(0, changed[i] - contextLines),
      to = Math.min(ops.length, changed[last] + contextLines + 1),
      prior = ops.slice(0, from),
      body = ops.slice(from, to),
      count = (items, op) => items.filter(item => item.op !== op).length;
    out.push(
      `@@ -${range(count(prior, '+') + 1, count(body, '+'))} +${range(count(prior, '-') + 1, count(body, '-'))} @@\n` +
        body.map(row).join(''),
    );
    i = last + 1;
  }
  return out.join('');
}

// changes: [{ path, before, after }] in manifest order; before is null for a created file and
// after is null for a deleted one. Deletions include the entire verified original.
export function sourceDiff(changes) {
  return changes
    .map(({ path, before, after }) =>
      [
        `diff --git a/${path} b/${path}\n`,
        before === null ? 'new file mode 100644\n' : '',
        after === null ? 'deleted file mode 100644\n' : '',
        `--- ${before === null ? '/dev/null' : 'a/' + path}\n`,
        `+++ ${after === null ? '/dev/null' : 'b/' + path}\n`,
        hunks(before ?? '', after ?? ''),
      ].join(''),
    )
    .join('');
}

// How much a diff changes, for the dashboard's change tile: its files and its added and removed lines. A file's
// header lines (up to its first hunk) are not counted, so a removed line that reads "-- note" is still a line.
export function sourceDiffStat(diff) {
  let files = 0,
    added = 0,
    removed = 0,
    header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      files++;
      header = true;
    } else if (line.startsWith('@@')) header = false;
    else if (!header && line.startsWith('+')) added++;
    else if (!header && line.startsWith('-')) removed++;
  }
  return { files, added, removed };
}

// Checks that a diff shows exactly the recorded changes: manifest changes [{ path, beforeHash,
// afterHash }] in order, with each created or edited file's candidate text from afterText(path).
// Only historical, unmarked manifests use completeDeletions: false (header-only deletions).
export function verifySourceDiff(text, changes, afterText, { completeDeletions = true } = {}) {
  const fail = reason => {
    throw new Error(`The candidate diff does not match the recorded change: ${reason}.`);
  };
  const rows = text.split('\n');
  if (rows.pop() !== '') fail('it must end with a newline');
  let at = 0;
  const expect = (value, what) => {
    if (rows[at] !== value) fail(`expected ${what} at line ${at + 1}`);
    at++;
  };
  for (const { path, beforeHash, afterHash } of changes) {
    expect(`diff --git a/${path} b/${path}`, `the header of ${path}`);
    if (beforeHash === null) expect('new file mode 100644', `${path} marked as new`);
    if (afterHash === null) expect('deleted file mode 100644', `${path} marked as deleted`);
    expect(`--- ${beforeHash === null ? '/dev/null' : 'a/' + path}`, `the original name of ${path}`);
    expect(`+++ ${afterHash === null ? '/dev/null' : 'b/' + path}`, `the changed name of ${path}`);
    const parsed = [];
    while (at < rows.length && rows[at].startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(rows[at++]);
      if (!header) fail(`malformed hunk header at line ${at}`);
      const [oldStart, oldLines = 1, newStart, newLines = 1] = [1, 2, 3, 4].map(i =>
        header[i] === undefined ? undefined : Number(header[i]),
      );
      if (!oldLines && !newLines) fail(`empty hunk at line ${at}`);
      const hunk = { oldStart, oldLines, newStart, newLines, lines: [] };
      let removed = 0,
        added = 0;
      while (removed < oldLines || added < newLines) {
        const line = rows[at++],
          op = line?.[0];
        if (!line || !' -+'.includes(op)) fail(`hunk ${parsed.length + 1} of ${path} ends early`);
        let content = line.slice(1) + '\n';
        if (rows[at] === '\\ No newline at end of file') {
          content = content.slice(0, -1);
          at++;
        }
        if (op !== '+') removed++;
        if (op !== '-') added++;
        if (removed > oldLines || added > newLines) fail(`hunk ${parsed.length + 1} of ${path} has the wrong length`);
        hunk.lines.push({ op, content });
      }
      parsed.push(hunk);
    }
    if (afterHash === null && !completeDeletions) {
      if (parsed.length) fail(`deleted file ${path} must show no lines`);
      continue;
    }
    // A deletion is reversed from an empty result; it has no staged after-file to read.
    const original = reverse(afterHash === null ? '' : afterText(path), parsed, reason => fail(`${path}: ${reason}`));
    if (
      afterHash === null &&
      parsed
        .flatMap(hunk => hunk.lines)
        .some(
          ({ op, content }, index, all) =>
            op !== '-' || content === '' || (!content.endsWith('\n') && index !== all.length - 1),
        )
    )
      fail(`${path} has malformed deletion lines`);
    if (beforeHash === null ? original !== '' : hash(original) !== beforeHash)
      fail(`${path} does not change the recorded original into the candidate`);
  }
  if (at !== rows.length) fail(`unexpected text at line ${at + 1}`);
}
// Rebuilds the original text from the candidate text and the hunks.
function reverse(text, parsed, fail) {
  const after = lines(text),
    before = [];
  let at = 0;
  for (const hunk of parsed) {
    const start = hunk.newLines ? hunk.newStart - 1 : hunk.newStart;
    if (start < at || start > after.length) fail('hunks overlap, are out of order or start past the end');
    before.push(...after.slice(at, start));
    at = start;
    if (before.length !== (hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart))
      fail(`a hunk's original line number is wrong`);
    for (const { op, content } of hunk.lines) {
      if (op !== '-') {
        if (after[at] !== content) fail(`line ${at + 1} differs from the candidate file`);
        at++;
      }
      if (op !== '+') before.push(content);
    }
  }
  return before.concat(after.slice(at)).join('');
}
