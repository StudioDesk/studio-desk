import { validateComplexity, validateComplexityLimits } from './contracts.mjs';
import { isRoleId } from './staffing.mjs';
import { TIERS } from './execution.mjs';

function fields(value, allowed, name) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error(`${name} contains unsupported fields.`);
}
function text(value, max, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${name} must contain bounded nonempty text.`);
}
export function validatePlan(plan, context) {
  const isReview = kind => (context.reviewKinds || []).includes(kind);
  fields(plan, ['version', 'summary', 'assumptions', 'directorDecisions', 'tasks'], 'Plan');
  if (plan.version !== 'studio-plan-v1') throw new Error('Unsupported plan version.');
  text(plan.summary, 4000, 'Plan summary');
  for (const name of ['assumptions', 'directorDecisions']) {
    if (!Array.isArray(plan[name]) || plan[name].length > 20) throw new Error(`Invalid plan ${name}.`);
    plan[name].forEach(value => text(value, 2000, name));
  }
  if (!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length > context.limits.maxTasks)
    throw new Error(`A plan needs 1 to ${context.limits.maxTasks} tasks.`);
  const keys = new Set();
  let seconds = 0,
    legacySeconds = 0;
  for (const task of plan.tasks) {
    fields(
      task,
      [
        'key',
        'title',
        'kind',
        'workerId',
        'role',
        'distinctFrom',
        'tier',
        'waitsFor',
        'brief',
        'acceptance',
        'dependencies',
        'acceptedInputs',
        'resources',
        'maxSeconds',
        'maxAttempts',
        ...(context.proposalSource ? ['complexity'] : []),
      ],
      'Planned task',
    );
    if (typeof task.key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(task.key) || keys.has(task.key))
      throw new Error('Plan task keys must be unique safe identifiers.');
    keys.add(task.key);
    text(task.title, 160, 'Task title');
    text(task.brief, 24000, 'Task brief');
    text(task.acceptance, 24000, 'Task acceptance');
    if (!context.kinds.includes(task.kind)) throw new Error('Plan uses an unsupported task kind.');
    // A planned task names an enabled employee, or a role that staffing resolves at intake.
    if (task.role !== undefined) {
      if (task.workerId !== undefined || !isRoleId(task.role))
        throw new Error('A planned task names either an employee or one role ID.');
      if (context.repair) throw new Error('Repair plans name employees, so independent review can be checked.');
    } else if (!context.workers.some(w => w.id === task.workerId))
      throw new Error('Plan must assign enabled employees from the supplied roster.');
    if (
      task.distinctFrom !== undefined &&
      (!Array.isArray(task.distinctFrom) ||
        task.distinctFrom.length > context.limits.maxTasks ||
        new Set(task.distinctFrom).size !== task.distinctFrom.length ||
        task.distinctFrom.some(key => typeof key !== 'string'))
    )
      throw new Error('Planned task distinctFrom must list distinct prerequisite keys or source.');
    if (
      task.waitsFor !== undefined &&
      (!task.waitsFor ||
        typeof task.waitsFor !== 'object' ||
        Array.isArray(task.waitsFor) ||
        Object.entries(task.waitsFor).some(
          ([key, milestone]) => !task.dependencies.includes(key) || typeof milestone !== 'string',
        ))
    )
      throw new Error('Planned task waitsFor maps its own prerequisite keys to milestones.');
    if (task.tier !== undefined && !TIERS.includes(task.tier))
      throw new Error(`A planned task tier must be one of ${TIERS.join(', ')}.`);
    if (context.proposalSource && Object.hasOwn(task, 'complexity')) validateComplexityLimits(task);
    else {
      if (
        !Number.isInteger(task.maxSeconds) ||
        task.maxSeconds < 5 ||
        task.maxSeconds > context.limits.maxSeconds ||
        !Number.isInteger(task.maxAttempts) ||
        task.maxAttempts < 1 ||
        task.maxAttempts > context.limits.maxAttempts
      )
        throw new Error('Plan exceeds a task execution limit.');
      legacySeconds += task.maxSeconds * task.maxAttempts;
    }
    seconds += task.maxSeconds * task.maxAttempts;
    if (
      !Array.isArray(task.resources) ||
      task.resources.length > 10 ||
      new Set(task.resources).size !== task.resources.length ||
      task.resources.some(
        r =>
          typeof r !== 'string' ||
          !/^[a-zA-Z0-9:_-]{1,80}$/.test(r) ||
          !context.resourcePrefixes.some(prefix => r.startsWith(prefix) && r.length > prefix.length),
      )
    )
      throw new Error('Plan requests an unsupported shared resource.');
    if (
      !Array.isArray(task.dependencies) ||
      task.dependencies.length > context.limits.maxTasks ||
      new Set(task.dependencies).size !== task.dependencies.length ||
      task.dependencies.some(id => typeof id !== 'string')
    )
      throw new Error('Invalid plan dependencies.');
    const accepted = task.acceptedInputs ?? [];
    if (
      !Array.isArray(accepted) ||
      accepted.length > 20 ||
      new Set(accepted).size !== accepted.length ||
      accepted.some(id => typeof id !== 'string' || !context.acceptedInputs?.some(ref => ref.taskId === id))
    )
      throw new Error('Plan references an unavailable accepted input.');
    if (isReview(task.kind) && !task.dependencies.length && !accepted.length && !context.proposalSource)
      throw new Error('A planned review needs prerequisite artifacts.');
  }
  const budget = context.limits.totalAttemptSeconds ?? 1800;
  if (legacySeconds > budget) throw new Error(`Plan exceeds the ${budget}-second total attempt time budget.`);
  const visited = new Set(),
    visiting = new Set(),
    byKey = new Map(plan.tasks.map(task => [task.key, task]));
  const visit = key => {
    if (!keys.has(key)) throw new Error('Plan references a missing prerequisite.');
    if (visiting.has(key)) throw new Error('Plan dependencies contain a cycle.');
    if (visited.has(key)) return;
    visiting.add(key);
    byKey.get(key).dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  keys.forEach(visit);
  if (context.repair) {
    const consumed = new Set(
      plan.tasks.filter(task => !isReview(task.kind)).flatMap(task => task.acceptedInputs || []),
    );
    if (context.acceptedInputs.some(ref => !consumed.has(ref.taskId)))
      throw new Error('Repair work must consume the pinned review and every reviewed source.');
    const repairs = new Set(plan.tasks.filter(task => !isReview(task.kind)).map(task => task.key));
    const reviewed = new Set();
    for (const reviewer of plan.tasks.filter(task => isReview(task.kind))) {
      const ancestors = new Set();
      const collect = key => {
        if (ancestors.has(key)) return;
        ancestors.add(key);
        byKey.get(key).dependencies.forEach(collect);
      };
      reviewer.dependencies.forEach(collect);
      for (const key of ancestors)
        if (repairs.has(key)) {
          if (byKey.get(key).workerId === reviewer.workerId)
            throw new Error('Repair review must use a different employee from its producing work.');
          reviewed.add(key);
        }
    }
    if ([...repairs].some(key => !reviewed.has(key)))
      throw new Error('A repair plan needs independent review of all newly accepted repair work.');
  }
  return { tasks: plan.tasks.length, totalAttemptSeconds: seconds };
}

// The general graph-proposal format (MP-015): the bounded task graph a planner node returns.
// Tasks name roles (or employees) and a complexity; the controller staffs them, derives time
// limits and retries from complexity, and validates kinds, ports, roster and budgets at intake,
// before any record is written. Planners never supply execution limits or resources.
const graphTaskFields = [
  'key',
  'title',
  'kind',
  'role',
  'workerId',
  'brief',
  'acceptance',
  'dependencies',
  'complexity',
  'distinctFrom',
  'tier',
];
export function validateGraphProposal(value) {
  fields(value, ['schemaVersion', 'summary', 'tasks'], 'Graph proposal');
  if (value.schemaVersion !== 'graph-proposal-v1') throw new Error('schemaVersion must be graph-proposal-v1.');
  text(value.summary, 4000, 'Graph proposal summary');
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 10)
    throw new Error('A graph proposal needs 1 to 10 tasks.');
  for (const task of value.tasks) {
    fields(task, graphTaskFields, 'Graph proposal task');
    validateComplexity(task.complexity);
  }
  return value;
}
export const graphProposalFormat = {
  id: 'graph-proposal-v1',
  label: 'Task graph proposal',
  artifactKind: 'graph-proposal',
  validate: validateGraphProposal,
};
export const graphProposalShape = {
  schemaVersion: 'graph-proposal-v1',
  summary: 'What the graph achieves and why it is shaped this way.',
  tasks: [
    {
      key: 'draft',
      title: 'Bounded task title',
      kind: 'registered:task-kind',
      role: 'role-id',
      brief: 'What this task does.',
      acceptance: 'Observable acceptance criteria.',
      dependencies: [],
      complexity: 2,
    },
    {
      key: 'check',
      title: 'Independent check of the draft',
      kind: 'registered:review-kind',
      role: 'another-role-id',
      brief: 'What to check.',
      acceptance: 'Observable acceptance criteria.',
      dependencies: ['draft'],
      complexity: 1,
      distinctFrom: ['draft'],
    },
  ],
};
// A planner task type uses this as its proposeWork: its graph-proposal artifact becomes Planned work.
export function proposeFromGraph({ attempt, readArtifact }) {
  const item = attempt.artifacts.find(item => item.kind === graphProposalFormat.artifactKind);
  if (!item) throw new Error('Return the graph proposal as an artifact of kind graph-proposal.');
  const graph = validateGraphProposal(JSON.parse(readArtifact(item.path)));
  return {
    path: item.path,
    tasks: graph.tasks.map(task => ({
      ...structuredClone(task),
      ...validateComplexity(task.complexity),
      resources: [],
    })),
  };
}
