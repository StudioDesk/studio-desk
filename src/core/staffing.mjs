// Staffing decides which employee runs a node (MP-015 G1). A node names a role, or an
// employee explicitly; the project's organization decides who holds each role, so one
// graph runs across differently shaped organizations. Separation of duties is declared,
// not coded: a node can exclude the employees of other nodes, and a task type can require
// an employee other than whoever produced its accepted inputs.
import { resolveAdapter } from './execution.mjs';

const roleId = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,79}$/;
export const isRoleId = value => typeof value === 'string' && roleId.test(value);

export function validateRoleList(value, label) {
  if (!Array.isArray(value) || value.length > 20 || new Set(value).size !== value.length || !value.every(isRoleId))
    throw new Error(`${label} must list up to 20 distinct role IDs (letters, digits, _ . : -).`);
  return [...value];
}

function capable(registries, kind, worker) {
  try {
    const requirements = registries.workflows.requirements({ kind, resources: [] }),
      adapter = resolveAdapter(registries.adapters, requirements.definition, worker);
    return requirements.capabilities.every(capability => adapter.capabilities.includes(capability));
  } catch {
    return false;
  }
}

// Resolves { worker, staffing } for one node. An explicit employee is checked as given.
// A role picks the first enabled, capable member holding it (the project's default owner
// for the kind first), skipping excluded employees. Only when no member holds the role
// does staffing fall back to the kind's default owner, then the caller's ordered fallbacks,
// so projects that have not assigned roles keep their explicit owners.
export function staff(org, registries, { kind, workerId, role, exclude = [], fallbacks = [] }) {
  const definition = registries.workflows.get(kind),
    excluded = [...new Set(exclude.filter(Boolean))],
    record = by => ({ by, ...(role ? { role } : {}), ...(excluded.length ? { exclude: excluded } : {}) }),
    find = id => org.workers.find(worker => worker.id === id),
    eligible = worker => !!worker?.enabled && !excluded.includes(worker.id) && capable(registries, kind, worker);
  role ||= definition.role;
  if (workerId) {
    const worker = find(workerId);
    if (!worker?.enabled) throw new Error(`Choose an enabled employee for ${definition.label}.`);
    if (excluded.includes(worker.id))
      throw new Error(
        `${worker.displayName || worker.id} cannot run ${definition.label}: separation of duties requires another employee.`,
      );
    // An explicitly named employee with no exclusions needs no staffing record.
    return { worker, staffing: excluded.length ? record('employee') : null };
  }
  const owner = find(org.kindOwners?.[kind]),
    holders = role ? org.workers.filter(worker => worker.roles?.includes(role)) : [];
  if (holders.length) {
    const chosen = [...holders.filter(worker => worker === owner), ...holders.filter(worker => worker !== owner)].find(
      eligible,
    );
    if (chosen) return { worker: chosen, staffing: record('role') };
    throw new Error(
      `No enabled employee holding role ${role} can run ${definition.label}${excluded.length ? ` other than ${excluded.join(', ')}` : ''}. Assign the role to another employee in Edit the teams (Agents, then Teams).`,
    );
  }
  if (eligible(owner)) return { worker: owner, staffing: record('kind-owner') };
  const fallback = fallbacks.map(find).find(eligible);
  if (fallback) return { worker: fallback, staffing: record('fallback') };
  throw new Error(
    role
      ? `No project member holds role ${role} for ${definition.label}. Assign the role in Edit the teams (Agents, then Teams) or choose an employee.`
      : `Choose an employee or a role for ${definition.label}.`,
  );
}

// Employees a task must not run as: its recorded exclusions and, for task types that
// require independence from their inputs, whoever produced each accepted prerequisite.
export function excludedEmployees(store, registries, task) {
  const excluded = new Set(task.staffing?.exclude || []);
  if (registries.workflows.find(task.kind)?.distinctFromInputs)
    for (const id of task.dependencies || []) {
      const dependency = store.task(id),
        accepted = dependency.acceptedAttemptId && store.attempt(dependency.acceptedAttemptId);
      if (accepted) excluded.add(accepted.workerId);
    }
  return excluded;
}

// Orders node keys so every node follows its prerequisites (the graph is already acyclic).
export function topologicalKeys(nodes) {
  const byKey = new Map(nodes.map(node => [node.key, node])),
    order = [],
    seen = new Set();
  const visit = key => {
    if (seen.has(key) || !byKey.has(key)) return;
    seen.add(key);
    byKey.get(key).dependencies.forEach(visit);
    order.push(key);
  };
  nodes.forEach(node => visit(node.key));
  return order;
}

// Staffs every node of a bounded graph in dependency order. `distinctFrom` names earlier
// nodes (its direct or indirect prerequisites), or 'source' for the proposing attempt's
// employee; their employees are excluded. A task type with distinctFromInputs also excludes
// the employees of its direct prerequisites, its proposing source and its pinned inputs.
export function staffNodes(org, registries, nodes, { label = 'Node', source = null, inputs = [] } = {}) {
  const byKey = new Map(nodes.map(node => [node.key, node])),
    staffed = new Map();
  const ancestors = key => {
    const found = new Set(),
      visit = id =>
        byKey
          .get(id)
          ?.dependencies.forEach(dependency => found.has(dependency) || (found.add(dependency), visit(dependency)));
    visit(key);
    return found;
  };
  for (const key of topologicalKeys(nodes)) {
    const node = byKey.get(key),
      definition = registries.workflows.get(node.kind),
      exclude = [];
    try {
      const earlier = ancestors(key);
      for (const other of node.distinctFrom || []) {
        if (other === 'source') {
          if (!source) throw new Error("distinctFrom 'source' needs a proposing source.");
          exclude.push(source);
        } else if (!earlier.has(other)) throw new Error('distinctFrom must name its own prerequisites.');
        else exclude.push(staffed.get(other).worker.id);
      }
      if (definition.distinctFromInputs) {
        exclude.push(...node.dependencies.map(dependency => staffed.get(dependency).worker.id));
        if (source) exclude.push(source);
        for (const input of inputs)
          if ((node.acceptedInputs || []).includes(input.taskId)) exclude.push(input.workerId);
      }
      staffed.set(key, staff(org, registries, { kind: node.kind, workerId: node.workerId, role: node.role, exclude }));
    } catch (error) {
      throw new Error(`${label} ${key}: ${error.message}`);
    }
  }
  return staffed;
}
