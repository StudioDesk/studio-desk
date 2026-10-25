import fs from 'node:fs';
import path from 'node:path';
import { layoutExample, validateLayout } from './contracts.mjs';
import { simulatedPlan } from './planning.mjs';

export function simulateGameTask({ attempt: a, output }) {
  let artifact, data, checks;
  if (a.assignment.kind === 'plan') {
    artifact = 'plan.json';
    data = simulatedPlan(a.planContext, a.assignment.brief);
    checks = [
      { name: 'Plan generation', status: 'not-run', evidence: 'Simulator template; no model interpreted the brief.' },
    ];
  } else if (a.assignment.kind === 'layout') {
    artifact = 'layout.json';
    data = structuredClone(layoutExample);
    checks = [
      { name: 'Design graph', status: 'pass', evidence: 'Three connected catalog rooms; logical graph only.' },
      { name: 'Engine traversal and playtest', status: 'not-run', evidence: 'Unreal is not connected.' },
    ];
  } else if (a.assignment.kind === 'review') {
    artifact = 'review.json';
    const layouts = a.inputReferences.flatMap(dep =>
      dep.artifacts
        .filter(item => item.kind === 'layout')
        .map(item => ({ ...item, taskId: dep.taskId, attemptId: dep.attemptId })),
    );
    const findings = [],
      evidence = [];
    checks = [];
    for (const ref of layouts) {
      let failures;
      try {
        failures = validateLayout(JSON.parse(fs.readFileSync(path.resolve(output, ref.path), 'utf8')));
      } catch {
        failures = ['Accepted layout could not be parsed as JSON.'];
      }
      const identity = `${ref.taskId}, attempt ${ref.attemptId}, path ${ref.path}, SHA-256 ${ref.hash}`;
      const detail = `${identity}: ${failures.length ? failures.join(' ') : 'Logical schema and directed entry/objective/exit connectivity passed.'}`;
      findings.push(...failures.map(failure => `${ref.taskId} (${ref.path}): ${failure}`));
      evidence.push(detail);
      checks.push({
        name: `Logical layout review: ${ref.taskId} (${ref.path})`,
        status: failures.length ? 'fail' : 'pass',
        evidence: detail,
      });
    }
    if (!layouts.length) {
      findings.push('No accepted layout supplied.');
      evidence.push('No accepted layout artifact was supplied; no layout checks were run.');
      checks.push({ name: 'Logical layout review', status: 'not-run', evidence: evidence[0] });
    }
    const limitation = 'Visual navigation, collisions, pacing, and fun require Unreal and human playtesting.';
    evidence.push(limitation);
    checks.push({ name: 'Engine traversal and playtest', status: 'not-run', evidence: limitation });
    data = { verdict: !layouts.length ? 'blocked' : findings.length ? 'revise' : 'pass', findings, evidence };
  } else {
    artifact = 'work.txt';
    data = `SIMULATED OUTPUT\n${a.assignment.title}\n${a.assignment.brief}\nThis placeholder proves dispatch and review only.`;
    checks = [
      { name: 'Requested work', status: 'not-run', evidence: 'Simulator does not perform arbitrary assignments.' },
    ];
  }
  return { artifact, data, checks };
}
