// Agents' proposals for the project's library (1.2 step 6), at the top of the Artifacts page: each proposal waiting for
// the director, with its name, what it is for, the agent who proposed it, the story it came from and whether it adds a
// new file or a newer revision of an entry. Add to the library approves it, Read it first opens the proposed file in a
// new tab, and Not now rejects it. A proposal approved that the library could not take reads as a plain note saying
// why, with nothing left to decide; the page also shows it on its file's row in the work, beside Add to the library.
// Library changes are not task changes on the stream, so each decision reads the library again, as does each library
// event the controller records. Today names what the autonomy policy added to the library today.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId } from 'react';
import {
  getJSON,
  libraryUrl,
  send,
  type LibraryEntry,
  type LibraryIndex,
  type LibraryProposal,
  type ProjectArtifact,
  type Shell,
  type Task,
  type WorkFile,
} from './api';
import { artifactUrl } from './files';
import { libraryKey } from './library';
import { workerName } from './names';
import { useLiveStream, useStreamReady } from './stream-context';
import { when } from './today';
import { useToast } from './toast';

// The library's index, the one the cards and the New idea box read: on each visit, and again when the controller
// records a library event, such as a proposal recorded or decided while the page is open. Only the index is read
// again, not each card's readers, and a read already under way serves.
export function useLibraryIndex(projectId: string) {
  const stream = useLiveStream(),
    client = useQueryClient();
  useEffect(
    () =>
      stream.subscribe({
        changes: message => {
          if (message.changes?.some(change => change.type === 'event' && change.kind?.startsWith('library_')))
            void client.invalidateQueries({ queryKey: libraryKey(projectId), exact: true }, { cancelRefetch: false });
        },
      }),
    [stream, client, projectId],
  );
  return useQuery({
    enabled: useStreamReady(),
    queryKey: libraryKey(projectId),
    queryFn: ({ signal }) => getJSON<LibraryIndex>(libraryUrl(projectId), signal),
    refetchOnMount: 'always',
  });
}

// The proposals the autonomy policy approved today, each now in the library, in the order they were recorded.
export const policyAddedToday = (library: LibraryIndex | undefined, now = new Date()) =>
  (library?.proposals ?? []).filter(
    proposal =>
      proposal.state === 'approved' &&
      proposal.decidedBy?.type === 'policy' &&
      !!proposal.decidedAt &&
      new Date(proposal.decidedAt).toDateString() === now.toDateString(),
  );

// The proposals the library could not take, in the order they were recorded.
export const refusedProposals = (library: LibraryIndex | undefined) =>
  (library?.proposals ?? []).filter(proposal => proposal.state === 'refused');

// Those proposing a file of the work: the same story and path, from its accepted attempt or one of its versions. The
// page reads them from the index LibraryProposals reads, so the library is read once.
export const refusedFor = (
  library: LibraryIndex | undefined,
  file: Pick<WorkFile, 'taskId' | 'path' | 'attemptId' | 'versions'>,
) =>
  refusedProposals(library).filter(
    ({ from }) =>
      from.taskId === file.taskId &&
      from.path === file.path &&
      (from.attemptId === file.attemptId || file.versions.some(version => version.attemptId === from.attemptId)),
  );

// A proposal the library could not take, as a plain note: its name and that the library could not take it, then its
// problem in the controller's words.
export function RefusedNote({ proposal }: { proposal: LibraryProposal }) {
  return (
    <span className="sd-meta" style={{ display: 'block', fontWeight: 400, overflowWrap: 'anywhere' }}>
      <span>{`The library could not take ${proposal.name}.`}</span>{' '}
      <span>{proposal.problem ?? 'The library gave no reason.'}</span>
    </span>
  );
}

// What the page knows to name an agent and a story by: the accepted files' stories and the project's records.
export interface ProposalNames {
  files?: ProjectArtifact[];
  records: (Pick<Shell, 'workers' | 'employeeDirectory'> & { tasks?: Task[] }) | null;
}
const storyOf = (proposal: LibraryProposal, { files, records }: ProposalNames) =>
  files?.find(file => file.taskId === proposal.from.taskId)?.title ??
  records?.tasks?.find(task => task.id === proposal.from.taskId)?.title ??
  proposal.from.taskId;

type Choice = 'approve' | 'reject';
const decisionUrl = (projectId: string, proposalId: string, choice: Choice) =>
  `${libraryUrl(projectId)}/proposals/${encodeURIComponent(proposalId)}/${choice}`;

export function LibraryProposals({ projectId, names }: { projectId: string; names: ProposalNames }) {
  const titleId = useId(),
    { data } = useLibraryIndex(projectId);
  // The library's own section says when the index is loading or could not be read; this one shows only proposals.
  const proposals = data?.proposals ?? [],
    waiting = proposals.filter(proposal => proposal.state === 'waiting'),
    refused = refusedProposals(data);
  if (!waiting.length && !refused.length) return null;
  return (
    <section aria-labelledby={titleId} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
        <h2 id={titleId} className="sd-section-title sd-section-title--sm">
          Proposed for the library
        </h2>
        {waiting.length > 0 && (
          <span className="sd-chip sd-chip--you">
            <span className="sd-chip__dot"></span>
            {waiting.length} waiting on you
          </span>
        )}
      </div>
      {waiting.length > 0 && (
        <>
          <p className="sd-meta" style={{ margin: 0 }}>
            Agents proposed these files from their accepted work. A file you add goes to every later attempt, read-only,
            with its name and what it is for.
          </p>
          {waiting.map(proposal => (
            <Proposal
              key={proposal.id}
              projectId={projectId}
              proposal={proposal}
              entries={data?.entries ?? []}
              names={names}
            />
          ))}
        </>
      )}
      {refused.length > 0 && (
        <div
          role="list"
          aria-label="Proposals the library could not take"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
        >
          {refused.map(proposal => (
            <div key={proposal.id} role="listitem">
              <RefusedNote proposal={proposal} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// One waiting proposal, named by its name, with the director's three choices. A decision keeps the choices disabled
// until the library has been read again, when a decided proposal leaves.
function Proposal({
  projectId,
  proposal,
  entries,
  names,
}: {
  projectId: string;
  proposal: LibraryProposal;
  entries: LibraryEntry[];
  names: ProposalNames;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    nameId = useId();
  const decide = useMutation({
    mutationFn: (choice: Choice) => send<LibraryProposal>(decisionUrl(projectId, proposal.id, choice), { projectId }),
    onSuccess: (answer, choice) =>
      toast(
        choice === 'reject'
          ? `Not now: ${proposal.name} stays out of the library.`
          : answer?.state === 'refused'
            ? `The library could not take ${proposal.name}.`
            : `Added ${proposal.name} to the library.`,
      ),
    onError: failure => toast(failure.message),
    onSettled: () => client.invalidateQueries({ queryKey: libraryKey(projectId), exact: true }),
  });
  const busy = decide.isPending,
    revising = proposal.entryId && (entries.find(entry => entry.id === proposal.entryId)?.name ?? proposal.entryId);
  return (
    <article
      className="sd-card"
      aria-labelledby={nameId}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', padding: 'var(--space-16) 18px' }}
    >
      <span id={nameId} style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
        {proposal.name}
      </span>
      <span style={{ color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{proposal.purpose}</span>
      <span className="sd-meta" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
        <span>{revising ? `A newer revision of ${revising}` : 'A new library file'}</span>
        <span aria-hidden="true">·</span>
        <span>Proposed by {workerName(names.records, proposal.proposedBy)}</span>
        <span aria-hidden="true">·</span>
        <span>
          From{' '}
          <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: proposal.from.taskId }}>
            {storyOf(proposal, names)}
          </Link>
        </span>
        <span aria-hidden="true">·</span>
        <time dateTime={proposal.at}>{when(proposal.at)}</time>
      </span>
      <span className="sd-mono sd-meta" style={{ overflowWrap: 'anywhere' }}>
        {proposal.from.path}
      </span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--primary"
          disabled={busy}
          onClick={() => decide.mutate('approve')}
        >
          {busy && decide.variables === 'approve' ? 'Adding…' : 'Add to the library'}
        </button>
        <a
          className="sd-btn sd-btn--sm"
          href={artifactUrl(projectId, proposal.from.attemptId, proposal.from.path)}
          target="_blank"
          rel="noreferrer"
        >
          Read it first
        </a>
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--ghost"
          disabled={busy}
          onClick={() => decide.mutate('reject')}
        >
          Not now
        </button>
      </span>
    </article>
  );
}
