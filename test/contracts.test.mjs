import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutExample, validateLayout, validateReview } from '../src/contracts.mjs';
import { jsonEqual, complexityPolicy, validateComplexity, validateComplexityLimits } from '../src/core/contracts.mjs';

test('complexity is a strict numeric story policy with fixed time and attempt limits', () => {
  for (const [complexity, maxSeconds, maxAttempts] of [
    [1, 600, 2],
    [2, 900, 2],
    [3, 1200, 3],
    [5, 1800, 3],
    [8, 2700, 3],
  ]) {
    assert.deepEqual(validateComplexity(complexity), { maxSeconds, maxAttempts });
    assert.ok(Object.isFrozen(complexityPolicy[complexity]));
    assert.doesNotThrow(() => validateComplexityLimits({ complexity, maxSeconds, maxAttempts }));
    assert.throws(
      () => validateComplexityLimits({ complexity, maxSeconds: maxSeconds - 1, maxAttempts }),
      /complexity/,
    );
    assert.throws(
      () => validateComplexityLimits({ complexity, maxSeconds, maxAttempts: maxAttempts + 1 }),
      /complexity/,
    );
  }
  assert.ok(Object.isFrozen(complexityPolicy));
  for (const complexity of [
    undefined,
    null,
    false,
    true,
    '1',
    '8',
    0,
    -1,
    1.5,
    4,
    13,
    NaN,
    Infinity,
    {},
    [],
    new Number(1),
  ])
    assert.throws(() => validateComplexity(complexity), /complexity.*smaller stories/);
});

test('jsonEqual ignores object key order but not array order, types or extra keys', () => {
  assert.ok(jsonEqual({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 }));
  assert.ok(!jsonEqual({ a: [1, 2] }, { a: [2, 1] }));
  assert.ok(!jsonEqual({ a: 1 }, { a: '1' }));
  assert.ok(!jsonEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!jsonEqual({ a: null }, { a: {} }));
  assert.ok(!jsonEqual([], {}));
});

test('review reports require text evidence and explained negative verdicts', () => {
  const report = { verdict: 'pass', findings: [], evidence: ['Checked the accepted layout logical graph.'] };
  assert.equal(validateReview(report), report);
  for (const verdict of ['revise', 'blocked'])
    assert.doesNotThrow(() =>
      validateReview({ ...report, verdict, findings: ['Supply the missing landmark or context.'] }),
    );
  for (const invalid of [
    null,
    {},
    { ...report, verdict: 'unknown' },
    { ...report, evidence: [] },
    { ...report, evidence: [false] },
    { ...report, evidence: [''] },
    { ...report, evidence: ['   '] },
    { ...report, findings: [null] },
    { ...report, findings: [''] },
    { ...report, verdict: 'revise' },
    { ...report, verdict: 'blocked' },
  ]) {
    assert.throws(() => validateReview(invalid), /Review|review/, JSON.stringify(invalid));
  }
});

test('logical layouts require distinct entry, objective and exit rooms', () => {
  assert.deepEqual(validateLayout(layoutExample), []);
  for (const [objective, exit] of [
    ['entry', 'exit'],
    ['objective', 'entry'],
    ['objective', 'objective'],
    ['entry', 'entry'],
  ]) {
    const layout = { ...structuredClone(layoutExample), objective, exit };
    assert.ok(
      validateLayout(layout).some(failure => /distinct/.test(failure)),
      `${objective} / ${exit}`,
    );
  }
  const collapsed = { ...structuredClone(layoutExample), objective: 'entry', exit: 'entry', links: [] };
  assert.ok(validateLayout(collapsed).length, 'Disconnected extra rooms cannot pass with all roles assigned to entry.');
  const renamed = structuredClone(layoutExample);
  renamed.rooms[1].id = renamed.objective = 'goal-room';
  renamed.links[0].to = renamed.links[1].from = 'goal-room';
  assert.deepEqual(validateLayout(renamed), [], 'Objective IDs remain design choices.');
});
