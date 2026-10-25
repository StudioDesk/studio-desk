// The CLI, model, effort and mode, shared by an agent's settings and a task's override (app-work.js
// executionFields). With `inherit` (the agent), a blank field uses the agent's setting.
import { useId } from 'react';
import type { Adapter, Execution } from './api';
import { effortWords } from './evidence';

export const modeLabels: Record<string, string> = {
  workspace: 'Workspace: the CLI uses its own configured tools',
};

// The modes the dashboard offers for a CLI. Text mode does not ship in 1.0.0 (the director, October 25): the
// controller keeps it for the model-free tests and the attempts that recorded it, and nothing here offers it.
export const offeredModes = (adapter: Adapter | undefined) => (adapter?.modes ?? []).filter(mode => mode !== 'text');

export const executionSummary = (adapters: Record<string, Adapter> | undefined, source: Execution) =>
  [
    (source.provider && adapters?.[source.provider]?.name) || source.provider,
    source.model || 'default model',
    source.effort ? `${source.effort} effort` : '',
    source.mode ? `${source.mode} mode` : '',
  ]
    .filter(Boolean)
    .join(' · ');

// What the fields offer for a choice of provider and model, as the controller reads them.
function choices(adapters: Record<string, Adapter>, value: Execution, inherit?: Execution) {
  const adapter = adapters[value.provider || inherit?.provider || ''],
    models = adapter?.models ?? [],
    known = models.find(item => item.id === (value.model ?? '').trim()),
    efforts = known?.efforts?.length ? known.efforts : (adapter?.efforts ?? []),
    modes = offeredModes(adapter),
    // Switching a task to another CLI drops the agent's effort and mode, as on the controller.
    sameProvider = !!inherit && (!value.provider || value.provider === inherit.provider);
  return { adapter, models, known, efforts, modes, sameProvider };
}

// The values to save: an effort or mode the chosen CLI does not offer is left to its default.
export function cleanExecution(adapters: Record<string, Adapter>, value: Execution, inherit?: Execution) {
  const { efforts, modes } = choices(adapters, value, inherit);
  return {
    provider: value.provider ?? '',
    model: (value.model ?? '').trim(),
    effort: value.effort && efforts.includes(value.effort) ? value.effort : '',
    mode: value.mode && modes.includes(value.mode) ? value.mode : '',
  };
}

export function ExecutionFields({
  adapters,
  value,
  onChange,
  inherit,
}: {
  adapters: Record<string, Adapter>;
  value: Execution;
  onChange: (value: Execution) => void;
  inherit?: Execution;
}) {
  const id = useId(),
    selectable = Object.values(adapters).filter(adapter => adapter.workerSelectable),
    { adapter, models, known, efforts, modes, sameProvider } = choices(adapters, value, inherit),
    inheritedMode = sameProvider ? inherit?.mode : '',
    set = (field: keyof Execution, next: string) => onChange({ ...value, [field]: next });
  return (
    <div className="sd-fieldgrid">
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${id}-provider`}>
          CLI
        </label>
        <select
          id={`${id}-provider`}
          className="sd-select"
          value={value.provider ?? ''}
          onChange={event => set('provider', event.target.value)}
        >
          {inherit && (
            <option value="">
              The agent&apos;s ({(inherit.provider && adapters[inherit.provider]?.name) || inherit.provider})
            </option>
          )}
          {selectable.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${id}-model`}>
          Model
        </label>
        <input
          id={`${id}-model`}
          className="sd-input"
          list={`${id}-models`}
          value={value.model ?? ''}
          onChange={event => set('model', event.target.value)}
          placeholder={inherit?.model && !value.provider ? `The agent's (${inherit.model})` : 'The CLI default'}
          autoComplete="off"
        />
        <datalist id={`${id}-models`}>
          {models.map(item => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </datalist>
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${id}-effort`}>
          Effort
        </label>
        <select
          id={`${id}-effort`}
          className="sd-select"
          value={value.effort && efforts.includes(value.effort) ? value.effort : ''}
          disabled={!adapter || !efforts.length}
          onChange={event => set('effort', event.target.value)}
        >
          <option value="">
            {sameProvider
              ? inherit?.effort
                ? `The agent's (${effortWords(inherit.effort)})`
                : "The agent's"
              : `The CLI default${known?.defaultEffort ? ` (${effortWords(known.defaultEffort)})` : ''}`}
          </option>
          {efforts.map(level => (
            <option key={level} value={level}>
              {effortWords(level)}
            </option>
          ))}
        </select>
      </div>
      {/* Only a CLI with a choice of modes shows the field; every CLI has one in 1.0.0. */}
      {modes.length > 1 && (
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={`${id}-mode`}>
            Mode
          </label>
          <select
            id={`${id}-mode`}
            className="sd-select"
            value={value.mode && modes.includes(value.mode) ? value.mode : ''}
            onChange={event => set('mode', event.target.value)}
          >
            <option value="">{inheritedMode ? `The agent's (${inheritedMode})` : `The default (${modes[0]})`}</option>
            {modes.map(mode => (
              <option key={mode} value={mode}>
                {modeLabels[mode] ?? mode}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
