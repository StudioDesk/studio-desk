// Artifacts (1.2 step 6): every file the project's accepted work handed back, newest first, each with its kind, the
// agent who made it, the idea it came from, when it was accepted and Open, which opens the file in a new tab. Filters
// for idea, agent and kind narrow the list, and each file can be added to the project's library, which sits at the top,
// above the files, after the files agents proposed for it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { artifactsUrl, getJSON, type ProjectArtifact } from './api';
import { artifactRows, choices, facets, matching, type ArtifactFilter, type Facet } from './artifacts';
import { artifactUrl } from './files';
import { Heading } from './layout';
import { AddToLibrary, Library } from './library';
import { LibraryProposals } from './library-proposals';
import { useStudio } from './records';
import { useLiveStream, useStreamReady } from './stream-context';
import { when } from './today';

const filterWords: Record<Facet, { label: string; every: string }> = {
  idea: { label: 'Idea', every: 'Every idea' },
  agent: { label: 'Agent', every: 'Every agent' },
  kind: { label: 'Kind', every: 'Every kind' },
};
const files = (count: number) => `${count} file${count === 1 ? '' : 's'}`;

export function ArtifactsPage({ projectId }: { projectId: string }) {
  const { state, error: recordsError } = useStudio(projectId),
    stream = useLiveStream(),
    client = useQueryClient(),
    [filter, setFilter] = useState<ArtifactFilter>({}),
    [adding, setAdding] = useState<ProjectArtifact | null>(null);
  // Read on each visit, since work accepted while the page was away adds files.
  const { data, error } = useQuery({
    enabled: useStreamReady(),
    queryKey: [projectId, 'artifacts'],
    queryFn: ({ signal }) => getJSON<ProjectArtifact[]>(artifactsUrl(projectId), signal),
    refetchOnMount: 'always',
  });
  // Work accepted while the page is open changes its task; the listing is read again then.
  useEffect(
    () =>
      stream.subscribe({
        changes: message => {
          if (message.changes?.some(change => change.type === 'task'))
            void client.invalidateQueries({ queryKey: [projectId, 'artifacts'] });
        },
      }),
    [stream, client, projectId],
  );
  // Agents' proposals and the library stay pinned at the top whatever the listing's state, and name their accepted
  // files' stories from it.
  const top = (
    <>
      <Heading title="Artifacts" lead="Every file the project's accepted work handed back, newest first." />
      <LibraryProposals projectId={projectId} names={{ files: data, records: state }} />
      <Library projectId={projectId} names={{ files: data, records: state }} />
    </>
  );
  if (error)
    return (
      <>
        {top}
        <p role="alert">The accepted files could not be loaded: {error.message}</p>
      </>
    );
  // Agents' names and ideas' words come from the project's records, so the list waits for them unless they fail.
  if (!data || (!state && !recordsError))
    return (
      <>
        {top}
        <p role="status" className="sd-meta">
          Loading the accepted files…
        </p>
      </>
    );
  const rows = artifactRows(data, state),
    shown = matching(rows, filter),
    filtered = facets.some(facet => filter[facet]);
  return (
    <>
      {top}
      <section aria-labelledby="accepted-files" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
          <h2 id="accepted-files" className="sd-section-title sd-section-title--sm">
            Accepted files
          </h2>
          {rows.length > 0 && (
            <span className="sd-meta">
              {filtered ? `${shown.length} of ${files(rows.length)}` : files(rows.length)}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <div className="sd-card sd-empty">
            <b>No accepted work has handed back files yet.</b>
            <span>Each file an agent hands back shows here once its work is accepted.</span>
          </div>
        ) : (
          <>
            <div className="sd-toolbar" role="group" aria-label="Filter the files">
              {facets.map(facet => (
                <label key={facet} className="sd-filter sd-relfilter">
                  <span>{filterWords[facet].label}</span>
                  <select
                    value={filter[facet] ?? ''}
                    onChange={event => {
                      const value = event.target.value;
                      setFilter(current => ({ ...current, [facet]: value || undefined }));
                    }}
                  >
                    <option value="">{filterWords[facet].every}</option>
                    {choices(rows, facet).map(choice => (
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
              <div className="sd-card sd-cardlist" role="list" aria-label="Accepted files">
                {shown.map(row => (
                  <div key={row.key} role="listitem" className="sd-cardlist__row sd-cardlist__row--line">
                    <span
                      className="sd-cardlist__label"
                      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', padding: '10px 0' }}
                    >
                      <span className="sd-mono" style={{ overflowWrap: 'anywhere' }}>
                        {row.file.path}
                      </span>
                      <span className="sd-cardlist__meta sd-meta" style={{ fontWeight: 400 }}>
                        <span>{row.kind.label}</span>
                        <span aria-hidden="true">·</span>
                        <span>{row.agent.label}</span>
                        <span aria-hidden="true">·</span>
                        <span>{row.idea.label}</span>
                        {row.file.acceptedAt && (
                          <>
                            <span aria-hidden="true">·</span>
                            <time dateTime={row.file.acceptedAt}>{when(row.file.acceptedAt)}</time>
                          </>
                        )}
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
                      <button
                        type="button"
                        className="sd-btn sd-btn--sm"
                        aria-label={`Add ${row.file.path} to the library`}
                        onClick={() => setAdding(row.file)}
                      >
                        Add to the library
                      </button>
                      <a
                        className="sd-btn sd-btn--sm"
                        href={artifactUrl(projectId, row.file.attemptId, row.file.path)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${row.file.path}`}
                      >
                        Open
                      </a>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sd-card sd-empty">No file matches these filters.</div>
            )}
          </>
        )}
      </section>
      <AddToLibrary projectId={projectId} file={adding} onClose={() => setAdding(null)} />
    </>
  );
}
