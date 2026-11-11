// Releases in a code project's Settings: the offer to give each version its own line. Until the project switches,
// it says what that does, the branch releases will ship to and what the switch needs first, each need met or not, and
// asks before switching (POST version-lines). Once switched, it says where releases ship and points to the Releases
// page. It reads the same releases overview the Releases page does (queryKeys.releases), and the controller decides
// whether the switch is allowed: a refusal is shown in its words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { getJSON, releasesUrl, send, versionLinesUrl, type Milestone, type ReleaseOverview } from './api';
import { Dialog } from './design/dialog';
import { queryKeys } from './records';
import { useStreamReady } from './stream-context';
import { useToast } from './toast';

export const versionLinesWords =
  'Each version gets a line of its own, made from the one before, and new work lands on the lowest open version. The branch releases ship to moves only when a release ships, so it always holds the newest release.';

// The lines the switch makes, in version order: each open version not yet on a line of its own (the overview names
// the branch releases are made on for those) gets release/<major>.<minor>, the first made from that branch and each
// next one from the line before.
export function linesToMake(milestones: Milestone[], shipsTo: string) {
  const branches: string[] = [];
  for (const milestone of milestones) {
    if (milestone.state !== 'open' || milestone.line !== shipsTo) continue;
    const [major, minor] = milestone.version.split('.');
    const branch = `release/${major}.${minor}`;
    if (!branches.includes(branch)) branches.push(branch);
  }
  return branches.map((branch, index) => ({ branch, from: index ? branches[index - 1]! : shipsTo }));
}

function Need({ met, children }: { met: boolean; children: ReactNode }) {
  return (
    <>
      <span className={`sd-chip ${met ? 'sd-chip--ok' : 'sd-chip--you'}`}>
        <span className="sd-chip__dot"></span>
        {met ? 'Done' : 'Still needed'}
      </span>
      {children}
    </>
  );
}

function ReleasesLink({ projectId, children }: { projectId: string; children: ReactNode }) {
  return (
    <Link className="sd-btn sd-btn--sm" to="/p/$projectId/releases" params={{ projectId }}>
      {children}
    </Link>
  );
}

function Switched({ projectId, shipsTo }: { projectId: string; shipsTo: string }) {
  return (
    <>
      <p style={{ margin: 0 }}>
        Releases ship to <span className="sd-file">{shipsTo}</span>, and each version has its own line.
      </p>
      <div>
        <ReleasesLink projectId={projectId}>Open the Releases page</ReleasesLink>
      </div>
    </>
  );
}

export function ReleaseSettings({ projectId }: { projectId: string }) {
  const ready = useStreamReady(),
    client = useQueryClient(),
    toast = useToast(),
    [asking, setAsking] = useState(false);
  const { data, error } = useQuery({
    queryKey: queryKeys.releases(projectId),
    queryFn: ({ signal }) => getJSON<ReleaseOverview>(releasesUrl(projectId), signal),
    enabled: ready,
  });
  const change = useMutation({
    mutationFn: (shipsTo: string) => send(versionLinesUrl(projectId), { projectId, shipsTo }),
    onSuccess: (_, shipsTo) => {
      toast(`Each version now has its own line, and releases ship to ${shipsTo}.`);
      setAsking(false);
      return client.invalidateQueries({ queryKey: queryKeys.releases(projectId) });
    },
  });
  // Each asking starts without the last refusal; closing keeps a switch's success, which the section shows.
  const ask = () => {
    change.reset();
    setAsking(true);
  };
  const close = () => setAsking(false);
  if (error)
    return (
      <p role="alert" style={{ margin: 0 }}>
        The releases could not be read: {error.message}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="sd-meta" style={{ margin: 0 }}>
        Reading the releases…
      </p>
    );
  if (!data.available)
    return (
      <p className="sd-meta" style={{ margin: 0 }}>
        {data.reason}
      </p>
    );
  if (data.shipsTo) return <Switched projectId={projectId} shipsTo={data.shipsTo.branch} />;
  // Switched just now, before the releases are read again.
  if (change.isSuccess) return <Switched projectId={projectId} shipsTo={change.variables} />;
  const lines = data.versionLines;
  if (!lines) return null;
  const shipsTo = lines.shipsTo,
    next = !lines.needs.some(need => need.kind === 'next-version'),
    work = lines.needs.find(need => need.kind === 'open-work'),
    making = shipsTo ? linesToMake(data.milestones ?? [], shipsTo) : [],
    allowed = lines.ready && !!shipsTo;
  return (
    <>
      <p style={{ margin: 0 }}>{versionLinesWords}</p>
      <dl className="sd-kv sd-kv--chips">
        <dt>Releases will ship to</dt>
        <dd>{shipsTo ? <span className="sd-file">{shipsTo}</span> : <span>No branch is checked out yet</span>}</dd>
        <dt>An open next version</dt>
        <dd>
          <Need met={next}>
            {!next && <ReleasesLink projectId={projectId}>Make one on the Releases page</ReleasesLink>}
          </Need>
        </dd>
        <dt>No open work on {shipsTo ?? 'that branch'}</dt>
        <dd>
          <Need met={!work}>
            {work && (
              <>
                <span>
                  {work.count} open:{' '}
                  {work.tasks.map((task, index) => (
                    <span key={task.id}>
                      {index > 0 && ', '}
                      <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }}>
                        {task.title}
                      </Link>
                    </span>
                  ))}
                </span>
                {work.count > work.tasks.length && (
                  <span className="sd-meta">and {work.count - work.tasks.length} more</span>
                )}
              </>
            )}
          </Need>
        </dd>
      </dl>
      <div>
        <button type="button" className="sd-btn sd-btn--primary" disabled={!allowed} onClick={ask}>
          Give each version its own line…
        </button>
      </div>
      <Dialog open={asking} label="Give each version its own line" busy={change.isPending} onClose={close}>
        <h2 className="sd-dialog__title">Give each version its own line?</h2>
        <p>
          Releases will ship to <span className="sd-file">{shipsTo}</span>, which then moves only when a release ships.
        </p>
        {making.length > 0 && (
          <>
            <p style={{ margin: 0 }}>The lines it makes:</p>
            <ul style={{ margin: 0, paddingLeft: '18px' }}>
              {making.map(line => (
                <li key={line.branch}>
                  <span className="sd-file">{line.branch}</span> from <span className="sd-file">{line.from}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {change.error && (
          <p role="alert" style={{ margin: 0, color: 'var(--bad)', fontWeight: 600 }}>
            {change.error.message}
          </p>
        )}
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            disabled={change.isPending || !shipsTo}
            onClick={() => shipsTo && change.mutate(shipsTo)}
          >
            {change.isPending ? 'Switching…' : 'Switch'}
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" disabled={change.isPending} onClick={close}>
            Not now
          </button>
        </div>
      </Dialog>
    </>
  );
}
