// One picked file of the work, read beside the Artifacts page. The page owns picking and Add to the library;
// this panel only reads recorded files and compares versions when asked. Its frame (the head with the kind tile and
// name, the body read in place, a version's row and the actions) is shared with a library file's own view
// (library-entry.tsx).
import type { QueryKey } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import type { WorkVersion } from './api';
import { readsInPlace, versionWhy, workLine, type WorkRow } from './artifacts';
import { artifactUrl, FileBody, imageFile, type FileRecord } from './files';
import { KindTile } from './kind-tile';
import { when } from './today';
import { VersionComparison, type ComparisonTextSource } from './work-versions';

export function FilePanel({
  projectId,
  row,
  onAdd,
  onClose,
}: {
  projectId: string;
  row: WorkRow;
  onAdd: (row: WorkRow) => void;
  onClose?: () => void;
}) {
  const nameId = useId(),
    { file } = row,
    versions = [...file.versions].sort((a, b) => b.n - a.n),
    newest = versions[0],
    attemptId = newest?.attemptId ?? file.attemptId,
    hash = newest ? newest.hash : file.hash,
    url = artifactUrl(projectId, attemptId, file.path),
    readable = readsInPlace(file.path),
    preview = imageFile(file.path) || file.path.endsWith('layout.json');
  return (
    <PanelFrame nameId={nameId}>
      <PanelHead nameId={nameId} path={file.path} name={row.name} onClose={onClose}>
        <span className="sd-meta">{row.kind}</span>
        <p className="sd-meta">{workLine(row)}</p>
      </PanelHead>
      <PanelBody
        readable={readable}
        url={url}
        queryKey={[projectId, preview ? 'picture' : 'file', attemptId, file.path, hash]}
        item={{ path: file.path, hash: hash ?? file.hash, kind: file.kind }}
      />
      {versions.length > 0 && (
        <section aria-label="Versions">
          <h3 className="sd-eyebrow">Versions</h3>
          <ol className="sd-filepanel__versions" aria-label={`Versions of ${file.path}`}>
            {versions.map((version, index) => {
              const previous = readable && !imageFile(file.path) ? versions[index + 1] : undefined,
                at = when(version.at);
              return (
                <PanelVersion
                  key={`${version.attemptId}/${file.path}/${version.n}`}
                  label={`Version ${version.n}`}
                  current={version.current}
                  compare={
                    previous && {
                      earlier: versionSource(projectId, file.path, previous),
                      later: versionSource(projectId, file.path, version),
                    }
                  }
                >
                  {at && version.at && (
                    <time className="sd-meta" dateTime={version.at}>
                      {at}
                    </time>
                  )}
                  <span className="sd-meta">{versionWhy(version)}</span>
                </PanelVersion>
              );
            })}
          </ol>
        </section>
      )}
      <PanelActions>
        {file.libraryEntryId ? (
          <span className="sd-chip sd-chip--inline sd-chip--ok">In the library</span>
        ) : (
          <button type="button" className="sd-btn sd-btn--sm" onClick={() => onAdd(row)}>
            Add to the library
          </button>
        )}
        <PanelDownload href={url} />
      </PanelActions>
    </PanelFrame>
  );
}

// The panel itself, named by the heading its head gives the file's name.
export function PanelFrame({ nameId, children }: { nameId: string; children: ReactNode }) {
  return (
    <aside className="sd-card sd-filepanel" aria-labelledby={nameId}>
      {children}
    </aside>
  );
}

// The file's kind tile, its name and the lines under it, and Close when the page supplies it. Close waits while the
// panel's own command runs.
export function PanelHead({
  nameId,
  path,
  name,
  children,
  onClose,
  closable = true,
}: {
  nameId: string;
  path: string;
  name: string;
  children: ReactNode;
  onClose?: (() => void) | undefined;
  closable?: boolean;
}) {
  return (
    <header className="sd-filepanel__head">
      <KindTile path={path} />
      <div className="sd-filepanel__name">
        <h2 id={nameId} title={path}>
          {name}
        </h2>
        {children}
      </div>
      {onClose && (
        <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={!closable} onClick={onClose}>
          Close
        </button>
      )}
    </header>
  );
}

// The file read in place from its recorded source under the caller's immutable cache key, or, for a kind the page
// cannot show, a note pointing at Download.
export function PanelBody({
  readable,
  url,
  queryKey,
  item,
}: {
  readable: boolean;
  url: string;
  queryKey: QueryKey;
  item: FileRecord;
}) {
  return (
    <div className="sd-filepanel__body">
      {readable ? (
        <FileBody key={JSON.stringify(queryKey)} url={url} queryKey={queryKey} item={item} />
      ) : (
        <p className="sd-meta">This file can't be shown here. Download it to look at the recorded file.</p>
      )}
    </div>
  );
}

// One version of the file: its dot, filled for the current one, its name and the lines under it, any actions of its
// own, and What changed against the version before when the caller can compare their texts.
export function PanelVersion({
  label,
  current,
  children,
  actions,
  compare,
}: {
  label: string;
  current: boolean;
  children: ReactNode;
  actions?: ReactNode;
  compare?: { earlier: ComparisonTextSource; later: ComparisonTextSource } | undefined;
}) {
  const [open, setOpen] = useState(false),
    nameId = useId(),
    changesId = useId();
  return (
    <li className="sd-filepanel__version" aria-labelledby={nameId}>
      <div className="sd-filepanel__version-head">
        <span className={`sd-filepanel__dot${current ? ' sd-filepanel__dot--current' : ''}`} aria-hidden="true" />
        <div className="sd-filepanel__name">
          <b id={nameId}>{label}</b>
          {children}
        </div>
        {compare && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-label={`What changed in ${label.toLowerCase()}`}
            aria-expanded={open}
            aria-controls={changesId}
            onClick={() => setOpen(!open)}
          >
            What changed
          </button>
        )}
        {actions}
      </div>
      {compare && (
        <div id={changesId} hidden={!open} style={{ minWidth: 0 }}>
          {open && <VersionComparison earlier={compare.earlier} later={compare.later} />}
        </div>
      )}
    </li>
  );
}

// The panel's actions, under a line at its foot.
export function PanelActions({ children }: { children: ReactNode }) {
  return <footer className="sd-filepanel__actions">{children}</footer>;
}

// Download the newest recorded bytes, as a plain download of the file.
export function PanelDownload({ href }: { href: string }) {
  return (
    <a className="sd-btn sd-btn--sm" href={href} download>
      Download
    </a>
  );
}

function versionSource(projectId: string, path: string, version: WorkVersion): ComparisonTextSource {
  return {
    url: artifactUrl(projectId, version.attemptId, path),
    queryKey: [projectId, 'file', version.attemptId, path, version.hash],
    label: `Version ${version.n}`,
  };
}
