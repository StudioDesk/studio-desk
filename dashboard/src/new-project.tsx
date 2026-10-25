// Settings' New project card and its dialog (v1.0 item 10): its first field is the folder the work lives in, typed,
// pasted or chosen in the folder browser, which starts at the folder in the field (or the nearest existing one above
// it) and at the home folder when the field is empty. Left empty, the project is for general work; a git
// repository's folder on this computer is inspected first (by Inspect, or Enter in the field), and the controller
// says what it found.
// Creating the project then runs the repository's tests once on a copy, and nothing is recorded unless they pass;
// the dialog stays open meanwhile. The director may edit the settings the inspection proposed; each change is
// inspected again, and creating the project sends the settings of the last inspection.
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { send, type RepositoryInspection, type SourceProfile } from './api';
import { Icon } from './design/icons';
import { Modal } from './dialog';
import { FolderBrowser } from './folder-browser';
import { useToast } from './toast';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// The settings the director is offered, as text: lists one entry per line. Fields not offered (id, extensions,
// limits, install) stay as the controller proposed them.
interface Draft {
  directories: string;
  files: string;
  contextFiles: string;
  testDirectory: string;
  testSuffix: string;
  protectedNames: string;
  formatter: string;
  formatterArgs: string;
}
const entries = (text: string) =>
  text
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(Boolean);
const draftOf = (profile: SourceProfile): Draft => ({
  directories: profile.directories.join('\n'),
  files: profile.files.join('\n'),
  contextFiles: profile.contextFiles.join('\n'),
  testDirectory: profile.tests.directory,
  testSuffix: profile.tests.suffix,
  protectedNames: profile.protectedNames.join('\n'),
  formatter: profile.formatter?.package ?? '',
  formatterArgs: profile.formatter?.args.join(' ') ?? '',
});
// The proposed profile with the director's edits; an empty formatter package means none.
const profileOf = (draft: Draft, proposed: SourceProfile): SourceProfile => ({
  ...proposed,
  directories: entries(draft.directories),
  files: entries(draft.files),
  contextFiles: entries(draft.contextFiles),
  tests: { directory: draft.testDirectory.trim(), suffix: draft.testSuffix.trim() },
  protectedNames: entries(draft.protectedNames),
  formatter: draft.formatter.trim()
    ? { package: draft.formatter.trim(), args: draft.formatterArgs.split(/[\s,]+/).filter(Boolean) }
    : null,
});
const settings: { name: keyof Draft; label: string; list?: boolean; help?: string; placeholder?: string }[] = [
  { name: 'directories', label: 'Folders stories may work in', list: true },
  { name: 'files', label: 'Top-level files stories may work on', list: true },
  { name: 'contextFiles', label: 'Documents agents read for context', list: true },
  { name: 'testDirectory', label: 'Where the tests live', help: 'A folder from the list above.' },
  { name: 'testSuffix', label: 'Test file names end with', help: 'For example .test.mjs.' },
  { name: 'protectedNames', label: 'Names no story may change', list: true },
  {
    name: 'formatter',
    label: 'Formatter',
    placeholder: 'None',
    help: 'A pinned npm package, such as prettier@3.3.3, run on the files each approved change touches. Leave it empty for none.',
  },
  { name: 'formatterArgs', label: 'Formatter arguments', help: 'Separated by spaces, for example --write.' },
];

// The proposed settings as editable fields. Editing them sends nothing; Check again has them inspected.
function Settings({
  draft,
  disabled,
  onEdit,
}: {
  draft: Draft;
  disabled: boolean;
  onEdit: (name: keyof Draft, value: string) => void;
}) {
  return (
    <>
      <span className="sd-meta">Lists take one entry per line, or entries separated by commas.</span>
      <div className="sd-fieldgrid">
        {settings.map(({ name, label, list, help, placeholder }) => {
          const props = {
            id: `project-${name}`,
            value: draft[name],
            disabled,
            placeholder,
            'aria-describedby': help ? `project-${name}-help` : undefined,
            onChange: (event: { target: { value: string } }) => onEdit(name, event.target.value),
          };
          return (
            <div className="sd-field" key={name}>
              <label className="sd-field__label" htmlFor={props.id}>
                {label}
              </label>
              {list ? (
                <textarea className="sd-textarea sd-mono" {...props} />
              ) : (
                <input className="sd-input sd-mono" {...props} />
              )}
              {help && (
                <span className="sd-meta" id={`project-${name}-help`}>
                  {help}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// A project created on a repository comes back with the totals of the tests it ran.
interface Created {
  id: string;
  tests?: { tests: number; pass: number };
}
const blank = { name: '', goal: '', direction: '' };
// The folder as typed, without surrounding spaces and the one pair of double quotes Windows' Copy as path adds.
// Quotes inside a path stay.
const folderOf = (typed: string) => {
  const folder = typed.trim();
  return folder.length > 1 && folder.startsWith('"') && folder.endsWith('"') ? folder.slice(1, -1) : folder;
};

// A finding's mark, as the story's evidence rows draw it: found, missing, or a problem that stops it.
function Mark({ tone }: { tone: 'ok' | 'bad' | 'wait' }) {
  return (
    <span className={`sd-row__icon${tone === 'wait' ? '' : ` sd-row__icon--${tone}`}`}>
      <Icon
        name={tone === 'ok' ? 'check' : tone === 'bad' ? 'close' : 'dash'}
        size={14}
        weight={tone === 'ok' ? 3 : 2.6}
      />
    </span>
  );
}

// What the controller found, in plain words, a sentence a row, and each problem that stops the repository being
// added. The folder named is the one the controller inspected, by its real path.
function Findings({ found }: { found: RepositoryInspection }) {
  const row = (tone: 'ok' | 'bad' | 'wait', text: ReactNode) => (
    <>
      <Mark tone={tone} />
      <span className="sd-row__text" style={{ display: 'block' }}>
        {text}
      </span>
    </>
  );
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <span className="sd-eyebrow">What the controller found</span>
      <ul aria-label="What the controller found" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        <li className="sd-row" style={{ borderTop: 0 }}>
          {row(
            'ok',
            <>
              Inspected <span className="sd-mono">{found.root}</span>.
            </>,
          )}
        </li>
        <li className="sd-row">
          {row(
            'ok',
            <>
              On branch <b>{found.branch}</b> at commit <span className="sd-mono">{found.head.slice(0, 7)}</span>.
            </>,
          )}
        </li>
        {found.files !== null && found.bytes !== null && (
          <li className="sd-row">
            {row(
              'ok',
              <>
                The project covers {plural(found.files, 'file')}, {size(found.bytes)} in all.
              </>,
            )}
          </li>
        )}
        <li className="sd-row">
          {row(
            found.testFiles ? 'ok' : 'wait',
            found.testFiles ? `${plural(found.testFiles, 'test file')} found.` : 'No test files found yet.',
          )}
        </li>
      </ul>
      {found.problems.map(problem => (
        <div key={problem} className="sd-row" role="alert">
          {row('bad', <b>{problem}</b>)}
        </div>
      ))}
    </section>
  );
}

// Settings' Create a project, which opens the dialog. The project rail's Add a project and Find a project's open it
// from any page (frame.tsx).
export function NewProject() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="sd-btn sd-btn--sm" onClick={() => setOpen(true)}>
        Create a project
      </button>
      <NewProjectDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [fields, setFields] = useState(blank),
    [root, setRoot] = useState(''),
    [browsing, setBrowsing] = useState(false),
    // The last inspection of the folder shown, which stays while another runs or is refused, and its settings as
    // the director edits them.
    [inspected, setInspected] = useState<RepositoryInspection>(),
    [draft, setDraft] = useState<Draft>(),
    navigate = useNavigate(),
    toast = useToast();
  // A folder given means a project on its git repository; the controller decides whether it is one.
  const repository = !!root.trim(),
    folder = folderOf(root);
  const inspect = useMutation({
    mutationFn: (body: { root: string; profile?: SourceProfile }) =>
      send<RepositoryInspection>('/api/projects/inspect-repository', body),
  });
  // Inspects a folder: with no profile the controller proposes one. An answer to an inspection the director has
  // since left (by changing the folder) is not shown.
  const inspectFolder = (at: string, profile?: SourceProfile) =>
    inspect.mutate(profile ? { root: at, profile } : { root: at }, {
      onSuccess: answer => {
        setInspected(answer);
        setDraft(draftOf(answer.profile));
      },
    });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => send<Created>('/api/projects', body),
    onSuccess: ({ id, tests }) => {
      onClose();
      setFields(blank);
      setRoot('');
      setInspected(undefined);
      setDraft(undefined);
      inspect.reset();
      toast(
        !tests
          ? 'Project created.'
          : tests.tests
            ? `Project created. Its tests passed: ${tests.pass} of ${tests.tests}.`
            : 'Project created. The repository has no tests yet.',
      );
      void navigate({ to: '/p/$projectId', params: { projectId: id } });
    },
  });
  // A new folder, typed or chosen, clears what was found in the last one.
  const changeFolder = (typed: string) => {
    setRoot(typed);
    setInspected(undefined);
    inspect.reset();
    create.reset();
  };
  const busy = create.isPending,
    // Inspect, and Enter in the folder field, inspect the folder shown unless there is none or a command runs.
    inspectable = !busy && !inspect.isPending && !!folder,
    // Findings are always of the folder shown: changing it clears them.
    found = repository ? inspected : undefined,
    edited = found && draft ? profileOf(draft, found.profile) : undefined,
    // Edited settings are created only once an inspection has checked them.
    changed = !!found && !!edited && JSON.stringify(edited) !== JSON.stringify(found.profile),
    ready = !repository || (!!found && !found.problems.length && !changed && !inspect.isPending);
  const field = (name: keyof typeof fields) => ({
    id: `project-${name}`,
    value: fields[name],
    disabled: busy,
    onChange: (event: { target: { value: string } }) =>
      setFields(current => ({ ...current, [name]: event.target.value })),
  });
  return (
    <>
      <Modal
        open={open}
        onClose={() => {
          onClose();
          setBrowsing(false);
        }}
        title="Create a project"
        closable={!busy}
      >
        <form
          className="sd-dialog__form"
          onSubmit={event => {
            event.preventDefault();
            if (!ready) return;
            setBrowsing(false);
            // A project made here starts on the recommended house rules, as the samples do.
            create.mutate({
              ...fields,
              ...(found ? { repository: { root: found.root, profile: found.profile } } : {}),
              houseRules: 'recommended',
            });
          }}
        >
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="project-root">
              Folder
            </label>
            <div className="sd-folderfield">
              <input
                id="project-root"
                className="sd-input sd-mono"
                value={root}
                disabled={busy}
                aria-describedby="project-root-help"
                onChange={event => changeFolder(event.target.value)}
                onKeyDown={event => {
                  // Enter here inspects the folder as Inspect does; it never creates the project.
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (inspectable) inspectFolder(folder);
                }}
              />
              <button type="button" className="sd-btn" disabled={!inspectable} onClick={() => inspectFolder(folder)}>
                Inspect
              </button>
              <button
                type="button"
                className="sd-btn sd-btn--ghost"
                disabled={busy || inspect.isPending || browsing}
                onClick={() => setBrowsing(true)}
              >
                Browse
              </button>
            </div>
            <span className="sd-meta" id="project-root-help">
              Leave it empty for work that isn&apos;t code. For code, give the folder of a git repository on this
              computer and inspect it, or browse to it.
            </span>
          </div>
          {browsing && (
            // It starts at the folder in the field, if any. Choosing a folder inspects it straight away, as Inspect
            // does.
            <FolderBrowser
              start={folder || undefined}
              onChoose={chosen => {
                setBrowsing(false);
                changeFolder(chosen);
                inspectFolder(chosen);
              }}
              onCancel={() => setBrowsing(false)}
            />
          )}
          {found && <Findings found={found} />}
          {found && draft && edited && (
            <fieldset className="sd-editpanel" aria-label="Proposed settings" style={{ margin: 0, minWidth: 0 }}>
              <b>Proposed settings</b>
              <Settings
                draft={draft}
                disabled={busy || inspect.isPending}
                onEdit={(name, value) => setDraft(current => current && { ...current, [name]: value })}
              />
              <button
                type="button"
                className="sd-btn sd-btn--sm"
                style={{ alignSelf: 'flex-start' }}
                disabled={busy || inspect.isPending}
                onClick={() => inspectFolder(folder, edited)}
              >
                Check again
              </button>
              {changed && (
                <p className="sd-meta" style={{ margin: 0, color: 'var(--you)' }}>
                  Check the changed settings again before creating the project.
                </p>
              )}
            </fieldset>
          )}
          {inspect.isPending && (
            <p role="status" className="sd-meta" style={{ margin: 0 }}>
              Inspecting the repository…
            </p>
          )}
          {inspect.error && (
            <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
              {inspect.error.message}
            </p>
          )}
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="project-name">
              Name
            </label>
            <input className="sd-input" {...field('name')} required maxLength={100} />
          </div>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="project-goal">
              Goal
            </label>
            <textarea className="sd-textarea" {...field('goal')} maxLength={24000} />
          </div>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="project-direction">
              Direction
            </label>
            <textarea className="sd-textarea" {...field('direction')} maxLength={24000} />
          </div>
          {repository && (
            <p className="sd-meta" style={{ margin: 0 }}>
              Creating the project runs the repository&apos;s tests once on a copy of its commit, which can take a few
              minutes. The project is added only if they pass.
            </p>
          )}
          <p className="sd-meta" style={{ margin: 0 }}>
            Ideas, stories and their files stay in their project. Agents and resources are shared by every project, and
            each project has its own teams and instructions.
          </p>
          <p className="sd-meta" style={{ margin: 0 }}>
            It starts on the recommended house rules: you approve every plan, and work that passes its review goes in on
            its own. Change them on its Today page.
          </p>
          {busy && repository && (
            <p role="status" className="sd-meta" style={{ margin: 0 }}>
              Running the repository&apos;s tests on a copy…
            </p>
          )}
          {create.error && (
            <p role="alert" style={{ margin: 0, color: 'var(--bad)' }}>
              {create.error.message}
            </p>
          )}
          <div className="sd-dialog__actions">
            <button className="sd-btn sd-btn--primary" disabled={busy || !ready}>
              Create project
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
