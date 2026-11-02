// The project's library on the Artifacts page (1.2 step 6): the files its later work should follow, under the
// library's total against what every attempt receives in full, each a card with its kind, its name, what it is for, its
// newest revision and that revision's size and how many attempts read it. The page's Upload a file adds one from the
// director's computer (UploadToLibrary), and Add to the library, on each accepted file, adds one that accepted work
// handed back; the controller's refusals show in the dialog. Library changes are not task changes on the stream, so
// each successful command reads the library again. Picking a card shows that file's own view (library-entry.tsx) in
// the page's panel, which on a phone the page hands back to open under the picked card.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import {
  getJSON,
  libraryReadersUrl,
  libraryUrl,
  send,
  type LibraryEntry,
  type LibraryIndex,
  type LibraryReader,
  type ProjectArtifact,
  type RunRecord,
  type Shell,
  type Task,
} from './api';
import { Modal } from './dialog';
import { encoded, fileSize } from './idea-composer';
import { KindTile } from './kind-tile';
import { useStreamReady } from './stream-context';
import { useToast } from './toast';

// What every attempt receives of the library in full, as src/core/library.mjs's libraryDeliveryBytes: files in the
// library's order up to this many bytes sit beside the work, and the rest are named in its index only.
export const libraryDeliveryBytes = 20 * 1024 * 1024;
const delivery = `${libraryDeliveryBytes / (1024 * 1024)} MiB`;

// The kinds the library keeps, by extension, as src/core/library.mjs's types: the controller checks the media type an
// upload names against its file's name. Another kind is sent as the browser names it, and the controller refuses it.
const types: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  svg: 'image/svg+xml',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
};
export const libraryAccept = Object.keys(types)
  .map(extension => `.${extension}`)
  .join(',');
const extensionOf = (name: string) => name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
export const libraryMediaType = (file: File) => types[extensionOf(file.name)] ?? file.type;
// The kinds a file's own view edits in place as text (library-entry.tsx): Markdown, plain text, JSON, CSV and YAML.
// The rest, such as pictures, HTML, SVG and code, take a newer revision only as a file.
const textKinds = new Set(['md', 'markdown', 'txt', 'csv', 'json', 'yaml', 'yml']);
export const libraryEditable = (name: string) => textKinds.has(extensionOf(name));

export const libraryKey = (projectId: string) => [projectId, 'library'] as const;
// The entries later work follows: those not removed, each at its newest revision, in the library's order.
export const currentEntries = (library: LibraryIndex) => library.entries.filter(entry => !entry.removedAt);
const newest = (entry: LibraryEntry) => entry.revisions.at(-1);

// What the page knows to name a source by: the accepted files' stories, the records' tasks and the projects; and the
// runs its records hold, for the ideas that left an entry out.
export interface LibraryNames {
  files?: ProjectArtifact[];
  records: (Pick<Shell, 'projects'> & { tasks?: Task[]; runs?: RunRecord[] }) | null;
}

export const storyTitle = (taskId: string, { files, records }: LibraryNames) =>
  files?.find(file => file.taskId === taskId)?.title ??
  records?.tasks?.find(task => task.id === taskId)?.title ??
  taskId;
export const projectName = (projectId: string, { records }: LibraryNames) =>
  records?.projects.find(item => item.id === projectId)?.name ?? projectId;
export const readBy = (count: number) =>
  count === 0 ? 'Not read yet' : `Read by ${count} attempt${count === 1 ? '' : 's'}`;
const counted = (count: number) => `${count} file${count === 1 ? '' : 's'}`;
// A card's foot after its revision: "1.5 KiB · read by 3 attempts", the size alone while its readers load.
export function cardFacts(byteLength: number | undefined, readers: number | null, failed = false) {
  const read = failed
    ? 'its readers could not be loaded'
    : readers === null
      ? null
      : readers === 0
        ? 'not read yet'
        : `read by ${readers} attempt${readers === 1 ? '' : 's'}`;
  return [byteLength === undefined ? null : fileSize(byteLength), read].filter(Boolean).join(' · ');
}

// The library's index, read on each visit, since attempts that started while the page was away read it. The page
// reads it too, for the file it shows in its panel; one read serves both.
export function useLibrary(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: libraryKey(projectId),
    queryFn: ({ signal }) => getJSON<LibraryIndex>(libraryUrl(projectId), signal),
    refetchOnMount: 'always',
  });
}

// The library: its heading, its total against what every attempt receives in full, and a card for each current entry.
// The page owns which card is picked; on a phone it hands back the picked file's panel, which opens under that card.
// The section keeps the landmark name Library while its heading reads The library.
export function Library({
  projectId,
  pickedId = null,
  onPick = () => {},
  under = null,
}: {
  projectId: string;
  pickedId?: string | null;
  onPick?: (entryId: string) => void;
  under?: ReactNode;
}) {
  const titleId = useId(),
    { data, error } = useLibrary(projectId);
  const entries = data ? currentEntries(data) : [],
    total = entries.reduce((sum, entry) => sum + (newest(entry)?.byteLength ?? 0), 0);
  return (
    <section aria-label="Library" className="sd-library">
      <div className="sd-library__head">
        <div className="sd-library__title">
          <h2 id={titleId} className="sd-section-title sd-section-title--sm">
            The library
          </h2>
          <span className="sd-meta">every agent in the project follows these</span>
        </div>
        {entries.length > 0 && (
          <div className="sd-library__total">
            <b>{`${counted(entries.length)} · ${fileSize(total)}`}</b>
            <span className="sd-bar sd-library__bar" aria-hidden="true">
              <span
                className="sd-bar__part sd-bar__part--brand"
                style={{ width: `${Math.min(100, (total / libraryDeliveryBytes) * 100)}%` }}
              ></span>
            </span>
            <span className="sd-meta">{`of the ${delivery} every attempt receives in full`}</span>
          </div>
        )}
        {total > libraryDeliveryBytes && (
          <p className="sd-meta" style={{ margin: 0 }}>
            {`That is more than ${delivery}: in the library's order, the files past it go in each attempt's index only, named with what they are for.`}
          </p>
        )}
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          The library could not be loaded: {error.message}
        </p>
      ) : !data ? (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Loading the library…
        </p>
      ) : entries.length === 0 ? (
        <div className="sd-card sd-empty">
          <b>The library is empty.</b>
          <span>
            Keep here the files later work should follow, such as brand guidelines, a design system, a spec or a data
            set. Every attempt receives them read-only, up to {delivery} in all. Upload a file, or add one of the
            accepted files below.
          </span>
        </div>
      ) : (
        <ul aria-label="Library files" className="sd-libgrid">
          {entries.map(entry => (
            <Card
              key={entry.id}
              projectId={projectId}
              entry={entry}
              picked={entry.id === pickedId}
              onPick={onPick}
              under={entry.id === pickedId ? under : null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// One entry's card, a button named by its entry's name (first, for its reading order; the kind's tile sits beside it)
// and described by what it is for and its foot; it reads the attempts that read the entry itself. Picking it shows the
// entry's own view in the page's panel; on a phone that panel follows the card as an item of its own across the grid.
function Card({
  projectId,
  entry,
  picked,
  onPick,
  under,
}: {
  projectId: string;
  entry: LibraryEntry;
  picked: boolean;
  onPick: (entryId: string) => void;
  under: ReactNode;
}) {
  const nameId = useId(),
    purposeId = useId(),
    footId = useId(),
    revision = newest(entry);
  const readers = useQuery({
    queryKey: [...libraryKey(projectId), entry.id, 'readers'],
    queryFn: ({ signal }) => getJSON<LibraryReader[]>(libraryReadersUrl(projectId, entry.id), signal),
    refetchOnMount: 'always',
  });
  return (
    <>
      <li className="sd-libgrid__item">
        <button
          type="button"
          className="sd-libcard"
          aria-labelledby={nameId}
          aria-describedby={`${purposeId} ${footId}`}
          aria-pressed={picked}
          onClick={() => onPick(entry.id)}
        >
          <span id={nameId} className="sd-libcard__name">
            {entry.name}
          </span>
          <KindTile path={revision?.file ?? entry.name} />
          <span id={purposeId} className="sd-libcard__purpose">
            {entry.purpose}
          </span>
          <span id={footId} className="sd-libcard__foot">
            {revision && (
              <span className="sd-chip sd-chip--inline sd-chip--brand">{`revision ${revision.revision}`}</span>
            )}
            <span className="sd-meta">
              {cardFacts(revision?.byteLength, readers.data ? readers.data.length : null, !!readers.error)}
            </span>
          </span>
        </button>
      </li>
      {under && <li className="sd-libgrid__under">{under}</li>}
    </>
  );
}

// Add to the library for one accepted file: its name and what it is for. No file shows nothing.
export function AddToLibrary({
  projectId,
  file,
  onClose,
}: {
  projectId: string;
  file: ProjectArtifact | null;
  onClose: () => void;
}) {
  return <EntryDialog projectId={projectId} open={file !== null} accepted={file} onClose={onClose} />;
}

// Upload a file, which the page opens from its header: a new entry from the director's computer.
export function UploadToLibrary({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  return <EntryDialog projectId={projectId} open={open} onClose={onClose} />;
}

// A new entry: an accepted file, or without one an upload, which asks for the file too. The dialog stays open with the
// controller's refusal until the director changes something, and closes once the controller adds the entry.
function EntryDialog({
  projectId,
  open,
  accepted = null,
  onClose,
}: {
  projectId: string;
  open: boolean;
  accepted?: ProjectArtifact | null;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    [picked, setPicked] = useState<File | null>(null),
    [name, setName] = useState(''),
    [purpose, setPurpose] = useState(''),
    fileId = useId(),
    nameId = useId(),
    purposeId = useId();
  const add = useMutation({
    mutationFn: async (entry: { name: string; purpose: string; from: ProjectArtifact | null; file: File | null }) =>
      send<LibraryEntry>(libraryUrl(projectId), {
        projectId,
        name: entry.name,
        purpose: entry.purpose,
        ...(entry.from
          ? { from: { taskId: entry.from.taskId, attemptId: entry.from.attemptId, path: entry.from.path } }
          : { file: await encoded({ id: 0, file: entry.file!, mediaType: libraryMediaType(entry.file!) }) }),
      }),
    onSuccess: (_, entry) => {
      close();
      toast(`Added ${entry.name} to the library.`);
      void client.invalidateQueries({ queryKey: libraryKey(projectId) });
    },
  });
  const busy = add.isPending,
    ready = !!name.trim() && !!purpose.trim() && (!!accepted || !!picked);
  function close() {
    setPicked(null);
    setName('');
    setPurpose('');
    add.reset();
    onClose();
  }
  // A change to any field clears the last refusal.
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      if (add.error) add.reset();
    };
  return (
    <Modal open={open} onClose={close} closable={!busy} title={accepted ? 'Add to the library' : 'Upload a file'}>
      <div className="sd-dialog__scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
        <p style={{ margin: 0 }}>
          {accepted ? (
            <>
              Adds <span className="sd-mono">{accepted.path}</span> from {accepted.title}.{' '}
            </>
          ) : null}
          Every later attempt receives the library&rsquo;s files read-only, each with its name and what it is for.
        </p>
        {!accepted && (
          <div className="sd-field">
            <label className="sd-field__label" htmlFor={fileId}>
              File
            </label>
            <input
              id={fileId}
              type="file"
              accept={libraryAccept}
              disabled={busy}
              onChange={event => edit(setPicked)(event.target.files?.[0] ?? null)}
            />
            {picked && <span className="sd-meta">{`${picked.name}, ${fileSize(picked.size)}`}</span>}
          </div>
        )}
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={nameId}>
            Name
          </label>
          {/* At most as long as the controller takes a name and a purpose. */}
          <input
            id={nameId}
            className="sd-input"
            autoComplete="off"
            maxLength={120}
            value={name}
            disabled={busy}
            onChange={event => edit(setName)(event.target.value)}
          />
        </div>
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={purposeId}>
            What it is for
          </label>
          <textarea
            id={purposeId}
            className="sd-textarea"
            maxLength={500}
            value={purpose}
            disabled={busy}
            onChange={event => edit(setPurpose)(event.target.value)}
          />
        </div>
        {add.error && (
          <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
            {add.error.message}
          </p>
        )}
      </div>
      <div className="sd-dialog__actions">
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={!ready || busy}
          onClick={() => add.mutate({ name: name.trim(), purpose: purpose.trim(), from: accepted, file: picked })}
        >
          {busy ? 'Adding…' : 'Add to the library'}
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
