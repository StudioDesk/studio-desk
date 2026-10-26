// What a source story's attempts recorded about its change, its tests and how long they took, read the same way
// by Today's calls and the story page (v1.0 item 23).
import type { AttemptSummary } from './api';

// While a code editor's attempt runs, whether it is editing or its candidate is being committed and tested, from
// the innermost source phase still open (attempt-record.tsx reads the same events).
export const testingPhases = ['install', 'candidate.commit', 'test'];

// A CLI's effort level in words, as the canvas writes it: "extra-high".
export const effortWords = (effort: string) => ({ xhigh: 'extra-high' })[effort] ?? effort;

// The source phase a running attempt is in now, as the compact record carries it ('source.edit', 'test'); null
// for a controller that does not say, or an attempt that is not running.
export const openPhaseOf = (attempt?: AttemptSummary) =>
  typeof attempt?.openPhase === 'string' ? attempt.openPhase : null;

export const plural = (count: number, one: string, many = one + 's') => (count === 1 ? one : many);
const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

// What a review found, whichever kind of review it was: a code candidate's review, other work's independent
// review, or an older source review, which records only its verdict.
export const reviewOf = (attempt?: AttemptSummary) => {
  const list = (value: unknown) => (Array.isArray(value) ? (value as string[]) : undefined);
  return {
    verdict: (attempt?.candidateReviewVerdict ?? attempt?.workReviewVerdict ?? attempt?.reviewVerdict) as
      | string
      | undefined,
    findings: list(attempt?.candidateReviewFindings) ?? list(attempt?.workReviewFindings) ?? [],
    notes: list(attempt?.candidateReviewNotes) ?? list(attempt?.workReviewNotes) ?? [],
  };
};

// An attempt's own execution time in whole minutes, at least one.
export const took = (attempt?: AttemptSummary) => {
  const ms =
    attempt?.executionTiming?.durationMs ??
    (attempt?.startedAt && attempt.finishedAt ? Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt) : null);
  return ms && ms > 0 ? minutes(ms) : null;
};

export interface Totals {
  tests?: number;
  pass?: number;
  fail?: number;
  cancelled?: number;
  skipped?: number;
  todo?: number;
}
// The candidate's measured tests, and how long the test run took.
export const totalsOf = (attempt?: AttemptSummary) =>
  (attempt?.testEvidence as { totals?: Totals | null } | undefined)?.totals ?? null;
export const testTime = (attempt?: AttemptSummary) => {
  const ms = (attempt?.testEvidence as { tapDurationMs?: number } | undefined)?.tapDurationMs;
  return typeof ms === 'number' && ms > 0 ? ms : null;
};

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}
// The candidate's diff size, recorded since October 22; older candidates have none.
export const diffStatOf = (attempt?: AttemptSummary) =>
  (attempt?.sourceCandidate as { diffStat?: DiffStat } | undefined)?.diffStat ?? null;

// Whether the candidate's tests ran in a sandbox, as the attempt's configuration recorded: the built-in one, or
// before 1.0.1 the Codex CLI sandbox (src/adapters/source-test-sandbox.mjs testSandboxOf: no setting means it).
export const sandboxed = (attempt?: AttemptSummary) =>
  (attempt?.configuration as { testSandbox?: string } | undefined)?.testSandbox !== 'none';

// "3 min 37 s", "47 s", "1 h 4 min".
export function spoken(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, ms > 0 ? 1 : 0)} s`;
  const hours = Math.floor(seconds / 3600),
    mins = Math.floor((seconds % 3600) / 60),
    secs = seconds % 60;
  return hours ? `${hours} h${mins ? ` ${mins} min` : ''}` : `${mins} min${secs ? ` ${secs} s` : ''}`;
}
