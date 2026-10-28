// A measured test run's whole record, read-only (src/connectors/test-records.mjs): the tests that failed and the
// totals first, then everything the run printed, to read in place or download. It reads nothing until the director
// opens it, and only the text once the summary says the run kept a record. Nothing in it changes a record. The
// attempt's record opens its checks or candidate tests, and a story's integration journal its merge; an editor's own
// test runs can open theirs here once their output is saved.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getJSON, testRecordUrl, type TestRecordRun, type TestRecordSummary } from './api';
import { queryKeys } from './records';

const titles: Record<TestRecordRun, string> = {
  attempt: "The tests' whole record",
  merge: "The merge's whole test record",
};

const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// How a run's totals read: what passed of all, what failed, and anything cancelled, skipped or left to do.
export const totalsWords = (totals: NonNullable<Extract<TestRecordSummary, { recorded: true }>['totals']>) =>
  [
    `${totals.pass}/${totals.tests} passed`,
    `${totals.fail} failed`,
    totals.cancelled ? `${totals.cancelled} cancelled` : '',
    totals.skipped ? `${totals.skipped} skipped` : '',
    totals.todo ? `${totals.todo} todo` : '',
  ]
    .filter(Boolean)
    .join(', ');

async function getText(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || `The controller refused the request (${response.status}).`);
  }
  return response.text();
}

const failure = (text: string) => (
  <p className="sd-meta" role="status" style={{ margin: 0, color: 'var(--bad)' }}>
    {text}
  </p>
);
const loading = (text: string) => (
  <p className="sd-meta" role="status" style={{ margin: 0 }}>
    {text}
  </p>
);

function RecordBody({ projectId, attemptId, run }: { projectId: string; attemptId: string; run: TestRecordRun }) {
  const summary = useQuery({
      queryKey: queryKeys.testRecord(projectId, attemptId, run),
      queryFn: ({ signal }) => getJSON<TestRecordSummary>(testRecordUrl(projectId, attemptId, run), signal),
      staleTime: Infinity,
    }),
    record = summary.data?.recorded ? summary.data : undefined,
    text = useQuery({
      enabled: !!record,
      queryKey: queryKeys.testRecord(projectId, attemptId, run, true),
      queryFn: ({ signal }) => getText(testRecordUrl(projectId, attemptId, run, true), signal),
      staleTime: Infinity,
    });
  if (summary.error) return failure(`The whole record could not be loaded: ${summary.error.message}`);
  if (!summary.data) return loading('Loading the whole record…');
  if (!record)
    return (
      <p className="sd-meta" style={{ margin: 0 }}>
        This run has no whole record: it ran before Studio desk kept them, or stopped before its tests started.
      </p>
    );
  const download = testRecordUrl(projectId, attemptId, run, true);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', minWidth: 0 }}>
      {record.failedTests.length > 0 && (
        <>
          <span className="sd-eyebrow">Failed tests</span>
          <ul aria-label="Failed tests" style={{ margin: 0, paddingLeft: 'var(--space-16)', overflowWrap: 'anywhere' }}>
            {record.failedTests.map((test, at) => (
              <li key={at}>
                <b>{test.name}</b>
                {test.file && <span className="sd-mono"> · {test.file}</span>}
                {test.error && <span>: {test.error}</span>}
              </li>
            ))}
          </ul>
          {(record.totals?.fail ?? 0) > record.failedTests.length && (
            <span className="sd-meta">
              And {record.totals!.fail - record.failedTests.length} more failed; the whole output names them.
            </span>
          )}
        </>
      )}
      <p style={{ margin: 0 }}>
        <b>{record.totals ? totalsWords(record.totals) : 'Stopped before reporting totals'}</b>
      </p>
      {record.limited && (
        <p className="sd-meta" style={{ margin: 0 }}>
          This record stops at its 64 MB limit: the run printed more than Studio desk keeps.
        </p>
      )}
      <div className="sd-readfile__head">
        <span className="sd-eyebrow">The whole output · {size(record.bytes)}</span>
        <a
          className="sd-btn sd-btn--sm"
          href={download}
          download={`${attemptId}-${run}-tests.txt`}
          aria-label="Download the whole output"
        >
          Download
        </a>
      </div>
      {text.error ? (
        failure(`The whole output could not be loaded: ${text.error.message} Download it to read the record.`)
      ) : text.data === undefined ? (
        loading('Loading the whole output…')
      ) : (
        <pre className="sd-code sd-code--block" aria-label="The whole output">
          {text.data}
        </pre>
      )}
    </div>
  );
}

// The run's whole record behind a closed disclosure; its body, and so every read, starts when it is first opened.
export function WholeTestRecord({
  projectId,
  attemptId,
  run,
}: {
  projectId: string;
  attemptId: string;
  run: TestRecordRun;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="sd-disclosure" onToggle={event => event.currentTarget.open && setOpened(true)}>
      <summary>{titles[run]}</summary>
      {opened && <RecordBody projectId={projectId} attemptId={attemptId} run={run} />}
    </details>
  );
}
