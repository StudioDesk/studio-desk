// Fan-out and join (MP-015 G3a). A map node is a template: when its source node's result is
// accepted, the controller creates one child task per item of that result's item list,
// within the run's approved envelope and the map's width, spread across the role's holders.
// A join node waits until every child has settled, then proceeds by its rule with the
// accepted children only; children that ended without an accepted result are recorded as
// missing, never invented. Expansions inside the approved envelope need no further approval.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { recordProject } from './projects.mjs';
import { projectOrganization } from './project-organization.mjs';
import { staff } from './staffing.mjs';
import { expandRun, runIdOf, gated, graphCeilings } from './graph.mjs';

const itemKey = /^[a-zA-Z0-9_-]{1,40}$/;
export function validateItemList(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(key => !['schemaVersion', 'items'].includes(key))
  )
    throw new Error('An item list has only schemaVersion and items.');
  if (value.schemaVersion !== 'item-list-v1') throw new Error('schemaVersion must be item-list-v1.');
  if (!Array.isArray(value.items) || value.items.length > 20) throw new Error('An item list has at most 20 items.');
  const keys = new Set();
  for (const item of value.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).some(key => !['key', 'title', 'brief'].includes(key)) ||
      typeof item.key !== 'string' ||
      !itemKey.test(item.key) ||
      keys.has(item.key) ||
      typeof item.title !== 'string' ||
      !item.title.trim() ||
      item.title.length > 160 ||
      typeof item.brief !== 'string' ||
      !item.brief.trim() ||
      item.brief.length > 8000
    )
      throw new Error('Each item needs a unique safe key, a title of at most 160 characters and a brief.');
    keys.add(item.key);
  }
  return value;
}
export const itemListFormat = {
  id: 'item-list-v1',
  label: 'Item list',
  artifactKind: 'item-list',
  validate: validateItemList,
};

function acceptedItems(store, attempt) {
  const item = attempt.artifacts.find(artifact => artifact.kind === itemListFormat.artifactKind);
  if (!item) throw new Error(`${attempt.taskId} returned no item list.`);
  const contents = fs.readFileSync(artifactPath(store, attempt, item.path));
  if (hash(contents) !== item.hash) throw new Error('The accepted item list changed after validation.');
  return validateItemList(JSON.parse(contents)).items;
}

// Called inside the acceptance transaction: expands each map whose source is this task.
export function expandMaps(store, registries, task, attempt) {
  const runId = runIdOf(task),
    run = runId && store.run(runId);
  if (!run) return [];
  const created = run.revisions[0],
    sourceKey = Object.keys(created.tasks).find(key => created.tasks[key] === task.id),
    maps = sourceKey ? created.graph.nodes.filter(node => node.map?.from === sourceKey) : [];
  const children = [];
  for (const template of maps) {
    // One expansion per accepted source result; a revised and re-accepted source does not repeat it.
    if (run.revisions.some(revision => revision.map?.node === template.key)) continue;
    const join = created.graph.nodes.find(node => node.join?.from === template.key),
      joinTask = store.task(created.tasks[join.key]);
    try {
      children.push(...expandMap(store, registries, { run, created, template, joinTask, source: task, attempt }));
    } catch (error) {
      Object.assign(joinTask, {
        status: 'blocked',
        queued: false,
        controllerWait: false,
        reason: `Map ${template.key} could not expand: ${error.message}`,
      });
      store.putTask(joinTask);
    }
  }
  if (children.length) {
    const org = store.organization();
    if (!org.pipelineEnabled) {
      org.pipelineEnabled = true;
      store.setOrganization(org);
    }
  }
  return children;
}

function expandMap(store, registries, { run, created, template, joinTask, source, attempt }) {
  const items = acceptedItems(store, attempt);
  const nodes =
    Object.values(created.tasks).filter(Boolean).length +
    run.revisions.slice(1).reduce((count, revision) => count + (revision.added?.length || 0), 0);
  // Code ceilings are hard limits. Within them, children beyond the map's width or the run's
  // approved node count wait at a gate for the director (G3c).
  if (nodes + items.length > graphCeilings.expandedNodes)
    throw new Error(
      `${items.length} children would bring the run to ${nodes + items.length} nodes, beyond the ceiling of ${graphCeilings.expandedNodes}.`,
    );
  const approved = Math.max(0, Math.min(template.map.maxWidth, run.envelope.nodes - nodes));
  const org = projectOrganization(store, recordProject(source)),
    definition = registries.workflows.get(template.kind),
    // Independence is a hard rule; spreading work across the role's holders is a preference.
    required = [
      ...(template.distinctFrom || []).map(key => store.task(created.tasks[key]).workerId),
      ...(definition.distinctFromInputs ? [attempt.workerId] : []),
    ],
    used = [],
    now = new Date().toISOString();
  const tasks = items.map((item, index) => {
    let chosen;
    try {
      chosen = staff(org, registries, { ...template, exclude: [...required, ...used] });
    } catch (error) {
      if (!used.length) throw error;
      used.length = 0;
      chosen = staff(org, registries, { ...template, exclude: required });
    }
    used.push(chosen.worker.id);
    return {
      id: 'T-' + randomUUID().slice(0, 8),
      projectId: recordProject(source),
      kind: template.kind,
      title: `${template.title}: ${item.title}`.slice(0, 160),
      brief: `${template.brief}\n\nItem ${item.key}: ${item.title}\n${item.brief}`,
      acceptance: template.acceptance,
      workerId: chosen.worker.id,
      team: chosen.worker.team,
      ...(chosen.staffing ? { staffing: chosen.staffing } : {}),
      ...(template.tier ? { tier: template.tier } : {}),
      resources: [...(template.resources || [])],
      maxSeconds: template.maxSeconds,
      maxAttempts: template.maxAttempts,
      dependencies: [source.id],
      goalId: null,
      direction: source.direction || '',
      status: 'ready',
      reason: '',
      hold: false,
      queued: true,
      lastAttemptId: null,
      createdAt: now,
      mapReference: { node: template.key, item: item.key },
      ...(index >= approved
        ? gated(
            `item ${index + 1} of ${items.length} is beyond the approved limits (map width ${template.map.maxWidth}, run envelope ${run.envelope.nodes} nodes).`,
          )
        : {}),
    };
  });
  const revision = expandRun(store, run.id, {
    reason: `Map ${template.key} expanded over ${items.length} item${items.length === 1 ? '' : 's'} from ${source.id}.`,
    source: source.id,
    tasks,
    details: { map: { node: template.key, join: joinTask.id, children: tasks.map(child => child.id) } },
  });
  for (const child of tasks) {
    child.mapReference.revision = revision;
    store.putTask(child);
  }
  // The join now waits for these children instead of the map's source.
  const placeholders = joinTask.join.placeholders || [];
  joinTask.dependencies = [
    ...joinTask.dependencies.filter(id => !placeholders.includes(id)),
    ...tasks.map(child => child.id),
  ];
  joinTask.join = { ...joinTask.join, children: tasks.map(child => child.id), revision };
  store.putTask(joinTask);
  return tasks;
}

// A child is settled once it can no longer produce an accepted result without the director.
function settled(store, registries, child) {
  return (
    ['done', 'denied', 'cancelled'].includes(child.status) ||
    (child.status === 'failed' && registries.workflows.stageAttempts(store, child).length >= child.maxAttempts)
  );
}
// Join readiness. Returns null for a task that is not an expanded join.
export function joinStatus(store, registries, task) {
  if (!task.join) return null;
  // Until its map expands, a join has no children to judge and must not run.
  if (!task.join.children)
    return { reason: `Waiting for map ${task.join.from} to expand when its source is accepted.` };
  const children = task.join.children.map(id => store.task(id)),
    waiting = children.filter(child => !settled(store, registries, child));
  if (waiting.length)
    return {
      reason: `Waiting for ${waiting.length} of ${children.length} children: ${waiting.map(child => child.id).join(', ')}.`,
    };
  const accepted = children.filter(child => child.status === 'done').map(child => child.id),
    missing = children.filter(child => child.status !== 'done').map(child => child.id),
    needed = task.join.rule === 'quorum' ? task.join.min : children.length;
  if (accepted.length < needed)
    return {
      reason: `This join needs ${needed} accepted children; ${accepted.length} were accepted and ${missing.length} are missing (${missing.join(', ')}).`,
    };
  return { accepted, missing };
}
