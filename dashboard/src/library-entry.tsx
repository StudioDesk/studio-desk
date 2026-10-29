// A library file's own view (1.2 step 6), opened by picking its card at the top of the Artifacts page: what the file
// is for and its revisions, newest first, each with when it was added, where it came from, how many attempts read that
// revision and Open, which opens its bytes in a new tab; then the ideas that left it out, among the runs the page's
// records already hold (the live set's and every finished-ideas page read so far; none is read for this view). Add a
// newer revision takes an upload or one of the accepted files, Copy to another project sends the newest revision to
// another project's library, and Remove from the library, once confirmed, stops later work receiving the file while
// its record stays. Each command reads the library again afterwards, and a refusal shows where it was asked.
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import {
  getJSON,
  libraryReadersUrl,
  libraryRevisionUrl,
  libraryUrl,
  projectsUrl,
  send,
  type FinishedPage,
  type LibraryEntry,
  type LibraryReader,
  type LibraryRevision,
  type LibrarySource,
  type Project,
  type ProjectArtifact,
  type RunRecord,
} from './api';
import { Modal } from './dialog';
import { encoded, fileSize } from './idea-composer';
import {
  libraryAccept,
  libraryKey,
  libraryMediaType,
  projectName,
  readBy,
  storyTitle,
  type LibraryNames,
} from './library';
import { queryKeys } from './records';
import { useToast } from './toast';
import { quoted, when } from './today';

// One command on the entry: its route under the entry, what it adds to the project in its body (an upload's is read
// from its file when the command runs) and what the toast says once the controller accepts it.
interface Command {
  action: 'revisions' | 'copy' | 'remove';
  body: () => Promise<Record<string, unknown>>;
  done: string;
}
type Panel = 'revision' | 'copy' | null;
const commandKey = (projectId: string) => [...libraryKey(projectId), 'command'] as const;
const fileKey = (file: ProjectArtifact) => `${file.attemptId}/${file.path}`;
const refusalStyle = { margin: 0, color: 'var(--bad)' };
const sectionStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' } as const;
const panelStyle = { ...sectionStyle, gap: 'var(--space-10)', padding: 'var(--space-14)' } as const;

// The runs the page's records hold, newest first: the live set's and those of every finished-ideas page any page of
// the project has read, the live copy of a run winning; how many finished ones that is, and whether older finished
// ideas are left unread (none was read, or no read reached the oldest).
function heldRuns(client: QueryClient, projectId: string, live: RunRecord[]) {
  const reads = client
    .getQueriesData<InfiniteData<FinishedPage>>({ queryKey: queryKeys.finished(projectId) })
    .flatMap(([, data]) => (data ? [data.pages] : []));
  const finished = reads.flatMap(pages => pages.flatMap(page => page.runs.map(item => item.run)));
  const runs = new Map([...finished, ...live].map(run => [run.id, run] as const));
  return {
    runs: [...runs.values()].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
    finished: new Set(finished.map(run => run.id)).size,
    more: reads.every(pages => pages.at(-1)?.next !== null),
  };
}
// Which ideas were looked through, so that none found says among which.
function lookedThrough({ finished, more }: { finished: number; more: boolean }) {
  if (!more) return 'Among every idea, open and finished.';
  if (!finished) return 'Among the open ideas. Finished ones count once the Ideas page lists them.';
  const newest = finished === 1 ? 'the newest finished one' : `the ${finished} newest finished ones`;
  return `Among the open ideas and ${newest}. Older ones count once the Ideas page lists them.`;
}
// The controller sends libraryLeftOut on a run only when the idea left something out (src/core/graph.mjs runView).
const leavesOut = (run: RunRecord, entryId: string) =>
  Array.isArray(run.libraryLeftOut) && run.libraryLeftOut.includes(entryId);
const ideaWords = (run: RunRecord) =>
  typeof run.brief === 'string' && run.brief.trim() ? quoted(run.brief) : `Idea ${run.id}`;

// The view over the page, named by the entry's name; no entry shows nothing. While a command runs it stays open.
export function LibraryFile({
  projectId,
  entry,
  names,
  onClose,
}: {
  projectId: string;
  entry: LibraryEntry | null;
  names: LibraryNames;
  onClose: () => void;
}) {
  const busy = useIsMutating({ mutationKey: commandKey(projectId) }) > 0;
  return (
    <Modal open={entry !== null} onClose={onClose} closable={!busy} title={entry?.name ?? ''}>
      {entry && <EntryView key={entry.id} projectId={projectId} entry={entry} names={names} onClose={onClose} />}
    </Modal>
  );
}

function EntryView({
  projectId,
  entry,
  names,
  onClose,
}: {
  projectId: string;
  entry: LibraryEntry;
  names: LibraryNames;
  onClose: () => void;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    [panel, setPanel] = useState<Panel>(null),
    revisionsId = useId(),
    ideasId = useId();
  // The card's own read of who read the entry, one attempt to a row with the revision it received.
  const readers = useQuery({
    queryKey: [...libraryKey(projectId), entry.id, 'readers'],
    queryFn: ({ signal }) => getJSON<LibraryReader[]>(libraryReadersUrl(projectId, entry.id), signal),
  });
  const command = useMutation({
    mutationKey: commandKey(projectId),
    mutationFn: async ({ action, body }: Command) =>
      send<LibraryEntry>(`${libraryUrl(projectId)}/${encodeURIComponent(entry.id)}/${action}`, {
        projectId,
        ...(await body()),
      }),
    onSuccess: (_, { action, done }) => {
      toast(done);
      if (action === 'remove') onClose();
      else setPanel(null);
    },
    // Library changes are not on the stream, so whatever the controller answered, the library is read again.
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey(projectId) }),
  });
  const busy = command.isPending,
    refusal = (action: Command['action']) =>
      command.error && command.variables?.action === action ? command.error.message : null,
    // A change to a command's fields clears its last refusal.
    edit = () => {
      if (command.error) command.reset();
    },
    toggle = (next: Exclude<Panel, null>) => {
      command.reset();
      setPanel(current => (current === next ? null : next));
    },
    remove = () => {
      const question = `Remove ${entry.name} from the library? Later work no longer receives it; its record stays.`;
      if (!confirm(question)) return;
      setPanel(null);
      command.mutate({ action: 'remove', body: async () => ({}), done: `Removed ${entry.name} from the library.` });
    };
  const read = new Map<number, number>();
  for (const reader of readers.data ?? []) read.set(reader.revision, (read.get(reader.revision) ?? 0) + 1);
  const revisions = [...entry.revisions].sort((a, b) => b.revision - a.revision),
    held = heldRuns(client, projectId, names.records?.runs ?? []),
    ideas = held.runs.filter(run => leavesOut(run, entry.id));
  return (
    <div className="sd-dialog__scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{entry.purpose}</p>
      <div className="sd-toolbar">
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          aria-expanded={panel === 'revision'}
          disabled={busy}
          onClick={() => toggle('revision')}
        >
          Add a newer revision
        </button>
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          aria-expanded={panel === 'copy'}
          disabled={busy}
          onClick={() => toggle('copy')}
        >
          Copy to another project
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--danger" disabled={busy} onClick={remove}>
          {busy && command.variables?.action === 'remove' ? 'Removing…' : 'Remove from the library'}
        </button>
      </div>
      {refusal('remove') && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {refusal('remove')}
        </p>
      )}
      {panel === 'revision' && (
        <NewRevision
          files={names.files}
          busy={busy}
          refusal={refusal('revisions')}
          onEdit={edit}
          onCancel={() => setPanel(null)}
          onAdd={body =>
            command.mutate({ action: 'revisions', body, done: `Added a newer revision of ${entry.name}.` })
          }
        />
      )}
      {panel === 'copy' && (
        <CopyTo
          projectId={projectId}
          busy={busy}
          refusal={refusal('copy')}
          onEdit={edit}
          onCancel={() => setPanel(null)}
          onCopy={project =>
            command.mutate({
              action: 'copy',
              body: async () => ({ to: project.id }),
              done: `Copied ${entry.name} to ${project.name}.`,
            })
          }
        />
      )}
      <section aria-labelledby={revisionsId} style={sectionStyle}>
        <h3 id={revisionsId} className="sd-eyebrow" style={{ margin: 0 }}>
          Revisions
        </h3>
        <span className="sd-meta">Later work receives the newest.</span>
        {readers.error && (
          <p className="sd-meta" style={{ margin: 0 }}>
            Who read each revision could not be loaded: {readers.error.message}
          </p>
        )}
        <div className="sd-card sd-cardlist" role="list" aria-label="Revisions">
          {revisions.map(revision => (
            <Revision
              key={revision.revision}
              projectId={projectId}
              entryId={entry.id}
              revision={revision}
              readers={readers.data ? (read.get(revision.revision) ?? 0) : null}
              names={names}
            />
          ))}
        </div>
      </section>
      <section aria-labelledby={ideasId} style={sectionStyle}>
        <h3 id={ideasId} className="sd-eyebrow" style={{ margin: 0 }}>
          Ideas that left it out
        </h3>
        <span className="sd-meta">{lookedThrough(held)}</span>
        {ideas.length ? (
          <ul
            aria-label="Ideas that left it out"
            style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
          >
            {ideas.map(run => (
              <li key={run.id}>
                <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: run.id }}>
                  {ideaWords(run)}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: 0 }}>None of them left it out.</p>
        )}
      </section>
    </div>
  );
}

// One revision: its number, when it was added, its file and size, how many attempts read it, where it came from and
// Open, which opens its bytes in a new tab.
function Revision({
  projectId,
  entryId,
  revision,
  readers,
  names,
}: {
  projectId: string;
  entryId: string;
  revision: LibraryRevision;
  readers: number | null;
  names: LibraryNames;
}) {
  return (
    <div role="listitem" className="sd-cardlist__row sd-cardlist__row--line">
      <span
        className="sd-cardlist__label"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: '10px 0' }}
      >
        <span>{`Revision ${revision.revision}`}</span>
        <span className="sd-cardlist__meta sd-meta" style={{ fontWeight: 400 }}>
          <time dateTime={revision.at}>{when(revision.at)}</time>
          <span aria-hidden="true">·</span>
          <span className="sd-mono" style={{ overflowWrap: 'anywhere' }}>
            {revision.file}
          </span>
          <span aria-hidden="true">·</span>
          <span>{fileSize(revision.byteLength)}</span>
          {readers !== null && (
            <>
              <span aria-hidden="true">·</span>
              <span>{readBy(readers)}</span>
            </>
          )}
        </span>
        <span className="sd-meta" style={{ fontWeight: 400 }}>
          <Source projectId={projectId} source={revision.source} names={names} />
        </span>
      </span>
      <a
        className="sd-btn sd-btn--sm"
        href={libraryRevisionUrl(projectId, entryId, revision.revision)}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open revision ${revision.revision}`}
      >
        Open
      </a>
    </div>
  );
}

// Where a revision came from: an upload, an accepted file with a link to its story, or a copy naming its project.
function Source({ projectId, source, names }: { projectId: string; source: LibrarySource; names: LibraryNames }) {
  if (source.type === 'upload') return <>Uploaded</>;
  if (source.type === 'accepted')
    return (
      <>
        From accepted work:{' '}
        <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: source.taskId }}>
          {storyTitle(source.taskId, names)}
        </Link>
      </>
    );
  return <>{`Copied from ${projectName(source.projectId, names)}`}</>;
}

// Add a newer revision: a file from the director's computer, or one of the files accepted work handed back.
function NewRevision({
  files,
  busy,
  refusal,
  onEdit,
  onAdd,
  onCancel,
}: {
  files?: ProjectArtifact[];
  busy: boolean;
  refusal: string | null;
  onEdit: () => void;
  onAdd: (body: Command['body']) => void;
  onCancel: () => void;
}) {
  const [from, setFrom] = useState<'upload' | 'accepted'>('upload'),
    [picked, setPicked] = useState<File | null>(null),
    [chosen, setChosen] = useState(''),
    fileId = useId(),
    acceptedId = useId();
  const accepted = files?.find(file => fileKey(file) === chosen),
    ready = from === 'upload' ? !!picked : !!accepted;
  const choose = (next: 'upload' | 'accepted') => {
      setFrom(next);
      onEdit();
    },
    add = () => {
      if (from === 'upload' && picked)
        onAdd(async () => ({ file: await encoded({ id: 0, file: picked, mediaType: libraryMediaType(picked) }) }));
      else if (from === 'accepted' && accepted)
        onAdd(async () => ({ from: { taskId: accepted.taskId, attemptId: accepted.attemptId, path: accepted.path } }));
    };
  return (
    <section aria-label="Add a newer revision" className="sd-card" style={panelStyle}>
      <span className="sd-segmented" role="group" aria-label="The newer revision" style={{ alignSelf: 'flex-start' }}>
        <button type="button" aria-pressed={from === 'upload'} disabled={busy} onClick={() => choose('upload')}>
          An upload
        </button>
        <button type="button" aria-pressed={from === 'accepted'} disabled={busy} onClick={() => choose('accepted')}>
          An accepted file
        </button>
      </span>
      {from === 'upload' ? (
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={fileId}>
            File
          </label>
          <input
            id={fileId}
            type="file"
            accept={libraryAccept}
            disabled={busy}
            onChange={event => {
              setPicked(event.target.files?.[0] ?? null);
              onEdit();
            }}
          />
          {picked && <span className="sd-meta">{`${picked.name}, ${fileSize(picked.size)}`}</span>}
        </div>
      ) : files?.length ? (
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={acceptedId}>
            Accepted file
          </label>
          <select
            id={acceptedId}
            className="sd-select"
            value={chosen}
            disabled={busy}
            onChange={event => {
              setChosen(event.target.value);
              onEdit();
            }}
          >
            <option value="">Choose a file</option>
            {files.map(file => (
              <option key={fileKey(file)} value={fileKey(file)}>
                {`${file.path}, from ${file.title}`}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          {files ? 'No accepted work has handed back files yet.' : 'The accepted files are not loaded.'}
        </p>
      )}
      {refusal && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {refusal}
        </p>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--primary" disabled={!ready || busy} onClick={add}>
          {busy ? 'Adding…' : 'Add the revision'}
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </section>
  );
}

// Copy to another project: one of the controller's other projects, whose library receives the newest revision.
function CopyTo({
  projectId,
  busy,
  refusal,
  onEdit,
  onCopy,
  onCancel,
}: {
  projectId: string;
  busy: boolean;
  refusal: string | null;
  onEdit: () => void;
  onCopy: (project: Project) => void;
  onCancel: () => void;
}) {
  const [to, setTo] = useState(''),
    selectId = useId();
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => getJSON<{ projects: Project[] }>(projectsUrl, signal),
  });
  const others = projects.data?.projects.filter(project => project.id !== projectId) ?? [],
    target = others.find(project => project.id === to);
  return (
    <section aria-label="Copy to another project" className="sd-card" style={panelStyle}>
      <p style={{ margin: 0 }}>
        Its newest revision joins that project&rsquo;s library with the same name and what it is for, and says where it
        came from.
      </p>
      {projects.error ? (
        <p role="alert" style={{ margin: 0 }}>
          The projects could not be listed: {projects.error.message}
        </p>
      ) : !projects.data ? (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Loading the projects…
        </p>
      ) : others.length === 0 ? (
        <p className="sd-meta" style={{ margin: 0 }}>
          There is no other project to copy it to.
        </p>
      ) : (
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={selectId}>
            Project
          </label>
          <select
            id={selectId}
            className="sd-select"
            value={to}
            disabled={busy}
            onChange={event => {
              setTo(event.target.value);
              onEdit();
            }}
          >
            <option value="">Choose a project</option>
            {others.map(project => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {refusal && (
        <p role="alert" className="sd-meta" style={refusalStyle}>
          {refusal}
        </p>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--primary"
          disabled={!target || busy}
          onClick={() => target && onCopy(target)}
        >
          {busy ? 'Copying…' : 'Copy'}
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </section>
  );
}
