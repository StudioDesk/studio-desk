import { hash } from '../../core/contracts.mjs';
import { validatePlan } from '../../core/planning.mjs';
import { validateLayout, validateReview } from './contracts.mjs';

export function validateGameOutput({ task, attempt: a, result, readArtifact, checks: integrity }) {
  if (task.kind === 'layout' && result.outcome === 'completed') {
    const item = a.artifacts.find(x => x.kind === 'layout' && x.path === 'layout.json');
    if (!item) throw new Error('Layout assignment must provide layout.json with kind layout.');
    const failures = validateLayout(JSON.parse(readArtifact(item.path).toString('utf8')));
    integrity.push({
      name: 'Controller layout validation',
      status: failures.length ? 'fail' : 'pass',
      evidence: failures.length
        ? failures.join(' ')
        : 'Catalog, IDs, positions, and directed objective/exit connectivity checked. No engine check performed.',
    });
    if (failures.length) throw new Error(failures.join(' '));
  }
  if (task.kind === 'review' && result.outcome === 'completed') {
    const item = a.artifacts.find(x => x.path === 'review.json');
    if (!item) throw new Error('Review assignment must return review.json.');
    const review = JSON.parse(readArtifact(item.path).toString('utf8'));
    validateReview(review);
    if (review.verdict === 'pass' && !a.inputReferences.some(dep => dep.artifacts.length))
      throw new Error('A passing review requires supplied accepted input artifacts.');
    a.reviewVerdict = review.verdict;
  }
  if (task.kind === 'plan' && result.outcome === 'completed') {
    const item = a.artifacts.find(x => x.path === 'plan.json' && x.kind === 'plan');
    if (!item || item.bytes > 256 * 1024)
      throw new Error('Planning requires a bounded plan.json artifact with kind plan.');
    const contents = readArtifact(item.path);
    if (hash(contents) !== item.hash) throw new Error('Plan changed during result validation.');
    const proposal = JSON.parse(contents.toString('utf8'));
    a.planBudget = validatePlan(proposal, a.planContext);
    a.plan = proposal;
    integrity.push({
      name: 'Controller plan validation',
      status: 'pass',
      evidence: `${a.planBudget.tasks} tasks; at most ${a.planBudget.totalAttemptSeconds} execution seconds across all permitted attempts. Roster, scope, limits and acyclic dependencies checked. No tasks created.`,
    });
  }
  return {
    checks: integrity,
    metadata: {
      ...(a.reviewVerdict ? { reviewVerdict: a.reviewVerdict } : {}),
      ...(a.plan ? { plan: a.plan, planBudget: a.planBudget } : {}),
    },
  };
}
