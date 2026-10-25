// A task's page, as the canvas's Story board draws it (v1.0 item 23): where the story is in its steps, where it
// stands with the director's decisions, the evidence it rests on, its tabs, and who works on it under which
// rules. The task and its attempts refresh when that task, one of its attempts or one of its recorded steps
// changes, and for nothing else. What the director is doing on the page (a draft, a chosen attempt or tab, a
// scroll position) is the page's own state, so a refresh never resets it.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  getJSON,
  logsUrl,
  send,
  storyActivityUrl,
  taskUrl,
  type AttemptSummary,
  type Execution,
  type LogEvent,
  type StoryActivity as StoryActivityRecord,
  type Task,
  type TaskPage,
} from './api';
import { carriedOf, continuation, openPhase, useAttemptDetail } from './attempt-record';
import { beforeThis, TraceActivity } from './activity';
import { askedPaths, fileRequest } from './decisions';
import { AgentAvatar } from './design/avatar';
import { agentState, attemptState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Clapper, Icon } from './design/icons';
import { diffStatOf, effortWords, plural, sandboxed, spoken, testTime, totalsOf } from './evidence';
import { cleanExecution, ExecutionFields } from './execution-fields';
import { workerName } from './names';
import { CommandRequest, TaskAutoMode } from './permissions';
import { queryKeys, useStudio } from './records';
import { SourceDiff } from './source-story';
import {
  attemptsUsed,
  cliName,
  houseRules,
  isSourceStory,
  kindLabel,
  limitsLine,
  phaseOf,
  prerequisite,
  standing,
  storyPeople,
  storySteps,
  testingPhases,
  type Step,
} from './story';
import {
  attemptName,
  AttemptsPanel,
  ChecksPanel,
  isReview,
  OverviewPanel,
  RecordPanel,
  ResultPanel,
  ReviewPanel,
  stagedWork,
} from './story-tabs';
import { useLiveStream, useStreamReady } from './stream-context';
import { active, explain, liveSummary, statusOf, type RunStory, type StudioState } from './studio-runs';
import { DecisionNotes, NextAttemptTools, OwnerForm, TaskDecisions } from './task-decisions';
import { agentLooks, placeIn, quoted, when } from './today';
import { useToast } from './toast';
import type { AttemptTrace } from './trace';
import { useTrace } from './trace-page';
import { useNarrow } from './use-narrow';
import { useNow } from './use-now';
import { clip, yourPart, type Part } from './your-part';

const running = (status: string) => status === 'running' || status === 'stopping';
const projectQuery = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;

// The project's records with this page's task and attempts, which are the newest the page holds.
function withPage(state: StudioState, page: TaskPage): StudioState {
  const ids = new Set(page.attempts.map(attempt => attempt.id));
  return {
    ...state,
    tasks: [...state.tasks.filter(task => task.id !== page.task.id), page.task],
    attempts: [...state.attempts.filter(attempt => !ids.has(attempt.id)), ...page.attempts],
  };
}

export function TaskView({ projectId, taskId }: { projectId: string; taskId: string }) {
  const { data, error, isPending } = useQuery({
      enabled: useStreamReady(),
      queryKey: queryKeys.task(projectId, taskId),
      queryFn: ({ signal }) => getJSON<TaskPage>(taskUrl(projectId, taskId), signal),
    }),
    { state } = useStudio(projectId),
    studio = useMemo(() => (state && data ? withPage(state, data) : null), [state, data]);
  if (error)
    return (
      <article className="sd-storypage">
        <Crumbs projectId={projectId} here={taskId} />
        <h1 className="sd-storyhead__title">Task unavailable</h1>
        <p role="alert">The task could not be loaded: {error.message}</p>
      </article>
    );
  if (isPending || !studio || !state)
    return (
      <article className="sd-storypage">
        <Crumbs projectId={projectId} here={taskId} />
        <p role="status" className="sd-meta">
          Loading the task…
        </p>
      </article>
    );
  return <Story projectId={projectId} task={data.task} attempts={data.attempts} studio={studio} live={state} />;
}

// "Ideas / “the idea” / Story 3 of 4", or "Ideas / T-1" for work outside any idea.
function Crumbs({
  projectId,
  here,
  idea,
}: {
  projectId: string;
  here: string;
  idea?: { runId: string; brief: string } | null;
}) {
  return (
    <nav className="sd-crumbs" aria-label="You are here">
      <Link to="/p/$projectId/runs" params={{ projectId }}>
        Ideas
      </Link>
      <span aria-hidden="true">/</span>
      {idea && (
        <>
          <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: idea.runId }}>
            {quoted(idea.brief, 48)}
          </Link>
          <span aria-hidden="true">/</span>
        </>
      )}
      <span aria-current="page">{here}</span>
    </nav>
  );
}

type TabId = 'overview' | 'changes' | 'checks' | 'review' | 'activity' | 'attempts' | 'record' | 'result' | 'details';
interface Tab {
  id: TabId;
  label: string;
  count?: number;
}

function Story({
  projectId,
  task,
  attempts,
  studio,
  live: liveState,
}: {
  projectId: string;
  task: Task;
  attempts: AttemptSummary[];
  studio: StudioState;
  live: StudioState;
}) {
  const narrow = useNarrow(),
    [draft, setDraft] = useState<string | null>(null),
    [chosen, setChosen] = useState<string | null>(null),
    [picked, setPicked] = useState<TabId | null>(null),
    looks = useMemo(
      () => agentLooks(projectId, [...studio.workers, ...(studio.employeeDirectory ?? [])]),
      [projectId, studio.workers, studio.employeeDirectory],
    );
  const latest = attempts.find(attempt => attempt.id === task.lastAttemptId) ?? attempts.at(-1),
    shown = attempts.find(attempt => attempt.id === chosen) ?? latest,
    detail = useAttemptDetail(projectId, shown?.id ?? '', !!shown),
    full = detail.data?.id === shown?.id ? detail.data : undefined,
    source = isSourceStory(task),
    // Unless an attempt is chosen, a staged task shows its own work first, then the later stage's attempt.
    work = !source && !chosen ? stagedWork(task, attempts, latest) : undefined,
    people = storyPeople(task, studio),
    built = people.candidate ?? people.build,
    // The candidate's own record, for where its time went; the attempt shown's when that is the candidate.
    builtDetail = useAttemptDetail(projectId, built?.id ?? '', source && !!built && built.id !== shown?.id),
    builtFull = built?.id === shown?.id ? full : builtDetail.data?.id === built?.id ? builtDetail.data : undefined,
    // The open phase from the full record when it is the one shown, otherwise as the compact record carries it.
    phase = active(task) ? (latest?.id === shown?.id && full ? openPhase(full) : phaseOf(task, studio)) : null,
    status = statusOf(studio, task),
    stand = standing(task, studio, phase),
    explanation = explain(task, studio),
    direction = draft ?? task.direction ?? '',
    place = placeIn(liveSummary(liveState).stories, task),
    idea = place ? { runId: place.run.id, brief: place.run.brief } : null,
    here = place && place.index > 0 ? `Story ${place.index} of ${place.total}` : task.id,
    stat = diffStatOf(built),
    // On a phone the chip says what the running attempt is doing: "Testing · attempt 4".
    liveLabel = active(task)
      ? isReview(latest)
        ? 'Reviewing'
        : `${phase ? (testingPhases.includes(phase) ? 'Testing' : 'Editing') : 'Working'}${latest ? ` · ${attemptName(task, attempts, latest, true).replace(/^A/, 'a')}` : ''}`
      : null;
  // The Attempts tab counts a story's build attempts, as its limit does; its reviews are a step of their own.
  const tries = source ? attempts.filter(item => !isReview(item)).length : attempts.length;
  const tabs: Tab[] = narrow
    ? [
        { id: 'activity', label: 'Activity' },
        source ? { id: 'changes', label: 'Changes', count: stat?.files } : { id: 'result', label: 'Result' },
        ...(source ? [{ id: 'checks' as const, label: 'Checks' }] : []),
        { id: 'attempts', label: 'Attempts', count: tries || undefined },
        { id: 'details', label: 'Details' },
      ]
    : [
        { id: 'overview', label: 'Overview' },
        ...(source
          ? [
              { id: 'changes' as const, label: 'Changes', count: stat?.files },
              { id: 'checks' as const, label: 'Checks' },
              { id: 'review' as const, label: 'Review' },
            ]
          : [{ id: 'result' as const, label: 'Result' }]),
        { id: 'activity', label: 'Activity' },
        { id: 'attempts', label: 'Attempts', count: tries || undefined },
        { id: 'record', label: 'Record' },
      ];
  // A story with a candidate opens on its change, other finished work on its result; the rest on what was asked.
  const fallback: TabId =
      source && people.candidate ? 'changes' : !source && shown ? 'result' : narrow ? 'details' : 'overview',
    tab = tabs.some(item => item.id === picked) ? picked! : fallback;
  const sideCards = (
    <>
      <People task={task} studio={studio} looks={looks} />
      <Details
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        stories={liveSummary(liveState).stories}
      />
    </>
  );
  const overview = (
    <OverviewPanel
      projectId={projectId}
      task={task}
      studio={studio}
      shown={source ? (builtFull ?? built) : (work ?? full ?? shown)}
      looks={looks}
    >
      <Direction
        projectId={projectId}
        taskId={task.id}
        value={direction}
        dirty={draft !== null}
        onChange={setDraft}
        status={task.status}
      />
    </OverviewPanel>
  );
  const panels: Record<TabId, () => ReactNode> = {
    overview: () => overview,
    changes: () => <SourceDiff task={task} studio={studio} selectedAttemptId={chosen ?? undefined} />,
    checks: () => (
      <>
        <ChecksPanel projectId={projectId} task={task} studio={studio} attempt={built} full={builtFull} />
        {narrow && (
          <ReviewPanel projectId={projectId} task={task} studio={studio} review={people.review} looks={looks} />
        )}
      </>
    ),
    review: () => (
      <ReviewPanel projectId={projectId} task={task} studio={studio} review={people.review} looks={looks} />
    ),
    activity: () => (
      <StoryActivity projectId={projectId} task={task} studio={studio} attempts={attempts} looks={looks} />
    ),
    attempts: () => (
      <>
        <AttemptsPanel
          task={task}
          studio={studio}
          attempts={attempts}
          shown={shown}
          onChoose={setChosen}
          looks={looks}
        />
        {shown && carriedOf(shown) && (
          <p className="sd-meta" style={{ margin: '0 22px 22px' }}>
            {continuation(carriedOf(shown)!)}
          </p>
        )}
      </>
    ),
    record: () => (
      <RecordPanel
        projectId={projectId}
        task={task}
        studio={studio}
        shown={shown}
        full={full}
        latest={shown?.id === latest?.id}
      />
    ),
    // While the attempt runs, its result is what it is doing; what it returns replaces that when it hands back.
    result: () => (
      <>
        {work && (
          <>
            <ResultPanel projectId={projectId} task={task} studio={studio} shown={work} />
            <div className="sd-tabpanel" style={{ paddingBlock: 0 }}>
              <div className="sd-divider">
                {workerName(studio, shown?.workerId)} ·{' '}
                {studio.taskKinds[String((shown?.assignment as { kind?: string } | undefined)?.kind)]?.label ??
                  'The next step'}
              </div>
            </div>
          </>
        )}
        {shown && running(shown.status) ? (
          <Activity
            key={shown.id}
            projectId={projectId}
            task={task}
            studio={studio}
            attempt={shown}
            looks={looks}
            onAttempts={() => setPicked('attempts')}
            lead={
              <>
                <p style={{ margin: 0 }}>
                  {workerName(studio, shown.workerId)} is working on it now. What it returns shows here when it hands it
                  back.
                </p>
                {carriedOf(shown) && (
                  <p className="sd-meta" style={{ margin: 0 }}>
                    {continuation(carriedOf(shown)!)}
                  </p>
                )}
              </>
            }
          />
        ) : (
          <ResultPanel projectId={projectId} task={task} studio={studio} shown={shown} />
        )}
      </>
    ),
    details: () => (
      <>
        {overview}
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)', paddingTop: 'var(--space-14)' }}
        >
          {sideCards}
        </div>
        <RecordPanel
          projectId={projectId}
          task={task}
          studio={studio}
          shown={shown}
          full={full}
          latest={shown?.id === latest?.id}
        />
      </>
    ),
  };
  // The chosen tab stays in view in the phone's scrolling row of tabs; only the row scrolls, never the page.
  useEffect(() => {
    const button = document.getElementById(`story-tab-${tab}`),
      row = button?.parentElement;
    if (!button || !row || row.scrollWidth <= row.clientWidth) return;
    const at = button.getBoundingClientRect(),
      within = row.getBoundingClientRect();
    if (at.left < within.left || at.right > within.right) row.scrollLeft += at.left - within.left - 16;
  }, [tab]);
  const choose = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(item => item.id === tab),
      next =
        event.key === 'ArrowRight'
          ? tabs[(index + 1) % tabs.length]
          : event.key === 'ArrowLeft'
            ? tabs[(index - 1 + tabs.length) % tabs.length]
            : null;
    if (!next) return;
    event.preventDefault();
    setPicked(next.id);
    document.getElementById(`story-tab-${next.id}`)?.focus();
  };
  return (
    <article className="sd-storypage">
      <div className="sd-backbar">
        {idea ? (
          <Link
            className="sd-btn sd-btn--ghost"
            style={{ padding: '0 12px', gap: 'var(--space-4)' }}
            to="/p/$projectId/runs/$runId"
            params={{ projectId, runId: idea.runId }}
          >
            <Icon name="back" size={20} weight={2.4} />
            Idea
          </Link>
        ) : (
          <Link
            className="sd-btn sd-btn--ghost"
            style={{ padding: '0 12px', gap: 'var(--space-4)' }}
            to="/p/$projectId/runs"
            params={{ projectId }}
          >
            <Icon name="back" size={20} weight={2.4} />
            Ideas
          </Link>
        )}
        <span className="sd-meta sd-backbar__place">{here}</span>
        <button
          type="button"
          className="sd-btn sd-btn--ghost"
          style={{ width: '48px', padding: 0 }}
          aria-label="More about this story"
          onClick={() => setPicked('details')}
        >
          <Icon name="more" size={20} />
        </button>
      </div>
      <Crumbs projectId={projectId} here={here} idea={idea} />
      <header className="sd-storyhead">
        <div className="sd-storyhead__kind sd-wide-only">
          <span className="sd-chip sd-chip--brand">{kindLabel(task, studio)}</span>
          <span className="sd-mono sd-meta">{task.id}</span>
        </div>
        <span className={`sd-chip sd-chip--${stand.tone} sd-narrow-only`} style={{ alignSelf: 'flex-start' }}>
          <span className="sd-chip__dot"></span>
          {liveLabel ?? stand.chip ?? status.label}
        </span>
        <h1 className="sd-storyhead__title">{task.title}</h1>
        <Steps steps={storySteps(task, studio, phase)} />
      </header>
      <Stands
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        phase={phase}
        looks={looks}
        narrow={narrow}
        direction={direction}
        onEditFiles={() => setPicked(narrow ? 'details' : 'overview')}
      >
        {explanation.kind === 'test-sandbox' && (
          <Link
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            to="/p/$projectId/settings"
            params={{ projectId }}
          >
            Open Candidate tests in Settings
          </Link>
        )}
        {explanation.kind === 'command-request' && (
          <CommandRequest key={explanation.attemptId} projectId={projectId} task={task} explanation={explanation} />
        )}
        <AskedFiles task={task} studio={studio} />
        <DecisionNotes projectId={projectId} task={task} studio={studio} />
      </Stands>
      {source && people.candidate && (
        <Tiles task={task} studio={studio} looks={looks} onShow={setPicked} narrow={narrow} />
      )}
      <div className="sd-story">
        <section className="sd-card sd-story__main">
          <div className="sd-tabs" role="tablist" aria-label="Story details" onKeyDown={choose}>
            {tabs.map(item => (
              <button
                key={item.id}
                id={`story-tab-${item.id}`}
                type="button"
                role="tab"
                className="sd-tabs__tab"
                aria-selected={item.id === tab}
                aria-controls="story-panel"
                tabIndex={item.id === tab ? 0 : -1}
                onClick={() => setPicked(item.id)}
              >
                {item.label}
                {item.count ? <span className="sd-tabs__count">{item.count}</span> : null}
              </button>
            ))}
          </div>
          <div id="story-panel" role="tabpanel" aria-labelledby={`story-tab-${tab}`}>
            {panels[tab]()}
          </div>
        </section>
        {!narrow && <aside className="sd-story__side">{sideCards}</aside>}
      </div>
    </article>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="sd-steps" aria-label="Where the story is">
      {steps.map((step, index) => (
        <li
          key={index}
          className={`sd-steps__step${step.state === 'done' ? '' : ` sd-steps__step--${step.state}`}`}
          aria-current={step.state === 'you' || step.state === 'live' ? 'step' : undefined}
        >
          <span className="sd-steps__mark">
            {step.state === 'done' ? (
              <Icon name="check" size={12} weight={4} />
            ) : step.state === 'bad' ? (
              <Icon name="close" size={11} weight={3.4} />
            ) : step.state === 'you' ? (
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            ) : null}
          </span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

// Where it stands: the director's call or the work moving, in the agents' words, with the decisions it offers.
function Stands({
  projectId,
  task,
  studio,
  attempts,
  phase,
  looks,
  narrow,
  direction,
  onEditFiles,
  children,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  phase: string | null;
  looks: Map<string, AgentLook>;
  narrow: boolean;
  direction: string;
  onEditFiles: () => void;
  children?: ReactNode;
}) {
  const stand = standing(task, studio, phase),
    look = stand.workerId ? looks.get(stand.workerId) : undefined,
    live = active(task),
    now = useNow(live),
    attempt = attempts.find(item => item.id === task.lastAttemptId),
    started = Date.parse(String(attempt?.startedAt ?? '')),
    limit = (task.maxSeconds ?? 0) * 1000,
    elapsed = live && Number.isFinite(started) ? Math.max(0, now - started) : null,
    { left } = attemptsUsed(task, attempts),
    icon = (size: number) =>
      stand.tone === 'you' ? (
        <Clapper size={size} />
      ) : look ? (
        <AgentAvatar
          look={look}
          size={size}
          state={live ? 'working' : stand.tone === 'ok' ? 'done' : stand.tone === 'bad' ? 'stuck' : 'idle'}
        />
      ) : null;
  return (
    <section className={`sd-stands sd-stands--${stand.tone}`} aria-label="Where it stands">
      {!narrow && icon(44) && <span className="sd-stands__icon">{icon(44)}</span>}
      <div className="sd-stands__text">
        <div className="sd-stands__head">
          {narrow && icon(36) && <span className="sd-stands__icon">{icon(36)}</span>}
          <div className="sd-stands__title">{stand.title}</div>
        </div>
        {stand.detail && <div className="sd-stands__detail">{stand.detail}</div>}
        {elapsed !== null && limit > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-6)' }}>
            <span className="sd-bar" aria-hidden="true">
              <span
                className="sd-bar__part sd-bar__part--live"
                style={{ width: `${Math.min(100, (elapsed / limit) * 100)}%` }}
              ></span>
            </span>
            <span
              className="sd-meta"
              style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)' }}
            >
              <span>
                {spoken(elapsed)} of {spoken(limit)}
              </span>
              <span>
                {left} {plural(left, 'attempt')} left
              </span>
            </span>
          </div>
        )}
        {children}
      </div>
      <TaskDecisions
        projectId={projectId}
        task={task}
        studio={studio}
        direction={direction}
        onEditFiles={onEditFiles}
      />
    </section>
  );
}

// The paths a blocked editor asked to add, as Today's call shows them.
function AskedFiles({ task, studio }: { task: Task; studio: StudioState }) {
  const { request, requested } = fileRequest(task, studio);
  if (!request || !requested) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-6)',
        alignItems: 'center',
        marginTop: 'var(--space-6)',
      }}
    >
      <span className="sd-meta">Asks to edit</span>
      {askedPaths(task, request).map(({ path, sign, note }) => (
        <span key={path} className={`sd-file${sign === '+' ? ' sd-file--add' : ' sd-file--del'}`}>
          {sign} {path}
          {note}
        </span>
      ))}
    </div>
  );
}

// The change, its tests and its review, each opening its tab.
function Tiles({
  task,
  studio,
  looks,
  onShow,
  narrow,
}: {
  task: Task;
  studio: StudioState;
  looks: Map<string, AgentLook>;
  onShow: (tab: TabId) => void;
  narrow: boolean;
}) {
  const { candidate, build, review, reviewer, reviewerId } = storyPeople(task, studio),
    built = candidate ?? build,
    stat = diffStatOf(built),
    totals = totalsOf(built),
    ran = testTime(built),
    findings = (review?.candidateReviewFindings as unknown[] | undefined)?.length ?? 0,
    notes = (review?.candidateReviewNotes as unknown[] | undefined)?.length ?? 0,
    verdict = review?.finishedAt ? review.candidateReviewVerdict : undefined,
    look = looks.get(reviewerId ?? ''),
    share = stat && stat.added + stat.removed ? (stat.added / (stat.added + stat.removed)) * 100 : 100,
    passed = totals?.tests ? ((totals.pass ?? 0) / totals.tests) * 100 : 0;
  return (
    <div className="sd-tiles">
      <button type="button" className="sd-tile sd-tile--raised" onClick={() => onShow('changes')}>
        <span className="sd-eyebrow">
          <span className="sd-wide-only">The change</span>
          <span className="sd-narrow-only">Change</span>
        </span>
        {stat ? (
          <>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-8)' }}>
              <b className="sd-tile__value sd-tile__value--lg" style={{ color: 'var(--add)' }}>
                +{stat.added}
              </b>
              <b className="sd-tile__value sd-tile__value--lg" style={{ color: 'var(--del)' }}>
                −{stat.removed}
              </b>
              <span className="sd-meta">
                in {stat.files} {plural(stat.files, 'file')}
              </span>
            </span>
            <span className="sd-bar" aria-hidden="true">
              <span className="sd-bar__part sd-bar__part--ok" style={{ width: `${share}%` }}></span>
              <span className="sd-bar__part sd-bar__part--bad" style={{ width: `${100 - share}%` }}></span>
            </span>
          </>
        ) : (
          <>
            <b className="sd-tile__value sd-tile__value--lg">Read it</b>
            <span className="sd-meta">Its size was not recorded</span>
          </>
        )}
      </button>
      <button type="button" className="sd-tile sd-tile--raised" onClick={() => onShow('checks')}>
        <span className="sd-eyebrow">
          <span className="sd-wide-only">{sandboxed(built) ? 'Tests in the sandbox' : 'Tests, no sandbox'}</span>
          <span className="sd-narrow-only">Tests</span>
        </span>
        {totals?.tests ? (
          <>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-8)' }}>
              <b className="sd-tile__value sd-tile__value--lg">
                {totals.pass} / {totals.tests}
              </b>
              {ran && <span className="sd-meta">{spoken(ran)}</span>}
            </span>
            <span className="sd-bar" aria-hidden="true">
              <span className="sd-bar__part sd-bar__part--ok" style={{ width: `${passed}%` }}></span>
              <span className="sd-bar__part sd-bar__part--bad" style={{ width: `${100 - passed}%` }}></span>
            </span>
          </>
        ) : (
          <>
            <b className="sd-tile__value sd-tile__value--lg">Not yet</b>
            <span className="sd-meta">The candidate has not been tested</span>
          </>
        )}
      </button>
      <button
        type="button"
        className="sd-tile sd-tile--raised"
        style={{ flexDirection: 'row', alignItems: 'center', gap: '14px' }}
        onClick={() => onShow(narrow ? 'checks' : 'review')}
      >
        {look && <AgentAvatar look={look} size={46} state={review ? attemptState(review) : 'idle'} />}
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <span className="sd-eyebrow">
            <span className="sd-wide-only">{reviewer === 'the reviewer' ? 'The review' : `${reviewer}'s review`}</span>
            <span className="sd-narrow-only">Review</span>
          </span>
          <span style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
            {verdict === 'pass' ? (
              <span className="sd-chip sd-chip--ok">
                <span className="sd-chip__dot"></span>Passed
              </span>
            ) : verdict === 'needs-work' ? (
              <span className="sd-chip sd-chip--you">
                <span className="sd-chip__dot"></span>Asked for changes
              </span>
            ) : (
              <span className="sd-chip">
                <span className="sd-chip__dot"></span>
                {review ? 'Reviewing' : 'Not yet'}
              </span>
            )}
            {verdict && (
              <span className="sd-chip">
                {findings} blocking · {notes} {plural(notes, 'note')}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  );
}

// Who built the story and who reviewed it.
function People({ task, studio, looks }: { task: Task; studio: StudioState; looks: Map<string, AgentLook> }) {
  const { candidate, review, editorId, reviewerId, stage } = storyPeople(task, studio),
    source = isSourceStory(task),
    workers = [...studio.workers, ...(studio.employeeDirectory ?? [])],
    person = (id: string | undefined, doing: string) => {
      if (!id) return null;
      const worker = workers.find(item => item.id === id),
        look = looks.get(id);
      return (
        <div className="sd-person">
          {look && <AgentAvatar look={look} size={40} state={agentState(studio, id, task)} />}
          <span>
            <b>{workerName(studio, id)}</b> {doing}
            <span className="sd-meta" style={{ display: 'block' }}>
              {[worker?.jobTitle, worker?.team].filter(Boolean).join(' · ')}
            </span>
          </span>
        </div>
      );
    };
  const live = active(task),
    reviewing = stage.phase === 'candidate-review' && live;
  return (
    <section className="sd-card sd-sidecard" aria-label="People">
      {source
        ? person(editorId, candidate ? 'built it' : live && !reviewing ? 'is building it' : 'builds it')
        : person(task.workerId, task.status === 'done' ? 'did it' : live ? 'is doing it' : 'does it')}
      {source && person(reviewerId, review?.finishedAt ? 'reviewed it' : reviewing ? 'is reviewing it' : 'reviews it')}
    </section>
  );
}

// How the next attempt runs, the limits, what the task waits for and the house rules.
// How the next attempt runs, its limits, what it waits for and the house rules, as the canvas's side card has
// them. Change opens what changes the next attempt: its CLI and model, its auto mode and a preview of what it will
// be told.
function Details({
  projectId,
  task,
  studio,
  attempts,
  stories,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  stories: RunStory[];
}) {
  const [changing, setChanging] = useState(false),
    owner = [...studio.workers, ...(studio.employeeDirectory ?? [])].find(worker => worker.id === task.workerId),
    override = task.execution as Execution | undefined,
    // Mirrors src/core/execution.mjs: the employee's settings, then the task's non-empty overrides.
    switched = !!override?.provider && override.provider !== owner?.provider,
    effective = {
      provider: override?.provider || owner?.provider,
      model: override?.model || (switched ? '' : owner?.model),
      effort: override?.effort || (switched ? '' : owner?.effort),
      mode: override?.mode || (switched ? '' : owner?.mode),
    },
    last = [...attempts].reverse().find(attempt => !isReview(attempt)),
    { used, allowed } = attemptsUsed(task, attempts),
    dependencies = task.dependencies ?? [];
  return (
    <section className="sd-card sd-sidecard" aria-label="Details" style={{ gap: 'var(--space-14)' }}>
      <div className="sd-detail">
        <span className="sd-eyebrow">Next attempt runs as</span>
        <span
          style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)', alignItems: 'baseline' }}
        >
          <span>
            {[
              cliName(studio, undefined, effective.provider),
              effective.model || 'default model',
              effective.effort ? effortWords(effective.effort) : '',
              effective.mode && effective.mode !== 'workspace' ? `${effective.mode} mode` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button type="button" className="sd-link" aria-expanded={changing} onClick={() => setChanging(!changing)}>
            Change
          </button>
        </span>
        <span className="sd-meta">
          {[
            override ? 'Set for this task.' : '',
            cliName(studio, last) && cliName(studio, last) !== cliName(studio, undefined, effective.provider)
              ? `This one ran on ${cliName(studio, last)}.`
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </span>
        {changing && (
          <div
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)', marginTop: 'var(--space-6)' }}
          >
            <TaskExecution key={task.workerId} projectId={projectId} task={task} studio={studio} />
            <TaskAutoMode projectId={projectId} task={task} studio={studio} />
            <NextAttemptTools projectId={projectId} task={task} />
          </div>
        )}
      </div>
      <div className="sd-detail">
        <span className="sd-eyebrow">Limits</span>
        <span>{limitsLine(task)}</span>
        {allowed > 0 && (
          <>
            <span className="sd-bar" aria-hidden="true">
              <span
                className="sd-bar__part sd-bar__part--brand"
                style={{ width: `${Math.min(100, (used / allowed) * 100)}%` }}
              ></span>
            </span>
            <span className="sd-meta">
              {used} of {allowed} used
            </span>
          </>
        )}
      </div>
      {dependencies.length > 0 && (
        <div className="sd-detail" style={{ gap: 'var(--space-6)' }}>
          <span className="sd-eyebrow">Waits for</span>
          {dependencies.map(id => {
            const other = studio.tasks.find(item => item.id === id),
              { met, words } = other ? prerequisite(other, studio, stories) : { met: false, words: id };
            return (
              <Link
                key={id}
                to="/p/$projectId/tasks/$taskId"
                params={{ projectId, taskId: id }}
                style={{
                  display: 'flex',
                  gap: 'var(--space-8)',
                  alignItems: 'center',
                  color: 'var(--ink)',
                  textDecoration: 'none',
                }}
              >
                <span className={`sd-chip sd-chip--inline${met ? ' sd-chip--ok' : ''}`} style={{ padding: '0 7px' }}>
                  <span className="sd-chip__dot"></span>
                </span>
                <span style={{ minWidth: 0 }}>{words}</span>
              </Link>
            );
          })}
        </div>
      )}
      <div className="sd-detail">
        <span className="sd-eyebrow">House rules here</span>
        <span style={{ color: 'var(--ink-2)', fontSize: '14px' }}>{houseRules(task, studio)}</span>
      </div>
      <OwnerForm projectId={projectId} task={task} studio={studio} />
    </section>
  );
}

// Which CLI, model, effort and mode the task's future attempts use: the employee's settings, or this task's own
// override (app-work.js taskExecutionForm). The form keeps what the director chose until it is saved.
function TaskExecution({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const toast = useToast(),
    adapters = studio.adapters ?? {},
    owner = [...studio.workers, ...(studio.employeeDirectory ?? [])].find(worker => worker.id === task.workerId),
    override = task.execution as Execution | undefined,
    [value, setValue] = useState<Execution>(override ?? {}),
    editable = !running(task.status) && !['done', 'denied'].includes(task.status);
  const save = useMutation({
    mutationFn: () =>
      send(
        `/api/tasks/${encodeURIComponent(task.id)}`,
        { projectId, execution: cleanExecution(adapters, value, owner) },
        'PATCH',
      ),
    onSuccess: () => toast('Saved for this task’s future attempts.'),
    onError: error => toast(error.message),
  });
  if (!editable)
    return (
      <span className="sd-meta" style={{ marginTop: 'var(--space-6)' }}>
        Recorded attempts keep the settings they started with.
      </span>
    );
  return (
    <form
      className="sd-detail"
      style={{ gap: 'var(--space-10)', marginTop: 'var(--space-8)' }}
      onSubmit={event => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <span className="sd-meta">
        Overrides {owner?.displayName ?? 'the agent'}&apos;s settings for this task&apos;s future attempts. Leave blank
        to use the agent&apos;s settings.
      </span>
      <ExecutionFields adapters={adapters} value={value} onChange={setValue} inherit={owner} />
      <button
        className="sd-btn sd-btn--sm sd-btn--primary"
        style={{ alignSelf: 'flex-start' }}
        disabled={save.isPending}
      >
        Save execution settings
      </button>
    </form>
  );
}

// The draft is the page's own state: it starts from the recorded direction and survives every refresh. A
// revision request sends it too.
function Direction({
  projectId,
  taskId,
  value,
  dirty,
  onChange,
  status,
}: {
  projectId: string;
  taskId: string;
  value: string;
  dirty: boolean;
  onChange: (value: string | null) => void;
  status: string;
}) {
  const editable = !running(status) && !['done', 'denied'].includes(status);
  const save = useMutation({
    mutationFn: (direction: string) =>
      send(`/api/tasks/${encodeURIComponent(taskId)}`, { projectId, direction }, 'PATCH'),
    onSuccess: () => onChange(null),
  });
  if (!editable && !value.trim()) return null;
  return (
    <div className="sd-field" aria-label="Direction">
      <label className="sd-eyebrow" htmlFor="task-direction">
        Direction for the next attempt
      </label>
      <textarea
        id="task-direction"
        className="sd-textarea"
        value={value}
        readOnly={!editable}
        onChange={event => onChange(event.target.value)}
      />
      {editable ? (
        <button
          type="button"
          className="sd-btn sd-btn--sm"
          style={{ alignSelf: 'flex-start' }}
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(value)}
        >
          Save future direction
        </button>
      ) : (
        <span className="sd-meta">Recorded attempts keep the direction they started with.</span>
      )}
      {save.error && <p role="alert">{save.error.message}</p>}
    </div>
  );
}

const lineLimit = 300;

// One attempt's trace as a conversation under a line naming who worked on which step, with the raw log a click
// away. The trace loads when the tab opens and, while the attempt runs, follows it.
function Conversation({
  projectId,
  task,
  studio,
  attempts,
  attempt,
  trace,
  looks,
  before,
  onBefore,
  onRaw,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  trace?: AttemptTrace;
  looks: Map<string, AgentLook>;
  before?: string;
  onBefore?: () => void;
  onRaw: () => void;
}) {
  const live = running(attempt.status),
    look = looks.get(attempt.workerId ?? ''),
    model = (attempt.reportedModel ?? attempt.requestedModel) as string | undefined,
    provider = cliName(studio, attempt),
    heading = [
      `${workerName(studio, attempt.workerId)} · ${attemptName(task, attempts, attempt)}`,
      provider ? [provider, model].filter(Boolean).join(', ') : '',
      clockOf(attempt.startedAt),
    ]
      .filter(Boolean)
      .join(' · ');
  if (!trace)
    return (
      <>
        <div className="sd-divider">{heading}</div>
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Reading what {workerName(studio, attempt.workerId)} did…
        </p>
      </>
    );
  return (
    <TraceActivity
      projectId={projectId}
      taskId={task.id}
      attempt={attempt}
      trace={trace}
      live={live}
      face={look && <AgentAvatar look={look} size={34} state={live ? 'working' : 'idle'} ring={false} />}
      heading={heading}
      cli={provider || 'The CLI'}
      before={before}
      onBefore={onBefore}
      actions={
        <button type="button" className="sd-btn sd-btn--ghost" style={{ flex: '1 1 160px' }} onClick={onRaw}>
          Raw log
        </button>
      }
    />
  );
}

// The attempt shown as it runs, on the Result tab: its conversation, and how the attempts before it ended. A
// controller that recorded no trace shows the raw log alone. `lead` is a line above the conversation.
function Activity({
  projectId,
  task,
  studio,
  attempt,
  looks,
  onAttempts,
  lead,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  onAttempts: () => void;
  lead?: ReactNode;
}) {
  const trace = useTrace(projectId, attempt.id, running(attempt.status)),
    [raw, setRaw] = useState(false),
    sameKind = studio.attempts.filter(item => item.taskId === task.id && isReview(item) === isReview(attempt));
  if (trace.error || trace.data?.source === 'none' || raw)
    return (
      <>
        {lead && (
          <div className="sd-tabpanel" style={{ paddingBottom: 0 }}>
            {lead}
          </div>
        )}
        <RawActivity projectId={projectId} task={task} studio={studio} attempt={attempt} looks={looks} />
        {raw && (
          <div className="sd-tabpanel" style={{ paddingTop: 0 }}>
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setRaw(false)}
            >
              Back to the conversation
            </button>
          </div>
        )}
      </>
    );
  return (
    <div className="sd-tabpanel" style={{ gap: '12px' }}>
      {lead}
      <Conversation
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={sameKind}
        attempt={attempt}
        trace={trace.data}
        looks={looks}
        before={beforeThis(sameKind, attempt, item => cliName(studio, item))}
        onBefore={onAttempts}
        onRaw={() => setRaw(true)}
      />
    </div>
  );
}

// One attempt in the story's Activity. One with no recorded trace shows its raw log.
function Chapter(props: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
}) {
  const { projectId, task, studio, attempt, looks } = props,
    trace = useTrace(projectId, attempt.id, running(attempt.status)),
    [raw, setRaw] = useState(false);
  const recorded = !trace.error && trace.data?.source !== 'none';
  if (raw || !recorded)
    return (
      <>
        <RawActivity projectId={projectId} task={task} studio={studio} attempt={attempt} looks={looks} embedded />
        {raw && (
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            onClick={() => setRaw(false)}
          >
            Back to the conversation
          </button>
        )}
      </>
    );
  return <Conversation {...props} trace={trace.data} onRaw={() => setRaw(true)} />;
}

// Something you did, as your own message on the right, or something a house rule did for you, as a quiet line.
// Long words show their first lines until Show all.
function PartLine({ projectId, part }: { projectId: string; part: Part }) {
  const [whole, setWhole] = useState(false),
    limit = part.by === 'rule' ? 160 : 480,
    long = (part.words?.length ?? 0) > limit,
    words = part.words && (whole || !long ? part.words : clip(part.words, limit)),
    more = long && (
      <button type="button" className="sd-link" onClick={() => setWhole(!whole)}>
        {whole ? 'Show less' : 'Show all'}
      </button>
    );
  const chips = (part.files?.length || part.commands?.length) && (
    <span className="sd-bubble__chips">
      {part.files?.map(file => (
        <span
          key={file.path}
          className={`sd-file${file.kind === 'add' ? ' sd-file--add' : file.kind === 'del' ? ' sd-file--del' : ''}`}
        >
          {file.kind === 'add' ? '+ ' : file.kind === 'del' ? '− ' : ''}
          {file.path}
        </span>
      ))}
      {part.commands?.map(command => (
        <span key={command} className="sd-file sd-file--command" title={command}>
          {command}
        </span>
      ))}
    </span>
  );
  if (part.by === 'rule')
    return (
      <div className="sd-event sd-event--center">
        <span className="sd-chip sd-chip--brand sd-chip--inline">House rule</span>
        <span>
          {part.lead}
          {words ? `: ${words.replace(/\.$/, '')}` : ''} · {clockOf(part.at)}
        </span>
        {more}
        {chips}
      </div>
    );
  return (
    <div className="sd-say sd-say--mine">
      <div className="sd-bubble sd-bubble--mine">
        <span className="sd-bubble__lead">{part.lead}</span>
        {words && <span className="sd-bubble__words">{words}</span>}
        {chips}
        <div className="sd-meta">
          You · {clockOf(part.at)}
          {more && <> · {more}</>}
          {part.runId && (
            <>
              {' · '}
              <Link className="sd-link" to="/p/$projectId/runs/$runId" params={{ projectId, runId: part.runId }}>
                Open the idea
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// A story's Activity: everything that happened to it, in order. Each attempt's conversation under who worked on
// which step (Eli's build, then Morgan's review), your part between them (build plan area 16), and for a source
// story where its integration stands. The director (October 24): it showed one step at a time and felt like it was
// missing a lot.
function StoryActivity({
  projectId,
  task,
  studio,
  attempts,
  looks,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  looks: Map<string, AgentLook>;
}) {
  const startOf = (attempt: AttemptSummary) => Date.parse(String(attempt.startedAt ?? '')) || Infinity,
    ordered = [...attempts].sort((a, b) => startOf(a) - startOf(b)),
    stage = task.sourceStage,
    // A controller without the route, or one that failed to read it, leaves only the attempts.
    record = useQuery({
      queryKey: queryKeys.story(projectId, task.id),
      queryFn: ({ signal }) => getJSON<StoryActivityRecord>(storyActivityUrl(projectId, task.id), signal),
    }),
    parts = yourPart(record.data, {
      noun: isSourceStory(task) ? 'story' : 'task',
      worker: id => workerName(studio, id),
      team: id => studio.teams?.find(team => team.id === id)?.name ?? id,
      step: id => {
        const attempt = attempts.find(item => item.id === id);
        return !attempt || !isSourceStory(task) ? 'attempt' : isReview(attempt) ? 'review' : 'build';
      },
    }),
    integrating = parts.filter(part => part.integration),
    integration =
      integrating.length > 0 ||
      (isSourceStory(task) && (stage?.phase === 'integration' || stage?.current === 'integrated'));
  // Your part goes before the first attempt that started after it, or before the attempt it started.
  const between = parts.filter(part => !part.integration),
    blocks: ReactNode[] = [];
  let next = 0;
  for (const attempt of ordered) {
    for (
      ;
      next < between.length &&
      (Date.parse(between[next]!.at) < startOf(attempt) || between[next]!.opens === attempt.id);
      next++
    )
      blocks.push(<PartLine key={between[next]!.key} projectId={projectId} part={between[next]!} />);
    blocks.push(
      <Chapter
        key={attempt.id}
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        attempt={attempt}
        looks={looks}
      />,
    );
  }
  for (const part of between.slice(next)) blocks.push(<PartLine key={part.key} projectId={projectId} part={part} />);
  return (
    <div className="sd-tabpanel" style={{ gap: '12px' }}>
      {blocks}
      {!ordered.length && <p style={{ margin: 0, color: 'var(--ink-2)' }}>Nothing has run yet.</p>}
      {integration && (
        <>
          <div className="sd-divider">Integration</div>
          {integrating.map(part => (
            <PartLine key={part.key} projectId={projectId} part={part} />
          ))}
          {isSourceStory(task) && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{standing(task, studio).title}</p>}
        </>
      )}
    </div>
  );
}

const clockOf = (value?: string | null) =>
  value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

function RawActivity({
  projectId,
  task,
  studio,
  attempt,
  looks,
  embedded = false,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  // Inside the story's Activity, among the other attempts, rather than a panel of its own.
  embedded?: boolean;
}) {
  const stream = useLiveStream(),
    [lines, setLines] = useState<LogEvent[] | null>(null),
    [failure, setFailure] = useState(''),
    lastSeq = useRef(0),
    view = useRef<HTMLPreElement>(null),
    following = useRef(true),
    // The whole log replaces the last 300 lines when the director asks for it, a page of 500 at a time.
    [whole, setWhole] = useState<{ count: number; total: number | null; loading: boolean; error: string } | null>(null),
    limit = whole && !whole.loading && !whole.error ? Infinity : lineLimit,
    loaded = lines !== null,
    live = running(attempt.status),
    look = looks.get(attempt.workerId ?? ''),
    model = (attempt.reportedModel ?? attempt.requestedModel) as string | undefined,
    provider = cliName(studio, attempt);
  const readWhole = async () => {
    setWhole({ count: 0, total: null, loading: true, error: '' });
    const events: LogEvent[] = [];
    let after = 0,
      snapshot: number | undefined;
    try {
      for (;;) {
        const page = await getJSON<{ events: LogEvent[]; total: number; snapshot: number; nextCursor: number | null }>(
          `/api/attempts/${encodeURIComponent(attempt.id)}/logs?${projectQuery(projectId)}&limit=500&after=${after}${snapshot === undefined ? '' : `&snapshot=${snapshot}`}`,
        );
        snapshot ??= page.snapshot;
        events.push(...page.events);
        setWhole({ count: events.length, total: page.total, loading: page.nextCursor !== null, error: '' });
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
      // Lines the stream added while the pages loaded follow the snapshot.
      setLines(current => [...events, ...(current ?? []).filter(line => line.seq > (snapshot ?? 0))]);
      lastSeq.current = Math.max(lastSeq.current, events.at(-1)?.seq ?? 0);
    } catch (error) {
      setWhole(current => ({
        count: current?.count ?? 0,
        total: current?.total ?? null,
        loading: false,
        error: (error as Error).message,
      }));
    }
  };
  useEffect(() => {
    if (loaded) return;
    const controller = new AbortController();
    getJSON<LogEvent[]>(logsUrl(projectId, attempt.id), controller.signal)
      .then(events => {
        lastSeq.current = events.at(-1)?.seq ?? 0;
        setLines(events.slice(-lineLimit));
      })
      .catch(error => {
        if (!controller.signal.aborted) setFailure(error.message);
      });
    return () => controller.abort();
  }, [loaded, projectId, attempt.id]);
  useEffect(() => {
    if (!loaded || !live) return;
    const unsubscribe = stream.subscribe({
      log: event => {
        if (event.attempt_id !== attempt.id || event.seq <= lastSeq.current) return;
        lastSeq.current = event.seq;
        setLines(current => [...(current ?? []), event].slice(-limit));
      },
    });
    stream.watchLog(attempt.id, lastSeq.current);
    return () => {
      unsubscribe();
      stream.watchLog(null);
    };
  }, [loaded, live, stream, attempt.id, limit]);
  // A reader scrolled to the end follows new lines; one reading further up keeps their place.
  useLayoutEffect(() => {
    const element = view.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [lines]);
  return (
    <div
      className={embedded ? undefined : 'sd-tabpanel'}
      style={embedded ? { display: 'flex', flexDirection: 'column', gap: '12px' } : { gap: '12px' }}
    >
      <div className="sd-divider">
        {[
          `${workerName(studio, attempt.workerId)} · ${attemptName(
            task,
            studio.attempts.filter(item => item.taskId === task.id),
            attempt,
          )}`,
          provider ? [provider, model].filter(Boolean).join(', ') : '',
          when(attempt.startedAt),
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {live && look && (
        <div className="sd-say" aria-label={`${workerName(studio, attempt.workerId)} is working`}>
          <AgentAvatar look={look} size={34} state="working" ring={false} />
          <span className="sd-typing" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
        </div>
      )}
      {failure ? (
        <p role="alert" style={{ margin: 0 }}>
          The activity could not be loaded: {failure}
        </p>
      ) : !loaded ? (
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Loading recent activity…
        </p>
      ) : (
        <pre
          ref={view}
          className="sd-code sd-code--block"
          aria-label="Raw log"
          onScroll={event => {
            const element = event.currentTarget;
            following.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 2;
          }}
        >
          {lines.map(line => `${line.time} ${line.message}`).join('\n')}
        </pre>
      )}
      {attempt.result?.summary && (
        <div
          style={{
            marginLeft: look ? '44px' : 0,
            padding: '14px 16px',
            borderRadius: '16px',
            border: '1.5px solid var(--brand)',
            background: 'var(--brand-soft)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-8)',
          }}
        >
          <span className="sd-eyebrow" style={{ color: 'var(--brand-text)' }}>
            Handed off{attempt.finishedAt ? ` · ${when(attempt.finishedAt)}` : ''}
          </span>
          <b style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{attempt.result.summary}</b>
        </div>
      )}
      {loaded && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-8)',
            alignItems: 'center',
            paddingTop: 'var(--space-8)',
            borderTop: '1.5px solid var(--line)',
          }}
        >
          <span className="sd-meta" style={{ flex: 1 }} role="status">
            {whole
              ? `${whole.count} of ${whole.total ?? '?'} event lines read${whole.loading ? ' · Loading…' : whole.error ? ` · Load failed: ${whole.error}` : ' · Complete.'}`
              : live
                ? 'The raw log, streaming while this tab is open.'
                : `The raw log, the last ${lineLimit} lines.`}
          </span>
          {(!whole || whole.error) && (
            <button type="button" className="sd-btn sd-btn--sm" onClick={() => void readWhole()}>
              Show every line
            </button>
          )}
          <a
            className="sd-btn sd-btn--sm sd-btn--ghost"
            href={`/api/attempts/${encodeURIComponent(attempt.id)}/logs/download?${projectQuery(projectId)}`}
            download
          >
            Download log
          </a>
        </div>
      )}
    </div>
  );
}
