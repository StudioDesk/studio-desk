// One picked file of the work, read beside the Artifacts page. The page owns picking and Add to the library;
// this panel only reads recorded files and compares versions when asked.
import { useId, useState } from 'react';
import type { WorkVersion } from './api';
import { readsInPlace, versionWhy, workLine, type WorkRow } from './artifacts';
import { artifactUrl, FileBody, imageFile } from './files';
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
    <aside className="sd-card sd-filepanel" aria-labelledby={nameId}>
      <header className="sd-filepanel__head">
        <KindTile path={file.path} />
        <div className="sd-filepanel__name">
          <h2 id={nameId} title={file.path}>
            {row.name}
          </h2>
          <span className="sd-meta">{row.kind}</span>
          <p className="sd-meta">{workLine(row)}</p>
        </div>
        {onClose && (
          <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <div className="sd-filepanel__body">
        {readable ? (
          <FileBody
            key={`${attemptId}/${file.path}/${hash}`}
            url={url}
            queryKey={[projectId, preview ? 'picture' : 'file', attemptId, file.path, hash]}
            item={{ path: file.path, hash: hash ?? file.hash, kind: file.kind }}
          />
        ) : (
          <p className="sd-meta">This file can't be shown here. Download it to look at the recorded file.</p>
        )}
      </div>
      {versions.length > 0 && (
        <section aria-label="Versions">
          <h3 className="sd-eyebrow">Versions</h3>
          <ol className="sd-filepanel__versions" aria-label={`Versions of ${file.path}`}>
            {versions.map((version, index) => (
              <PanelVersion
                key={`${version.attemptId}/${file.path}/${version.n}`}
                projectId={projectId}
                path={file.path}
                version={version}
                previous={readable && !imageFile(file.path) ? versions[index + 1] : undefined}
              />
            ))}
          </ol>
        </section>
      )}
      <footer className="sd-filepanel__actions">
        {file.libraryEntryId ? (
          <span className="sd-chip sd-chip--inline sd-chip--ok">In the library</span>
        ) : (
          <button type="button" className="sd-btn sd-btn--sm" onClick={() => onAdd(row)}>
            Add to the library
          </button>
        )}
        <a className="sd-btn sd-btn--sm" href={url} download>
          Download
        </a>
      </footer>
    </aside>
  );
}

function versionSource(projectId: string, path: string, version: WorkVersion): ComparisonTextSource {
  return {
    url: artifactUrl(projectId, version.attemptId, path),
    queryKey: [projectId, 'file', version.attemptId, path, version.hash],
    label: `Version ${version.n}`,
  };
}

function PanelVersion({
  projectId,
  path,
  version,
  previous,
}: {
  projectId: string;
  path: string;
  version: WorkVersion;
  previous: WorkVersion | undefined;
}) {
  const [open, setOpen] = useState(false),
    nameId = useId(),
    changesId = useId(),
    at = when(version.at);
  return (
    <li className="sd-filepanel__version" aria-labelledby={nameId}>
      <div className="sd-filepanel__version-head">
        <span
          className={`sd-filepanel__dot${version.current ? ' sd-filepanel__dot--current' : ''}`}
          aria-hidden="true"
        />
        <div className="sd-filepanel__name">
          <b id={nameId}>Version {version.n}</b>
          {at && version.at && (
            <time className="sd-meta" dateTime={version.at}>
              {at}
            </time>
          )}
          <span className="sd-meta">{versionWhy(version)}</span>
        </div>
        {previous && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            aria-label={`What changed in version ${version.n}`}
            aria-expanded={open}
            aria-controls={changesId}
            onClick={() => setOpen(!open)}
          >
            What changed
          </button>
        )}
      </div>
      {previous && (
        <div id={changesId} hidden={!open} style={{ minWidth: 0 }}>
          {open && (
            <VersionComparison
              earlier={versionSource(projectId, path, previous)}
              later={versionSource(projectId, path, version)}
            />
          )}
        </div>
      )}
    </li>
  );
}
