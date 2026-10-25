import { createHash } from 'node:crypto';

export const hash = text => createHash('sha256').update(text).digest('hex');
// Controller-owned story limits. Historical tasks keep their recorded limits.
export const complexityPolicy = Object.freeze({
  1: Object.freeze({ maxSeconds: 600, maxAttempts: 2 }),
  2: Object.freeze({ maxSeconds: 900, maxAttempts: 2 }),
  3: Object.freeze({ maxSeconds: 1200, maxAttempts: 3 }),
  5: Object.freeze({ maxSeconds: 1800, maxAttempts: 3 }),
  8: Object.freeze({ maxSeconds: 2700, maxAttempts: 3 }),
});
export function validateComplexity(complexity) {
  if (typeof complexity !== 'number' || !Number.isInteger(complexity) || !Object.hasOwn(complexityPolicy, complexity))
    throw new Error('Invalid complexity: use numeric 1, 2, 3, 5 or 8; the work must be split into smaller stories.');
  return complexityPolicy[complexity];
}
export function validateComplexityLimits(task) {
  const limits = validateComplexity(task.complexity);
  if (task.maxSeconds !== limits.maxSeconds || task.maxAttempts !== limits.maxAttempts)
    throw new Error(
      `Task execution limits must match complexity ${task.complexity}: ${limits.maxSeconds} seconds and ${limits.maxAttempts} attempts.`,
    );
  return limits;
}
// Structural equality for JSON values: object key order is ignored, array order is not.
export function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, i) => jsonEqual(value, b[i]));
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}
export const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'outcome', 'summary', 'artifacts', 'checks', 'issues', 'handoff'],
  properties: {
    taskId: { type: 'string' },
    outcome: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'kind'],
        properties: { path: { type: 'string' }, kind: { type: 'string' } },
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'status', 'evidence'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'fail', 'not-run'] },
          evidence: { type: 'string' },
        },
      },
    },
    issues: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string' },
  },
};
// A result names at most 30 artifacts unless its task type declares more (maxArtifacts), up to a
// ceiling in code.
export const RESULT_ARTIFACTS = 30;
export const MAX_RESULT_ARTIFACTS = 200;
export function validateResult(result, maxArtifacts = RESULT_ARTIFACTS) {
  if (
    !result ||
    typeof result.taskId !== 'string' ||
    !['completed', 'blocked'].includes(result.outcome) ||
    typeof result.summary !== 'string' ||
    !result.summary.trim()
  )
    throw new Error('Result needs task ID, outcome, and summary.');
  if (
    !Array.isArray(result.artifacts) ||
    !Array.isArray(result.checks) ||
    !Array.isArray(result.issues) ||
    typeof result.handoff !== 'string'
  )
    throw new Error('Result does not match the common contract.');
  if (
    result.artifacts.length > Math.min(maxArtifacts, MAX_RESULT_ARTIFACTS) ||
    result.checks.length > 100 ||
    !result.issues.every(x => typeof x === 'string')
  )
    throw new Error('Invalid result entries or size.');
  for (const a of result.artifacts)
    if (!a || typeof a.path !== 'string' || typeof a.kind !== 'string') throw new Error('Invalid artifact record.');
  for (const c of result.checks)
    if (
      !c ||
      typeof c.name !== 'string' ||
      !['pass', 'fail', 'not-run'].includes(c.status) ||
      typeof c.evidence !== 'string'
    )
      throw new Error('Invalid check record.');
  return result;
}
