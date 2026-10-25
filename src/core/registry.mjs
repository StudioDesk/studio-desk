// Registries contain explicitly imported, trusted local code. They do not load
// arbitrary plugins and are not a permission sandbox.
import { FormatRegistry, validatePorts } from './formats.mjs';
import { isRoleId } from './staffing.mjs';
import { graphProposalFormat } from './planning.mjs';
import { itemListFormat } from './fanout.mjs';
import { collectionFormat } from './transforms.mjs';
import { TIERS } from './execution.mjs';
import { validateStageTemplate, templateStages } from './stage-template.mjs';
import { MAX_RESULT_ARTIFACTS } from './contracts.mjs';

const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value);
const strings = value => Array.isArray(value) && value.every(identifier);
const freezeData = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeData);
    Object.freeze(value);
  }
  return value;
};
const controllerFields = new Set([
  'id',
  'taskId',
  'workerId',
  'provider',
  'requestedModel',
  'requestedTier',
  'joinMissing',
  'inputTransform',
  'reportedModel',
  'status',
  'startedAt',
  'finishedAt',
  'pid',
  'sessionId',
  'outputFolder',
  'artifacts',
  'configuration',
  'assignment',
  'inputReferences',
  'delivery',
  'instructions',
  'contracts',
  'operation',
  'result',
  'controllerChecks',
  'error',
  'acceptedAt',
  'acceptedBy',
  'revisionRequestedBy',
  'failedTests',
  'reconciledAt',
  'integration',
  '__proto__',
  'constructor',
  'prototype',
  'toJSON',
]);

export class OrganizationPresetRegistry {
  constructor() {
    this.presets = new Map();
  }
  register(preset) {
    if (
      !identifier(preset.id) ||
      !identifier(preset.version) ||
      this.presets.has(preset.id) ||
      typeof preset.create !== 'function'
    )
      throw new Error('Invalid or duplicate organization preset.');
    this.presets.set(preset.id, Object.freeze({ ...preset }));
    return this;
  }
  get(id) {
    const preset = this.presets.get(id);
    if (!preset) throw new Error(`Unknown organization preset: ${id}.`);
    return preset;
  }
}

[
  'projectId',
  'project',
  'workflowReference',
  'checkExecution',
  'sourceEditExecution',
  'sourceCandidate',
  'sourceWorktree',
  'sourceIntegration',
  'approval',
  'proposalReference',
  'proposedConfiguration',
  'proposedTaskIds',
  'sprintId',
  'organization',
  'organizationReference',
  'ownerHistory',
  'teamId',
].forEach(field => controllerFields.add(field));

// Whether an attempt counts toward its stage's attempt limit (WorkflowRegistry.stageAttempts): not one a usage limit
// stopped, nor one interrupted by the controller's stop and then reconciled. public/runs.js and the dashboard's
// story page apply the same rule.
export const countsTowardLimit = attempt =>
  !attempt.subscriptionHold && !(attempt.status === 'interrupted' && attempt.reconciledAt);

// A task definition's stages run one task record through several execution views.
// Each view runs as its own attempt with its own kind, employee, inputs and limits;
// the hooks are trusted pack code and default to single-stage behavior. `closable` says
// whether accepted work is still unfinished and may be closed; `closed` records the closing;
// `direction` keeps the director's direction for the current stage and says whether it did;
// `returnable` gives { findings, passed, needsNote } when the director may send the work back: what a later stage
// returned, findings or (passed) a pass the director overrules, and whether the director's note is needed.
const stageHooks = [
  'view',
  'attempts',
  'progress',
  'inputs',
  'finished',
  'accepted',
  'retry',
  'clear',
  'closable',
  'closed',
  'direction',
  'returnable',
];

export class WorkflowRegistry {
  constructor(connectors, formats = new FormatRegistry()) {
    this.connectors = connectors;
    this.formats = formats;
    // Core formats every pack may use.
    for (const format of [graphProposalFormat, itemListFormat, collectionFormat])
      if (!formats.formats.has(format.id)) formats.register(format);
    this.roles = new Map();
    this.packs = new Map();
    this.tasks = new Map();
    this.resourceRules = [];
  }
  register(pack) {
    if (
      !identifier(pack.id) ||
      !identifier(pack.version) ||
      this.packs.has(pack.id) ||
      !Array.isArray(pack.tasks) ||
      !pack.tasks.length
    )
      throw new Error('Invalid or duplicate workflow pack.');
    if (pack.formats !== undefined && !Array.isArray(pack.formats))
      throw new Error('Workflow pack formats must be a list.');
    for (const format of pack.formats || []) this.formats.register(format);
    // Roles a pack's task types are staffed by. Organizations decide who holds them.
    if (pack.roles !== undefined && !Array.isArray(pack.roles)) throw new Error('Workflow pack roles must be a list.');
    for (const role of pack.roles || []) {
      if (!role || !isRoleId(role.id) || typeof role.label !== 'string' || !role.label.trim())
        throw new Error('Workflow pack roles need a role ID and label.');
      // Role IDs are shared vocabulary across packs; the first pack to name a role labels it.
      if (!this.roles.has(role.id)) this.roles.set(role.id, Object.freeze({ id: role.id, label: role.label }));
    }
    const kinds = new Set();
    for (const task of pack.tasks) {
      if (
        !identifier(task.kind) ||
        !identifier(task.version) ||
        this.tasks.has(task.kind) ||
        kinds.has(task.kind) ||
        !strings(task.requiredCapabilities) ||
        !strings(task.requiredResources) ||
        (task.resourcesFor !== undefined && typeof task.resourcesFor !== 'function') ||
        typeof task.label !== 'string' ||
        typeof task.instructions !== 'function' ||
        typeof task.validateOutput !== 'function'
      )
        throw new Error('Invalid or duplicate task definition.');
      kinds.add(task.kind);
      validatePorts(this.formats, task);
      if (task.operation) {
        if (!this.connectors) throw new Error('An operation binding requires a connector registry.');
        this.connectors.resolve(task.operation);
        if (task.executionAdapter !== 'local-operation')
          throw new Error('Local operation bindings require controller-owned execution.');
      }
      if (
        task.attemptFields &&
        (!strings(task.attemptFields) || task.attemptFields.some(field => controllerFields.has(field)))
      )
        throw new Error('Workflow metadata cannot overwrite controller-owned attempt fields.');
      if (task.role !== undefined && !isRoleId(task.role)) throw new Error('A task role must be a role ID.');
      if (
        task.milestones !== undefined &&
        (!task.milestones ||
          typeof task.milestones !== 'object' ||
          Array.isArray(task.milestones) ||
          Object.entries(task.milestones).some(
            ([name, reached]) => !identifier(name) || name === 'accepted' || typeof reached !== 'function',
          ))
      )
        throw new Error('Task milestones map names other than accepted to synchronous checks.');
      if (task.tier !== undefined && !TIERS.includes(task.tier))
        throw new Error(`A task tier must be one of ${TIERS.join(', ')}.`);
      if (
        task.maxArtifacts !== undefined &&
        (!Number.isInteger(task.maxArtifacts) || task.maxArtifacts < 1 || task.maxArtifacts > MAX_RESULT_ARTIFACTS)
      )
        throw new Error(`maxArtifacts must be a whole number from 1 to ${MAX_RESULT_ARTIFACTS}.`);
      for (const flag of [
        'fixedAttemptLimit',
        'requiresIsolation',
        'revalidateOnAccept',
        'exactProposals',
        'distinctFromInputs',
      ])
        if (task[flag] !== undefined && typeof task[flag] !== 'boolean')
          throw new Error(`${flag} must be true or false.`);
      if (
        task.stages !== undefined &&
        (!task.stages ||
          typeof task.stages !== 'object' ||
          Array.isArray(task.stages) ||
          Object.entries(task.stages).some(([hook, fn]) => !stageHooks.includes(hook) || typeof fn !== 'function'))
      )
        throw new Error(`Task stages support only these synchronous hooks: ${stageHooks.join(', ')}.`);
      if (
        (task.proposeWork !== undefined && typeof task.proposeWork !== 'function') ||
        (task.autoProposeWork && !task.proposeWork)
      )
        throw new Error('Proposed work needs a synchronous trusted task hook.');
      // A task type may say how a blocked attempt's scope request is applied (scopeRequest), and
      // only then may the policy approve such requests ('scope' mode). Likewise, a task type with an
      // integration step may say when its accepted result is ready to integrate (integration), and
      // only then may the policy request that integration ('integrate' mode).
      const autonomy = task.autonomy,
        scoped = autonomy?.scopeRequest !== undefined,
        integrated = autonomy?.integration !== undefined;
      if (
        autonomy !== undefined &&
        (!autonomy ||
          typeof autonomy !== 'object' ||
          Object.keys(autonomy).some(
            key => !['recommended', 'evaluate', 'scopeRequest', 'integration'].includes(key),
          ) ||
          (autonomy.evaluate !== undefined && typeof autonomy.evaluate !== 'function') ||
          (scoped &&
            (typeof autonomy.scopeRequest?.label !== 'string' || typeof autonomy.scopeRequest.apply !== 'function')) ||
          (integrated &&
            (typeof autonomy.integration?.label !== 'string' || typeof autonomy.integration.ready !== 'function')) ||
          (autonomy.recommended !== undefined &&
            Object.entries(autonomy.recommended).some(
              ([key, mode]) =>
                !['approve', 'accept', ...(scoped ? ['scope'] : []), ...(integrated ? ['integrate'] : [])].includes(
                  key,
                ) || !['director', 'auto'].includes(mode),
            )))
      )
        throw new Error('Invalid task autonomy declaration.');
    }
    for (const rule of pack.resourceRules || [])
      if (!(rule.pattern instanceof RegExp) || !identifier(rule.capability) || typeof rule.reason !== 'string')
        throw new Error('Invalid workflow resource capability rule.');
    // A stage template (G3d) may name kinds registered earlier or in this pack.
    const inPack = new Map(pack.tasks.map(task => [task.kind, task]));
    for (const task of pack.tasks)
      if (task.stageTemplate !== undefined)
        validateStageTemplate(task, task.stageTemplate, kind => this.tasks.get(kind) || inPack.get(kind) || null);
    for (const task of pack.tasks) {
      const operation = task.operation && structuredClone(task.operation);
      if (operation) freezeData(operation);
      const stageTemplate = task.stageTemplate && freezeData(structuredClone(task.stageTemplate));
      this.tasks.set(
        task.kind,
        Object.freeze({
          ...task,
          ...(operation ? { operation } : {}),
          ...(stageTemplate ? { stageTemplate, stages: templateStages(task.kind, stageTemplate) } : {}),
          attemptFields: Object.freeze([...(task.attemptFields || [])]),
          requiredCapabilities: Object.freeze([...task.requiredCapabilities]),
          requiredResources: Object.freeze([...task.requiredResources]),
          ...(task.consumes ? { consumes: Object.freeze([...task.consumes]) } : {}),
          ...(task.produces ? { produces: Object.freeze([...task.produces]) } : {}),
          packId: pack.id,
          packVersion: pack.version,
        }),
      );
    }
    this.packs.set(pack.id, Object.freeze({ ...pack }));
    this.resourceRules.push(...(pack.resourceRules || []));
    if (pack.planning && !this.planning) this.planning = pack.planning;
    return this;
  }
  get(kind) {
    const task = this.tasks.get(kind);
    if (!task) throw new Error(`Unknown assignment kind: ${kind}.`);
    return task;
  }
  find(kind) {
    return this.tasks.get(kind);
  }
  list() {
    return [...this.tasks.values()];
  }
  // Whether a task has reached a milestone: accepted (its result is accepted), or one its task
  // type defines, such as integrated for source stories.
  reached(store, task, milestone = 'accepted') {
    if (task.status !== 'done') return false;
    if (milestone === 'accepted') return true;
    return !!this.tasks.get(task.kind)?.milestones?.[milestone]?.(task, { store });
  }
  milestonesOf(kind) {
    return ['accepted', ...Object.keys(this.tasks.get(kind)?.milestones || {})];
  }
  stagesOf(task) {
    return this.tasks.get(task.kind)?.stages;
  }
  // The execution view for a task's current stage; the task itself otherwise.
  stageView(task) {
    return this.stagesOf(task)?.view?.(task) ?? task;
  }
  // The stored task a stage view belongs to, or null when `task` is not a stage view.
  stageOwner(store, task) {
    let stored;
    try {
      stored = store.task(task.id);
    } catch {
      return null;
    }
    return stored.kind !== task.kind && this.stagesOf(stored) ? stored : null;
  }
  // Attempts that count toward the current stage's attempt limit. An attempt a provider's
  // usage limit stopped, or one the controller's own stop interrupted and the director then
  // reconciled, says nothing about the work, so it stays on record but doesn't count, except
  // under a fixed limit, which is a safety rule (the recovery drill, v1.0 criterion 3).
  stageAttempts(store, task) {
    const owner = this.stageOwner(store, task) || task,
      attempts = this.stagesOf(owner)?.attempts?.(store, task) ?? store.attempts(task.id);
    return this.find(task.kind)?.fixedAttemptLimit ? attempts : attempts.filter(countsTowardLimit);
  }
  // Input references for a stage view, or null to use the task's accepted dependencies.
  stageInputs(store, task) {
    const owner = this.stageOwner(store, task);
    return (owner && this.stagesOf(owner).inputs?.(store, task)) ?? null;
  }
  // Sets the director's direction for a task's next attempt, in its current stage if it has one.
  direct(task, text) {
    if (!this.stagesOf(task)?.direction?.(task, text)) task.direction = text;
  }
  stageProgress(store, task) {
    this.stagesOf(task)?.progress?.(task, { store });
  }
  // context.store lets a task type name resources that depend on the task's project (resourcesFor),
  // such as one repository's source resources; without it the type names its defaults.
  requirements(task, context = {}) {
    const definition = this.get(task.kind);
    const operation = definition.operation && this.connectors.resolve(definition.operation);
    const resources = [
      ...new Set([
        ...definition.requiredResources,
        ...(definition.resourcesFor?.({ task, store: context.store }) || []),
        ...(operation?.requiredResources || []),
        ...task.resources,
      ]),
    ];
    const rules = this.resourceRules.filter(rule =>
      resources.some(resource => {
        rule.pattern.lastIndex = 0;
        return rule.pattern.test(resource);
      }),
    );
    return {
      definition,
      resources,
      capabilities: [
        ...new Set([
          ...definition.requiredCapabilities,
          ...(operation ? [operation.capability] : []),
          ...rules.map(rule => rule.capability),
        ]),
      ],
      rules,
    };
  }
  describe() {
    return Object.fromEntries(
      this.list().map(task => {
        const requirements = this.requirements({ kind: task.kind, resources: [] });
        return [
          task.kind,
          {
            kind: task.kind,
            label: task.label,
            cardLabel: task.cardLabel,
            visualLabel: task.visualLabel,
            packId: task.packId,
            packVersion: task.packVersion,
            version: task.version,
            creatable: !!task.creatable,
            planAllowed: !!task.planAllowed,
            proposesWork: !!task.proposeWork,
            consumes: task.consumes || [],
            produces: task.produces || [],
            role: task.role || null,
            milestones: ['accepted', ...Object.keys(task.milestones || {})],
            tier: task.tier || null,
            distinctFromInputs: !!task.distinctFromInputs,
            ...(task.stageTemplate
              ? {
                  stageTemplate: task.stageTemplate.stages.map(stage => ({
                    key: stage.key,
                    label: stage.label || stage.key,
                    kind: stage.kind || task.kind,
                  })),
                }
              : {}),
            executionNotice: task.executionNotice,
            autonomy: task.autonomy?.recommended || null,
            ...(task.autonomy?.scopeRequest ? { scopeRequestLabel: task.autonomy.scopeRequest.label } : {}),
            ...(task.autonomy?.integration ? { integrationLabel: task.autonomy.integration.label } : {}),
            requiredCapabilities: requirements.capabilities,
            requiredResources: requirements.resources,
            ...(task.operation ? { operation: task.operation } : {}),
          },
        ];
      }),
    );
  }
  planningContext(org, repair, adapters, project) {
    if (!this.planning) throw new Error('No planning workflow is registered.');
    return {
      ...this.planning(org, repair, {
        kinds: this.list()
          .filter(task => task.planAllowed && (!org.taskKinds || org.taskKinds.includes(task.kind)))
          .map(task => task.kind),
        adapterIds: adapters
          .list()
          .filter(adapter => adapter.workerSelectable)
          .map(adapter => adapter.id),
      }),
      ...(project ? { project } : {}),
    };
  }
}

export class AdapterRegistry {
  constructor() {
    this.adapters = new Map();
  }
  register(adapter) {
    if (
      !identifier(adapter.id) ||
      !identifier(adapter.version) ||
      this.adapters.has(adapter.id) ||
      !strings(adapter.capabilities) ||
      ['start', 'blockReason', 'status', 'configuration', 'requestedModel'].some(
        method => typeof adapter[method] !== 'function',
      ) ||
      !['string', 'function'].includes(typeof adapter.delivery) ||
      !['string', 'function'].includes(typeof adapter.deliveryScope) ||
      (adapter.modes !== undefined &&
        (!Array.isArray(adapter.modes) || !adapter.modes.every(mode => ['workspace', 'text'].includes(mode)))) ||
      (adapter.modes?.length && typeof adapter.run !== 'function') ||
      typeof adapter.name !== 'string' ||
      (adapter.efforts !== undefined && !strings(adapter.efforts)) ||
      (adapter.models !== undefined && typeof adapter.models !== 'function')
    )
      throw new Error('Invalid or duplicate execution adapter.');
    this.adapters.set(
      adapter.id,
      Object.freeze({ ...adapter, capabilities: Object.freeze([...adapter.capabilities]) }),
    );
    return this;
  }
  get(id) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Worker adapter is not implemented: ${id}.`);
    return adapter;
  }
  find(id) {
    return this.adapters.get(id);
  }
  list() {
    return [...this.adapters.values()];
  }
  // Adapters that start no model: neither a model CLI (delivery modes) nor a wrapper that
  // delegates to one (modelFor). The Runs timeline shows no delivery mode for them.
  modelFree() {
    return this.list()
      .filter(adapter => !adapter.modes?.length && !adapter.modelFor)
      .map(adapter => adapter.id);
  }
  describe(runtime) {
    return Object.fromEntries(
      this.list()
        .filter(adapter => adapter.workerSelectable)
        .map(adapter => [
          adapter.id,
          {
            ...adapter.status(runtime),
            id: adapter.id,
            version: adapter.version,
            name: adapter.name,
            quotaLabel: adapter.quotaLabel || adapter.name,
            capabilities: adapter.capabilities,
            efforts: adapter.efforts || [],
            modes: adapter.modes || [],
            models: adapter.models?.(runtime) || [],
            subscription: !!adapter.subscription,
            workerSelectable: true,
          },
        ]),
    );
  }
}
