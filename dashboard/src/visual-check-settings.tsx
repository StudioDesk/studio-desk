// The visual check in Settings (1.2 step 8), the body of its section: on or off, the browser it drives, the widths and
// themes it captures and the reviewer's duty, read from the project's visual view (visual-check.ts). Only a code
// project has one, and each story names its own pages on its Pages tab. The controller checks and saves what the
// director edits (src/connectors/visual-check.mjs saveVisualSettings), for the next check.
import { useId, useState } from 'react';
import type { VisualSettings, VisualTheme } from './api';
import { Dialog } from './design/dialog';
import { isCodeProject } from './frame';
import { Toggle } from './layout';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';
import { browserName, useSaveVisual, useVisualView, widthLabel } from './visual-check';

const themes = ['light', 'dark'] as const;
const themeNames: Record<VisualTheme, string> = { light: 'Light', dark: 'Dark' };
// The widths the controller takes (validateVisualSettings).
const minWidth = 320,
  maxWidth = 2560,
  maxWidths = 3;

export function VisualCheckSettings({ projectId, state }: { projectId: string; state: StudioState }) {
  return isCodeProject(state) ? (
    <VisualCheck projectId={projectId} />
  ) : (
    <p>The visual check is for a project on a git repository: it shows the reviewer a code story&apos;s pages.</p>
  );
}

function VisualCheck({ projectId }: { projectId: string }) {
  const view = useVisualView(projectId),
    flip = useSaveVisual(projectId),
    save = useSaveVisual(projectId),
    toast = useToast(),
    [editing, setEditing] = useState(false);
  const close = () => {
    save.reset();
    setEditing(false);
  };
  const data = view.data;
  if (view.error)
    return (
      <p role="alert" style={{ margin: 0 }}>
        The visual check settings could not be read: {view.error.message}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="sd-meta" style={{ margin: 0 }}>
        Reading the visual check settings…
      </p>
    );
  const settings = data.settings;
  return (
    <>
      <p>
        Before a story&apos;s review, the check opens the pages it names in a browser and captures each one at each
        width and theme, so the reviewer sees them as you would.
      </p>
      <div className="sd-setrow sd-setrow--first">
        <span className="sd-setrow__text">
          <b>Visual check</b>
          <span className="sd-meta">
            {settings.enabled
              ? 'On. A story that names pages has them captured for its review.'
              : 'Off. Stories are reviewed without images of their pages.'}
          </span>
        </span>
        <Toggle
          label="Visual check"
          on={settings.enabled}
          disabled={flip.isPending || save.isPending}
          onChange={() =>
            flip.mutate({ ...settings, enabled: !settings.enabled }, { onError: error => toast(error.message) })
          }
        />
      </div>
      <dl className="sd-kv sd-kv--chips">
        <dt>Browser</dt>
        <dd>
          {data.browser ? (
            <>
              <span>{browserName(data.browser)}</span>
              <span className="sd-file sd-file--path">{data.browser}</span>
            </>
          ) : (
            <>
              <span>No Chromium-based browser found</span>
              {settings.browser && (
                <>
                  <span className="sd-meta">at</span>
                  <span className="sd-file sd-file--path">{settings.browser}</span>
                </>
              )}
              {data.note && <span className="sd-meta">{data.note}</span>}
            </>
          )}
        </dd>
        <dt>Widths</dt>
        <dd>
          {settings.widths.map(width => (
            <span key={width} className="sd-file">
              {widthLabel(width)}
            </span>
          ))}
        </dd>
        <dt>Themes</dt>
        <dd>
          {settings.themes.map(theme => (
            <span key={theme} className="sd-file">
              {themeNames[theme]}
            </span>
          ))}
        </dd>
      </dl>
      {data.blocked && (
        <p>
          <span>{data.blocked}</span>{' '}
          <span className="sd-meta">
            <a href="#repository">Trying a story yourself</a>, under Repository above, sets how the app starts and where
            it runs.
          </span>
        </p>
      )}
      <p>The reviewer must describe each image before a story can pass review.</p>
      <p className="sd-meta">Each story names its own pages on its Pages tab, never here.</p>
      <div>
        <button type="button" className="sd-btn sd-btn--sm" onClick={() => setEditing(true)}>
          Edit what is captured
        </button>
      </div>
      <Dialog open={editing} label="Edit what is captured" busy={save.isPending} onClose={close}>
        <VisualForm
          settings={settings}
          busy={save.isPending}
          problem={save.error?.message}
          onSave={chosen =>
            save.mutate(chosen, {
              onSuccess: () => {
                toast('Saved. The next check uses them.');
                setEditing(false);
              },
            })
          }
          onClose={close}
        />
      </Dialog>
    </>
  );
}

// Each opening starts from the saved settings, and keeps the check on or off as it is. Every width field is sent, so
// the controller says what is wrong with one; an empty browser field is sent as null, which uses Microsoft Edge or
// Google Chrome where they install. A refusal stays beside the edits, so none are lost.
function VisualForm({
  settings,
  busy,
  problem,
  onSave,
  onClose,
}: {
  settings: VisualSettings;
  busy: boolean;
  problem?: string;
  onSave: (settings: VisualSettings) => void;
  onClose: () => void;
}) {
  const field = useId(),
    [widths, setWidths] = useState(settings.widths.map(String)),
    [chosen, setChosen] = useState<VisualTheme[]>(settings.themes),
    [browser, setBrowser] = useState(settings.browser ?? '');
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        onSave({
          enabled: settings.enabled,
          widths: widths.map(Number),
          themes: themes.filter(theme => chosen.includes(theme)),
          browser: browser.trim() || null,
        });
      }}
    >
      <h2 className="sd-dialog__title">Edit what is captured</h2>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        For the next check: each page a story names is captured at each width, in each theme.
      </p>
      <div className="sd-field" role="group" aria-labelledby={`${field}-widths`}>
        <span id={`${field}-widths`} className="sd-field__label">
          Widths
        </span>
        {widths.map((width, index) => (
          <span key={index} style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'center' }}>
            <input
              type="number"
              className="sd-input sd-mono"
              aria-label={`Width ${index + 1}`}
              min={minWidth}
              max={maxWidth}
              step={1}
              required
              value={width}
              disabled={busy}
              onChange={event =>
                setWidths(current => current.map((item, at) => (at === index ? event.target.value : item)))
              }
            />
            <span className="sd-meta">px</span>
            {widths.length > 1 && (
              <button
                type="button"
                className="sd-btn sd-btn--sm sd-btn--ghost"
                aria-label={`Remove width ${index + 1}`}
                disabled={busy}
                onClick={() => setWidths(current => current.filter((_, at) => at !== index))}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)', alignItems: 'center' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={busy || widths.length >= maxWidths}
            onClick={() => setWidths(current => [...current, ''])}
          >
            Add a width
          </button>
          <span className="sd-meta">
            One to {maxWidths}, from {minWidth} to {maxWidth} px; under 600 px is captured as a phone.
          </span>
        </span>
      </div>
      <div className="sd-field" role="group" aria-labelledby={`${field}-themes`}>
        <span id={`${field}-themes`} className="sd-field__label">
          Themes
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-16)' }}>
          {themes.map(theme => (
            <label key={theme} style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={chosen.includes(theme)}
                disabled={busy}
                onChange={event =>
                  setChosen(current =>
                    event.target.checked ? [...current, theme] : current.filter(item => item !== theme),
                  )
                }
              />
              {themeNames[theme]}
            </label>
          ))}
        </span>
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`${field}-browser`}>
          Browser program
        </label>
        <input
          id={`${field}-browser`}
          className="sd-input sd-mono"
          placeholder="Microsoft Edge or Google Chrome where they install"
          value={browser}
          disabled={busy}
          aria-describedby={`${field}-browser-note`}
          onChange={event => setBrowser(event.target.value)}
        />
        <span id={`${field}-browser-note`} className="sd-meta">
          Optional: the full path of a Chromium-based browser&apos;s program. Empty uses Microsoft Edge or Google Chrome
          where they install.
        </span>
      </div>
      {problem && (
        <p role="alert" style={{ margin: 0, color: 'var(--bad)', fontWeight: 600 }}>
          {problem}
        </p>
      )}
      <div className="sd-dialog__actions">
        <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="sd-btn sd-btn--primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
