// How an agent worked on one attempt (the canvas's "How Eli worked", v1.0 items 21 and 23): what it cost in time,
// tool calls, thinking, blocked commands and usage, every step in chapters with the agent's own words, and beside
// them the story's attempts, how the attempt was set up, what it touched and its usage. A running attempt's trace
// follows its log: each line it writes asks the controller for the steps after the last one shown.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getJSON, taskUrl, type AttemptSummary, type Task, type TaskPage } from './api';
import { AgentAvatar } from './design/avatar';
import { Icon, type IconName } from './design/icons';
import { effortWords, plural } from './evidence';
import { agentState } from './faces';
import { workerName } from './names';
import { queryKeys, useStudio } from './records';
import { cliName, isSourceStory } from './story';
import { attemptChip } from './story-tabs';
import { useLiveStream, useStreamReady } from './stream-context';
import { liveSummary, type StudioState } from './studio-runs';
import { agentLooks, placeIn, quoted } from './today';
import {
  chaptersOf,
  cliOf,
  filters,
  setupLine,
  span,
  toolsUsed,
  touched,
  traceRows,
  type AttemptTrace,
  type TraceRow,
} from './trace';

const running = (status?: string) => status === 'running' || status === 'stopping';
const clock = (value?: string | null) =>
  value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
// "11:19:59", on the 12-hour clock the rest of the page uses, without AM or PM.
const seconds = (value: string) => {
  const date = new Date(value),
    two = (number: number) => String(number).padStart(2, '0');
  return `${date.getHours() % 12 || 12}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};
const traceUrl = (projectId: string, attemptId: string, after?: number) =>
  `/api/attempts/${encodeURIComponent(attemptId)}/trace?projectId=${encodeURIComponent(projectId)}${after === undefined ? '' : `&after=${after}`}`;
// Not under the attempt's own key, which every change to the attempt reloads whole: the trace reads only what is new.
export const traceKey = (projectId: string, attemptId: string) => [projectId, 'trace', attemptId] as const;

// An attempt's trace, kept current while it runs: each log line it writes, at most every three seconds, reads the
// steps after the one before its earliest pending step, which may still change, and the counts and usage whole.
export function useTrace(projectId: string, attemptId: string, live: boolean) {
  const client = useQueryClient(),
    stream = useLiveStream();
  const trace = useQuery({
    enabled: useStreamReady() && !!attemptId,
    queryKey: traceKey(projectId, attemptId),
    queryFn: ({ signal }) => getJSON<AttemptTrace>(traceUrl(projectId, attemptId), signal),
    retry: false,
  });
  const reading = useRef(false),
    again = useRef(false),
    loaded = !!trace.data;
  useEffect(() => {
    if (!live || !loaded) return;
    const key = traceKey(projectId, attemptId);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      timer = null;
      if (reading.current) {
        again.current = true;
        return;
      }
      reading.current = true;
      try {
        const known = client.getQueryData<AttemptTrace>(key);
        if (!known) return;
        const pending = known.steps.find(step => step.pending),
          after = pending ? pending.seq - 1 : (known.steps.at(-1)?.seq ?? -1),
          next = await getJSON<AttemptTrace>(traceUrl(projectId, attemptId, after));
        client.setQueryData<AttemptTrace>(key, {
          ...next,
          steps: [...known.steps.filter(step => step.seq <= after), ...next.steps],
        });
      } catch {
        // The next line tries again; the page keeps what it has.
      } finally {
        reading.current = false;
        if (again.current) {
          again.current = false;
          timer ??= setTimeout(() => void read(), 3000);
        }
      }
    };
    const unsubscribe = stream.subscribe({
      log: event => {
        if (event.attempt_id === attemptId) timer ??= setTimeout(() => void read(), 3000);
      },
      // The attempt's own record changes when it finishes or says something.
      changes: message => {
        if (message.changes?.some(change => change.type === 'attempt' && change.id === attemptId))
          timer ??= setTimeout(() => void read(), 500);
      },
    });
    // Only lines from now on: the trace already holds the ones before.
    stream.watchLog(attemptId, Number.MAX_SAFE_INTEGER);
    return () => {
      unsubscribe();
      stream.watchLog(null);
      if (timer) clearTimeout(timer);
    };
  }, [live, loaded, stream, client, projectId, attemptId]);
  return trace;
}

export function TracePage({ projectId, taskId, attemptId }: { projectId: string; taskId: string; attemptId: string }) {
  const page = useQuery({
      enabled: useStreamReady(),
      queryKey: queryKeys.task(projectId, taskId),
      queryFn: ({ signal }) => getJSON<TaskPage>(taskUrl(projectId, taskId), signal),
    }),
    { state } = useStudio(projectId),
    attempt = page.data?.attempts.find(item => item.id === attemptId),
    trace = useTrace(projectId, attemptId, running(attempt?.status));
  if (page.error) return <p role="alert">The story could not be loaded: {page.error.message}</p>;
  if (!page.data || !state)
    return (
      <p role="status" className="sd-meta">
        Loading the trace…
      </p>
    );
  if (!attempt) return <p role="alert">This attempt is not one of the story&apos;s.</p>;
  return (
    <Trace
      projectId={projectId}
      task={page.data.task}
      attempts={page.data.attempts}
      attempt={attempt}
      studio={state}
      trace={trace.data}
      error={trace.error}
    />
  );
}

const icons: Record<TraceRow['kind'], IconName> = {
  think: 'ideas',
  say: 'note',
  shell: 'terminal',
  read: 'file',
  search: 'search',
  edit: 'pencil',
  blocked: 'blocked',
  error: 'alert',
  tool: 'build',
  phase: 'check',
  handoff: 'arrow',
  omitted: 'more',
};

// A long command shows its first lines until asked for the rest.
function Code({ text }: { text: string }) {
  const [whole, setWhole] = useState(false),
    lines = text.split('\n'),
    long = lines.length > 8 || text.length > 900,
    shown = whole || !long ? text : lines.slice(0, 8).join('\n').slice(0, 900);
  return (
    <>
      <pre className="sd-step__cmd">{shown}</pre>
      {long && (
        <button
          type="button"
          className="sd-link"
          style={{ alignSelf: 'flex-start', fontSize: '13px' }}
          onClick={() => setWhole(!whole)}
        >
          {whole ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </>
  );
}

function Step({ row, output, face }: { row: TraceRow; output: boolean; face?: ReactNode }) {
  const bad = row.tone === 'bad';
  return (
    <div className={`sd-step${row.pending ? ' sd-step--pending' : ''}`}>
      <span
        className={`sd-step__icon sd-step__icon--${row.kind === 'error' || (row.kind === 'phase' && bad) ? 'error' : row.kind}`}
        aria-hidden="true"
      >
        {row.kind === 'say' && face ? face : <Icon name={icons[row.kind]} size={16} weight={2.2} />}
      </span>
      <span className="sd-step__time">{seconds(row.at)}</span>
      <span className="sd-step__body">
        {row.kind === 'say' ? (
          <span className="sd-bubble">{row.title}</span>
        ) : (
          <span
            className={`sd-step__title${row.kind === 'think' ? ' sd-step__title--think' : bad ? ' sd-step__title--bad' : ''}`}
          >
            {row.title}
          </span>
        )}
        {row.detail && <Code text={row.detail} />}
        {row.prose && <span style={{ color: 'var(--ink-2)', overflowWrap: 'anywhere' }}>{row.prose}</span>}
        {row.reason && <span className={`sd-step__why${bad ? ' sd-step__why--bad' : ''}`}>{row.reason}</span>}
        {output && row.output && <pre className="sd-step__out">{row.output}</pre>}
      </span>
    </div>
  );
}

function Trace({
  projectId,
  task,
  attempts,
  attempt,
  studio,
  trace,
  error,
}: {
  projectId: string;
  task: Task;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  studio: StudioState;
  trace?: AttemptTrace;
  error: Error | null;
}) {
  const [thinking, setThinking] = useState(true),
    [output, setOutput] = useState(false),
    [filter, setFilter] = useState<(typeof filters)[number]['id']>('all'),
    looks = useMemo(
      () => agentLooks(projectId, [...studio.workers, ...(studio.employeeDirectory ?? [])]),
      [projectId, studio.workers, studio.employeeDirectory],
    ),
    look = looks.get(attempt.workerId ?? ''),
    name = workerName(studio, attempt.workerId),
    review = (attempt.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change-review',
    sameKind = attempts.filter(
      item =>
        ((item.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change-review') === review,
    ),
    number = sameKind.indexOf(attempt) + 1,
    place = placeIn(liveSummary(studio).stories, task),
    storyName = place && place.index > 0 ? `Story ${place.index}` : isSourceStory(task) ? 'The story' : 'This task';
  const rows = useMemo(() => (trace ? traceRows(trace, attempt) : []), [trace, attempt]),
    group = filters.find(item => item.id === filter)!.groups,
    shown = rows.filter(row => group.includes(row.group) && (thinking || row.group !== 'think')),
    chapters = chaptersOf(shown);
  const counts = trace?.counts ?? {},
    calls =
      (counts.shell ?? 0) +
      (counts.read ?? 0) +
      (counts.search ?? 0) +
      (counts.edit ?? 0) +
      (counts.blocked ?? 0) +
      (counts.error ?? 0),
    blocked = counts.blocked ?? 0,
    cli = cliOf(trace?.provider),
    phases = trace?.phases ?? [],
    editing = phases.find(phase => phase.phaseId === 'source.edit' && phase.boundary === 'finish'),
    testing = phases.find(phase => phase.phaseId === 'test' && phase.boundary === 'finish'),
    window5 = trace?.usage?.windows?.five_hour,
    weekly = trace?.usage?.windows?.seven_day,
    tokens = trace?.usage?.tokens,
    changed = trace ? touched(trace) : { changed: [], read: [] };
  const statCount = (kind: 'shell' | 'read' | 'search' | 'edit', one: string, many: string) =>
    counts[kind] ? `${counts[kind]} ${plural(counts[kind]!, one, many)}` : '';
  const filterCount = (id: (typeof filters)[number]['id']) =>
    rows.filter(
      row => filters.find(item => item.id === id)!.groups.includes(row.group) && (thinking || row.group !== 'think'),
    ).length;
  return (
    <div className="sd-tracepage">
      <nav className="sd-crumbs" aria-label="You are here">
        <Link to="/p/$projectId/runs" params={{ projectId }}>
          Ideas
        </Link>
        <span aria-hidden="true">/</span>
        {place && (
          <>
            <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: place.run.id }}>
              {quoted(place.run.brief, 48)}
            </Link>
            <span aria-hidden="true">/</span>
          </>
        )}
        <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }}>
          {place && place.index > 0 ? `Story ${place.index}` : task.id}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">
          {review ? 'Review' : 'Attempt'} {number}
        </span>
      </nav>
      <header className="sd-tracehead">
        <div className="sd-tracehead__who">
          {look && <AgentAvatar look={look} size={56} state={agentState(studio, attempt.workerId, task)} />}
          <div className="sd-tracehead__text">
            <h1 className="sd-tracehead__title">
              How {name} worked on {review ? 'review' : 'attempt'} {number}
            </h1>
            <span style={{ color: 'var(--ink-2)', fontSize: '14px' }}>
              {[
                task.title,
                attempt.startedAt
                  ? `${clock(attempt.startedAt)}${attempt.finishedAt ? ` to ${clock(attempt.finishedAt)}` : ', still running'}`
                  : '',
                trace
                  ? [cli, trace.model, trace.effort ? `${effortWords(trace.effort)} effort` : '']
                      .filter(Boolean)
                      .join(', ')
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        </div>
        {(() => {
          const [tone, label] = attemptChip(attempt);
          return (
            <span className={`sd-chip${tone ? ` sd-chip--${tone}` : ''}`}>
              <span className="sd-chip__dot"></span>
              {label}
            </span>
          );
        })()}
      </header>
      {error ? (
        <section className="sd-card sd-setsec" role="status">
          <b>The trace could not be read.</b>
          <span className="sd-meta">
            {error.message} This controller may not record traces yet; the story&apos;s Activity has the raw log.
          </span>
        </section>
      ) : !trace ? (
        <p role="status" className="sd-meta">
          Reading the trace…
        </p>
      ) : (
        <>
          <div className="sd-tracestats">
            <div className="sd-tracestat">
              <span className="sd-eyebrow">Time</span>
              <b>{span(editing?.durationMs ?? trace.durationMs) || (running(attempt.status) ? 'Running' : '—')}</b>
              <span className="sd-meta">
                {testing
                  ? `working, then ${span(testing.durationMs)} of sandbox tests`
                  : running(attempt.status)
                    ? 'so far'
                    : 'working'}
              </span>
            </div>
            <div className="sd-tracestat">
              <span className="sd-eyebrow">Tool calls</span>
              <b>{calls}</b>
              <span className="sd-meta">
                {[
                  counts.shell || counts.blocked
                    ? `${(counts.shell ?? 0) + blocked} ${plural((counts.shell ?? 0) + blocked, 'command', 'commands')}`
                    : '',
                  statCount('read', 'read', 'reads'),
                  statCount('search', 'search', 'searches'),
                  statCount('edit', 'edit', 'edits'),
                ]
                  .filter(Boolean)
                  .join(' · ') || 'none'}
              </span>
            </div>
            <div className="sd-tracestat">
              <span className="sd-eyebrow">Thinking</span>
              <b>
                {counts.think
                  ? `${counts.think} ${plural(counts.think, 'pause', 'pauses')}`
                  : tokens?.reasoningOutput
                    ? `${tokens.reasoningOutput.toLocaleString('en-US')} tokens`
                    : 'None reported'}
              </b>
              <span className="sd-meta">
                {counts.think
                  ? `${counts.thinkTokens ? `about ${counts.thinkTokens.toLocaleString('en-US')} tokens; ` : ''}the text stays private`
                  : tokens?.reasoningOutput
                    ? `${cli} reports thinking only as tokens`
                    : `${cli} reported no thinking`}
              </span>
            </div>
            <div className={`sd-tracestat${blocked ? ' sd-tracestat--you' : ''}`}>
              <span className="sd-eyebrow">Blocked</span>
              <b>{blocked ? `${blocked} ${plural(blocked, 'command', 'commands')}` : 'Nothing'}</b>
              <span className="sd-meta">{blocked ? `by ${cli}'s permission rules` : `${cli} refused nothing`}</span>
            </div>
            <div className="sd-tracestat">
              <span className="sd-eyebrow">{window5 ? 'Subscription' : 'Usage'}</span>
              <b>
                {window5
                  ? `${window5.before ?? '?'}% → ${window5.after ?? '?'}%`
                  : tokens?.output
                    ? tokens.output.toLocaleString('en-US')
                    : '—'}
              </b>
              <span className="sd-meta">
                {window5
                  ? `of ${cli === 'Claude Code' ? "Claude's" : `${cli}'s`} 5-hour window`
                  : tokens?.output
                    ? 'output tokens'
                    : `${cli} reported no usage`}
              </span>
            </div>
          </div>
          {blocked > 0 && (
            <div className="sd-callout" role="note">
              <span className="sd-callout__icon">
                <Icon name="alert" size={26} weight={2.4} />
              </span>
              <span className="sd-callout__text">
                <b>
                  {cli} blocked {blocked} of {name}&apos;s {plural(blocked, 'command', 'commands')}.
                </b>{' '}
                Its permission rules refuse a command they can&apos;t check before it runs, and nobody is there to
                approve a prompt, so {name} had to work around {blocked === 1 ? 'it' : 'them'} or hand off without{' '}
                {blocked === 1 ? 'it' : 'them'}. Approved commands in Settings let the next attempts run them.
              </span>
              <button type="button" className="sd-btn sd-btn--sm" onClick={() => setFilter('blocked')}>
                Show the {blocked} blocked {plural(blocked, 'command', 'commands')}
              </button>
            </div>
          )}
          <div className="sd-tracecols">
            <section className="sd-card sd-tracemain" aria-label="Every step">
              <div className="sd-tracebar">
                <button
                  type="button"
                  className="sd-pillswitch"
                  role="switch"
                  aria-checked={thinking}
                  onClick={() => setThinking(!thinking)}
                >
                  Show thinking
                  <i aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  className="sd-pillswitch"
                  role="switch"
                  aria-checked={output}
                  onClick={() => setOutput(!output)}
                >
                  Show tool output
                  <i aria-hidden="true"></i>
                </button>
                <span className="sd-toolbar__rule" aria-hidden="true"></span>
                {filters.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className="sd-filter"
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label} <b>{filterCount(item.id)}</b>
                  </button>
                ))}
              </div>
              {chapters.length ? (
                chapters.map(chapter => (
                  <section key={chapter.key} className="sd-chapter" aria-label={chapter.title}>
                    <div className="sd-chapter__head">
                      <h2 className="sd-chapter__title">{chapter.title}</h2>
                      <span className="sd-meta">
                        {seconds(chapter.from)} to {seconds(chapter.to)}
                        {Date.parse(chapter.to) - Date.parse(chapter.from) >= 1000
                          ? ` · ${span(Date.parse(chapter.to) - Date.parse(chapter.from))}`
                          : ''}
                      </span>
                    </div>
                    {chapter.rows.map(row => (
                      <Step
                        key={row.key}
                        row={row}
                        output={output}
                        face={look && <AgentAvatar look={look} size={30} ring={false} />}
                      />
                    ))}
                  </section>
                ))
              ) : (
                <p className="sd-meta" style={{ padding: '18px' }}>
                  {rows.length ? 'Nothing of this kind.' : 'No steps recorded yet.'}
                </p>
              )}
              {trace.handoff?.handoff && (
                <details className="sd-disclosure" style={{ padding: '0 18px 12px' }}>
                  <summary>Read the whole handoff</summary>
                  <pre className="sd-step__cmd">{trace.handoff.handoff}</pre>
                </details>
              )}
              <p
                className="sd-meta"
                style={{ margin: 0, padding: '12px 18px 18px', borderTop: '1.5px solid var(--line)' }}
              >
                {trace.lines ? `${trace.lines.toLocaleString('en-US')} log lines, condensed into these steps. ` : ''}
                {trace.source === 'log-rows'
                  ? 'Read from the log, which cut its longest lines' +
                    (trace.unreadLines ? `; ${trace.unreadLines} could not be read. ` : '. ')
                  : ''}
                Test output lives in Checks. Every raw line:{' '}
                <a
                  href={`/api/attempts/${encodeURIComponent(attempt.id)}/logs/download?projectId=${encodeURIComponent(projectId)}`}
                  download
                >
                  Download the log
                </a>
              </p>
            </section>
            <aside className="sd-tracerail">
              <section className="sd-card sd-sidecard" aria-labelledby="trace-attempts">
                <h2 id="trace-attempts" className="sd-eyebrow">
                  {storyName}&apos;s attempts
                </h2>
                {attempts.map(item => {
                  const [, label] = attemptChip(item),
                    itemNumber =
                      attempts
                        .filter(
                          other =>
                            ((other.assignment as { kind?: string } | undefined)?.kind ===
                              'studio-development:change-review') ===
                            ((item.assignment as { kind?: string } | undefined)?.kind ===
                              'studio-development:change-review'),
                        )
                        .indexOf(item) + 1,
                    itemReview =
                      (item.assignment as { kind?: string } | undefined)?.kind === 'studio-development:change-review';
                  return (
                    <Link
                      key={item.id}
                      className="sd-attrow"
                      aria-current={item.id === attempt.id ? 'page' : undefined}
                      to="/p/$projectId/tasks/$taskId/attempts/$attemptId"
                      params={{ projectId, taskId: task.id, attemptId: item.id }}
                    >
                      <span className="sd-attrow__number">{itemReview ? 'R' : itemNumber}</span>
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <b>
                          {itemReview ? `Review ${itemNumber} · ` : ''}
                          {cliName(studio, item) ||
                            (['claude', 'codex'].includes(item.provider ?? '') ? cliOf(item.provider) : 'Build')}
                        </b>
                        <span className="sd-meta">
                          {(label ?? '').toLowerCase()} · {clock(item.finishedAt ?? item.startedAt)}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </section>
              <section className="sd-card sd-sidecard" aria-labelledby="trace-setup">
                <h2 id="trace-setup" className="sd-eyebrow">
                  How it was set up
                </h2>
                <span>{setupLine(trace)}</span>
                {trace.setup && (
                  <span className="sd-meta">
                    {trace.setup.tools ? `${trace.setup.tools} tools available, ` : ''}
                    {trace.setup.mcpServers?.length
                      ? `MCP servers ${trace.setup.mcpServers.join(', ')}`
                      : 'no MCP servers'}
                    .
                    {toolsUsed(trace).length
                      ? ` It used ${toolsUsed(trace).slice(0, -1).join(', ')}${toolsUsed(trace).length > 1 ? ' and ' : ''}${toolsUsed(trace).at(-1)}.`
                      : ''}
                  </span>
                )}
                <Link
                  className="sd-link"
                  style={{ alignSelf: 'flex-start' }}
                  to="/p/$projectId/tasks/$taskId"
                  params={{ projectId, taskId: task.id }}
                >
                  Read what it was told
                </Link>
              </section>
              {(changed.changed.length > 0 || changed.read.length > 0) && (
                <section className="sd-card sd-sidecard" aria-labelledby="trace-touched">
                  <h2 id="trace-touched" className="sd-eyebrow">
                    What it touched
                  </h2>
                  {changed.changed.length > 0 && (
                    <>
                      <span className="sd-meta">Changed</span>
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
                        {changed.changed.map(item => (
                          <span
                            key={item.path}
                            className={`sd-file sd-file--fit${item.created ? ' sd-file--add' : ''}`}
                            title={item.path}
                          >
                            {item.created ? '+ ' : ''}
                            {item.path.split(/[\\/]/).at(-1)}
                            {item.edits > 1 ? ` ×${item.edits}` : ''}
                          </span>
                        ))}
                      </span>
                    </>
                  )}
                  {changed.read.length > 0 && (
                    <>
                      <span className="sd-meta">Read or searched</span>
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
                        {changed.read.map(path => (
                          <span key={path} className="sd-file sd-file--fit" title={path}>
                            {path.split(/[\\/]/).at(-1)}
                          </span>
                        ))}
                      </span>
                    </>
                  )}
                </section>
              )}
              {(window5 || weekly || tokens) && (
                <section className="sd-card sd-sidecard" aria-labelledby="trace-usage">
                  <h2 id="trace-usage" className="sd-eyebrow">
                    {window5
                      ? `${cli === 'Claude Code' ? 'Claude' : cli} subscription, as ${cli} reported it`
                      : `Usage, as ${cli} reported it`}
                  </h2>
                  {[
                    ['5-hour window', window5],
                    ['Weekly', weekly],
                  ].map(([label, item]) => {
                    const usage = item as typeof window5;
                    if (!usage) return null;
                    const before = usage.before ?? 0,
                      after = usage.after ?? before;
                    return (
                      <div
                        key={label as string}
                        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}
                      >
                        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)' }}>
                          <span className="sd-meta" style={{ color: 'var(--ink-2)' }}>
                            {label as string}
                          </span>
                          <span className="sd-meta">
                            {after}%{usage.resetsAt ? ` · resets ${resets(usage.resetsAt)}` : ''}
                          </span>
                        </span>
                        <span className="sd-bar" aria-hidden="true">
                          <span
                            className="sd-bar__part sd-bar__part--wait"
                            style={{ width: `${Math.min(100, before)}%` }}
                          ></span>
                          <span
                            className="sd-bar__part sd-bar__part--brand"
                            style={{ width: `${Math.max(0, Math.min(100, after) - Math.min(100, before))}%` }}
                          ></span>
                        </span>
                      </div>
                    );
                  })}
                  {tokens && (tokens.output || tokens.input) ? (
                    <span className="sd-meta">
                      {window5 ? 'The violet part is this attempt. ' : ''}
                      {[
                        tokens.input ? `${tokens.input.toLocaleString('en-US')} input` : '',
                        tokens.output ? `${tokens.output.toLocaleString('en-US')} output` : '',
                        tokens.reasoningOutput
                          ? `${tokens.reasoningOutput.toLocaleString('en-US')} of them reasoning`
                          : '',
                      ]
                        .filter(Boolean)
                        .join(', ')}{' '}
                      tokens.
                    </span>
                  ) : window5 ? (
                    <span className="sd-meta">The violet part is this attempt.</span>
                  ) : null}
                </section>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

// "3:30 AM" today or tomorrow, otherwise "Oct 25".
function resets(value: string) {
  const date = new Date(value),
    hours = (date.getTime() - Date.now()) / 3600000;
  return hours < 20 ? clock(value) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
