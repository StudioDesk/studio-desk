// The project's model tiers in Settings → Command-line tools: for each CLI listed there, the model, effort and way of
// working that Light, Standard and Deep work ask for. They are this project's, saved with its organization as its
// next revision with the teams, agents and kinds of work unchanged, and they reach work that starts after the save.
import { useState } from 'react';
import type { Adapter, Tiers } from './api';
import { modeLabels, offeredModes } from './execution-fields';
import { organizationBody, setTiers, useSaveOrganization } from './organization';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';

const tierNames = ['light', 'standard', 'deep'] as const;
type TierField = 'model' | 'effort' | 'mode';
const tierWords: Record<(typeof tierNames)[number], string> = {
  light: 'Light work',
  standard: 'Standard work',
  deep: 'Deep work',
};
const fieldWords: Record<TierField, string> = { model: 'model', effort: 'effort', mode: 'way of working' };
// A CLI's fields: its model, an effort when it offers efforts, and a way of working when it offers more than one.
const tierFields = (adapter: Adapter): TierField[] => [
  'model',
  ...(adapter.efforts?.length ? (['effort'] as const) : []),
  ...(offeredModes(adapter).length > 1 ? (['mode'] as const) : []),
];

export function ModelTiers({
  projectId,
  state,
  adapters,
}: {
  projectId: string;
  state: StudioState;
  adapters: Adapter[];
}) {
  const saved = state.organizationConfiguration?.tiers ?? {},
    [draft, setDraft] = useState<Tiers>(() => structuredClone(saved)),
    save = useSaveOrganization(projectId),
    toast = useToast();
  const value = (tiers: Tiers, tier: string, provider: string, field: TierField) =>
    tiers[tier]?.[provider]?.[field]?.trim() ?? '';
  const changed = adapters.some(adapter =>
    tierNames.some(tier =>
      tierFields(adapter).some(
        field => value(draft, tier, adapter.id, field) !== value(saved, tier, adapter.id, field),
      ),
    ),
  );
  const setTier = (tier: string, provider: string, field: TierField, text: string) =>
    setDraft(current => ({
      ...current,
      [tier]: { ...current[tier], [provider]: { ...current[tier]?.[provider], [field]: text } },
    }));
  // A CLI listed here sends only the fields it offers; the settings for one not listed are kept as they were saved.
  const submit = () => {
    const tiers = structuredClone(draft);
    for (const adapter of adapters)
      for (const tier of tierNames) {
        const settings = tiers[tier]?.[adapter.id];
        if (settings)
          tiers[tier]![adapter.id] = Object.fromEntries(tierFields(adapter).map(field => [field, settings[field]]));
      }
    save.mutate(setTiers(organizationBody(state), tiers), {
      onSuccess: () => toast('Model tiers saved. Work that starts from now on uses them.'),
    });
  };
  if (!adapters.length) return null;
  return (
    <div
      id="model-tiers"
      role="group"
      aria-labelledby="model-tiers-title"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}
    >
      <span id="model-tiers-title" className="sd-field__label">
        Model tiers
      </span>
      <span className="sd-meta">
        {state.project.name}&apos;s own: the model, effort and way of working each kind of work&apos;s tier asks for.
        Leave one blank for the agent&apos;s own setting. Tiers apply to work that starts after you save them; recorded
        attempts keep what they ran with.
      </span>
      {adapters.map(adapter => (
        <div key={adapter.id} className="sd-editpanel" role="group" aria-labelledby={`tiers-${adapter.id}`}>
          <b id={`tiers-${adapter.id}`}>{`${adapter.name}'s tiers`}</b>
          {tierNames.map(tier => {
            const prefix = `tier-${tier}-${adapter.id}`;
            return (
              <div key={tier} className="sd-fieldgrid">
                <div className="sd-field">
                  <label className="sd-field__label" htmlFor={`${prefix}-model`}>
                    {tierWords[tier]} model
                  </label>
                  <input
                    id={`${prefix}-model`}
                    className="sd-input"
                    value={draft[tier]?.[adapter.id]?.model ?? ''}
                    list={`${prefix}-models`}
                    maxLength={100}
                    autoComplete="off"
                    placeholder="The agent's own"
                    onChange={event => setTier(tier, adapter.id, 'model', event.target.value)}
                  />
                  <datalist id={`${prefix}-models`}>
                    {(adapter.models ?? []).map(model => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </datalist>
                </div>
                {tierFields(adapter)
                  .filter(field => field !== 'model')
                  .map(field => (
                    <div key={field} className="sd-field">
                      <label className="sd-field__label" htmlFor={`${prefix}-${field}`}>
                        {tierWords[tier]} {fieldWords[field]}
                      </label>
                      <select
                        id={`${prefix}-${field}`}
                        className="sd-select"
                        value={draft[tier]?.[adapter.id]?.[field] ?? ''}
                        onChange={event => setTier(tier, adapter.id, field, event.target.value)}
                      >
                        <option value="">The agent&apos;s own</option>
                        {(field === 'effort' ? (adapter.efforts ?? []) : offeredModes(adapter)).map(item => (
                          <option key={item} value={item}>
                            {field === 'mode' ? (modeLabels[item] ?? item) : item}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
        <button type="button" className="sd-btn sd-btn--primary" disabled={!changed || save.isPending} onClick={submit}>
          Save the tiers
        </button>
        {save.error && (
          <span role="alert" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            {save.error.message}
          </span>
        )}
      </div>
    </div>
  );
}
