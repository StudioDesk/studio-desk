// Snapshots (1.2 step 6, decision 12), below the accepted files on the Artifacts page of a project that is not code: a
// named set of its accepted files at one moment, such as what was sent to a client, its counterpart to a code project's
// release. Each snapshot, newest first, shows when it was made, how many files it holds and how many changed since,
// counted here by task and path against the accepted files listed now. What changed opens the controller's own changes
// against the snapshot before it, and Download is a plain link to the set as one zip; the controller checks each file
// by hash and answers one that no longer matches with its own message. New snapshot names every accepted file or the
// ones chosen, and the controller's refusals show in its dialog. Snapshots are not task changes on the stream, so a new
// one reads the list again.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { getJSON, send, snapshotDownloadUrl, snapshotsUrl, type ProjectArtifact, type Snapshot } from './api';
import { Modal } from './dialog';
import { useStreamReady } from './stream-context';
import { when } from './today';
import { useToast } from './toast';

// What the controller takes, as src/core/snapshots.mjs's createSnapshot and snapshotLimits.
export const snapshotNameLength = 120;
export const snapshotFiles = 200;

export const snapshotsKey = (projectId: string) => [projectId, 'snapshots'] as const;
const counted = (count: number) => `${count} file${count === 1 ? '' : 's'}`;
const fileKey = (file: { taskId: string; path: string }) => `${file.taskId}\0${file.path}`;
// A file of the listing, for choosing it: its accepted attempt and path, as the listing's own rows are keyed.
const listed = (file: ProjectArtifact) => `${file.attemptId}/${file.path}`;

// What changed since a snapshot, by task and path as the controller compares two snapshots, against the accepted
// files listed now: files added since, files with another hash and files gone.
export function changedSince(
  snapshot: Pick<Snapshot, 'files'>,
  current: Pick<ProjectArtifact, 'taskId' | 'path' | 'hash'>[],
) {
  const held = new Map(snapshot.files.map(file => [fileKey(file), file])),
    now = new Set(current.map(fileKey));
  return {
    added: current.filter(file => !held.has(fileKey(file))).length,
    changed: current.filter(file => {
      const was = held.get(fileKey(file));
      return !!was && was.hash !== file.hash;
    }).length,
    gone: snapshot.files.filter(file => !now.has(fileKey(file))).length,
  };
}
export function changedWords({ added, changed, gone }: ReturnType<typeof changedSince>) {
  const total = added + changed + gone,
    parts = [
      [added, 'added'],
      [changed, 'changed'],
      [gone, 'gone'],
    ] as const;
  if (!total) return 'Nothing changed since';
  return `${total} changed since (${parts
    .filter(([count]) => count)
    .map(([count, word]) => `${count} ${word}`)
    .join(', ')})`;
}

export function Snapshots({ projectId, files }: { projectId: string; files: ProjectArtifact[] }) {
  const titleId = useId(),
    [making, setMaking] = useState(false);
  // Read on each visit, since a snapshot named elsewhere adds one.
  const { data, error } = useQuery({
    enabled: useStreamReady(),
    queryKey: snapshotsKey(projectId),
    queryFn: ({ signal }) => getJSON<Snapshot[]>(snapshotsUrl(projectId), signal),
    refetchOnMount: 'always',
  });
  // The controller answers oldest first, each with what changed since the one before it; the newest shows first.
  const shown = (data ?? [])
    .map((snapshot, index, all) => ({ snapshot, previous: index ? all[index - 1] : undefined }))
    .toReversed();
  return (
    <section aria-labelledby={titleId} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
        <h2 id={titleId} className="sd-section-title sd-section-title--sm">
          Snapshots
        </h2>
        {shown.length > 0 && (
          <span className="sd-meta">{`${shown.length} snapshot${shown.length === 1 ? '' : 's'}`}</span>
        )}
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          style={{ marginLeft: 'auto' }}
          disabled={!files.length}
          onClick={() => setMaking(true)}
        >
          New snapshot
        </button>
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          The snapshots could not be loaded: {error.message}
        </p>
      ) : !data ? (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Loading the snapshots…
        </p>
      ) : shown.length === 0 ? (
        <div className="sd-card sd-empty">
          <b>No snapshots yet.</b>
          <span>
            Name the accepted files as they are now, such as what you sent to a client, to see later what changed since
            and download the set again.
          </span>
        </div>
      ) : (
        <ul
          aria-label="Snapshots"
          className="sd-card sd-cardlist"
          style={{ listStyle: 'none', margin: 0, display: 'flex', flexDirection: 'column' }}
        >
          {shown.map(({ snapshot, previous }) => (
            <Item key={snapshot.id} projectId={projectId} snapshot={snapshot} previous={previous} files={files} />
          ))}
        </ul>
      )}
      <NewSnapshot projectId={projectId} open={making} files={files} onClose={() => setMaking(false)} />
    </section>
  );
}

// One snapshot, named by its name, with what changed since it and its two actions.
function Item({
  projectId,
  snapshot,
  previous,
  files,
}: {
  projectId: string;
  snapshot: Snapshot;
  previous: Snapshot | undefined;
  files: ProjectArtifact[];
}) {
  const [open, setOpen] = useState(false),
    nameId = useId(),
    changesId = useId();
  return (
    <li aria-labelledby={nameId} className="sd-cardlist__row">
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)' }}>
        <span
          className="sd-cardlist__label"
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
        >
          <span id={nameId} style={{ overflowWrap: 'anywhere' }}>
            {snapshot.name}
          </span>
          <span className="sd-cardlist__meta sd-meta" style={{ fontWeight: 400 }}>
            <time dateTime={snapshot.at}>{when(snapshot.at)}</time>
            <span aria-hidden="true">·</span>
            <span>{counted(snapshot.files.length)}</span>
            <span aria-hidden="true">·</span>
            <span>{changedWords(changedSince(snapshot, files))}</span>
          </span>
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            aria-expanded={open}
            aria-controls={changesId}
            onClick={() => setOpen(!open)}
          >
            What changed
          </button>
          <a
            className="sd-btn sd-btn--sm"
            href={snapshotDownloadUrl(projectId, snapshot.id)}
            target="_blank"
            rel="noreferrer"
            aria-label={`Download ${snapshot.name}`}
          >
            Download
          </a>
        </span>
      </span>
      <div id={changesId} hidden={!open}>
        {open && <Changes snapshot={snapshot} previous={previous} />}
      </div>
    </li>
  );
}

const changeWords = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

// The controller's own changes against the snapshot before it, by task and path, each file named with its story.
function Changes({ snapshot, previous }: { snapshot: Snapshot; previous: Snapshot | undefined }) {
  const story = (taskId: string) =>
      [...snapshot.files, ...(previous?.files ?? [])].find(file => file.taskId === taskId)?.title ?? taskId,
    kinds = (['added', 'changed', 'removed'] as const).filter(kind => snapshot.changes[kind].length);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', padding: 'var(--space-6) 0' }}>
      <span className="sd-meta">
        {previous
          ? `Since ${previous.name}, ${when(previous.at)}`
          : 'The first snapshot, so every file it holds is added.'}
      </span>
      {kinds.length === 0 && previous && <span className="sd-meta">The same files as {previous.name}.</span>}
      {kinds.map(kind => (
        <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <span style={{ fontWeight: 600 }}>{`${changeWords[kind]} (${snapshot.changes[kind].length})`}</span>
          <ul
            aria-label={changeWords[kind]}
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {snapshot.changes[kind].map(change => (
              <li key={fileKey(change)} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
                <span className="sd-mono" style={{ overflowWrap: 'anywhere' }}>
                  {change.path}
                </span>
                <span className="sd-meta">{story(change.taskId)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// New snapshot: a name and every accepted file, or the files chosen from the listing. The dialog stays open with the
// controller's refusal until the director changes something, and closes once the controller names the snapshot.
function NewSnapshot({
  projectId,
  open,
  files,
  onClose,
}: {
  projectId: string;
  open: boolean;
  files: ProjectArtifact[];
  onClose: () => void;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    [name, setName] = useState(''),
    [every, setEvery] = useState(true),
    [chosen, setChosen] = useState<string[]>([]),
    nameId = useId(),
    whichId = useId(),
    filesId = useId();
  const make = useMutation({
    mutationFn: (snapshot: { name: string; files?: ProjectArtifact[] }) =>
      send<Snapshot>(snapshotsUrl(projectId), {
        projectId,
        name: snapshot.name,
        ...(snapshot.files
          ? { files: snapshot.files.map(({ taskId, attemptId, path }) => ({ taskId, attemptId, path })) }
          : {}),
      }),
    onSuccess: (made, snapshot) => {
      close();
      toast(`Named the snapshot ${made?.name ?? snapshot.name}.`);
      void client.invalidateQueries({ queryKey: snapshotsKey(projectId) });
    },
  });
  // The chosen files in the listing's order; one no longer listed drops out.
  const picked = files.filter(file => chosen.includes(listed(file))),
    count = every ? files.length : picked.length,
    busy = make.isPending,
    ready = !!name.trim() && count > 0 && count <= snapshotFiles;
  function close() {
    setName('');
    setEvery(true);
    setChosen([]);
    make.reset();
    onClose();
  }
  // A change to any field clears the last refusal.
  const edited = () => {
    if (make.error) make.reset();
  };
  const choice = { display: 'flex', gap: 'var(--space-8)', alignItems: 'baseline' } as const;
  return (
    <Modal open={open} onClose={close} closable={!busy} title="New snapshot">
      <div className="sd-dialog__scroll" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}>
        <p style={{ margin: 0 }}>
          Names the accepted files as they are now, each by its accepted work and hash, so you can see what changed
          since and download the set.
        </p>
        <div className="sd-field">
          <label className="sd-field__label" htmlFor={nameId}>
            Name
          </label>
          {/* At most as long as the controller takes a snapshot's name. */}
          <input
            id={nameId}
            className="sd-input"
            autoComplete="off"
            placeholder="Sent to the client"
            maxLength={snapshotNameLength}
            value={name}
            disabled={busy}
            onChange={event => {
              setName(event.target.value);
              edited();
            }}
          />
        </div>
        <fieldset
          disabled={busy}
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', margin: 0, padding: 0, border: 0 }}
        >
          <legend className="sd-field__label" style={{ padding: 0, marginBottom: 'var(--space-8)' }}>
            Files
          </legend>
          <label style={choice}>
            <input
              type="radio"
              name={whichId}
              checked={every}
              onChange={() => {
                setEvery(true);
                edited();
              }}
            />
            {`Every accepted file (${counted(files.length)})`}
          </label>
          <label style={choice}>
            <input
              type="radio"
              name={whichId}
              checked={!every}
              onChange={() => {
                setEvery(false);
                edited();
              }}
            />
            The files I choose
          </label>
        </fieldset>
        {!every && (
          <fieldset
            disabled={busy}
            aria-describedby={filesId}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-8)',
              margin: 0,
              padding: 0,
              border: 0,
            }}
          >
            <legend className="sd-meta" style={{ padding: 0, marginBottom: 'var(--space-8)' }}>
              Check the files the snapshot holds.
            </legend>
            {files.map(file => (
              <label key={listed(file)} style={choice}>
                <input
                  type="checkbox"
                  checked={chosen.includes(listed(file))}
                  onChange={event => {
                    const key = listed(file);
                    setChosen(current =>
                      event.target.checked ? [...current, key] : current.filter(item => item !== key),
                    );
                    edited();
                  }}
                />
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
                  <span className="sd-mono" style={{ overflowWrap: 'anywhere' }}>
                    {file.path}
                  </span>
                  <span className="sd-meta">{file.title}</span>
                </span>
              </label>
            ))}
            <span id={filesId} className="sd-meta">
              {`${counted(picked.length)} chosen`}
            </span>
          </fieldset>
        )}
        {count > snapshotFiles && (
          <p className="sd-meta" style={{ margin: 0 }}>
            {`A snapshot holds at most ${snapshotFiles} files${every ? '; choose the ones it holds.' : '.'}`}
          </p>
        )}
        {make.error && (
          <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
            {make.error.message}
          </p>
        )}
      </div>
      <div className="sd-dialog__actions">
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={!ready || busy}
          onClick={() => make.mutate({ name: name.trim(), ...(every ? {} : { files: picked }) })}
        >
          {busy ? 'Naming…' : 'Name the snapshot'}
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
