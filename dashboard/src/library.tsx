// The project's library, pinned at the top of the Artifacts page (1.2 step 6): the files its later work should follow,
// each a card with what it is for, its name, its newest revision and that revision's size, how many attempts read it
// and where it came from, under the library's total against what every attempt receives in full. Upload a file adds
// one from the director's computer, and Add to the library, on each accepted file, adds one that accepted work handed
// back; the controller's refusals show in the dialog. Library changes are not task changes on the stream, so each
// successful command reads the library again. Picking a card opens nothing yet: the page passes onPick when it does.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  getJSON,
  libraryReadersUrl,
  libraryUrl,
  send,
  type LibraryEntry,
  type LibraryIndex,
  type LibraryReader,
  type LibrarySource,
  type ProjectArtifact,
  type Shell,
  type Task,
} from './api';
import { Modal } from './dialog';
import { encoded, fileSize } from './idea-composer';
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
const accept = Object.keys(types)
  .map(extension => `.${extension}`)
  .join(',');
const mediaTypeOf = (file: File) => types[file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? ''] ?? file.type;

export const libraryKey = (projectId: string) => [projectId, 'library'] as const;
// The entries later work follows: those not removed, each at its newest revision, in the library's order.
export const currentEntries = (library: LibraryIndex) => library.entries.filter(entry => !entry.removedAt);
const newest = (entry: LibraryEntry) => entry.revisions.at(-1);

// What the page knows to name a source by: the accepted files' stories, the records' tasks and the projects.
export interface LibraryNames {
  files?: ProjectArtifact[];
  records: (Pick<Shell, 'projects'> & { tasks?: Task[] }) | null;
}

function sourceWords(source: LibrarySource, { files, records }: LibraryNames) {
  if (source.type === 'upload') return 'Uploaded';
  if (source.type === 'accepted') {
    const story =
      files?.find(file => file.taskId === source.taskId)?.title ??
      records?.tasks?.find(task => task.id === source.taskId)?.title ??
      source.taskId;
    return `From accepted work: ${story}`;
  }
  const project = records?.projects.find(item => item.id === source.projectId)?.name ?? source.projectId;
  return `Copied from ${project}`;
}
const readBy = (count: number) => (count === 0 ? 'Not read yet' : `Read by ${count} attempt${count === 1 ? '' : 's'}`);
const counted = (count: number) => `${count} file${count === 1 ? '' : 's'}`;

export function Library({
  projectId,
  names,
  onPick,
}: {
  projectId: string;
  names: LibraryNames;
  onPick?: (entry: LibraryEntry) => void;
}) {
  const [uploading, setUploading] = useState(false),
    titleId = useId();
  // Read on each visit, since attempts that started while the page was away read it.
  const { data, error } = useQuery({
    enabled: useStreamReady(),
    queryKey: libraryKey(projectId),
    queryFn: ({ signal }) => getJSON<LibraryIndex>(libraryUrl(projectId), signal),
    refetchOnMount: 'always',
  });
  const entries = data ? currentEntries(data) : [],
    total = entries.reduce((sum, entry) => sum + (newest(entry)?.byteLength ?? 0), 0);
  return (
    <section aria-labelledby={titleId} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
        <h2 id={titleId} className="sd-section-title sd-section-title--sm">
          Library
        </h2>
        {entries.length > 0 && <span className="sd-meta">{counted(entries.length)}</span>}
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          style={{ marginLeft: 'auto' }}
          onClick={() => setUploading(true)}
        >
          Upload a file
        </button>
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
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
            <span className="sd-meta">{`${fileSize(total)} in all, of the ${delivery} every attempt receives in full`}</span>
            <span className="sd-bar sd-bar--thin" aria-hidden="true">
              <span
                className="sd-bar__part sd-bar__part--brand"
                style={{ width: `${Math.min(100, (total / libraryDeliveryBytes) * 100)}%` }}
              ></span>
            </span>
            {total > libraryDeliveryBytes && (
              <p className="sd-meta" style={{ margin: 0 }}>
                {`That is more than ${delivery}: in the library's order, the files past it go in each attempt's index only, named with what they are for.`}
              </p>
            )}
          </div>
          <ul
            aria-label="Library files"
            style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: '12px' }}
          >
            {entries.map(entry => (
              <Card key={entry.id} projectId={projectId} entry={entry} names={names} onPick={onPick} />
            ))}
          </ul>
        </>
      )}
      <EntryDialog projectId={projectId} open={uploading} onClose={() => setUploading(false)} />
    </section>
  );
}

// One entry's card, named by its name and described by the rest; it reads the attempts that read the entry itself.
function Card({
  projectId,
  entry,
  names,
  onPick,
}: {
  projectId: string;
  entry: LibraryEntry;
  names: LibraryNames;
  onPick?: (entry: LibraryEntry) => void;
}) {
  const nameId = useId(),
    detailsId = useId(),
    revision = newest(entry);
  const readers = useQuery({
    queryKey: [...libraryKey(projectId), entry.id, 'readers'],
    queryFn: ({ signal }) => getJSON<LibraryReader[]>(libraryReadersUrl(projectId, entry.id), signal),
    refetchOnMount: 'always',
  });
  const facts = [
    revision && `Revision ${revision.revision}`,
    revision && fileSize(revision.byteLength),
    readers.data ? readBy(readers.data.length) : readers.error ? 'Its readers could not be loaded' : null,
  ].filter((fact): fact is string => !!fact);
  return (
    <li style={{ display: 'flex', flex: '1 1 260px', minWidth: 0 }}>
      <button
        type="button"
        className="sd-tile sd-tile--raised"
        style={{ flex: 1 }}
        aria-labelledby={nameId}
        aria-describedby={detailsId}
        onClick={() => onPick?.(entry)}
      >
        <span id={nameId} style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
          {entry.name}
        </span>
        <span id={detailsId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <span style={{ color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{entry.purpose}</span>
          <span className="sd-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
            {facts.map((fact, index) => (
              <span key={fact} style={{ display: 'contents' }}>
                {index > 0 && <span aria-hidden="true">·</span>}
                <span>{fact}</span>
              </span>
            ))}
          </span>
          {revision && <span className="sd-meta">{sourceWords(revision.source, names)}</span>}
        </span>
      </button>
    </li>
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
          : { file: await encoded({ id: 0, file: entry.file!, mediaType: mediaTypeOf(entry.file!) }) }),
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
              accept={accept}
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
