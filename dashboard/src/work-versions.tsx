// A file's versions on the Artifacts page (1.2 step 6), opened from "3 versions" on its row of The work: each version
// newest first with its number, when it was made, why, Open on that version's file and, for text, What changed against
// the version before. What changed reads both versions through the artifact route, which answers only while a file's
// bytes match its recorded hash, and compares their lines with line-diff.ts. A picture's version has Open and no
// comparison.
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { getText, type WorkFile, type WorkVersion } from './api';
import { versionWhy } from './artifacts';
import { artifactUrl, imageFile } from './files';
import { lineDiff, type LineDiff } from './line-diff';
import { when } from './today';

const linesCounted = (count: number) => `${count} line${count === 1 ? '' : 's'}`;
// What changed lists at most this many lines, so a large change does not slow the page.
const changesShown = 400;

// The versions newest first, by number, as the controller lists them.
export function WorkVersions({ projectId, file }: { projectId: string; file: Pick<WorkFile, 'path' | 'versions'> }) {
  const versions = [...file.versions].sort((a, b) => b.n - a.n),
    picture = imageFile(file.path);
  return (
    <ol
      aria-label={`Versions of ${file.path}`}
      className="sd-work-versions"
      style={{
        minWidth: 0,
        listStyle: 'none',
        margin: 0,
        padding: '0 0 var(--space-10)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-8)',
      }}
    >
      {versions.map((version, index) => (
        <Version
          key={version.n}
          projectId={projectId}
          path={file.path}
          version={version}
          previous={picture ? undefined : versions[index + 1]}
        />
      ))}
    </ol>
  );
}

// One version: Version 3, its date and why, What changed when there is a version before it to compare, and Open.
function Version({
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
    <li
      aria-labelledby={nameId}
      className="sd-card"
      style={{
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-8)',
        padding: 'var(--space-10)',
      }}
    >
      <span style={{ minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)' }}>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <span className="sd-cardlist__meta">
            <span id={nameId} style={{ fontWeight: 600 }}>{`Version ${version.n}`}</span>
            {at && version.at && (
              <time className="sd-meta" dateTime={version.at}>
                {at}
              </time>
            )}
          </span>
          <span className="sd-meta" style={{ overflowWrap: 'anywhere' }}>
            {versionWhy(version)}
          </span>
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
          {previous && (
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              aria-expanded={open}
              aria-controls={changesId}
              aria-label={`What changed in version ${version.n}`}
              onClick={() => setOpen(!open)}
            >
              What changed
            </button>
          )}
          <a
            className="sd-btn sd-btn--sm"
            href={artifactUrl(projectId, version.attemptId, path)}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open version ${version.n} of ${path}`}
          >
            Open
          </a>
        </span>
      </span>
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

export interface ComparisonTextSource {
  url: string;
  queryKey: QueryKey;
  label: string;
}

// Work files retain the same cache identity as the file readers: attempt, path and recorded hash.
function versionSource(projectId: string, path: string, version: WorkVersion): ComparisonTextSource {
  return {
    url: artifactUrl(projectId, version.attemptId, path),
    queryKey: [projectId, 'file', version.attemptId, path, version.hash],
    label: `Version ${version.n}`,
  };
}

function useComparisonText(source: ComparisonTextSource) {
  return useQuery({
    queryKey: source.queryKey,
    queryFn: ({ signal }) => getText(source.url, signal),
    staleTime: Infinity,
  });
}

// What changed for any two recorded text sources, including work versions and library revisions.
export function VersionComparison({ earlier, later }: { earlier: ComparisonTextSource; later: ComparisonTextSource }) {
  const before = useComparisonText(earlier),
    after = useComparisonText(later);
  const diff = useMemo(
    () => (before.data === undefined || after.data === undefined ? null : lineDiff(before.data, after.data)),
    [before.data, after.data],
  );
  const failed = before.error
    ? { label: earlier.label, error: before.error }
    : after.error
      ? { label: later.label, error: after.error }
      : null;
  if (failed)
    return (
      <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)', overflowWrap: 'anywhere' }}>
        {`${failed.label} could not be read: ${failed.error.message}`}
      </p>
    );
  if (!diff)
    return (
      <p role="status" className="sd-meta" style={{ margin: 0 }}>
        {`Reading ${readingLabels(earlier.label, later.label)}…`}
      </p>
    );
  return <ChangedLines diff={diff} earlier={earlier.label} later={later.label} />;
}

// Keep "Reading versions 2 and 1…" (or "revisions") for numbered labels; other labels read in full.
function readingLabels(earlier: string, later: string) {
  const before = /^(.*) (\d+)$/.exec(earlier),
    after = /^(.*) (\d+)$/.exec(later);
  return before && after && before[1] === after[1]
    ? `${after[1]!.toLowerCase()}s ${after[2]} and ${before[2]}`
    : `${later.toLowerCase()} and ${earlier.toLowerCase()}`;
}

// The lines removed and added, each with its line number in the version before or in this one, in reading order, as
// the source diff marks them.
function ChangedLines({ diff, earlier, later }: { diff: LineDiff; earlier: string; later: string }) {
  let before = 0,
    after = 0;
  const lines = diff.rows.flatMap(row => {
    if (row.type !== 'added') before++;
    if (row.type !== 'removed') after++;
    return row.type === 'same' ? [] : [{ row, line: row.type === 'added' ? after : before }];
  });
  if (lines.length === 0)
    return (
      <p className="sd-meta" style={{ margin: 0 }}>
        {`The same lines as ${earlier.toLowerCase()}.`}
      </p>
    );
  return (
    <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <span className="sd-meta">
        {`Against ${earlier.toLowerCase()}: ${linesCounted(diff.added)} added, ${linesCounted(diff.removed)} removed`}
      </span>
      {!diff.exact && (
        <span className="sd-meta">
          Too much changed to match line by line, so the changed part reads as removed, then added.
        </span>
      )}
      <div
        className="sd-code sd-code--wrap"
        role="list"
        aria-label={`Lines added and removed in ${later.toLowerCase()}`}
        style={{ minWidth: 0, maxHeight: '320px', overflow: 'auto' }}
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
    </div>
  );
}
