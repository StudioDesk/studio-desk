// Edit the repository settings (Settings, Repository): an existing project's repository settings, which the
// controller calls its profile, as the design system's Settings draws them, each list a chip editor, in a wide
// dialog. Saving runs the project's tests with the edited settings on the branch's commit, as adding the project
// did, and records them as the next revision once they pass. The limits stay as the controller sized them.
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent } from 'react';
import { send, type Project, type SourceProfile } from './api';
import { Dialog } from './design/dialog';
import { useToast } from './toast';

type Source = NonNullable<Project['source']>;

// A list edited in place: its entries as chips with a remove button, then a field that adds one on Enter or a comma.
// Backspace in the empty field takes the last one back into it.
export function ChipEdit({
  id,
  values,
  onChange,
  prefix = '',
  suffix = '',
  disabled,
  describedBy,
}: {
  id: string;
  values: string[];
  onChange: (values: string[]) => void;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const [typed, setTyped] = useState('');
  const add = (text: string) => {
    const entries = text
      .split(',')
      .map(entry => entry.trim())
      // The chip's own marks (a dot before a file type, a slash after a folder) are not part of the entry.
      .map(entry => (prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry))
      .map(entry => (suffix && entry.endsWith(suffix) ? entry.slice(0, -suffix.length) : entry))
      .filter(entry => entry && !values.includes(entry));
    if (entries.length) onChange([...values, ...new Set(entries)]);
    setTyped('');
  };
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(typed);
    } else if (event.key === 'Backspace' && !typed && values.length) {
      event.preventDefault();
      setTyped(values.at(-1)!);
      onChange(values.slice(0, -1));
    }
  };
  return (
    <span className="sd-chipedit">
      {values.map(value => (
        <span key={value} className="sd-file">
          {prefix}
          {value}
          {suffix}
          <button
            type="button"
            className="sd-chipedit__remove"
            aria-label={`Remove ${prefix}${value}${suffix}`}
            disabled={disabled}
            onClick={() => onChange(values.filter(item => item !== value))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        id={id}
        className="sd-chipedit__input"
        value={typed}
        disabled={disabled}
        aria-describedby={describedBy}
        placeholder="Add…"
        onChange={event => setTyped(event.target.value)}
        onKeyDown={key}
        onBlur={() => typed.trim() && add(typed)}
      />
    </span>
  );
}

const size = (bytes: number) =>
  bytes >= 1048576 ? `${Math.round((bytes / 1048576) * 10) / 10} MiB` : `${Math.round(bytes / 1024)} KiB`;

export function ProfileDialog({
  open,
  projectId,
  source,
  onClose,
}: {
  open: boolean;
  projectId: string;
  source: Source;
  onClose: () => void;
}) {
  const toast = useToast(),
    save = useMutation({
      mutationFn: (profile: SourceProfile) =>
        send<{ source: Source; tests: { tests: number; pass: number } }>(
          `/api/projects/${encodeURIComponent(projectId)}/source`,
          { projectId, expectedRevision: source.revision ?? 1, profile },
        ),
      onSuccess: saved => {
        toast(
          `Repository settings revision ${saved.source.revision} saved. Its tests passed ${saved.tests.pass} of ${saved.tests.tests}.`,
        );
        onClose();
      },
    }),
    close = () => {
      save.reset();
      onClose();
    };
  return (
    <Dialog open={open} label="Edit the repository settings" size="wide" busy={save.isPending} onClose={close}>
      <ProfileForm
        recorded={source.profile}
        busy={save.isPending}
        problem={save.error?.message}
        onSave={profile => save.mutate(profile)}
        onClose={close}
      />
    </Dialog>
  );
}

// Each opening starts from the recorded profile; a refusal stays beside the edits, so none are lost.
function ProfileForm({
  recorded,
  busy,
  problem,
  onSave,
  onClose,
}: {
  recorded: SourceProfile;
  busy: boolean;
  problem?: string;
  onSave: (profile: SourceProfile) => void;
  onClose: () => void;
}) {
  const field = useId(),
    [draft, setDraft] = useState(recorded);
  const set =
      <Key extends keyof SourceProfile>(key: Key) =>
      (value: SourceProfile[Key]) =>
        setDraft(current => ({ ...current, [key]: value })),
    list = (key: 'directories' | 'files' | 'extensions' | 'protectedNames' | 'contextFiles') => ({
      id: `${field}-${key}`,
      values: draft[key],
      onChange: set(key),
      disabled: busy,
    });
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <h2 className="sd-dialog__title">Edit the repository settings</h2>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        What a story may touch, what the planner reads and how changes are tested, for stories that start after you
        save. Add an entry with Enter or a comma.
      </p>
      <dl className="sd-kv sd-kv--chips" style={{ margin: 0 }}>
        <dt>
          <label htmlFor={`${field}-directories`}>Folders stories may change</label>
        </dt>
        <dd>
          <ChipEdit {...list('directories')} suffix="/" />
        </dd>
        <dt>
          <label htmlFor={`${field}-files`}>Top-level files they may change</label>
        </dt>
        <dd>
          <ChipEdit {...list('files')} />
        </dd>
        <dt>
          <label htmlFor={`${field}-extensions`}>File types</label>
        </dt>
        <dd>
          <ChipEdit {...list('extensions')} prefix="." />
        </dd>
        <dt>
          <label htmlFor={`${field}-protectedNames`}>Never touched by a story</label>
        </dt>
        <dd>
          <ChipEdit {...list('protectedNames')} />
        </dd>
        <dt>
          <label htmlFor={`${field}-contextFiles`}>Read by the planner and reviews</label>
        </dt>
        <dd>
          <ChipEdit {...list('contextFiles')} />
        </dd>
        <dt>
          <label htmlFor={`${field}-tests`}>Tests</label>
        </dt>
        <dd>
          <span>Node&apos;s test runner on</span>
          <select
            id={`${field}-tests`}
            className="sd-select sd-mono"
            style={{ width: 'auto', fontSize: '13px' }}
            value={draft.tests.directory}
            disabled={busy}
            onChange={event => set('tests')({ ...draft.tests, directory: event.target.value })}
          >
            {[...new Set([...draft.directories, draft.tests.directory])].map(folder => (
              <option key={folder} value={folder}>
                {folder}/
              </option>
            ))}
          </select>
          <span>files ending</span>
          <input
            aria-label="Test file names end with"
            className="sd-input sd-mono"
            style={{ width: '140px', fontSize: '13px' }}
            value={draft.tests.suffix}
            disabled={busy}
            onChange={event => set('tests')({ ...draft.tests, suffix: event.target.value.trim() })}
          />
        </dd>
        <dt>Before tests</dt>
        <dd>
          <button
            type="button"
            className="sd-toggle"
            role="switch"
            aria-checked={draft.install === 'npm-ci'}
            aria-label="Install packages with npm ci before tests"
            disabled={busy}
            onClick={() => set('install')(draft.install === 'npm-ci' ? null : 'npm-ci')}
          />
          <span>
            Install packages with <span className="sd-file">npm ci</span>
          </span>
        </dd>
        <dt>
          <label htmlFor={`${field}-formatter`}>On integration</label>
        </dt>
        <dd>
          <span>Format changed files with</span>
          <input
            id={`${field}-formatter`}
            className="sd-input sd-mono"
            style={{ width: '180px', fontSize: '13px' }}
            placeholder="No formatter"
            value={draft.formatter?.package ?? ''}
            disabled={busy}
            onChange={event =>
              set('formatter')(
                event.target.value.trim()
                  ? { package: event.target.value.trim(), args: draft.formatter?.args ?? ['--write'] }
                  : null,
              )
            }
          />
          {draft.formatter && (
            <input
              aria-label="Formatter arguments"
              className="sd-input sd-mono"
              style={{ width: '140px', fontSize: '13px' }}
              value={draft.formatter.args.join(' ')}
              disabled={busy}
              onChange={event =>
                set('formatter')({
                  package: draft.formatter!.package,
                  args: event.target.value.split(/\s+/).filter(Boolean),
                })
              }
            />
          )}
        </dd>
        <dt>Limits</dt>
        <dd>
          <span className="sd-meta">
            {draft.limits.files} files · {size(draft.limits.fileBytes)} a file · {size(draft.limits.totalBytes)} in all,
            sized from the repository
          </span>
        </dd>
      </dl>
      <p className="sd-meta" style={{ margin: 0 }}>
        Saving runs the project&apos;s tests with these settings on the branch&apos;s latest commit, as adding the
        project did, and records it once they pass. Nothing in this project may be running meanwhile.
      </p>
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
          {busy ? 'Running the tests…' : 'Run the tests and save'}
        </button>
      </div>
    </form>
  );
}
