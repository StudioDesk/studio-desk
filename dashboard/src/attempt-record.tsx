// One attempt's record (app-dialogs.js renderTaskModal's attempt section, planReview and app-core.js
// phaseTimeline): what it received from earlier steps, its phases, the configuration it ran with and its complete
// result, for the Record tab; and the parts the Result tab shows. The full record is read once for the attempt
// shown and again only when that attempt or its phases change.
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getJSON, taskUrl, type AttemptSummary, type Task, type TaskPage } from './api';
import { effortWords } from './evidence';
import { FileActions, FileText, readableFile } from './files';
import { workerName } from './names';
import { queryKeys } from './records';
import { cliName } from './story';
import type { StudioState } from './studio-runs';

interface PhaseEvent {
  attempt_id: string;
  task_id: string;
  payload?: {
    schemaVersion?: string;
    attemptId?: string;
    taskId?: string;
    occurrenceId?: string;
    phaseId: string;
    integrationOccurrenceId?: string;
    integrationId?: string;
    boundary?: 'start' | 'finish';
    timestamp?: string;
    durationMs?: number;
    outcome?: string;
    timing?: string;
    error?: string;
    totals?: { pass: number; fail: number; cancelled: number; tests: number; skipped?: number; todo?: number };
  };
}
interface InputReference {
  taskId?: string;
  attemptId?: string;
  summary?: unknown;
  artifacts?: { path: string; hash: string; kind: string }[];
}
export interface FullAttempt extends AttemptSummary {
  phaseEvents?: PhaseEvent[];
  instructions?: { hash?: string; text?: string };
  delivery?: string;
  sessionId?: string;
  outputFolder?: string;
  inputReferences?: InputReference[];
  plan?: {
    summary: string;
    assumptions: string[];
    directorDecisions: string[];
    tasks: {
      key: string;
      title: string;
      workerId: string;
      brief: string;
      acceptance: string;
      dependencies: string[];
      acceptedInputs?: string[];
      maxSeconds: number;
      maxAttempts: number;
      resources: string[];
    }[];
  };
  planBudget?: { tasks: number; totalAttemptSeconds: number };
  planContext?: { workers: { id: string; name: string; team: string; provider: string; model?: string }[] };
  integration?: {
    state?: string;
    leaseToken?: unknown;
    checkpoint?: unknown;
    operations?: { kind: string; status: string }[];
  };
  // Tests a code-editing agent ran on its edits through the controller (v1.0 item 22).
  employeeTestRuns?: {
    startedAt?: string;
    files?: string[];
    exitCode?: number | null;
    totals?: { pass: number; fail: number; tests: number } | null;
  }[];
}

export function useAttemptDetail(projectId: string, attemptId: string, enabled = true) {
  return useQuery({
    enabled: enabled && !!attemptId,
    queryKey: queryKeys.attempt(projectId, attemptId),
    queryFn: ({ signal }) =>
      getJSON<FullAttempt>(
        `/api/attempts/${encodeURIComponent(attemptId)}?projectId=${encodeURIComponent(projectId)}`,
        signal,
      ),
  });
}

const phaseNames: Record<string, string> = {
  attempt: 'Attempt execution',
  'source.edit': 'Source editing',
  install: 'Installing packages',
  'candidate.commit': 'Candidate commit',
  test: 'Tests',
  'integration.prepare': 'Integration preparation',
  'integration.merge': 'Integration merge',
  'integration.format': 'Integration formatting',
  'integration.verification': 'Integration verification',
  'integration.commit': 'Integration commit',
  'integration.fast-forward': 'Integration fast-forward',
};

export function phaseDuration(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'Duration unavailable';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60
    ? `${(milliseconds / 1000).toFixed(1).replace(/\.0$/, '')}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

type Phase = { phaseId: string; start?: PhaseEvent['payload']; finish?: PhaseEvent['payload'] };

// Only structured, attempt-owned observations describe phases; log lines are never a timing source.
function attemptPhases(attempt: FullAttempt): Phase[] {
  const occurrences = new Map<string, Phase>();
  for (const event of attempt.phaseEvents ?? []) {
    const p = event.payload;
    if (
      p?.schemaVersion !== 'source-phase-v1' ||
      p.attemptId !== attempt.id ||
      p.taskId !== attempt.taskId ||
      event.attempt_id !== attempt.id ||
      event.task_id !== attempt.taskId ||
      !p.occurrenceId ||
      !p.boundary
    )
      continue;
    const key = JSON.stringify([p.occurrenceId, p.phaseId, p.integrationOccurrenceId]);
    if (!occurrences.has(key)) occurrences.set(key, { phaseId: p.phaseId });
    occurrences.get(key)![p.boundary] = p;
  }
  return [...occurrences.values()];
}

function phaseIsActive(attempt: FullAttempt, phase: Phase, phases: Phase[]) {
  if (!phase.start || phase.finish) return false;
  const p = phase.start;
  if (p.phaseId.startsWith('integration.')) {
    // A review's execution has finished when integration begins; its journal names the occurrence still working.
    const journal = attempt.sourceIntegration as
      | { state?: string; finishedAt?: string; phaseOccurrenceId?: string; id?: string; reviewAttemptId?: string }
      | null
      | undefined;
    return (
      journal?.state === 'verifying' &&
      !journal.finishedAt &&
      journal.phaseOccurrenceId === p.integrationOccurrenceId &&
      journal.id === p.integrationId &&
      journal.reviewAttemptId === attempt.id
    );
  }
  return (
    ['running', 'stopping'].includes(attempt.status) &&
    !attempt.finishedAt &&
    !phases.some(item => item.phaseId === 'attempt' && item.finish)
  );
}

// Whether the controller recorded any phase of the attempt.
export const recordedPhases = (attempt: FullAttempt) => attemptPhases(attempt).length > 0;

// The innermost source phase still open on a running attempt, such as 'source.edit' or 'test'.
export function openPhase(attempt?: FullAttempt) {
  if (!attempt) return null;
  const phases = attemptPhases(attempt);
  return (
    phases.filter(phase => phase.phaseId !== 'attempt' && phaseIsActive(attempt, phase, phases)).at(-1)?.phaseId ?? null
  );
}

// Where an attempt's time went, from its finished source phases: each phase's name and milliseconds.
export function phaseTimes(attempt?: FullAttempt) {
  if (!attempt) return [];
  return attemptPhases(attempt)
    .filter(phase => phase.phaseId !== 'attempt' && !phase.phaseId.startsWith('integration.'))
    .map(phase => ({ phaseId: phase.phaseId, ms: phase.finish?.durationMs ?? NaN }))
    .filter(phase => Number.isFinite(phase.ms) && phase.ms >= 0);
}

const outcomes: Record<string, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
const timings: Record<string, string> = {
  'process-group-unconfirmed': 'Process stop unconfirmed.',
  'observed-until-restart': 'Observed until restart; process stop unconfirmed.',
  'shutdown-requested': 'Shutdown requested; completion unconfirmed.',
};

export function PhaseTimeline({ attempt }: { attempt: FullAttempt }) {
  const phases = attemptPhases(attempt),
    working = phases.some(phase => phaseIsActive(attempt, phase, phases)),
    [now, setNow] = useState(() => Date.now());
  // A phase still in progress shows its elapsed time, counted each second while it runs.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working]);
  if (!phases.length)
    return (
      <p className="sd-meta" style={{ margin: 0 }}>
        No phases were recorded for this attempt.
      </p>
    );
  return (
    <ol className="sd-phases">
      {phases.map((phase, index) => {
        const { start, finish } = phase,
          date = start?.timestamp ? new Date(start.timestamp) : null,
          valid = !!date && Number.isFinite(date.getTime()),
          live = phaseIsActive(attempt, phase, phases),
          totals = finish?.totals,
          tests = totals
            ? `Tests: ${totals.pass} passed, ${totals.fail} failed, ${totals.cancelled} cancelled of ${totals.tests}${totals.skipped ? `; ${totals.skipped} skipped` : ''}${totals.todo ? `; ${totals.todo} todo` : ''}.`
            : '',
          evidence = [tests, timings[finish?.timing ?? ''] ?? '', finish?.error ?? ''].filter(Boolean).join(' ');
        return (
          <li key={index}>
            <span className="sd-phases__name">{phaseNames[phase.phaseId] ?? phase.phaseId}</span>
            <span className="sd-phases__time">
              {finish
                ? phaseDuration(finish.durationMs ?? NaN)
                : live && valid
                  ? `${phaseDuration(Math.max(0, now - date!.getTime()))} elapsed`
                  : 'Duration unavailable'}
            </span>
            <span className="sd-phases__detail">
              {valid ? <time dateTime={start!.timestamp}>{date!.toLocaleString()}</time> : 'Start time unavailable'}
              {' · '}
              {finish
                ? (outcomes[finish.outcome ?? ''] ?? 'Outcome unavailable')
                : live
                  ? 'In progress'
                  : 'Terminal timing unavailable'}
            </span>
            {evidence && <span className="sd-phases__detail">{evidence}</span>}
          </li>
        );
      })}
    </ol>
  );
}

// The attempt's execution time: its own observation, never the sum of its phases or time waiting for the
// director (app-core.js runExecutionTime).
export function executionTime(attempt: AttemptSummary, now = Date.now()) {
  const timing = attempt.executionTiming as
    | { durationMs: number | null; activeStart: string | null; completionUnconfirmed?: boolean }
    | undefined;
  const between = (start?: string | null, finish?: string | null) => {
    const milliseconds = Date.parse(String(finish)) - Date.parse(String(start));
    return start && finish && Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : NaN;
  };
  if (timing) {
    const label = (duration: number) =>
      `${phaseDuration(duration)}${timing.completionUnconfirmed ? ' observed; completion unconfirmed' : ''}`;
    if (Number.isFinite(timing.durationMs) && (timing.durationMs ?? -1) >= 0) return label(timing.durationMs!);
    const recorded = between(attempt.startedAt, attempt.finishedAt);
    if (Number.isFinite(recorded)) return label(recorded);
    const elapsed = now - Date.parse(String(timing.activeStart));
    if (timing.activeStart && Number.isFinite(elapsed) && elapsed >= 0) return `${phaseDuration(elapsed)} elapsed`;
    return 'Timing unavailable';
  }
  const recorded = between(attempt.startedAt, attempt.finishedAt);
  if (Number.isFinite(recorded)) return phaseDuration(recorded);
  const elapsed = now - Date.parse(String(attempt.startedAt));
  if (
    !attempt.finishedAt &&
    ['running', 'stopping'].includes(attempt.status) &&
    Number.isFinite(elapsed) &&
    elapsed >= 0
  )
    return `${phaseDuration(elapsed)} elapsed`;
  return 'Timing unavailable';
}

// What the attempt received from earlier steps: each producer's summary and the files it pinned, resolved
// against that producer's registered files by index, name, hash and kind.
function ReceivedInputs({
  projectId,
  studio,
  attempt,
}: {
  projectId: string;
  studio: StudioState;
  attempt: FullAttempt;
}) {
  const references = attempt.inputReferences ?? [],
    held = (reference: InputReference) =>
      studio.attempts.some(item => item.id === reference.attemptId && item.taskId === reference.taskId),
    // A producer the page does not hold (settled work, as most inputs are) is read with its task.
    missing = [
      ...new Set(references.filter(item => item.attemptId && item.taskId && !held(item)).map(item => item.taskId!)),
    ],
    pages = useQueries({
      queries: missing.map(taskId => ({
        queryKey: queryKeys.task(projectId, taskId),
        queryFn: ({ signal }: { signal: AbortSignal }) => getJSON<TaskPage>(taskUrl(projectId, taskId), signal),
      })),
    }),
    attempts = [...studio.attempts, ...pages.flatMap(page => page.data?.attempts ?? [])],
    tasks = [...studio.tasks, ...pages.flatMap(page => (page.data?.task ? [page.data.task] : []))];
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-10)', minWidth: 0 }}>
      <span className="sd-eyebrow">Received from previous steps</span>
      {references.length ? (
        references.map((reference, index) => {
          const synthetic = !reference.attemptId && !!reference.taskId?.startsWith('transform:'),
            producer = attempts.find(
              item =>
                item.id === reference.attemptId &&
                item.taskId === reference.taskId &&
                (!item.projectId || item.projectId === projectId),
            ),
            step = tasks.find(item => item.id === reference.taskId);
          return (
            <section key={index} className="sd-readfile">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>
                <b>{step ? `${workerName(studio, step.workerId)}'s ${step.title}` : (reference.taskId ?? 'A step')}</b>
                <span className="sd-meta sd-mono" style={{ fontSize: '12.5px', overflowWrap: 'anywhere' }}>
                  {reference.taskId} ·{' '}
                  {reference.attemptId || (synthetic ? 'a controller transform' : 'no producing attempt recorded')}
                </span>
              </div>
              <p style={{ margin: 0 }}>
                {typeof reference.summary === 'string' ? reference.summary : 'No summary was recorded.'}
              </p>
              {synthetic ? (
                <span className="sd-meta">The controller made this input itself; no attempt or file produced it.</span>
              ) : !producer && pages.some(page => page.isPending) ? (
                <span className="sd-meta" role="status">
                  Loading the step that produced it…
                </span>
              ) : !producer ? (
                <span className="sd-meta" style={{ color: 'var(--bad)' }}>
                  The attempt that produced it is not in this project, so where it came from cannot be shown.
                </span>
              ) : null}
              {(reference.artifacts ?? []).map(pinned => {
                const item = producer?.artifacts?.find(
                  (file, at) =>
                    pinned.path === `../inputs/${reference.taskId}/${at}-${file.path.split(/[\\/]/).pop()}` &&
                    pinned.hash === file.hash &&
                    pinned.kind === file.kind,
                );
                return (
                  <div
                    key={pinned.path}
                    style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', minWidth: 0 }}
                  >
                    <div className="sd-readfile__head">
                      <h4>{item?.path ?? pinned.path}</h4>
                      {producer && item && <FileActions projectId={projectId} attempt={producer} item={item} />}
                    </div>
                    <span
                      className="sd-meta sd-mono"
                      style={{ fontSize: '12.5px', overflowWrap: 'anywhere' }}
                      title={pinned.hash}
                    >
                      {pinned.kind} · sha-256 {pinned.hash}
                    </span>
                    {producer && item ? (
                      readableFile(producer, item) && (
                        <FileText projectId={projectId} attemptId={producer.id} item={item} />
                      )
                    ) : producer ? (
                      <span className="sd-meta" style={{ color: 'var(--bad)' }}>
                        No file the step registered matches this one&apos;s place, name, hash and kind.
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </section>
          );
        })
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          No inputs from earlier steps were recorded.
        </p>
      )}
    </section>
  );
}

// A planning attempt's proposed pipeline: its tasks, limits, assumptions and the decisions it leaves to the
// director (app-dialogs.js planReview).
export function PlanReview({ projectId, attempt, task }: { projectId: string; attempt: FullAttempt; task: Task }) {
  const plan = attempt.plan!,
    providers: Record<string, string> = { mock: 'Simulator', codex: 'Codex CLI', claude: 'Claude Code CLI' },
    created = task.materializedTaskIds as string[] | undefined;
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
        <span className="sd-eyebrow">{title}</span>
        <ul className="sd-reader__text" style={{ margin: 0 }}>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)', minWidth: 0 }}>
      <span className="sd-eyebrow">The work it proposes</span>
      <p style={{ margin: 0 }}>{plan.summary}</p>
      <span className="sd-meta">
        {attempt.planBudget?.tasks} tasks, up to {attempt.planBudget?.totalAttemptSeconds}s across every attempt
        allowed. Each result waits for your acceptance; a revision you ask for runs within these limits, and failed,
        cancelled or blocked work stops for you. Engine work and playtesting are not connected.
      </span>
      {list('Assumptions', plan.assumptions)}
      {list('Left to you', plan.directorDecisions)}
      <ol className="sd-proposed">
        {plan.tasks.map(job => {
          const worker = attempt.planContext?.workers.find(item => item.id === job.workerId);
          return (
            <li key={job.key}>
              <b>{job.title}</b>
              <span className="sd-meta">
                {[
                  job.key,
                  worker?.name,
                  worker?.team,
                  providers[worker?.provider ?? ''] ?? worker?.provider,
                  worker?.model,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span>{job.brief}</span>
              <span className="sd-meta">
                <b>Done means:</b> {job.acceptance}
              </span>
              <span className="sd-meta">
                After {[...job.dependencies, ...(job.acceptedInputs ?? [])].join(', ') || 'nothing'} · {job.maxSeconds}s
                an attempt · {job.maxAttempts} attempts at most · reserves{' '}
                {job.resources.join(', ') || 'only its agent'}
              </span>
            </li>
          );
        })}
      </ol>
      {created && task.acceptedAttemptId === attempt.id ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <span className="sd-eyebrow">The work it created</span>
          {created.map(id => (
            <Link key={id} to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: id }}>
              {id}
            </Link>
          ))}
        </div>
      ) : attempt.id !== task.lastAttemptId ? (
        <span className="sd-meta">An earlier proposal. The latest attempt holds the one to decide on.</span>
      ) : (
        <span className="sd-meta">
          Approving creates this work and starts what is ready. Nothing is created until then.
        </span>
      )}
    </section>
  );
}

// The tests a code-editing agent ran on its edits through the controller (v1.0 item 22).
export function AgentTestRuns({ attempt, name }: { attempt: FullAttempt; name: string }) {
  if (!attempt.employeeTestRuns?.length) return null;
  return (
    <section
      aria-label={`${name}'s test runs`}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)', minWidth: 0 }}
    >
      <span className="sd-eyebrow">{name}&apos;s own test runs</span>
      <span className="sd-meta">
        Tests {name} ran on its edits through the controller, where candidate tests run; the candidate&apos;s own tests
        still decide.
      </span>
      <ol className="sd-phases">
        {attempt.employeeTestRuns.map((run, index) => (
          <li key={index}>
            <span className="sd-phases__name">
              {run.totals
                ? `${run.totals.pass}/${run.totals.tests} passed${run.totals.fail ? `, ${run.totals.fail} failed` : ''}`
                : `Stopped with exit code ${run.exitCode} before reporting totals`}
            </span>
            <span className="sd-phases__time">{when(run.startedAt)}</span>
            <span className="sd-phases__detail">{run.files?.length ? run.files.join(', ') : 'Every test'}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const when = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';

interface Carried {
  attemptId: string;
  files?: { path: string }[];
  filesOmitted?: number;
  fresh?: { reason: string };
}
// The earlier work an attempt carried on, or why it started fresh instead (item 18).
export const carriedOf = (attempt: AttemptSummary) => attempt.continueFrom as Carried | undefined;
export function continuation(carried: Carried) {
  return carried.fresh
    ? `Started fresh instead of the work of ${carried.attemptId}: ${carried.fresh.reason.replace(/\.$/, '')}. Its history still shows that work.`
    : carried.files?.length
      ? `Continued from ${carried.attemptId}: ${carried.files.map(file => file.path).join(', ')}${carried.filesOmitted ? ` and ${carried.filesOmitted} more` : ''}`
      : `Continued from ${carried.attemptId}, which recorded no work files.`;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

// Everything the controller recorded about one attempt, under the Record tab: who ran it on what and where, what
// it received from earlier steps, how its phases ran, and its diagnostics, configuration, result and journals as
// recorded. What it returned is read on its Result tab.
export function AttemptRecord({
  projectId,
  summary,
  latest,
  studio,
  task,
}: {
  projectId: string;
  summary: AttemptSummary;
  latest: boolean;
  studio: StudioState | null;
  task: Task;
}) {
  const detail = useAttemptDetail(projectId, summary.id),
    full = detail.data?.id === summary.id ? detail.data : undefined,
    attempt: FullAttempt = full ?? summary,
    name = workerName(studio, attempt.workerId),
    model = (attempt.reportedModel ?? attempt.requestedModel) as string | undefined,
    result = attempt.result as { checks?: unknown } | undefined,
    { sourceIntegration } = attempt,
    metadata = Object.fromEntries(
      Object.entries(attempt).filter(
        ([key]) => !['instructions', 'phaseEvents', 'result', 'sourceIntegration'].includes(key),
      ),
    );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-16)', paddingTop: 'var(--space-12)' }}>
      <dl className="sd-kv">
        <dt>Agent</dt>
        <dd>
          {name} · {(attempt.assignment as { kind?: string } | undefined)?.kind ?? task.kind}
        </dd>
        <dt>Ran on</dt>
        <dd>
          {[
            attempt.provider === 'mock'
              ? 'the Simulator, no model used'
              : attempt.provider === 'unreal-gateway-fixture'
                ? 'the integration fixture, no real engine calls'
                : studio
                  ? cliName(studio, attempt) || attempt.provider
                  : attempt.provider,
            model ? `${attempt.reportedModel ? 'reported' : 'requested'} model ${model}` : '',
            attempt.requestedEffort ? `${effortWords(String(attempt.requestedEffort))} effort` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </dd>
        {attempt.startedAt && (
          <>
            <dt>When</dt>
            <dd>
              {when(attempt.startedAt)}
              {attempt.finishedAt ? ` to ${when(attempt.finishedAt)}` : ''} · {executionTime(attempt)}
            </dd>
          </>
        )}
        {full && (
          <>
            <dt>Session</dt>
            <dd className="sd-mono" style={{ fontSize: '13px' }}>
              {attempt.sessionId || 'Not reported'}
            </dd>
            <dt>Folder</dt>
            <dd className="sd-mono" style={{ fontSize: '13px', overflowWrap: 'anywhere' }}>
              {attempt.outputFolder}
            </dd>
          </>
        )}
      </dl>
      {full && studio ? (
        <ReceivedInputs projectId={projectId} studio={studio} attempt={full} />
      ) : detail.error ? (
        <p className="sd-meta" role="status" style={{ margin: 0, color: 'var(--bad)' }}>
          The attempt&apos;s details could not be loaded: {detail.error.message}
        </p>
      ) : (
        <p className="sd-meta" role="status" style={{ margin: 0 }}>
          Loading what it received…
        </p>
      )}
      {full && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-eyebrow">How its time went</span>
          <PhaseTimeline attempt={full} />
        </section>
      )}
      {full && <AgentTestRuns attempt={full} name={name} />}
      {full?.integration && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
          <span className="sd-eyebrow">Integration fixture · {full.integration.state}</span>
          <span className="sd-meta">
            Engine observations and screenshots are simulated. No real editor mutation or playtest was performed.
          </span>
          <ol className="sd-phases">
            {(full.integration.operations ?? []).map((operation, index) => (
              <li key={index}>
                <span className="sd-phases__name">{operation.kind}</span>
                <span className="sd-phases__time">{operation.status}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <details className="sd-disclosure">
          <summary>Diagnostics and checks as recorded</summary>
          <pre className="sd-code sd-code--block">
            {json({
              error: attempt.error,
              reason: latest ? task.reason : (attempt.assignment as { reason?: string } | undefined)?.reason,
              autonomyNote: latest
                ? task.autonomyNote
                : (attempt.assignment as { autonomyNote?: string } | undefined)?.autonomyNote,
              checks: result?.checks,
              controllerChecks: attempt.controllerChecks,
              stopContext: attempt.stopContext,
            })}
          </pre>
        </details>
        {full && (
          <>
            <details className="sd-disclosure">
              <summary>Configuration and inputs as recorded</summary>
              <pre className="sd-code sd-code--block">{json(metadata)}</pre>
            </details>
            {attempt.result ? (
              <details className="sd-disclosure">
                <summary>The whole result as recorded</summary>
                <pre className="sd-code sd-code--block">{json(attempt.result)}</pre>
              </details>
            ) : null}
            {sourceIntegration ? (
              <details className="sd-disclosure">
                <summary>The integration journal</summary>
                <pre className="sd-code sd-code--block">{json(sourceIntegration)}</pre>
              </details>
            ) : null}
            {full.integration && (
              <details className="sd-disclosure">
                <summary>The integration fixture&apos;s journal</summary>
                <pre className="sd-code sd-code--block">{json(full.integration)}</pre>
              </details>
            )}
          </>
        )}
      </div>
    </div>
  );
}
