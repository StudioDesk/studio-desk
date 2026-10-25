import { randomUUID } from 'node:crypto';
import { hash, jsonEqual } from './contracts.mjs';
import { LEGACY_PROJECT } from './projects.mjs';
import { projectOrganization, assertProjectKind } from './project-organization.mjs';
import { resolveAdapter, TIERS } from './execution.mjs';
import { unmetConsumes, portMessage } from './formats.mjs';
import { isRoleId, staffNodes } from './staffing.mjs';
import { transforms } from './transforms.mjs';
import { workflowGraph, stepsFromGraph, validateGraphShape, graphEnvelope, newRun, gated } from './graph.mjs';
import { createDirectorInputs } from './idea-inputs.mjs';

function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !allowed.includes(key))
  )
    throw new Error('Workflow contains unsupported fields.');
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} needs bounded nonempty text.`);
}
export function validateWorkflow(store, registries, steps, projectId = LEGACY_PROJECT) {
  return checkWorkflow(store, registries, steps, projectId).budget;
}
// A graph-v1 workflow (MP-015 G2): its structure, the same node checks as steps, then its envelope.
export function validateGraph(store, registries, graph, projectId = LEGACY_PROJECT) {
  validateGraphShape(graph);
  checkMapSources(registries, graph);
  checkMilestones(registries, graph);
  const { budget } = checkWorkflow(store, registries, graphSteps(graph), projectId, transformOutputs(graph));
  return { ...budget, envelope: graphEnvelope(graph, budget) };
}
// A map expands over its source's accepted item list, so the source must produce one.
function checkMilestones(registries, graph) {
  for (const edge of graph.edges.filter(edge => edge.milestone && edge.milestone !== 'accepted')) {
    const upstream = graph.nodes.find(node => node.key === edge.from);
    if (!registries.workflows.milestonesOf(upstream.kind).includes(edge.milestone))
      throw new Error(
        `Edge ${edge.from} → ${edge.to} waits for ${edge.milestone}, which ${upstream.kind} does not define; it defines ${registries.workflows.milestonesOf(upstream.kind).join(', ')}.`,
      );
  }
}
function checkMapSources(registries, graph) {
  for (const node of graph.nodes.filter(node => node.map)) {
    const source = graph.nodes.find(other => other.key === node.map.from);
    if (!registries.workflows.get(source.kind).produces?.includes('item-list-v1'))
      throw new Error(`Map ${node.key} needs a source whose task type produces item-list-v1.`);
  }
}
// A join's controller transform is one more input it receives, so its output format counts
// as produced upstream of the join.
function transformOutputs(graph) {
  return new Map(
    graph.nodes
      .filter(node => node.join?.transform)
      .map(node => {
        const transform = transforms[node.join.transform];
        if (!transform)
          throw new Error(
            `Join ${node.key} names an unknown transform; choose one of: ${Object.keys(transforms).join(', ')}.`,
          );
        return [node.key, [transform.output.id]];
      }),
  );
}
// A graph's nodes as steps. Map and join settings are graph-only; nodes get the step checks.
function graphSteps(graph) {
  return stepsFromGraph(graph).map(({ map, join, gate, ...step }) => step);
}
// The steps a workflow runs: its graph's nodes with incoming edges, or its saved steps.
function workflowSteps(workflow) {
  if (!workflow.graph) return workflow.steps;
  const graph = validateGraphShape(structuredClone(workflow.graph));
  return graphSteps(graph);
}
// Validates a workflow and staffs its steps for the project's current organization.
function checkWorkflow(store, registries, steps, projectId, produced = new Map()) {
  if (
    !Array.isArray(steps) ||
    !steps.length ||
    steps.length > 10 ||
    Buffer.byteLength(JSON.stringify(steps)) > 256 * 1024
  )
    throw new Error('A workflow needs 1 to 10 bounded steps.');
  const org = projectOrganization(store, projectId),
    byKey = new Map();
  let budget = 0;
  for (const step of steps) {
    fields(step, [
      'key',
      'title',
      'kind',
      'workerId',
      'role',
      'distinctFrom',
      'tier',
      'brief',
      'acceptance',
      'dependencies',
      'resources',
      'maxSeconds',
      'maxAttempts',
      'inputData',
    ]);
    if (typeof step.key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(step.key) || byKey.has(step.key))
      throw new Error('Workflow step keys must be unique safe identifiers.');
    text(step.title, 160, 'Step title');
    text(step.brief, 24000, 'Step brief');
    text(step.acceptance, 24000, 'Step acceptance');
    // A step names one employee, or a role the project's organization staffs (MP-015).
    if (step.role === undefined) {
      if (!org.workers.some(worker => worker.id === step.workerId && worker.enabled))
        throw new Error('Choose an enabled employee or a role for every step.');
    } else if (step.workerId !== undefined || !isRoleId(step.role))
      throw new Error('A step names either an enabled employee or one role ID.');
    if (
      step.distinctFrom !== undefined &&
      (!Array.isArray(step.distinctFrom) ||
        step.distinctFrom.length > 10 ||
        new Set(step.distinctFrom).size !== step.distinctFrom.length ||
        step.distinctFrom.some(key => typeof key !== 'string'))
    )
      throw new Error('Step distinctFrom must list distinct step keys.');
    if (step.tier !== undefined && !TIERS.includes(step.tier))
      throw new Error(`A step tier must be one of ${TIERS.join(', ')}.`);
    const definition = registries.workflows.get(step.kind);
    assertProjectKind(store, registries, projectId, step.kind);
    if (!definition.creatable) throw new Error('This task definition cannot be composed into a workflow.');
    if (
      !Array.isArray(step.resources) ||
      step.resources.length > 10 ||
      step.resources.some(resource => typeof resource !== 'string' || !/^[a-zA-Z0-9:_-]{1,80}$/.test(resource))
    )
      throw new Error('Invalid workflow resource.');
    if (
      !Array.isArray(step.dependencies) ||
      step.dependencies.length > 10 ||
      new Set(step.dependencies).size !== step.dependencies.length
    )
      throw new Error('Invalid workflow handoffs.');
    if (
      !Number.isInteger(step.maxSeconds) ||
      step.maxSeconds < 5 ||
      step.maxSeconds > 600 ||
      !Number.isInteger(step.maxAttempts) ||
      step.maxAttempts < 1 ||
      step.maxAttempts > 3
    )
      throw new Error('Invalid workflow execution limits.');
    budget += step.maxSeconds * step.maxAttempts;
    if (definition.operation?.source === 'task-data')
      registries.connectors.inputData(definition.operation, step.inputData);
    else if (step.inputData !== undefined) throw new Error('This workflow step does not accept supplied data.');
    if (definition.acceptFailedChecks && !definition.standaloneReport && !step.dependencies.length)
      throw new Error('A review step needs a prerequisite.');
    byKey.set(step.key, step);
  }
  if (budget > 1800) throw new Error('Workflow exceeds the 1800-second total attempt budget.');
  const visiting = new Set(),
    visited = new Set();
  const visit = key => {
    if (!byKey.has(key)) throw new Error('Workflow references a missing prerequisite.');
    if (visiting.has(key)) throw new Error('Workflow handoffs contain a cycle.');
    if (visited.has(key)) return;
    visiting.add(key);
    byKey.get(key).dependencies.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  byKey.forEach((step, key) => visit(key));
  const staffed = staffNodes(org, registries, steps, { label: 'Step' });
  for (const step of steps) {
    const requirements = registries.workflows.requirements(step),
      adapter = resolveAdapter(registries.adapters, registries.workflows.get(step.kind), staffed.get(step.key).worker);
    for (const capability of requirements.capabilities)
      if (!adapter.capabilities.includes(capability))
        throw new Error(`Step adapter lacks required capability: ${capability}.`);
  }
  for (const step of steps) {
    const unmet = unmetConsumes(
      registries.workflows,
      step.kind,
      step.dependencies.map(key => byKey.get(key).kind),
    ).filter(format => !(produced.get(step.key) || []).includes(format));
    if (unmet.length) throw new Error(portMessage(registries.workflows, `Step ${step.key}`, unmet));
  }
  for (const step of steps) {
    const binding = registries.workflows.get(step.kind).operation;
    if (binding?.source === 'accepted-artifact') {
      const producers = step.dependencies
        .map(key => registries.workflows.get(byKey.get(key).kind).operation)
        .filter(Boolean);
      if (
        producers.length !== 1 ||
        producers[0].outputContract !== binding.inputContract ||
        !jsonEqual(producers[0].configuration, binding.configuration)
      )
        throw new Error('Accepted handoff needs one compatible producing step.');
    }
  }
  return { budget: { steps: steps.length, totalAttemptSeconds: budget }, staffed };
}
// A director brief steers one run: it is recorded on the run reference and becomes each step's
// direction, so it reaches the composed instructions recorded for every attempt.
// The run record keeps the exact graph and the task created for each node.
export function materializeWorkflow(store, registries, workflow, { brief = '', ideaFiles = [] } = {}) {
  const steps = workflowSteps(workflow),
    graph = workflowGraph(workflow),
    { budget, staffed } = checkWorkflow(
      store,
      registries,
      steps,
      workflow.projectId,
      workflow.graph ? transformOutputs(graph) : undefined,
    ),
    envelope = graphEnvelope(graph, budget),
    runId = 'run-' + randomUUID(),
    now = new Date().toISOString(),
    directorInputs = createDirectorInputs(workflow.projectId, runId, ideaFiles);
  // A map node is a template with no task until its source is accepted; a join waits on
  // the map's source until then, and on the map's children afterwards (fanout.mjs).
  const shapes = new Map(graph.nodes.map(node => [node.key, node])),
    isMap = key => !!shapes.get(key)?.map;
  const ids = new Map(steps.filter(step => !isMap(step.key)).map(step => [step.key, 'T-' + randomUUID().slice(0, 8)]));
  const digest = hash(JSON.stringify(workflow.graph || workflow.steps));
  // Edges that wait for a later milestone than acceptance.
  const waitsForOf = key => {
    const later = graph.edges.filter(edge => edge.to === key && edge.milestone && edge.milestone !== 'accepted');
    return later.length
      ? { waitsFor: Object.fromEntries(later.map(edge => [ids.get(edge.from), edge.milestone])) }
      : {};
  };
  const tasks = steps
    .filter(step => !isMap(step.key))
    .map(({ role, distinctFrom, ...step }) => {
      const { worker, staffing } = staffed.get(step.key),
        direct = step.dependencies.filter(key => !isMap(key)).map(key => ids.get(key)),
        placeholders = step.dependencies
          .filter(isMap)
          .map(key => ids.get(shapes.get(key).map.from))
          .filter(id => !direct.includes(id)),
        join = shapes.get(step.key).join,
        gate = shapes.get(step.key).gate;
      return {
        ...structuredClone(step),
        ...(join ? { join: { ...structuredClone(join), placeholders } } : {}),
        workerId: worker.id,
        ...(staffing ? { staffing } : {}),
        id: ids.get(step.key),
        projectId: workflow.projectId,
        directorInputs: structuredClone(directorInputs),
        team: worker.team,
        goalId: null,
        dependencies: [...new Set([...direct, ...placeholders])],
        status: 'ready',
        direction: brief ? `Director brief for this run: ${brief}` : '',
        reason: '',
        hold: false,
        queued: true,
        lastAttemptId: null,
        createdAt: now,
        // A gate node waits in Planned for the director before it can run.
        ...(gate ? gated(gate.reason) : {}),
        ...waitsForOf(step.key),
        workflowReference: {
          id: workflow.id,
          name: workflow.name,
          version: workflow.version,
          runId,
          key: step.key,
          hash: digest,
          ...(brief ? { brief } : {}),
        },
      };
    });
  const run = newRun({
    id: runId,
    projectId: workflow.projectId,
    workflow,
    brief,
    graph,
    envelope,
    taskIds: ids,
    at: now,
  });
  run.directorInputs = structuredClone(directorInputs);
  return { runId, tasks, budget, run };
}
