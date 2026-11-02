// Artifacts (1.2 step 6), as the director's frames draw it: the heading with Upload a file, the files agents proposed
// for the library, then two columns. On the left the library, a card for each file every agent follows, then The work
// in one card, read from the work (GET …/work): each file's kind tile, readable name and its line (agent, idea or step,
// latest date), In the library or Add to the library, how many versions it has, which folds them open under the row
// (work-versions.tsx), and Open, or Download for a file the page cannot show, with the All, Documents N and Images N
// choice and the idea and agent choices, and at its foot the records of how the work was done with Open the ideas.
// A project that is not code names sets of the accepted files as snapshots in a card below. On the right, the panel:
// the picked library card (library-entry.tsx) or file of the work (file-panel.tsx), read in place, and before any pick
// a line saying to pick one. Picking is the page's own state, so a visit starts with nothing picked. On a phone, or
// wherever both columns do not fit, the panel opens under the picked card or row instead, comes into view and closes
// with Close.
// A code project's code is in its repository, which a card above the library says, with Open Releases. Below the
// library, what the work made that isn't code: the files its other steps handed back, as on any project, and each
// story's visual check, which opens the story on its Pages tab, with its records line and Open the board at its foot.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { artifactsUrl, getJSON, workUrl, type ProjectArtifact, type ProjectWork, type WorkPictures } from './api';
import {
  acceptedFile,
  matchingWork,
  newestAttemptId,
  picturesLine,
  readsInPlace,
  recordsWords,
  versionCount,
  workChoices,
  workCount,
  workLine,
  workRows,
  workShowChoices,
  type WorkFilter,
  type WorkRow,
} from './artifacts';
import { Icon } from './design/icons';
import { FilePanel } from './file-panel';
import { artifactUrl } from './files';
import { isCodeProject } from './frame';
import { KindTile } from './kind-tile';
import { Heading } from './layout';
import { AddToLibrary, currentEntries, Library, UploadToLibrary, useLibrary } from './library';
import { LibraryFile } from './library-entry';
import { LibraryProposals } from './library-proposals';
import { useStudio } from './records';
import { Snapshots } from './snapshots';
import { useLiveStream, useStreamReady } from './stream-context';
import { useNarrow } from './use-narrow';
import { WorkVersions } from './work-versions';

const choiceWords = { idea: 'Idea', agent: 'Agent' } as const;
// The file the panel shows: a library entry by its id, or a file of the work by its row's key.
type Picked = { library: string } | { work: string } | null;
// The page's width both columns need: the files' 440px, the panel's 300px and the 22px between them.
const besideWidth = 762;

export function ArtifactsPage({ projectId }: { projectId: string }) {
  const { state, error: recordsError, shell } = useStudio(projectId),
    stream = useLiveStream(),
    client = useQueryClient(),
    ready = useStreamReady(),
    narrow = useNarrow(),
    [tight, measure] = useTight(),
    [filter, setFilter] = useState<WorkFilter>({}),
    [adding, setAdding] = useState<ProjectArtifact | null>(null),
    [uploading, setUploading] = useState(false),
    [picked, setPicked] = useState<Picked>(null);
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
  // The library's own read, which its cards share: the picked entry as the library reads now, so its panel closes once
  // the entry is removed.
  const library = useLibrary(projectId);
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
    code = !!shell && isCodeProject(shell),
    under = narrow || tight,
    // Agents' names and ideas' words come from the project's records, so the work waits for them unless they fail.
    rows = data && (state || recordsError) ? workRows(data.work, state) : null,
    pickedEntry =
      picked && 'library' in picked && library.data
        ? (currentEntries(library.data).find(entry => entry.id === picked.library) ?? null)
        : null,
    pickedRow = picked && 'work' in picked ? (rows?.find(row => row.key === picked.work) ?? null) : null,
    close = () => setPicked(null),
    add = (row: WorkRow) => setAdding(acceptedFile(row.file));
  // A library file's panel closes only itself: a removal still under way when another file was picked leaves that one.
  const closeEntry = (entryId: string) => () =>
    setPicked(current => (current && 'library' in current && current.library === entryId ? null : current));
  const panel = pickedEntry ? (
    <LibraryFile
      key={pickedEntry.id}
      projectId={projectId}
      entry={pickedEntry}
      names={names}
      onClose={closeEntry(pickedEntry.id)}
    />
  ) : pickedRow ? (
    <FilePanel key={pickedRow.key} projectId={projectId} row={pickedRow} onAdd={add} onClose={close} />
  ) : null;
  // On a phone the panel follows what was picked, and comes into view each time another file is picked.
  const phonePanel = under && panel && <PhonePanel key={pickedEntry?.id ?? pickedRow?.key}>{panel}</PhonePanel>;
  const picking: RowPicking = {
    projectId,
    pickedKey: pickedRow?.key ?? null,
    under: pickedRow ? phonePanel : null,
    onPick: row => setPicked({ work: row.key }),
    onAdd: add,
  };
  // Snapshots hold the accepted files, so they wait for them; a code project has none.
  const snapshots =
    shell && !isCodeProject(shell) ? (
      listing.error ? (
        <p role="alert" style={{ margin: 0 }}>
          The accepted files snapshots hold could not be loaded: {listing.error.message}
        </p>
      ) : (
        files && <Snapshots projectId={projectId} files={files} />
      )
    ) : null;
  const records = data ? recordsWords(data.records, code) : null;
  const work = error ? (
    <p role="alert" style={{ margin: 0 }}>
      What the work made could not be loaded: {error.message}
    </p>
  ) : !data || !rows ? (
    <p role="status" className="sd-meta" style={{ margin: 0 }}>
      Loading what the work made…
    </p>
  ) : code ? (
    <NotCode rows={rows} pictures={data.pictures} records={records} picking={picking} />
  ) : (
    <TheWork work={data} rows={rows} filter={filter} onFilter={setFilter} records={records} picking={picking} />
  );
  return (
    <>
      <Heading
        title="Artifacts"
        lead={
          code
            ? "The files that go with this project's code: the library every agent follows, and what the work made " +
              "that isn't code. The code itself lives in the repository."
            : "What this project's work made and you accepted, one row per file, and your own uploads. At the top, " +
              'the library: the files every agent follows.'
        }
        tools={
          <button type="button" className="sd-btn" onClick={() => setUploading(true)}>
            Upload a file
          </button>
        }
      />
      {code && <Repository projectId={projectId} />}
      {/* Agents' proposals stay pinned at the top whatever the work's state, below a code project's card. */}
      <LibraryProposals projectId={projectId} names={names} />
      <div className="sd-artifacts" ref={measure}>
        <div className="sd-artifacts__main">
          <Library
            projectId={projectId}
            pickedId={picked && 'library' in picked ? picked.library : null}
            onPick={entryId => setPicked({ library: entryId })}
            under={pickedEntry ? phonePanel : null}
          />
          {work}
          {(error || rows) && snapshots}
        </div>
        {!under && (
          <div className="sd-artifacts__side">
            {panel ?? <div className="sd-empty">Pick a file to read it here.</div>}
          </div>
        )}
      </div>
      <AddToLibrary projectId={projectId} file={adding} onClose={() => setAdding(null)} />
      <UploadToLibrary projectId={projectId} open={uploading} onClose={() => setUploading(false)} />
    </>
  );
}

// Whether the page is too narrow for both columns, as the browser measures the columns' row: no measure, as where
// the browser cannot, keeps them side by side.
function useTight() {
  const [tight, setTight] = useState(false);
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setTight(entry.contentRect.width < besideWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [tight, measure] as const;
}

// The panel under what was picked, brought into view as it opens.
function PhonePanel({ children }: { children: ReactNode }) {
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wrapper.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  return (
    <div ref={wrapper} className="sd-artifacts__under">
      {children}
    </div>
  );
}

// What each row of the work needs from the page to be picked: which one is, the panel that follows it on a phone,
// picking it and Add to the library.
interface RowPicking {
  projectId: string;
  pickedKey: string | null;
  under: ReactNode;
  onPick: (row: WorkRow) => void;
  onAdd: (row: WorkRow) => void;
}

// The work of a project that is not code: its heading and count with the kind, idea and agent choices, its rows, and
// the records line at its foot.
function TheWork({
  work,
  rows,
  filter,
  onFilter,
  records,
  picking,
}: {
  work: ProjectWork;
  rows: WorkRow[];
  filter: WorkFilter;
  onFilter: (update: (current: WorkFilter) => WorkFilter) => void;
  records: ReturnType<typeof recordsWords>;
  picking: RowPicking;
}) {
  const titleId = useId(),
    shown = matchingWork(rows, filter),
    filtered = !!(filter.idea || filter.agent || (filter.show && filter.show !== 'all'));
  return (
    <section className="sd-card sd-workcard" aria-labelledby={titleId}>
      <div className="sd-workcard__head">
        <h2 id={titleId} className="sd-workcard__title">
          The work
        </h2>
        {rows.length > 0 && <span className="sd-meta">{workCount(work.work)}</span>}
        {rows.length > 0 && (
          <div className="sd-workcard__tools" role="group" aria-label="Filter the work">
            <div className="sd-segmented sd-segmented--filter" role="group" aria-label="Show">
              {workShowChoices(rows).map(show => (
                <button
                  key={show.value}
                  type="button"
                  aria-pressed={(filter.show ?? 'all') === show.value}
                  onClick={() => onFilter(current => ({ ...current, show: show.value }))}
                >
                  {show.label}
                </button>
              ))}
            </div>
            {(['idea', 'agent'] as const).map(facet => (
              <label key={facet} className={`sd-chipselect${filter[facet] ? ' sd-chipselect--on' : ''}`}>
                <span className="sd-sr">{choiceWords[facet]}</span>
                <select
                  value={filter[facet] ?? ''}
                  onChange={event => {
                    const value = event.target.value;
                    onFilter(current => ({ ...current, [facet]: value || undefined }));
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
              <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={() => onFilter(() => ({}))}>
                Show every file
              </button>
            )}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="sd-empty">
          <b>Nothing has been made yet.</b>
          <span>Each file the work hands back shows here once you accept it.</span>
        </div>
      ) : shown.length ? (
        <div role="list" aria-label="The work">
          {shown.map(row => (
            <FileRow key={row.key} row={row} picking={picking} />
          ))}
        </div>
      ) : (
        <div className="sd-empty">No file matches these filters.</div>
      )}
      {records && (
        <Records words={records}>
          <Link
            className="sd-btn sd-btn--sm sd-btn--ghost"
            to="/p/$projectId/runs"
            params={{ projectId: picking.projectId }}
          >
            Open the ideas
          </Link>
        </Records>
      )}
    </section>
  );
}

// How many records of how the work was done there are and where they stay, with the way to them.
function Records({ words, children }: { words: { title: string; detail: string }; children: ReactNode }) {
  return (
    <div className="sd-records">
      <span className="sd-records__text">
        <b>{words.title}</b>
        <span className="sd-meta">{words.detail}</span>
      </span>
      {children}
    </div>
  );
}

// A code project's card: its code is in the repository, where each story's Changes tab and Releases show it.
function Repository({ projectId }: { projectId: string }) {
  const titleId = useId();
  return (
    <section className="sd-card sd-coderef" aria-labelledby={titleId}>
      <span className="sd-coderef__icon" aria-hidden="true">
        <Icon name="code" size={22} />
      </span>
      <span className="sd-coderef__text">
        <b id={titleId}>The code is in the repository</b>
        <span>Each story's changes are on its Changes tab, and what each line shipped is on Releases.</span>
      </span>
      <Link className="sd-btn sd-btn--sm" to="/p/$projectId/releases" params={{ projectId }}>
        Open Releases
      </Link>
    </section>
  );
}

// What a code project's work made that isn't code: the files its other steps handed back, then each story's visual
// check, each newest first as the controller answers, and the records line at its foot. The list keeps the work's
// name, as on any project.
function NotCode({
  rows,
  pictures,
  records,
  picking,
}: {
  rows: WorkRow[];
  pictures: WorkPictures[];
  records: ReturnType<typeof recordsWords>;
  picking: RowPicking;
}) {
  const titleId = useId(),
    count = rows.length + pictures.length;
  return (
    <section className="sd-card sd-workcard" aria-labelledby={titleId}>
      <div className="sd-workcard__head">
        <h2 id={titleId} className="sd-workcard__title">
          What the work made that isn't code
        </h2>
        {count > 0 && <span className="sd-meta">{`${count} file${count === 1 ? '' : 's'}`}</span>}
      </div>
      {count ? (
        <div role="list" aria-label="The work">
          {rows.map(row => (
            <FileRow key={row.key} row={row} picking={picking} />
          ))}
          {pictures.map(item => (
            <PicturesItem key={item.attemptId} projectId={picking.projectId} pictures={item} />
          ))}
        </div>
      ) : (
        <div className="sd-empty">
          <b>Nothing has been made yet.</b>
          <span>
            The documents from steps that aren't code, and the pictures each story's visual check takes, show here once
            you accept them.
          </span>
        </div>
      )}
      {records && (
        <Records words={records}>
          <Link
            className="sd-btn sd-btn--sm sd-btn--ghost"
            to="/p/$projectId/board"
            params={{ projectId: picking.projectId }}
          >
            Open the board
          </Link>
        </Records>
      )}
    </section>
  );
}

// One story's visual check: "The visual check · “its title” · Oct 28 · 4 pictures", which opens the story on its Pages
// tab, where the pictures are.
function PicturesItem({ projectId, pictures }: { projectId: string; pictures: WorkPictures }) {
  return (
    <div role="listitem" className="sd-filerow">
      <div className="sd-filerow__head">
        <KindTile path={pictures.images[0]?.path ?? 'pictures.png'} small />
        <Link
          className="sd-filerow__name"
          to="/p/$projectId/tasks/$taskId"
          params={{ projectId, taskId: pictures.taskId }}
          search={{ tab: 'pages' }}
        >
          {picturesLine(pictures)}
        </Link>
      </div>
    </div>
  );
}

// Open picks the file for the panel on a plain click; a click with a key held, or the middle button, opens the
// newest version in a new tab as a link does.
const plainClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// One file of the work: its kind tile, readable name and line, In the library or Add to the library, how many
// versions it has when it was made more than once, which folds them open under the row, and Open, which shows its
// newest version in the panel, or, for a kind the page cannot show, Download. Clicking the row away from its buttons
// picks it too. On a phone its panel follows it.
function FileRow({ row, picking }: { row: WorkRow; picking: RowPicking }) {
  const [open, setOpen] = useState(false),
    versionsId = useId(),
    versions = versionCount(row.file),
    { projectId, onPick, onAdd } = picking,
    picked = picking.pickedKey === row.key,
    path = row.file.path,
    url = artifactUrl(projectId, newestAttemptId(row.file), path);
  return (
    <div
      role="listitem"
      className={`sd-filerow${picked ? ' sd-filerow--picked' : ''}`}
      aria-current={picked || undefined}
    >
      <div
        className="sd-filerow__head"
        onClick={event => {
          if (!(event.target as HTMLElement).closest('a, button, select, label')) onPick(row);
        }}
      >
        <KindTile path={path} small />
        <span className="sd-filerow__name">
          <b title={path}>{row.name}</b>
          <span className="sd-meta">{workLine(row)}</span>
        </span>
        {row.file.libraryEntryId ? (
          <span className="sd-chip sd-chip--inline sd-chip--ok">In the library</span>
        ) : (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            aria-label={`Add ${path} to the library`}
            onClick={() => onAdd(row)}
          >
            Add to the library
          </button>
        )}
        {versions && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-expanded={open}
            aria-controls={versionsId}
            aria-label={`${versions} of ${path}`}
            onClick={() => setOpen(!open)}
          >
            {versions}
          </button>
        )}
        {readsInPlace(path) ? (
          <a
            className="sd-btn sd-btn--sm"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${path}`}
            onClick={event => {
              if (!plainClick(event)) return;
              event.preventDefault();
              onPick(row);
            }}
          >
            Open
          </a>
        ) : (
          <a className="sd-btn sd-btn--sm" href={url} download aria-label={`Download ${path}`}>
            Download
          </a>
        )}
      </div>
      {versions && (
        <div id={versionsId} hidden={!open} className="sd-filerow__versions">
          {open && <WorkVersions projectId={projectId} file={row.file} />}
        </div>
      )}
      {picked && picking.under}
    </div>
  );
}
