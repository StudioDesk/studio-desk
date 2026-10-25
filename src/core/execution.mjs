// Execution settings choose which installed CLI runs an attempt and how. An
// employee holds the defaults; a task may override them for its future
// attempts. Each attempt records the effective settings it was started with.
export const EXECUTION_FIELDS = ['provider', 'model', 'effort', 'mode'];
// Model tiers (MP-015): a node asks for how much capability it needs, never for a model.
// A project maps each tier to model, effort and mode per CLI.
export const TIERS = ['light', 'standard', 'deep'];
const MODEL_ID = /^[a-zA-Z0-9_.:/-]+$/;

// The worker a task actually runs as: employee defaults, then the project's settings for
// the task's tier on the CLI that runs it, then non-empty task overrides. A tier never
// changes the CLI.
export function executionWorker(worker, task, { tiers, tier } = {}) {
  if (!worker) return worker;
  const merged = { ...worker, effort: worker.effort || '', mode: worker.mode || '' },
    execution = task?.execution || {};
  // A provider override must not inherit a model, effort or mode from another CLI.
  if (execution.provider && execution.provider !== worker.provider)
    Object.assign(merged, { provider: execution.provider, model: '', effort: '', mode: '' });
  const settings = tiers?.[tier || task?.tier]?.[merged.provider];
  for (const field of ['model', 'effort', 'mode']) if (settings?.[field]) merged[field] = settings[field];
  for (const field of EXECUTION_FIELDS) if (execution[field]) merged[field] = execution[field];
  return merged;
}

// Validates a project's tier settings: { tier: { provider: { model, effort, mode } } }.
export function validateTierSettings(adapters, value) {
  const closed = (item, allowed, label) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some(key => !allowed.includes(key))
    )
      throw new Error(`${label} has unsupported fields.`);
  };
  closed(value, TIERS, 'Tier settings');
  const tiers = {};
  for (const [tier, providers] of Object.entries(value)) {
    const selectable = adapters
      .list()
      .filter(adapter => adapter.workerSelectable)
      .map(adapter => adapter.id);
    closed(providers, selectable, `Tier ${tier}`);
    tiers[tier] = {};
    for (const [provider, settings] of Object.entries(providers)) {
      closed(settings, ['model', 'effort', 'mode'], `Tier ${tier} for ${provider}`);
      const next = {
        model: typeof settings.model === 'string' ? settings.model.trim() : (settings.model ?? ''),
        effort: settings.effort ?? '',
        mode: settings.mode ?? '',
      };
      check(adapters, provider, next.model, next.effort, next.mode);
      tiers[tier][provider] = Object.fromEntries(Object.entries(next).filter(([, field]) => field));
    }
  }
  return tiers;
}

function check(adapters, provider, model, effort, mode = '') {
  if (typeof model !== 'string' || model.length > 100 || (model && !MODEL_ID.test(model)))
    throw new Error('Enter a CLI model ID or leave it blank for its default.');
  if (typeof effort !== 'string') throw new Error('Effort must be text.');
  if (effort && !(adapters.get(provider).efforts || []).includes(effort))
    throw new Error(`${adapters.get(provider).name} does not accept effort "${effort}".`);
  if (typeof mode !== 'string' || (mode && !(adapters.get(provider).modes || []).includes(mode)))
    throw new Error(`${adapters.get(provider).name} does not offer the "${mode}" delivery mode.`);
}

// Apply a director edit to an employee's defaults. Fields left undefined stay as they are.
export function applyWorkerExecution(adapters, worker, data) {
  const next = {
    provider: worker.provider,
    model: worker.model || '',
    effort: worker.effort || '',
    mode: worker.mode || '',
  };
  if (data.provider !== undefined) {
    if (!adapters.get(data.provider).workerSelectable) throw new Error('Unsupported adapter.');
    next.provider = data.provider;
  }
  if (data.model !== undefined) next.model = typeof data.model === 'string' ? data.model.trim() : data.model;
  if (data.effort !== undefined) next.effort = data.effort;
  if (data.mode !== undefined) next.mode = data.mode;
  // A mode another CLI offered does not carry over to a new provider.
  if (
    data.provider !== undefined &&
    data.mode === undefined &&
    !(adapters.get(next.provider).modes || []).includes(next.mode)
  )
    next.mode = '';
  check(adapters, next.provider, next.model, next.effort, next.mode);
  Object.assign(worker, next);
  return worker;
}

// Validate a task override. Returns null when every field is blank.
export function taskExecution(adapters, worker, value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !EXECUTION_FIELDS.includes(k)))
    throw new Error('Execution override takes only provider, model, effort and mode.');
  const execution = {
    provider: value.provider || '',
    model: typeof value.model === 'string' ? value.model.trim() : (value.model ?? ''),
    effort: value.effort || '',
    mode: value.mode || '',
  };
  if (execution.provider && !adapters.get(execution.provider).workerSelectable) throw new Error('Unsupported adapter.');
  const effective = executionWorker(worker, { execution });
  check(adapters, effective.provider, execution.model, execution.effort, execution.mode);
  return EXECUTION_FIELDS.some(field => execution[field]) ? execution : null;
}

// A task kind may bind a controller-owned adapter; otherwise the employee's CLI runs it.
export function resolveAdapter(adapters, definition, worker) {
  return adapters.get(definition.executionAdapter || worker?.provider);
}

// Model contract. A model adapter declares the delivery modes it supports and runs
// one attempt through run(runtime, entry, worker, { mode, editable, context, onComplete }):
// - workspace: the CLI works on the job's output folder with the tools, MCP servers
//   and permissions its administrator configured; editable and context files are
//   already there. The default: the person running the studio decides what the CLI can use.
// - text: a hardened option with no tools. The controller puts instructions, inputs,
//   context and editable files in the prompt and stages the files the model returns
//   (adapters/text-delivery.mjs).
// The employee's (or task's) execution mode picks one; blank means the adapter's first.
// Steps are written once against this contract and never name a model.
export const DELIVERY_MODES = ['workspace', 'text'];
export function modelAdapter(adapters, worker) {
  const model = adapters.find(worker?.provider);
  if (!model || typeof model.run !== 'function' || !model.modes?.length)
    throw new Error(
      `${model?.name || worker?.provider || 'This employee'} has no model delivery mode for this step. Choose a model CLI in the employee's execution settings.`,
    );
  return model;
}
export function modelMode(model, worker) {
  return model.modes.includes(worker?.mode) ? worker.mode : model.modes[0];
}
// The subscription a dispatch draws on: a wrapper names its model's.
export function quotaKey(adapter, worker) {
  return adapter.quotaKey?.(worker) ?? adapter.subscriptionProvider ?? adapter.id;
}
// Delivery text may depend on the employee's model (for a wrapping adapter).
export function adapterText(adapter, field, worker, runtime) {
  return typeof adapter[field] === 'function' ? adapter[field](worker, runtime) : adapter[field];
}
