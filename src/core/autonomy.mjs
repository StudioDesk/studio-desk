// Per-project autonomy policy: which steps the controller may take on the
// director's behalf. Defaults keep every decision with the director. The
// policy never grants permissions; it only automates approval, acceptance,
// bounded retries, scope requests a task type knows how to apply, the request
// to integrate a result a task type says is ready (MP-023), and the start of a
// saved workflow. Integration itself still verifies everything it verified
// after the director's approval, and overriding a review stays the director's.
import fs from 'node:fs';
import { hash } from './contracts.mjs';
import { artifactPath } from './artifacts.mjs';
import { projectCatalog } from './project-organization.mjs';

export const MODES = ['director', 'auto'];
const key = id => 'project-autonomy:' + id;
const runsKey = id => 'project-autonomy-runs:' + id;
const DAY = 24 * 60 * 60 * 1000;

function fields(value, allowed, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(field => !allowed.includes(field))
  )
    throw new Error(`Unsupported ${label} fields.`);
}

export function defaultPolicy() {
  return {
    revision: 0,
    enabled: false,
    kinds: {},
    retries: 0,
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  };
}

export function autonomyPolicy(store, projectId) {
  return store.setting(key(projectId)) || defaultPolicy();
}

// Recommended per-kind modes come from each task definition; anything else stays with the director.
export function recommendedKinds(store, registries, projectId) {
  return Object.fromEntries(
    projectCatalog(store, registries, projectId)
      .filter(definition => definition.autonomy?.recommended)
      .map(definition => [
        definition.kind,
        { approve: 'director', accept: 'director', ...definition.autonomy.recommended },
      ]),
  );
}

// The recommended house rules a new project can start on: the director approves plans; work that passes its
// review goes in on its own, with one automatic retry and no cycle.
export function applyRecommendedHouseRules(store, registries, projectId) {
  return saveAutonomyPolicy(store, registries, projectId, {
    expectedRevision: autonomyPolicy(store, projectId).revision,
    enabled: true,
    retries: 1,
    kinds: recommendedKinds(store, registries, projectId),
    cycle: { enabled: false, workflowId: null, maxPerDay: 3 },
  });
}

export function saveAutonomyPolicy(store, registries, projectId, data) {
  store.project(projectId);
  fields(data, ['expectedRevision', 'enabled', 'kinds', 'retries', 'cycle'], 'autonomy policy');
  const previous = autonomyPolicy(store, projectId);
  if (data.expectedRevision !== previous.revision) throw new Error('Autonomy policy changed. Refresh before saving.');
  if (typeof data.enabled !== 'boolean') throw new Error('Choose whether autonomy is enabled.');
  if (![0, 1].includes(data.retries)) throw new Error('Automatic retries must be 0 or 1.');
  const definitions = projectCatalog(store, registries, projectId),
    catalog = definitions.map(definition => definition.kind);
  fields(data.kinds || {}, catalog, 'autonomy task type');
  const kinds = {};
  for (const [kind, mode] of Object.entries(data.kinds || {})) {
    // Only a task type that says how to apply a scope request has a scope mode, and only one that
    // says when its result is ready to integrate has an integrate mode.
    const declared = definitions.find(definition => definition.kind === kind).autonomy,
      scoped = !!declared?.scopeRequest,
      integrated = !!declared?.integration;
    fields(
      mode,
      ['approve', 'accept', ...(scoped ? ['scope'] : []), ...(integrated ? ['integrate'] : [])],
      'autonomy mode',
    );
    if (
      !MODES.includes(mode.approve) ||
      !MODES.includes(mode.accept) ||
      (mode.scope !== undefined && !MODES.includes(mode.scope)) ||
      (mode.integrate !== undefined && !MODES.includes(mode.integrate))
    )
      throw new Error('Autonomy modes must be director or auto.');
    kinds[kind] = {
      approve: mode.approve,
      accept: mode.accept,
      ...(scoped ? { scope: mode.scope ?? 'director' } : {}),
      ...(integrated ? { integrate: mode.integrate ?? 'director' } : {}),
    };
  }
  const cycle = data.cycle || { enabled: false, workflowId: null, maxPerDay: 3 };
  fields(cycle, ['enabled', 'workflowId', 'maxPerDay'], 'autonomy cycle');
  if (
    typeof cycle.enabled !== 'boolean' ||
    !Number.isInteger(cycle.maxPerDay) ||
    cycle.maxPerDay < 1 ||
    cycle.maxPerDay > 20
  )
    throw new Error('Choose a daily cycle cap from 1 to 20.');
  if (cycle.workflowId !== null) {
    const workflow = store.workflow(cycle.workflowId);
    if (workflow.projectId !== projectId) throw new Error('Choose a saved workflow from this project.');
  } else if (cycle.enabled) throw new Error('Choose the workflow that starts each cycle.');
  const policy = {
    revision: previous.revision + 1,
    enabled: data.enabled,
    kinds,
    retries: data.retries,
    cycle: { enabled: cycle.enabled, workflowId: cycle.workflowId, maxPerDay: cycle.maxPerDay },
    savedAt: new Date().toISOString(),
  };
  policy.history = [...(previous.history || []), { ...structuredClone(policy), history: undefined }].slice(-50);
  store.putSetting(key(projectId), policy);
  store.event(
    'autonomy_updated',
    null,
    null,
    `Autonomy policy revision ${policy.revision} saved (${policy.enabled ? 'enabled' : 'disabled'}). ${
      policy.enabled && Object.values(kinds).some(mode => mode.integrate === 'auto')
        ? 'Work set to integrate after a passing review integrates without the director; any other integration waits for the director.'
        : 'Integration waits for the director.'
    }`,
    projectId,
  );
  return policy;
}

// scope: whether the policy approves a blocked attempt's scope request (a task type's scopeRequest
// hook); integrate: whether it requests the integration of a result the task type's integration
// hook says is ready. Policies saved before either mode leave that decision with the director.
export function kindMode(policy, kind) {
  const director = { approve: 'director', accept: 'director', scope: 'director', integrate: 'director' };
  if (!policy.enabled) return director;
  return { ...director, ...policy.kinds[kind] };
}

// Decides what the controller may do with a reviewed attempt.
// Returns { ok, reason } plus optional { retry } (redo this task) or
// { retryUpstream: { taskId, reason } } (record this result, redo its source).
export function evaluateAttempt(store, registries, task, attempt) {
  const definition = registries.workflows.get(task.kind);
  const failed = [...(attempt.result?.checks || []), ...(attempt.controllerChecks || [])].filter(
    check => check.status === 'fail',
  );
  const readArtifact = relative => {
    const item = attempt.artifacts.find(item => item.path === relative);
    if (!item) throw new Error('Autonomy evaluation requested an unregistered artifact.');
    const contents = fs.readFileSync(artifactPath(store, attempt, relative));
    if (hash(contents) !== item.hash) throw new Error('Artifact changed after validation.');
    return contents;
  };
  if (definition.autonomy?.evaluate) {
    const verdict = definition.autonomy.evaluate({ store, task, attempt, readArtifact, failed });
    if (!verdict || verdict.then || typeof verdict.ok !== 'boolean' || typeof verdict.reason !== 'string')
      throw new Error('Autonomy evaluation must return a synchronous verdict.');
    return verdict;
  }
  return failed.length
    ? { ok: false, retry: true, reason: 'Failed checks: ' + failed.map(check => check.name).join(', ') }
    : { ok: true, reason: 'All recorded checks passed.' };
}

export function cycleRunsToday(store, projectId, now = Date.now()) {
  return (store.setting(runsKey(projectId)) || []).filter(at => now - Date.parse(at) < DAY).length;
}

export function recordCycleRun(store, projectId, now = new Date()) {
  const runs = (store.setting(runsKey(projectId)) || []).filter(at => now - Date.parse(at) < DAY);
  store.putSetting(runsKey(projectId), [...runs, now.toISOString()]);
}
