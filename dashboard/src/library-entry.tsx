// A library file's own view (1.2 step 6), opened by picking its card at the top of the Artifacts page, in the panel a
// picked file of the work uses (file-panel.tsx): its kind, name, what it is for and where its newest revision came
// from; that revision read in place, or, for a kind the page cannot show, a note pointing at Download; its revisions,
// newest first, each with when it was added, its file and size, how many attempts read it, where it came from, What
// changed against the revision before for text and Open, which opens its bytes in a new tab; then the ideas that left
// it out, among the runs the page's records already hold (the live set's and every finished-ideas page read so far;
// none is read for this view); and its actions. Add a newer revision takes an upload or one of the accepted files.
// Edit, on a file whose newest revision is Markdown, plain text, JSON, CSV or YAML, opens that revision's text in
// place, with a preview beside Markdown and What changed against it before anything is sent, and saves the edit as the
// next revision under the same file name. Copy to another project sends the newest revision to another project's
// library, Remove from the library, once confirmed, stops later work receiving the file while its record stays and
// closes the panel, and Download saves the newest revision. Each command reads the library again afterwards, and a
// refusal shows where it was asked.
import { useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import {
  getJSON,
  getText,
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
import { readsInPlace } from './artifacts';
import { PanelActions, PanelBody, PanelDownload, PanelFrame, PanelHead, PanelVersion } from './file-panel';
import { imageFile, TextReader } from './files';
import { encoded, fileSize } from './idea-composer';
import {
  libraryAccept,
  libraryEditable,
  libraryKey,
  libraryMediaType,
  projectName,
  readBy,
  storyTitle,
  type LibraryNames,
} from './library';
import { lineDiff, type LineDiff } from './line-diff';
import { queryKeys } from './records';
import { useToast } from './toast';
import { quoted, when } from './today';
import type { ComparisonTextSource } from './work-versions';

// One command on the entry: its route under the entry, what it adds to the project in its body (an upload's is read
// from its file when the command runs) and what the toast says once the controller accepts it.
interface Command {
  action: 'revisions' | 'copy' | 'remove';
  body: () => Promise<Record<string, unknown>>;
  done: string;
}
type Panel = 'revision' | 'edit' | 'copy' | null;
// A revision's bytes never change, so its text is read once under its own key, shared by the panel's reader, What
// changed and Edit, and kept apart from the library's key, which every command reads again. A picture is read as
// one under a key of its own.
const revisionKey = (projectId: string, entryId: string, revision: number) =>
  [projectId, 'library-revision', entryId, revision] as const;
const pictureFile = (name: string) => imageFile(name) || name.endsWith('layout.json');
// What changed compares two revisions when both are text the page reads in place.
const textFile = (name: string) => readsInPlace(name) && !imageFile(name);
const revisionSource = (projectId: string, entryId: string, revision: LibraryRevision): ComparisonTextSource => ({
  url: libraryRevisionUrl(projectId, entryId, revision.revision),
  queryKey: revisionKey(projectId, entryId, revision.revision),
  label: `Revision ${revision.revision}`,
});
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

// The panel, named by the entry's name; no entry shows nothing. Close shows when the page supplies onClose, and waits
// while a command runs.
export function LibraryFile({
  projectId,
  entry,
  names,
  onClose,
}: {
  projectId: string;
  entry: LibraryEntry | null;
  names: LibraryNames;
  onClose?: (() => void) | undefined;
}) {
  return entry && <EntryView key={entry.id} projectId={projectId} entry={entry} names={names} onClose={onClose} />;
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
  onClose: (() => void) | undefined;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    [panel, setPanel] = useState<Panel>(null),
    nameId = useId(),
    revisionsId = useId(),
    ideasId = useId();
  // The panel's own read of who read the entry, one attempt to a row with the revision it received.
  const readers = useQuery({
    queryKey: [...libraryKey(projectId), entry.id, 'readers'],
    queryFn: ({ signal }) => getJSON<LibraryReader[]>(libraryReadersUrl(projectId, entry.id), signal),
  });
  const command = useMutation({
    mutationFn: async ({ action, body }: Command) =>
      send<LibraryEntry>(`${libraryUrl(projectId)}/${encodeURIComponent(entry.id)}/${action}`, {
        projectId,
        ...(await body()),
      }),
    // Removed, the panel closes; without onClose the page drops it once the library read again no longer holds it.
    onSuccess: (_, { action, done }) => {
      toast(done);
      if (action === 'remove') onClose?.();
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
    newest = revisions[0],
    editable = !!newest && libraryEditable(newest.file),
    held = heldRuns(client, projectId, names.records?.runs ?? []),
    ideas = held.runs.filter(run => leavesOut(run, entry.id));
  return (
    <PanelFrame nameId={nameId}>
      <PanelHead nameId={nameId} path={newest?.file ?? entry.name} name={entry.name} onClose={onClose} closable={!busy}>
        <p>{entry.purpose}</p>
        {newest && (
          <p className="sd-meta">
            <Source projectId={projectId} source={newest.source} names={names} />
          </p>
        )}
      </PanelHead>
      {newest && (
        <PanelBody
          readable={readsInPlace(newest.file)}
          url={libraryRevisionUrl(projectId, entry.id, newest.revision)}
          queryKey={
            pictureFile(newest.file)
              ? [...revisionKey(projectId, entry.id, newest.revision), 'picture']
              : revisionKey(projectId, entry.id, newest.revision)
          }
          item={{ path: newest.file, hash: newest.sha256 }}
        />
      )}
      <section aria-labelledby={revisionsId} style={sectionStyle}>
        <h3 id={revisionsId} className="sd-eyebrow">
          Revisions
        </h3>
        <p className="sd-meta" style={{ margin: 0 }}>
          Later work receives the newest.
        </p>
        {readers.error && (
          <p className="sd-meta" style={{ margin: 0 }}>
            Who read each revision could not be loaded: {readers.error.message}
          </p>
        )}
        <ol className="sd-filepanel__versions" aria-label="Revisions">
          {revisions.map((revision, index) => (
            <Revision
              key={revision.revision}
              projectId={projectId}
              entryId={entry.id}
              revision={revision}
              previous={revisions[index + 1]}
              current={index === 0}
              readers={readers.data ? (read.get(revision.revision) ?? 0) : null}
              names={names}
            />
          ))}
        </ol>
      </section>
      <section aria-labelledby={ideasId} style={sectionStyle}>
        <h3 id={ideasId} className="sd-eyebrow">
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
      <PanelActions>
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          aria-expanded={panel === 'revision'}
          disabled={busy}
          onClick={() => toggle('revision')}
        >
          Add a newer revision
        </button>
        {editable && (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            aria-expanded={panel === 'edit'}
            disabled={busy}
            onClick={() => toggle('edit')}
          >
            Edit
          </button>
        )}
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
        {newest && <PanelDownload href={libraryRevisionUrl(projectId, entry.id, newest.revision)} />}
      </PanelActions>
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
      {panel === 'edit' && editable && (
        <EditText
          projectId={projectId}
          entry={entry}
          revision={newest}
          busy={busy}
          refusal={refusal('revisions')}
          onEdit={edit}
          onCancel={() => setPanel(null)}
          onSave={text =>
            command.mutate({
              action: 'revisions',
              // The edit as a file under the newest revision's name, sent as an upload is: its UTF-8 bytes in base64.
              body: async () => {
                const file = new File([text], newest.file);
                return { file: await encoded({ id: 0, file, mediaType: libraryMediaType(file) }) };
              },
              done: `Saved revision ${newest.revision + 1} of ${entry.name}.`,
            })
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
    </PanelFrame>
  );
}

// One revision, the newest marked current: its number, when it was added, its file and size, how many attempts read
// it, where it came from, What changed against the revision before when both are text, and Open, which opens its
// bytes in a new tab.
function Revision({
  projectId,
  entryId,
  revision,
  previous,
  current,
  readers,
  names,
}: {
  projectId: string;
  entryId: string;
  revision: LibraryRevision;
  previous: LibraryRevision | undefined;
  current: boolean;
  readers: number | null;
  names: LibraryNames;
}) {
  return (
    <PanelVersion
      label={`Revision ${revision.revision}`}
      current={current}
      compare={
        previous && textFile(previous.file) && textFile(revision.file)
          ? {
              earlier: revisionSource(projectId, entryId, previous),
              later: revisionSource(projectId, entryId, revision),
            }
          : undefined
      }
      actions={
        <a
          className="sd-btn sd-btn--sm sd-btn--ghost"
          href={libraryRevisionUrl(projectId, entryId, revision.revision)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open revision ${revision.revision}`}
        >
          Open
        </a>
      }
    >
      <span className="sd-cardlist__meta sd-meta">
        <time dateTime={revision.at}>{when(revision.at)}</time>
        <span aria-hidden="true">·</span>
        <span className="sd-mono">{revision.file}</span>
        <span aria-hidden="true">·</span>
        <span>{fileSize(revision.byteLength)}</span>
        {readers !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span>{readBy(readers)}</span>
          </>
        )}
      </span>
      <span className="sd-meta">
        <Source projectId={projectId} source={revision.source} names={names} />
      </span>
    </PanelVersion>
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

const markdownFile = (name: string) => /\.(md|markdown)$/i.test(name);
// A textarea reads every line break as \n, so an edit of a file written with \r\n is saved with \r\n again.
const withBreaks = (original: string, text: string) =>
  original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
const linesCounted = (count: number) => `${count} line${count === 1 ? '' : 's'}`;
// What changed lists at most this many lines, so a large edit does not slow the page as the director types.
const changesShown = 400;

// Edit: the newest revision's text in place, with a preview beside a Markdown file and what the edit changes against
// that revision, saved as the next revision under the same file name. Cancel, or closing, drops the edit.
function EditText({
  projectId,
  entry,
  revision,
  busy,
  refusal,
  onEdit,
  onSave,
  onCancel,
}: {
  projectId: string;
  entry: LibraryEntry;
  revision: LibraryRevision;
  busy: boolean;
  refusal: string | null;
  onEdit: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  // The edit, or null while it is the revision's text as read.
  const [draft, setDraft] = useState<string | null>(null),
    textId = useId(),
    previewId = useId();
  // The revision's text as the panel's reader reads it, under the same key.
  const read = useQuery({
    queryKey: revisionKey(projectId, entry.id, revision.revision),
    queryFn: ({ signal }) => getText(libraryRevisionUrl(projectId, entry.id, revision.revision), signal),
    // A revision's bytes never change.
    staleTime: Infinity,
  });
  const original = read.data,
    text = draft ?? original ?? '',
    saved = original === undefined || draft === null ? original : withBreaks(original, draft),
    changed = original !== undefined && saved !== undefined && saved !== original,
    next = revision.revision + 1;
  const diff = useMemo(
    () => (original === undefined || saved === undefined ? null : lineDiff(original, saved)),
    [original, saved],
  );
  return (
    <section aria-label={`Edit ${entry.name}`} className="sd-card" style={panelStyle}>
      <p style={{ margin: 0 }}>
        {`Saved, the edit becomes revision ${next}. Work already done keeps the revision it read, and work that starts afterwards receives the new one.`}
      </p>
      {original === undefined ? (
        read.error ? (
          <p role="alert" className="sd-meta" style={refusalStyle}>
            {`Revision ${revision.revision} could not be read: ${read.error.message}`}
          </p>
        ) : (
          <p role="status" className="sd-meta" style={{ margin: 0 }}>
            {`Loading revision ${revision.revision}…`}
          </p>
        )
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 'var(--space-10)',
              alignItems: 'start',
            }}
          >
            <div className="sd-field">
              <label className="sd-field__label" htmlFor={textId}>
                Text
              </label>
              <textarea
                id={textId}
                className="sd-textarea"
                style={{ fontFamily: 'var(--font-mono)', fontSize: '13px' }}
                rows={14}
                spellCheck={false}
                value={text}
                disabled={busy}
                onChange={event => {
                  setDraft(event.target.value);
                  onEdit();
                }}
              />
            </div>
            {markdownFile(revision.file) && (
              <section aria-labelledby={previewId} className="sd-field" style={{ minWidth: 0 }}>
                <span id={previewId} className="sd-field__label">
                  Preview
                </span>
                <TextReader text={text} markdown />
              </section>
            )}
          </div>
          {diff && <Changes diff={diff} />}
        </>
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
          disabled={!changed || busy}
          onClick={() => saved !== undefined && onSave(saved)}
        >
          {busy ? 'Saving…' : `Save as revision ${next}`}
        </button>
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </span>
    </section>
  );
}

// What changed: the lines the edit removes and adds, each with its line number in the revision or in the edit, in
// reading order, as the source diff marks them.
function Changes({ diff }: { diff: LineDiff }) {
  const titleId = useId();
  let before = 0,
    after = 0;
  const lines = diff.rows.flatMap(row => {
    if (row.type !== 'added') before++;
    if (row.type !== 'removed') after++;
    return row.type === 'same' ? [] : [{ row, line: row.type === 'added' ? after : before }];
  });
  return (
    <section aria-labelledby={titleId} style={sectionStyle}>
      <h4 id={titleId} className="sd-eyebrow" style={{ margin: 0 }}>
        What changed
      </h4>
      {lines.length === 0 ? (
        <p className="sd-meta" style={{ margin: 0 }}>
          Nothing changed yet.
        </p>
      ) : (
        <>
          <span className="sd-meta">{`${linesCounted(diff.added)} added, ${linesCounted(diff.removed)} removed`}</span>
          {!diff.exact && (
            <span className="sd-meta">
              Too much changed to match line by line, so the changed part reads as removed, then added.
            </span>
          )}
          <div
            className="sd-code"
            role="list"
            aria-label="Lines added and removed"
            style={{ maxHeight: '320px', overflow: 'auto' }}
          >
            {lines.slice(0, changesShown).map(({ row, line }, index) => (
              <div
                key={index}
                role="listitem"
                aria-label={`Line ${line} ${row.type}: ${row.text}`}
                className={`sd-code__line ${row.type === 'added' ? 'sd-code__line--add' : 'sd-code__line--del'}`}
              >
                <span className="sd-code__num">{row.type === 'removed' ? line : ''}</span>
                <span className="sd-code__num">{row.type === 'added' ? line : ''}</span>
                <span className="sd-code__sign">{row.type === 'added' ? '+' : '−'}</span>
                <span>
                  {row.text}
                  {row.noNewlineAtEnd && <span className="sd-code__cm"> No newline at the end of the file</span>}
                </span>
              </div>
            ))}
          </div>
          {lines.length > changesShown && (
            <span className="sd-meta">{`Showing the first ${changesShown} of ${lines.length} changed lines.`}</span>
          )}
        </>
      )}
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
