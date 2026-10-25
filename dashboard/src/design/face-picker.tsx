// The design system's FacePicker: an agent's face from the agent kit's parts, as the canvas's Agent kit board builds
// one. The face large in the state shown, beside a row of choices for each part, each choice the agent's own face
// with that one part changed. Shuffle picks a whole new look; Show steps through the states the controller records,
// so the director sees the face move before saving. It opens in a wide dialog from the agent's face on its page.
import { useId, useState } from 'react';
import { COLORS, SLOTS, STATES, hash, pickLook, rng, type AgentLook } from './agent-kit.js';
import { AgentAvatar } from './avatar';
import { Dialog } from './dialog';

const labels: Partial<Record<keyof AgentLook, string>> = {
  body: 'Body',
  eyes: 'Eyes',
  mouth: 'Mouth',
  top: 'Topper',
  detail: 'Detail',
};
const same = (a: AgentLook, b: AgentLook) => SLOTS.every(([key]) => a[key] === b[key]);

export function FacePicker({
  open,
  name,
  saving,
  onClose,
  ...picker
}: Picker & {
  open: boolean;
  name: string;
  saving: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} label={`${name}'s face`} size="face" busy={saving} onClose={onClose}>
      <Picker name={name} saving={saving} onClose={onClose} {...picker} />
    </Dialog>
  );
}

interface Picker {
  role: string;
  look: AgentLook;
  /** The agent has a face the director chose, which Use the picked face gives back to the kit. */
  stored: boolean;
  onSave: (look: AgentLook) => void;
  onReset: () => void;
}

// Each opening starts from the agent's face, working, as the board shows it.
function Picker({
  name,
  role,
  look,
  stored,
  saving,
  onSave,
  onReset,
  onClose,
}: Picker & { name: string; saving: boolean; onClose: () => void }) {
  const title = useId(),
    [draft, setDraft] = useState(look),
    [shown, setShown] = useState(1);
  const [state, stateName, meaning] = STATES[shown]!,
    pick = (key: keyof AgentLook, value: number) => setDraft(current => ({ ...current, [key]: value }));
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <h2 className="sd-dialog__title">{name}&apos;s face</h2>
      <div className="sd-facepicker">
        <div className="sd-facepicker__hero">
          <span className="sd-facepicker__stage">
            <AgentAvatar look={draft} state={state} size={160} label={`${name}, ${stateName.toLowerCase()}`} />
          </span>
          <span className="sd-facepicker__name">
            <b>{name}</b>
            <span className="sd-meta">{role}</span>
          </span>
          <span className="sd-facepicker__tools">
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              onClick={() => setDraft(pickLook(rng(hash(`${name}#${Date.now()}`))))}
            >
              Shuffle
            </button>
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost"
              onClick={() => setShown(index => (index + 1) % STATES.length)}
            >
              Show: {stateName}
            </button>
          </span>
          <span className="sd-meta" aria-live="polite">
            {meaning}
          </span>
        </div>
        <div className="sd-facepicker__parts">
          <div className="sd-partrow">
            <span className="sd-eyebrow" id={`${title}-color`}>
              Color · {COLORS.length}
            </span>
            <div className="sd-partrow__opts" role="radiogroup" aria-labelledby={`${title}-color`}>
              {COLORS.map(([color, hex], index) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  className="sd-colorpick"
                  aria-checked={draft.color === index}
                  aria-label={color}
                  title={color}
                  style={{ background: hex }}
                  onClick={() => pick('color', index)}
                />
              ))}
            </div>
          </div>
          {SLOTS.filter(([key]) => key !== 'color').map(([key, list]) => (
            <div key={key} className="sd-partrow">
              <span className="sd-eyebrow" id={`${title}-${key}`}>
                {labels[key]} · {list.length}
              </span>
              <div className="sd-partrow__opts" role="radiogroup" aria-labelledby={`${title}-${key}`}>
                {list.map(([part], index) => (
                  <button
                    key={part}
                    type="button"
                    role="radio"
                    className="sd-partopt"
                    aria-checked={draft[key] === index}
                    aria-label={part}
                    title={part}
                    onClick={() => pick(key, index)}
                  >
                    <AgentAvatar look={{ ...draft, [key]: index }} size={44} />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sd-dialog__actions">
        {stored && (
          <button type="button" className="sd-btn sd-btn--ghost" disabled={saving} onClick={onReset}>
            Use the picked face
          </button>
        )}
        <button type="button" className="sd-btn" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="sd-btn sd-btn--primary" disabled={saving || same(draft, look)}>
          Save the face
        </button>
      </div>
    </form>
  );
}
