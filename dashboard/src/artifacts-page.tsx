// Artifacts (1.2 step 6): what the project's work made and the director accepted, one row per file, read from the
// work (GET …/work). The files agents proposed for the library and the library itself, with Upload a file, sit at the
// top. The work follows: each file's kind, readable name, agent, idea or step and latest date, In the library or Add to
// the library, Open on its newest version and how many versions it has, which opens each version (work-versions.tsx),
// with the All, Documents and Images filter and the idea and agent choices. Then how many records of how the work was
// done there are, with Open the ideas. A project that is not code names sets of the accepted files as snapshots below;
// a code project has Releases instead.
// A code project's code is in its repository, which a card above the library says, with Open Releases. Below the
// library, what the work made that isn't code: the files its other steps handed back, as on any project, and each
// story's visual check, which opens the story on its Pages tab. Its records line opens the board.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { artifactsUrl, getJSON, workUrl, type ProjectArtifact, type ProjectWork, type WorkPictures } from './api';
import {
  acceptedFile,
  matchingWork,
  newestAttemptId,
  picturesLine,
  recordsSentence,
  versionCount,
  workChoices,
  workCount,
  workLine,
  workRows,
  workShows,
  type WorkFilter,
  type WorkRow,
} from './artifacts';
import { artifactUrl } from './files';
import { isCodeProject } from './frame';
import { Heading } from './layout';
import { AddToLibrary, Library } from './library';
import { LibraryProposals } from './library-proposals';
import { useStudio } from './records';
import { Snapshots } from './snapshots';
import { useLiveStream, useStreamReady } from './stream-context';
import { WorkVersions } from './work-versions';

const choiceWords = { idea: 'Idea', agent: 'Agent' } as const;

export function ArtifactsPage({ projectId }: { projectId: string }) {
  const { state, error: recordsError, shell } = useStudio(projectId),
    stream = useLiveStream(),
    client = useQueryClient(),
    ready = useStreamReady(),
    [filter, setFilter] = useState<WorkFilter>({}),
    [adding, setAdding] = useState<ProjectArtifact | null>(null);
  // Both are read on each visit, since work accepted while the page was away adds files. The accepted files are what
  // the library and its proposals name their stories from and what snapshots hold; the work is what the page lists.
  const listing = useQuery({
    enabled: ready,
    queryKey: [projectId, 'artifacts'],
    queryFn: ({ signal }) => getJSON<ProjectArtifact[]>(artifactsUrl(projectId), signal),
    refetchOnMount: 'always',
  });
  const { data, error } = useQuery({
    enabled: ready,
    queryKey: [projectId, 'work'],
    queryFn: ({ signal }) => getJSON<ProjectWork>(workUrl(projectId), signal),
    refetchOnMount: 'always',
  });
  // Work accepted while the page is open changes its task, and both are read again then. A library change moves which
  // file the library holds, so the work is read again for it too.
  useEffect(
    () =>
      stream.subscribe({
        changes: message => {
          const changes = message.changes ?? [];
          if (changes.some(change => change.type === 'task')) {
            void client.invalidateQueries({ queryKey: [projectId, 'artifacts'] });
            void client.invalidateQueries({ queryKey: [projectId, 'work'] });
          } else if (changes.some(change => change.type === 'event' && change.kind?.startsWith('library_')))
            void client.invalidateQueries({ queryKey: [projectId, 'work'] });
        },
      }),
    [stream, client, projectId],
  );
  const files = listing.data,
    names = { files, records: state },
    code = !!shell && isCodeProject(shell);
  // Agents' proposals and the library stay pinned at the top whatever the work's state, below a code project's card.
  const top = (
    <>
      <Heading
        title="Artifacts"
        lead={
          code
            ? "The files that go with this project's code: the library every agent follows, and what the work made " +
              "that isn't code. The code itself lives in the repository."
            : "What this project's work made and you accepted, one row per file, and your own uploads."
        }
      />
      {code && <Repository projectId={projectId} />}
      <LibraryProposals projectId={projectId} names={names} />
      <Library projectId={projectId} names={names} />
    </>
  );
  // Snapshots hold the accepted files, so they wait for them; a code project has none.
  const snapshots =
    shell && !isCodeProject(shell) ? (
      listing.error ? (
        <p role="alert">The accepted files snapshots hold could not be loaded: {listing.error.message}</p>
      ) : (
        files && <Snapshots projectId={projectId} files={files} />
      )
    ) : null;
  if (error)
    return (
      <>
        {top}
        <p role="alert">What the work made could not be loaded: {error.message}</p>
        {snapshots}
      </>
    );
  // Agents' names and ideas' words come from the project's records, so the work waits for them unless they fail.
  if (!data || (!state && !recordsError))
    return (
      <>
        {top}
        <p role="status" className="sd-meta">
          Loading what the work made…
        </p>
      </>
    );
  const rows = workRows(data.work, state),
    shown = matchingWork(rows, filter),
    filtered = !!(filter.idea || filter.agent || (filter.show && filter.show !== 'all')),
    records = recordsSentence(data.records, code);
  if (code)
    return (
      <>
        {top}
        <NotCode
          projectId={projectId}
          rows={rows}
          pictures={data.pictures}
          onAdd={row => setAdding(acceptedFile(row.file))}
        />
        {records && (
          <p className="sd-meta" style={{ margin: 0 }}>
            {records}{' '}
            <Link to="/p/$projectId/board" params={{ projectId }}>
              Open the board
            </Link>
          </p>
        )}
        <AddToLibrary projectId={projectId} file={adding} onClose={() => setAdding(null)} />
      </>
    );
  return (
    <>
      {top}
      <section aria-labelledby="the-work" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
          <h2 id="the-work" className="sd-section-title sd-section-title--sm">
            The work
          </h2>
          {rows.length > 0 && <span className="sd-meta">{workCount(data.work)}</span>}
        </div>
        {rows.length === 0 ? (
          <div className="sd-card sd-empty">
            <b>Nothing has been made yet.</b>
            <span>Each file the work hands back shows here once you accept it.</span>
          </div>
        ) : (
          <>
            <div className="sd-toolbar" role="group" aria-label="Filter the work">
              <div className="sd-filters" role="group" aria-label="Show">
                {workShows.map(show => (
                  <button
                    key={show.value}
                    type="button"
                    aria-pressed={(filter.show ?? 'all') === show.value}
                    onClick={() => setFilter(current => ({ ...current, show: show.value }))}
                  >
                    {show.label}
                  </button>
                ))}
              </div>
              {(['idea', 'agent'] as const).map(facet => (
                <label key={facet} className="sd-filter sd-relfilter">
                  <span>{choiceWords[facet]}</span>
                  <select
                    value={filter[facet] ?? ''}
                    onChange={event => {
                      const value = event.target.value;
                      setFilter(current => ({ ...current, [facet]: value || undefined }));
                    }}
                  >
                    {workChoices(rows, facet).map(choice => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {filtered && (
                <button type="button" className="sd-btn sd-btn--sm" onClick={() => setFilter({})}>
                  Show every file
                </button>
              )}
            </div>
            {shown.length ? (
              <div className="sd-card sd-cardlist" role="list" aria-label="The work">
                {shown.map(row => (
                  <WorkItem
                    key={row.key}
                    projectId={projectId}
                    row={row}
                    onAdd={() => setAdding(acceptedFile(row.file))}
                  />
                ))}
              </div>
            ) : (
              <div className="sd-card sd-empty">No file matches these filters.</div>
            )}
          </>
        )}
      </section>
      {records && (
        <p className="sd-meta" style={{ margin: 0 }}>
          {records}{' '}
          <Link to="/p/$projectId/runs" params={{ projectId }}>
            Open the ideas
          </Link>
        </p>
      )}
      {snapshots}
      <AddToLibrary projectId={projectId} file={adding} onClose={() => setAdding(null)} />
    </>
  );
}

// A code project's card: its code is in the repository, where each story's Changes tab and Releases show it.
function Repository({ projectId }: { projectId: string }) {
  return (
    <section
      className="sd-card"
      aria-label="The code"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)', padding: '14px 18px' }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', flex: 1, minWidth: 0 }}>
        <b>The code is in the repository.</b>
        <span className="sd-meta">
          Each story's changes are on its Changes tab, and what each line shipped is on Releases.
        </span>
      </span>
      <Link className="sd-btn sd-btn--sm" to="/p/$projectId/releases" params={{ projectId }}>
        Open Releases
      </Link>
    </section>
  );
}

// What a code project's work made that isn't code: the files its other steps handed back, then each story's visual
// check, each newest first as the controller answers. The list keeps the work's name, as on any project.
function NotCode({
  projectId,
  rows,
  pictures,
  onAdd,
}: {
  projectId: string;
  rows: WorkRow[];
  pictures: WorkPictures[];
  onAdd: (row: WorkRow) => void;
}) {
  return (
    <section aria-labelledby="not-code" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <h2 id="not-code" className="sd-section-title sd-section-title--sm">
        What the work made that isn't code
      </h2>
      {rows.length || pictures.length ? (
        <div className="sd-card sd-cardlist" role="list" aria-label="The work">
          {rows.map(row => (
            <WorkItem key={row.key} projectId={projectId} row={row} onAdd={() => onAdd(row)} />
          ))}
          {pictures.map(item => (
            <PicturesItem key={item.attemptId} projectId={projectId} pictures={item} />
          ))}
        </div>
      ) : (
        <div className="sd-card sd-empty">
          <b>Nothing has been made yet.</b>
          <span>
            The documents from steps that aren't code, and the pictures each story's visual check takes, show here once
            you accept them.
          </span>
        </div>
      )}
    </section>
  );
}

// One story's visual check: "The visual check · “its title” · Oct 28 · 4 pictures", which opens the story on its Pages
// tab, where the pictures are.
function PicturesItem({ projectId, pictures }: { projectId: string; pictures: WorkPictures }) {
  return (
    <div role="listitem" className="sd-cardlist__row sd-cardlist__row--line">
      <Link
        className="sd-cardlist__label"
        style={{ padding: '10px 0', overflowWrap: 'anywhere' }}
        to="/p/$projectId/tasks/$taskId"
        params={{ projectId, taskId: pictures.taskId }}
        search={{ tab: 'pages' }}
      >
        {picturesLine(pictures)}
      </Link>
    </div>
  );
}

// One file of the work: its kind, readable name and line, then how many versions it has when it was made more than
// once, which opens them under the row, In the library or Add to the library, and Open on its newest version.
function WorkItem({ projectId, row, onAdd }: { projectId: string; row: WorkRow; onAdd: () => void }) {
  const [open, setOpen] = useState(false),
    versionsId = useId(),
    versions = versionCount(row.file);
  return (
    <div role="listitem" className="sd-cardlist__row sd-cardlist__row--line" style={{ flexWrap: 'wrap' }}>
      <span
        className="sd-cardlist__label"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: '10px 0' }}
      >
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
          <span className="sd-chip sd-chip--inline sd-chip--outline">{row.kind}</span>
          <span title={row.file.path} style={{ overflowWrap: 'anywhere' }}>
            {row.name}
          </span>
        </span>
        <span className="sd-meta" style={{ fontWeight: 400 }}>
          {workLine(row)}
        </span>
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-6)' }}>
        {versions && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-expanded={open}
            aria-controls={versionsId}
            aria-label={`${versions} of ${row.file.path}`}
            onClick={() => setOpen(!open)}
          >
            {versions}
          </button>
        )}
        {row.file.libraryEntryId ? (
          <span className="sd-chip sd-chip--inline sd-chip--ok">In the library</span>
        ) : (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            aria-label={`Add ${row.file.path} to the library`}
            onClick={onAdd}
          >
            Add to the library
          </button>
        )}
        <a
          className="sd-btn sd-btn--sm"
          href={artifactUrl(projectId, newestAttemptId(row.file), row.file.path)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${row.file.path}`}
        >
          Open
        </a>
      </span>
      {versions && (
        <div id={versionsId} hidden={!open} style={{ flexBasis: '100%' }}>
          {open && <WorkVersions projectId={projectId} file={row.file} />}
        </div>
      )}
    </div>
  );
}
