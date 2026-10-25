// An attempt's trace read into the page's rows: runs of thinking, reads and edits to one file become one row,
// blocked commands say what the CLI refused, the source phases and the handoff join in time, and chapters follow
// the work from getting oriented to the controller's checks.
import { expect, test } from 'vitest';
import { chaptersOf, inJob, program, touched, toolsUsed, traceRows, type AttemptTrace, type TraceStep } from './trace';

const at = (minute: number, second = 0) => new Date(2026, 9, 21, 23, minute, second).toISOString();
let seq = 0;
const step = (minute: number, second: number, kind: TraceStep['kind'], facts: Partial<TraceStep> = {}): TraceStep => ({
  seq: seq++,
  at: at(minute, second),
  kind,
  ...facts,
});
const trace = (steps: TraceStep[], extra: Partial<AttemptTrace> = {}): AttemptTrace => ({
  schemaVersion: 'attempt-trace-v1',
  attemptId: 'attempt-1',
  taskId: 'T-1',
  provider: 'claude',
  status: 'accepted',
  source: 'activity-file',
  counts: {},
  steps,
  ...extra,
});

test('runs of thinking, reads and edits to one file each read as one row', () => {
  seq = 0;
  const rows = traceRows(
    trace([
      step(20, 3, 'think', { durationMs: 1000, tokens: 215 }),
      step(20, 4, 'think', { durationMs: 2000, tokens: 300 }),
      step(20, 5, 'read', { path: 'src/core/a.mjs', startLine: 1 }),
      step(20, 6, 'read', { path: 'src/core/b.mjs', startLine: 1 }),
      step(20, 7, 'read', { path: 'src/core/orchestrator.mjs', startLine: 400 }),
      step(20, 8, 'read', { path: 'src/core/orchestrator.mjs', startLine: 600 }),
      step(20, 9, 'edit', { path: 'src/core/orchestrator.mjs', change: 'edit', added: 2, removed: 1 }),
      step(20, 10, 'edit', { path: 'src/core/orchestrator.mjs', change: 'edit', added: 5, removed: 4 }),
      step(20, 11, 'edit', { path: 'src/core/history.mjs', change: 'create', added: 40, removed: 0 }),
    ]),
  );
  expect(rows.map(row => row.title)).toEqual([
    'Thought twice · about 515 tokens',
    'Read 3 files',
    'Edited orchestrator.mjs in 2 places',
    'Created history.mjs',
  ]);
  expect(rows[2]!.detail).toBe('+2 −1 · +5 −4 lines');
});

test('a blocked command says what the CLI refused, and the phases and handoff join in time', () => {
  seq = 0;
  const rows = traceRows(
    trace(
      [
        step(20, 10, 'blocked', {
          tool: 'Bash',
          description: 'Run the new tests in a scratch copy',
          detail: 'rm -rf "$TEMP/x" && node --test',
          reason: "A variable in this command can't be checked before it runs.",
        }),
        step(20, 12, 'shell', { command: 'node --test', description: 'Run the tests', exitCode: 1 }),
      ],
      {
        phases: [
          { at: at(19, 59), phaseId: 'source.edit', boundary: 'start' },
          { at: at(25), phaseId: 'test', boundary: 'finish', outcome: 'failed', durationMs: 341000 },
        ],
        handoff: { at: at(24, 36), outcome: 'completed', summary: 'Added the history module.' },
      },
    ),
    { id: 'attempt-1', taskId: 'T-1', status: 'accepted', testEvidence: { totals: { tests: 611, pass: 605 } } },
  );
  expect(rows.map(row => [row.kind, row.title])).toEqual([
    ['phase', 'Started editing in a private copy of the source'],
    ['blocked', 'Tried to run the new tests in a scratch copy'],
    ['shell', 'Run the tests'],
    ['handoff', 'Handed off its work'],
    ['phase', 'Sandbox tests: 605 of 611 passed in 5 min 41 s'],
  ]);
  expect(rows[1]!.reason).toBe("Claude Code refused it: a variable in this command can't be checked before it runs.");
  expect(rows[2]!.reason).toBe('It ended with exit code 1.');
  expect(rows[4]!.tone).toBe('bad');
});

test('chapters follow the work: oriented, the change, trying it and handing off, then the controller', () => {
  seq = 0;
  const steps = [
      step(20, 0, 'shell', { command: 'ls', description: 'Look around' }),
      step(20, 2, 'read', { path: 'src/a.mjs' }),
      step(20, 4, 'search', { path: 'src', pattern: 'x' }),
      step(20, 6, 'think', { durationMs: 1000, tokens: 10 }),
      step(21, 0, 'edit', { path: 'src/a.mjs', change: 'edit', added: 1, removed: 1 }),
      step(21, 5, 'say', { text: 'Now the tests.' }),
      step(21, 6, 'think', { durationMs: 1000, tokens: 10 }),
      step(21, 8, 'blocked', { tool: 'Bash', detail: 'npm test && x' }),
    ],
    rows = traceRows(
      trace(steps, {
        phases: [{ at: at(25), phaseId: 'candidate.commit', boundary: 'finish', outcome: 'succeeded' }],
        handoff: { at: at(22), outcome: 'completed', summary: 'Done.' },
      }),
    );
  expect(chaptersOf(rows).map(chapter => [chapter.title, chapter.rows.length])).toEqual([
    ['Getting oriented', 4],
    ['Writing the change', 3],
    ['Trying it, then handing off', 2],
    ["The controller's checks", 1],
  ]);
  const files = touched(trace(steps));
  expect(files.changed).toEqual([{ path: 'src/a.mjs', edits: 1, created: false }]);
  expect(files.read).toEqual(['src']);
  expect(toolsUsed(trace(steps))).toEqual(['Bash', 'Read', 'Grep', 'Edit']);
});

test("a command names files in the job folder from the job folder, as the trace's own paths do", () => {
  expect(inJob('cd C:/Users/me/studio/data/projects/p/jobs/attempt-e94cb01b-9b5c-4ae0/inputs/T-1 && cat x')).toBe(
    'cd inputs/T-1 && cat x',
  );
  expect(inJob('sha256sum C:\\data\\jobs\\attempt-ab12-cd\\output\\x.json')).toBe('sha256sum output\\x.json');
  expect(inJob('ls src')).toBe('ls src');
});

test('a command the CLI gave no words for is named by the program it runs', () => {
  expect(program('Get-Content -LiteralPath AGENTS.md -Raw')).toBe('Get-Content');
  expect(program('"C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe" -Command "x"')).toBe('powershell');
  expect(program('$r = Get-Content x | ConvertFrom-Json')).toBe('Get-Content');
  expect(program('cd inputs && node check.mjs')).toBe('node');
  expect(program('')).toBe('a command');
});
