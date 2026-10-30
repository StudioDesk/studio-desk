// A task's page, as the canvas's Story board draws it (v1.0 item 23): where the story is in its steps, where it
// stands with the director's decisions, the evidence it rests on, its attempts and its tabs, and beside them its brief
// and who works on it under which rules. The task and its attempts refresh when that task, one of its attempts or one of its recorded steps
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
import { TraceActivity } from './activity';
import { carryWords, type CarryRecord } from './carries';
import { askedPaths, fileRequest } from './decisions';
import { AgentAvatar } from './design/avatar';
import { agentState, attemptState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Clapper, Icon } from './design/icons';
import { diffStatOf, effortWords, plural, reviewOf, sandboxed, spoken, testTime, totalsOf } from './evidence';
import { cleanExecution, ExecutionFields } from './execution-fields';
import { NewUpdates, useFollow } from './follow';
import { isCodeProject } from './frame';
import { workerName } from './names';
import { PagesPanel, PagesTile } from './pages-panel';
import { CommandRequest, TaskAutoMode } from './permissions';
import { AnswerBox, QuestionCard } from './question-card';
import { changeableAnswer, exchange, waitingQuestion, type Answer, type Exchange } from './questions';
import { queryKeys, useStudio } from './records';
import { StoryReleaseChip } from './release-chip';
import { SourceDiff } from './source-story';
import { factsLine, storyFacts } from './stands';
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
  type Stage,
  type Step,
} from './story';
import {
  attemptChip,
  attemptName,
  AttemptStrip,
  BriefCard,
  briefEditId,
  ChecksPanel,
  HandedBack,
  isReview,
  keepInRow,
  proposer,
  ranOn,
  ResultPanel,
  ReviewVerdict,
  stagedWork,
  StandsInFull,
  standsInFullId,
} from './story-tabs';
import { useLiveStream, useStreamReady } from './stream-context';
import { active, explain, liveSummary, statusOf, type RunStory, type StudioState } from './studio-runs';
import { DecisionNotes, NextAttemptTools, OwnerForm, TaskDecisions } from './task-decisions';
import { agentLooks, placeIn, quoted, when } from './today';
import { useToast } from './toast';
import type { AttemptTrace } from './trace';
import { useTrace } from './trace-page';
import { tryOffered } from './try-it';
import { TriedTile, TryPanel } from './try-panel';
import { useNarrow } from './use-narrow';
import { useNow } from './use-now';
import { pagesTabShown, useStoryPages, useVisualRecord, useVisualView } from './visual-check';
import { clip, yourPart, type Part } from './your-part';

const running = (status: string) => status === 'running' || status === 'stopping';
const projectQuery = (projectId: string) => `projectId=${encodeURIComponent(projectId)}`;

// The project's records with this page's task and attempts, which are the newest the page holds.
export function withPage(state: StudioState, page: TaskPage): StudioState {
  const ids = new Set(page.attempts.map(attempt => attempt.id));
  return {
    ...state,
    tasks: [...state.tasks.filter(task => task.id !== page.task.id), page.task],
    attempts: [...state.attempts.filter(attempt => !ids.has(attempt.id)), ...page.attempts],
  };
}

// `tab` is the tab the story's address names, which it opens on once the story shows that tab.
export function TaskView({ projectId, taskId, tab }: { projectId: string; taskId: string; tab?: TabId }) {
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
  return (
    <Story
      projectId={projectId}
      task={data.task}
      attempts={data.attempts}
      studio={studio}
      live={state}
      initialTab={tab}
    />
  );
}

// "Ideas / “the idea” / Story 3 of 4", or "Ideas / T-1" for work outside any idea; with `story`, a page under the
// story's: "Ideas / “the idea” / Story 3 / Record of attempt 2".
export function Crumbs({
  projectId,
  here,
  idea,
  story,
}: {
  projectId: string;
  here: string;
  idea?: { runId: string; brief: string } | null;
  story?: { taskId: string; label: string };
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
      {story && (
        <>
          <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: story.taskId }}>
            {story.label}
          </Link>
          <span aria-hidden="true">/</span>
        </>
      )}
      <span aria-current="page">{here}</span>
    </nav>
  );
}

export type TabId = 'changes' | 'checks' | 'pages' | 'try' | 'activity' | 'overview' | 'details';
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
  initialTab,
}: {
  projectId: string;
  task: Task;
  attempts: AttemptSummary[];
  studio: StudioState;
  live: StudioState;
  initialTab?: TabId;
}) {
  const narrow = useNarrow(),
    [draft, setDraft] = useState<string | null>(null),
    [chosen, setChosen] = useState<string | null>(null),
    [picked, setPicked] = useState<TabId | null>(initialTab ?? null),
    // Each use of the notice's link to its full account, which brings that account into view once its tab shows.
    [reading, setReading] = useState(0),
    // Each use of the notice's Edit the file list, which brings the brief's file form into view.
    [editing, setEditing] = useState(0),
    // The chapters in Activity the director opened or folded, by attempt; the rest open as StoryActivity opens them.
    [opened, setOpened] = useState<Record<string, boolean>>({}),
    // Each use of the review tile or of the attempt strip, which brings that attempt's chapter into view once
    // Activity shows, and the last use it brought into view.
    [revealing, setRevealing] = useState<{ attemptId: string; count: number } | null>(null),
    revealed = useRef(0),
    looks = useMemo(
      () => agentLooks(projectId, [...studio.workers, ...(studio.employeeDirectory ?? [])]),
      [projectId, studio.workers, studio.employeeDirectory],
    ),
    toast = useToast();
  const latest = attempts.find(attempt => attempt.id === task.lastAttemptId) ?? attempts.at(-1),
    // An agent's question waiting for an answer, and auto mode's answer the director may still change.
    asking = waitingQuestion(task, attempts),
    autoAnswer = changeableAnswer(task),
    // The attempt chosen in the strip, which every view shows, or else the latest.
    choice = attempts.find(attempt => attempt.id === chosen),
    shown = choice ?? latest,
    detail = useAttemptDetail(projectId, shown?.id ?? '', !!shown),
    full = detail.data?.id === shown?.id ? detail.data : undefined,
    source = isSourceStory(task),
    // Unless an attempt is chosen, a staged task shows its own work first, then the later stage's attempt.
    work = !source && !chosen ? stagedWork(task, attempts, latest) : undefined,
    people = storyPeople(task, studio),
    // A story whose tests passed may be tried in the project's try copy: its Tried by you tile and Try it tab.
    tryable = source && tryOffered(task, studio),
    built = people.candidate ?? people.build,
    // The candidate's own record, for where its time went; the attempt shown's when that is the candidate.
    builtDetail = useAttemptDetail(projectId, built?.id ?? '', source && !!built && built.id !== shown?.id),
    builtFull = built?.id === shown?.id ? full : builtDetail.data?.id === built?.id ? builtDetail.data : undefined,
    // Checks reads the build attempt chosen, with its full record, or else the candidate.
    checked = choice && !isReview(choice) ? choice : built,
    checkedFull = checked?.id === shown?.id ? full : builtFull,
    // A code story in a code project has a Pages tab (1.2 step 8) once it names pages, its candidate recorded a visual
    // check, or the project's check is on and its pages may still change; other work reads neither view.
    code = source && isCodeProject(studio),
    pagesView = useStoryPages(projectId, task.id, code).data,
    visualView = useVisualView(projectId, code).data,
    visualRecord = useVisualRecord(projectId, code ? built : undefined).data,
    pagesShown = code && pagesTabShown({ pagesView, visualView, record: visualRecord }),
    // The open phase from the full record when it is the one shown, otherwise as the compact record carries it.
    phase = active(task) ? (latest?.id === shown?.id && full ? openPhase(full) : phaseOf(task, studio)) : null,
    status = statusOf(studio, task),
    stand = standing(task, studio, phase),
    explanation = explain(task, studio),
    direction = draft ?? task.direction ?? '',
    place = placeIn(liveSummary(liveState).stories, task),
    idea = place ? { runId: place.run.id, brief: place.run.brief } : null,
    here = place && place.index > 0 ? `Story ${place.index} of ${place.total}` : task.id,
    // A source story's release (1.1): it moves from its chip until it starts.
    release = (
      <StoryReleaseChip
        projectId={projectId}
        task={task}
        run={studio.runs.find(run => run.id === idea?.runId)}
        tasks={studio.tasks}
        attempts={attempts}
      />
    ),
    stat = diffStatOf(built),
    // On a phone the chip says what the running attempt is doing: "Testing · attempt 4".
    liveLabel = active(task)
      ? isReview(latest)
        ? 'Reviewing'
        : `${phase ? (testingPhases.includes(phase) ? 'Testing' : 'Editing') : 'Working'}${latest ? ` · ${attemptName(task, attempts, latest, true).replace(/^A/, 'a')}` : ''}`
      : null;
  // The attempts are the strip above the tabs, not a tab of their own, and everything recorded about the one shown is
  // its own page, linked from Details. Pages follows Checks when it shows, and Try it follows them once the story's
  // tests passed.
  const pagesTab: Tab[] = pagesShown ? [{ id: 'pages', label: 'Pages' }] : [];
  const tryTab: Tab[] = tryable ? [{ id: 'try', label: 'Try it' }] : [];
  const tabs: Tab[] = narrow
    ? [
        { id: 'activity', label: 'Activity' },
        source ? { id: 'changes', label: 'Changes', count: stat?.files } : { id: 'overview', label: 'Overview' },
        ...(source ? [{ id: 'checks' as const, label: 'Checks' }] : []),
        ...pagesTab,
        ...tryTab,
        { id: 'details', label: 'Details' },
      ]
    : [
        ...(source
          ? [
              { id: 'changes' as const, label: 'Changes', count: stat?.files },
              { id: 'checks' as const, label: 'Checks' },
              ...pagesTab,
              ...tryTab,
            ]
          : [{ id: 'overview' as const, label: 'Overview' }]),
        { id: 'activity', label: 'Activity' },
      ];
  // A story with a candidate opens on its change, other work with an attempt on its Overview of what that attempt
  // returned; the rest on what happened to it. What was asked is the brief beside the tabs.
  const fallback: TabId = source ? (people.candidate ? 'changes' : 'activity') : shown ? 'overview' : 'activity',
    tab = tabs.some(item => item.id === picked) ? picked! : fallback;
  // The brief, then who works on it and under which rules: beside the tabs, or under Details on a phone.
  const sideCards = (
    <>
      <BriefCard
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
      </BriefCard>
      <People task={task} studio={studio} looks={looks} />
      <Details
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        shown={shown}
        stories={liveSummary(liveState).stories}
      />
    </>
  );
  // The review tile, and Open Activity on other work's Overview while its attempt runs, open Activity with that
  // attempt's chapter open and bring the chapter into view.
  const showChapter = (attemptId?: string) => {
    setPicked('activity');
    if (!attemptId) return;
    setOpened(current => ({ ...current, [attemptId]: true }));
    setRevealing(current => ({ attemptId, count: (current?.count ?? 0) + 1 }));
  };
  // Choosing an attempt in the strip shows it in every view: its change, its checks, the link to its record in
  // Details, and its chapter in Activity, opened and brought into view there. Choosing the latest, or Back to the
  // latest, clears the choice, and the chapter the choice opened folds or opens as it would.
  const chooseAttempt = (attemptId: string) => {
    setOpened(current => {
      const next = { ...current, [attemptId]: true };
      if (chosen && chosen !== attemptId) delete next[chosen];
      return next;
    });
    setChosen(attemptId === latest?.id ? null : attemptId);
    setRevealing(current => ({ attemptId, count: (current?.count ?? 0) + 1 }));
  };
  const backToLatest = () => {
    if (latest) chooseAttempt(latest.id);
  };
  // The notice's whole account heads a story's Checks, and other work's Overview. The review is its own chapter in
  // Activity.
  const panels: Record<TabId, () => ReactNode> = {
    changes: () => <SourceDiff task={task} studio={studio} selectedAttemptId={chosen ?? undefined} />,
    checks: () => (
      <>
        <StandsInFull task={task} stand={stand} />
        <ChecksPanel projectId={projectId} task={task} studio={studio} attempt={checked} full={checkedFull} />
      </>
    ),
    pages: () => <PagesPanel projectId={projectId} task={task} studio={studio} />,
    try: () => <TryPanel projectId={projectId} task={task} studio={studio} />,
    activity: () => (
      <StoryActivity
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        looks={looks}
        opened={opened}
        onToggle={(id, open) => setOpened(current => ({ ...current, [id]: open }))}
        focus={revealing?.attemptId}
      />
    ),
    // Other work's Overview: what the latest attempt, or the one chosen, returned, under where it stands in full. A
    // staged task shows its own work first, then the later step's attempt. While the attempt runs, who is working on
    // it now; its live conversation is its chapter in Activity, and what it returns shows here when it hands back.
    overview: () => (
      <>
        <StandsInFull task={task} stand={stand} />
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
          <WorkingNow studio={studio} attempt={shown} onOpen={() => showChapter(shown.id)} />
        ) : (
          <ResultPanel projectId={projectId} task={task} studio={studio} shown={shown} />
        )}
      </>
    ),
    details: () => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)', paddingTop: 'var(--space-14)' }}>
        {sideCards}
      </div>
    ),
  };
  // The chosen tab stays in view in the phone's scrolling row of tabs; only the row scrolls, never the page.
  useEffect(() => keepInRow(document.getElementById(`story-tab-${tab}`)), [tab]);
  useEffect(() => {
    if (reading) document.getElementById(standsInFullId)?.scrollIntoView?.({ block: 'start' });
  }, [reading]);
  const readInFull = () => {
    setPicked(source ? 'checks' : 'overview');
    setReading(count => count + 1);
  };
  // The chapter showChapter or the strip opened comes into view once Activity shows it: at once, or when the director
  // next opens Activity after choosing an attempt on another tab, and once for each use. A finished chapter shows from
  // its start; a running one ends at its newest lines, which it then follows.
  useEffect(() => {
    if (!revealing || revealing.count === revealed.current || tab !== 'activity') return;
    const chapter = document.getElementById(chapterId(revealing.attemptId));
    if (!chapter) return;
    revealed.current = revealing.count;
    const live = attempts.some(attempt => attempt.id === revealing.attemptId && running(attempt.status));
    chapter.scrollIntoView?.({ block: live ? 'end' : 'start' });
  }, [revealing, tab, attempts]);
  // The brief's file form, opened and brought into view where the brief shows: beside the tabs, which stay as they
  // are, or under Details on a phone.
  useEffect(() => {
    const form = editing ? document.getElementById(briefEditId) : null;
    if (!form) return;
    const disclosure = form.querySelector('details');
    if (disclosure) disclosure.open = true;
    form.scrollIntoView?.({ block: 'start' });
  }, [editing]);
  const editFiles = () => {
    if (narrow) setPicked('details');
    setEditing(count => count + 1);
  };
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
          {release}
          <span className="sd-mono sd-meta">{task.id}</span>
        </div>
        <div className="sd-storyhead__kind sd-narrow-only">
          <span className={`sd-chip sd-chip--${stand.tone}`}>
            <span className="sd-chip__dot"></span>
            {liveLabel ?? stand.chip ?? status.label}
          </span>
          {release}
        </div>
        <h1 className="sd-storyhead__title">{task.title}</h1>
        <Steps steps={storySteps(task, studio, phase)} />
      </header>
      {/* The question an agent stopped to ask comes first, with the box that answers it. */}
      {asking && (
        <QuestionCard key={asking.id} projectId={projectId} state={studio} task={task} attempt={asking}>
          <AnswerBox
            projectId={projectId}
            state={studio}
            task={task}
            attempt={asking}
            onSent={() =>
              toast(`Answered. ${workerName(studio, asking.workerId ?? task.workerId)} continues from its saved work.`)
            }
          />
        </QuestionCard>
      )}
      {autoAnswer && (
        <AutoAnswer
          key={`${autoAnswer.attemptId} ${autoAnswer.at ?? ''}`}
          projectId={projectId}
          task={task}
          studio={studio}
          attempts={attempts}
          answer={autoAnswer}
        />
      )}
      <Stands
        projectId={projectId}
        task={task}
        studio={studio}
        attempts={attempts}
        phase={phase}
        looks={looks}
        narrow={narrow}
        direction={direction}
        onEditFiles={editFiles}
        onRevised={() => setDraft(null)}
        onReadInFull={readInFull}
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
        <Tiles
          projectId={projectId}
          task={task}
          studio={studio}
          looks={looks}
          tryable={tryable}
          pages={pagesShown}
          onShow={setPicked}
          onReview={() => showChapter(people.review?.id)}
        />
      )}
      <AttemptStrip
        task={task}
        studio={studio}
        attempts={attempts}
        shown={shown}
        chosen={choice && choice.id !== latest?.id ? choice : undefined}
        onChoose={chooseAttempt}
        onLatest={backToLatest}
        looks={looks}
      />
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

// Where it stands: the director's call or the work moving in one sentence, in the agents' words, with a line of the
// facts under it (its tests, its review and the attempts it used), then the decisions it offers. A shortened notice
// links to its full account under Checks, or other work's Overview.
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
  onRevised,
  onReadInFull,
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
  onRevised: () => void;
  onReadInFull: () => void;
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
    facts = factsLine(storyFacts(task, studio, phase)),
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
        <div className="sd-stands__facts">{facts}</div>
        {(stand.detail || stand.shortened) && (
          <div className="sd-stands__detail">
            {stand.detail}
            {stand.shortened && (
              <>
                {stand.detail && ' '}
                <button type="button" className="sd-link" onClick={onReadInFull}>
                  Read why in {isSourceStory(task) ? 'Checks' : 'Overview'}
                </button>
              </>
            )}
          </div>
        )}
        {elapsed !== null && limit > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: 'var(--space-6)' }}>
            <span className="sd-bar" aria-hidden="true">
              <span
                className="sd-bar__part sd-bar__part--live"
                style={{ width: `${Math.min(100, (elapsed / limit) * 100)}%` }}
              ></span>
            </span>
            <span className="sd-meta">
              {spoken(elapsed)} of {spoken(limit)}
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
        onRevised={onRevised}
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

// Auto mode's answer the director may still change (questions.ts changeableAnswer): what the agent asked and what
// auto mode chose, with Change the answer, which opens the Answer box in change mode.
function AutoAnswer({
  projectId,
  task,
  studio,
  attempts,
  answer,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  answer: Answer;
}) {
  const toast = useToast(),
    [changing, setChanging] = useState(false),
    asking = attempts.find(attempt => attempt.id === answer.attemptId);
  if (!asking?.question?.ask) return null;
  const name = workerName(studio, asking.workerId ?? task.workerId),
    chose = [answer.label, answer.text].filter(Boolean).join(' — ');
  return (
    <section className="sd-card sd-decision" aria-label="Auto mode's answer">
      <div className="sd-decision__head">
        <span className="sd-chip">
          <span className="sd-chip__dot"></span>
          Auto mode answered
        </span>
        <span className="sd-meta sd-decision__time">{when(answer.at ?? answer.by?.at)}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <span className="sd-meta">{name} asked</span>
        <div style={{ fontWeight: 700, textWrap: 'pretty' }}>{asking.question.ask}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <span className="sd-meta">Auto mode chose</span>
        <div style={{ textWrap: 'pretty' }}>{chose}</div>
      </div>
      {changing ? (
        <AnswerBox
          projectId={projectId}
          state={studio}
          task={task}
          attempt={asking}
          change
          onSent={() => toast(`Changed the answer. ${name} reworks from its saved work.`)}
        />
      ) : (
        <div className="sd-decision__actions">
          <button type="button" className="sd-btn sd-btn--sm" onClick={() => setChanging(true)}>
            Change the answer
          </button>
        </div>
      )}
    </section>
  );
}

// The change and its tests, each opening its tab, and its review, which opens the review's chapter in Activity; once
// its tests passed, whether the director tried it, which opens Try it; and while the story shows its Pages tab, what
// its visual check captured, which opens Pages.
function Tiles({
  projectId,
  task,
  studio,
  looks,
  tryable,
  pages,
  onShow,
  onReview,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  looks: Map<string, AgentLook>;
  tryable: boolean;
  pages: boolean;
  onShow: (tab: TabId) => void;
  onReview: () => void;
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
        onClick={onReview}
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
      {tryable && <TriedTile projectId={projectId} taskId={task.id} onShow={() => onShow('try')} />}
      {pages && <PagesTile projectId={projectId} task={task} studio={studio} onShow={() => onShow('pages')} />}
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
// them, and the link to everything recorded about the attempt shown (the one chosen in the strip, or else the
// latest), once one has run. Change opens what changes the next attempt: its CLI and model, its auto mode and a
// preview of what it will be told.
function Details({
  projectId,
  task,
  studio,
  attempts,
  shown,
  stories,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  shown?: AttemptSummary;
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
      {shown && (
        <Link
          className="sd-link"
          style={{ alignSelf: 'flex-start' }}
          to="/p/$projectId/tasks/$taskId/attempts/$attemptId/record"
          params={{ projectId, taskId: task.id, attemptId: shown.id }}
        >
          Everything recorded about this attempt
        </Link>
      )}
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
// revision request's note starts from it; once the controller records that request, the draft is dropped and the
// field shows the direction it recorded.
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
  onRaw,
  follows,
  opens,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  trace?: AttemptTrace;
  looks: Map<string, AgentLook>;
  onRaw: () => void;
  follows: boolean;
  opens: boolean;
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
      follows={follows}
      opens={opens}
      actions={
        <button type="button" className="sd-btn sd-btn--ghost" style={{ flex: '1 1 160px' }} onClick={onRaw}>
          Raw log
        </button>
      }
    />
  );
}

// The attempt shown as it runs, on other work's Overview: who is working on it now and the work it continued from.
// Its live conversation is its chapter in Activity, which Open Activity opens.
function WorkingNow({ studio, attempt, onOpen }: { studio: StudioState; attempt: AttemptSummary; onOpen: () => void }) {
  const carried = carriedOf(attempt);
  return (
    <div className="sd-tabpanel" style={{ gap: '12px' }}>
      <p style={{ margin: 0 }}>
        {workerName(studio, attempt.workerId)} is working on it now. What it returns shows here when it hands it back.
      </p>
      {carried && (
        <p className="sd-meta" style={{ margin: 0 }}>
          {continuation(carried)}
        </p>
      )}
      <button type="button" className="sd-btn sd-btn--sm" style={{ alignSelf: 'flex-start' }} onClick={onOpen}>
        Open Activity
      </button>
    </div>
  );
}

// The id of an attempt's chapter in the story's Activity, which the review tile brings into view.
const chapterId = (attemptId: string) => `chapter-${attemptId}`;

// One attempt in the story's Activity, under a line naming the attempt, who ran it and how it ended, which opens and
// folds it. A folded chapter is that line alone and reads nothing.
function Chapter({
  open,
  onToggle,
  ...props
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  follows: boolean;
  opens: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { task, studio, attempts, attempt, looks } = props,
    name = attemptName(task, attempts, attempt),
    look = looks.get(attempt.workerId ?? ''),
    [tone, label] = attemptChip(attempt);
  return (
    <section id={chapterId(attempt.id)} className="sd-attemptfold" aria-label={name}>
      <button type="button" className="sd-attemptfold__line" aria-expanded={open} onClick={onToggle}>
        <span className="sd-attemptfold__mark" aria-hidden="true">
          <Icon name="down" size={16} weight={2.6} />
        </span>
        {look && <AgentAvatar look={look} size={28} state={attemptState(attempt)} ring={false} />}
        <span className="sd-attemptfold__name">
          <b>{name}</b> · {workerName(studio, attempt.workerId)}
        </span>
        <span className={`sd-chip${tone ? ` sd-chip--${tone}` : ''}`}>
          <span className="sd-chip__dot"></span>
          {label}
        </span>
      </button>
      {open && <ChapterBody {...props} />}
    </section>
  );
}

// An open chapter: what the attempt ran on, when and for how long, as its chip's title says, then what the agent did
// and said (its raw log when no trace was recorded), ending with what it handed back, or a review with its verdict.
// A running attempt's chapter is its live activity under the line that the agent is working on it now, which follows
// its newest moments in the page when it is the running chapter that follows (`follows`), and starts at them when
// it shows (`opens`). The attempt's full record is read only here.
function ChapterBody({
  projectId,
  task,
  studio,
  attempts,
  attempt,
  looks,
  follows,
  opens,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  follows: boolean;
  opens: boolean;
}) {
  const live = running(attempt.status),
    verdict = isReview(attempt) && !!attempt.finishedAt && !!reviewOf(attempt).verdict,
    trace = useTrace(projectId, attempt.id, live),
    detail = useAttemptDetail(projectId, attempt.id, !live && !verdict),
    full = detail.data?.id === attempt.id ? detail.data : undefined,
    [raw, setRaw] = useState(false),
    recorded = !trace.error && trace.data?.source !== 'none',
    // What it handed back ends the chapter, so its conversation leaves out the hand-off it would repeat.
    handedBack = !live && !!attempt.result?.summary,
    ran = ranOn(studio, attempt);
  return (
    <div className="sd-attemptfold__body">
      {ran.length > 0 && <span className="sd-meta">{ran.join(' · ')}</span>}
      {live && (
        <>
          <p style={{ margin: 0 }}>
            {workerName(studio, attempt.workerId)} is working on it now. What it returns shows here when it hands it
            back.
          </p>
          {carriedOf(attempt) && (
            <p className="sd-meta" style={{ margin: 0 }}>
              {continuation(carriedOf(attempt)!)}
            </p>
          )}
        </>
      )}
      {raw || !recorded ? (
        <>
          <RawActivity
            projectId={projectId}
            task={task}
            studio={studio}
            attempt={attempt}
            looks={looks}
            handoff={!handedBack}
          />
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
      ) : (
        <Conversation
          projectId={projectId}
          task={task}
          studio={studio}
          attempts={attempts}
          attempt={attempt}
          trace={trace.data && handedBack ? { ...trace.data, handoff: null } : trace.data}
          looks={looks}
          onRaw={() => setRaw(true)}
          follows={follows}
          opens={opens}
        />
      )}
      {!live && (
        <>
          <div className="sd-divider">{verdict ? 'Its verdict' : 'What it handed back'}</div>
          {verdict ? (
            <ReviewVerdict projectId={projectId} studio={studio} review={attempt} looks={looks} />
          ) : (
            <HandedBack
              projectId={projectId}
              task={task}
              studio={studio}
              attempt={attempt}
              full={full}
              proposals={proposer(task, attempts)?.id === attempt.id}
            />
          )}
        </>
      )}
    </div>
  );
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

// What an answer set the work's Auto mode to, when it set it: on, off, or back to following Settings.
const autoModeSet = (answer: Answer) =>
  answer.autoMode === true
    ? 'Set Auto mode on'
    : answer.autoMode === false
      ? 'Set Auto mode off'
      : answer.autoMode === null
        ? 'Set Auto mode to follow Settings'
        : '';

// The exchange an asking attempt started (questions.ts exchange), right after its conversation: what the agent asked
// and why, its options with the recommended one marked, then each answer as the controller recorded it. Auto mode's
// is a quiet line; yours is your own message, marked when it changed auto mode's. A question still waiting has no
// answer yet.
function QuestionExchange({
  task,
  studio,
  attempt,
  looks,
  asked,
  waiting,
}: {
  task: Task;
  studio: StudioState;
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  asked: Exchange;
  waiting: boolean;
}) {
  const { question, answers } = asked,
    workerId = attempt.workerId ?? task.workerId,
    name = workerName(studio, workerId),
    look = looks.get(workerId ?? ''),
    options = question.options ?? [];
  return (
    <section aria-label={`${name}'s question and its answers`} style={{ display: 'grid', gap: '12px' }}>
      <div className="sd-say">
        {look && <AgentAvatar look={look} size={34} state="idle" ring={false} />}
        <div className="sd-bubble">
          <span className="sd-meta">{name} asked you</span>
          <span className="sd-bubble__lead">{question.ask}</span>
          {question.why && <span className="sd-bubble__words">{question.why}</span>}
          {options.length > 0 && (
            <ul aria-label={`${name}'s options`} style={{ margin: 'var(--space-8) 0 0', paddingLeft: '20px' }}>
              {options.map((option, index) => (
                <li key={index}>
                  <b>{option.label}</b>
                  {option.detail && ` ${option.detail}`}
                  {question.recommended === index && (
                    <>
                      {' '}
                      <span className="sd-chip sd-chip--brand sd-chip--inline">Recommended</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="sd-meta" style={{ marginTop: '2px' }}>
            {clockOf(attempt.finishedAt)}
          </div>
        </div>
      </div>
      {answers.map((answer, index) => {
        const set = autoModeSet(answer),
          at = clockOf(answer.at ?? answer.by?.at);
        if (answer.by?.type === 'auto-mode')
          return (
            <div key={index} className="sd-event sd-event--center">
              <span className="sd-chip sd-chip--brand sd-chip--inline">Auto mode</span>
              <span>
                Chose {[answer.label, answer.text].filter(Boolean).join(' — ')}
                {set && ` · ${set}`} · {at}
              </span>
            </div>
          );
        return (
          <div key={index} className="sd-say sd-say--mine">
            <div className="sd-bubble sd-bubble--mine">
              <span className="sd-bubble__lead">
                {answer.replaces === 'auto-mode' ? "Changed auto mode's answer" : 'Answered'}
                {answer.label && `: ${answer.label}`}
              </span>
              {answer.text && <span className="sd-bubble__words">{answer.text}</span>}
              <div className="sd-meta">
                You · {at}
                {set && ` · ${set}`}
              </div>
            </div>
          </div>
        );
      })}
      {waiting && !answers.length && <div className="sd-event sd-event--center">No answer yet.</div>}
    </section>
  );
}

// A story's Activity: everything that happened to it, in order. Each attempt's chapter, which folds, under who worked
// on which step (Eli's build, then Morgan's review), the question an attempt asked with its answers right after it,
// your part between them (build plan area 16), and for a source story where its integration stands and where its fix
// went from there (1.1). The director (October 24): it showed one step at a time and felt like it was missing a lot.
// The latest attempt's chapter and a running one's open, the earlier ones folded, until the director opens or folds
// one (`opened`, the page's own state, so a refresh keeps it). One open running chapter follows its newest moments:
// the one the page last brought into view (`focus`), or else the newest. It starts at them as Activity shows it,
// unless the page brought another chapter into view.
function StoryActivity({
  projectId,
  task,
  studio,
  attempts,
  looks,
  opened,
  onToggle,
  focus,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempts: AttemptSummary[];
  looks: Map<string, AgentLook>;
  opened: Record<string, boolean>;
  onToggle: (attemptId: string, open: boolean) => void;
  focus?: string;
}) {
  const startOf = (attempt: AttemptSummary) => Date.parse(String(attempt.startedAt ?? '')) || Infinity,
    ordered = [...attempts].sort((a, b) => startOf(a) - startOf(b)),
    isOpen = (attempt: AttemptSummary) => opened[attempt.id] ?? (attempt === ordered.at(-1) || running(attempt.status)),
    runningOpen = ordered.filter(attempt => running(attempt.status) && isOpen(attempt)),
    follower = runningOpen.find(attempt => attempt.id === focus) ?? runningOpen.at(-1),
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
    // The carries of the review attempt whose integration they follow, forward or brought back.
    review = attempts.find(item => item.id === (stage as Stage | null | undefined)?.review?.attemptId),
    carries = (isSourceStory(task) && review?.sourceCarries) || [],
    integration =
      integrating.length > 0 ||
      carries.length > 0 ||
      (isSourceStory(task) && (stage?.phase === 'integration' || stage?.current === 'integrated'));
  // Your part goes before the first attempt that started after it, or before the attempt it started.
  const between = parts.filter(part => !part.integration),
    waiting = waitingQuestion(task, attempts),
    blocks: ReactNode[] = [];
  let next = 0;
  for (const attempt of ordered) {
    const open = isOpen(attempt);
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
        follows={attempt === follower}
        opens={attempt === follower && (!focus || focus === attempt.id)}
        open={open}
        onToggle={() => onToggle(attempt.id, !open)}
      />,
    );
    const asked = exchange(task, attempt);
    if (asked)
      blocks.push(
        <QuestionExchange
          key={`${attempt.id} exchange`}
          task={task}
          studio={studio}
          attempt={attempt}
          looks={looks}
          asked={asked}
          waiting={waiting?.id === attempt.id}
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
          {carries.length > 0 && <Carries projectId={projectId} carries={carries} studio={studio} />}
        </>
      )}
    </div>
  );
}

// Each carry in the words the Releases page uses, a story it waits for linked to its page.
function Carries({ projectId, carries, studio }: { projectId: string; carries: CarryRecord[]; studio: StudioState }) {
  const titleOf = (id: string) => studio.tasks.find(item => item.id === id)?.title;
  return (
    <ul aria-label="Carries" style={{ margin: 0, paddingLeft: '20px', color: 'var(--ink-2)' }}>
      {carries.map((carry, index) => {
        const words = carryWords(carry, titleOf),
          parts: ReactNode[] = [];
        let from = 0;
        for (const id of carry.after ?? []) {
          const at = words.indexOf(id, from);
          if (at < 0) continue;
          parts.push(
            words.slice(from, at),
            <Link key={at} className="sd-link" to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: id }}>
              {id}
            </Link>,
          );
          from = at + id.length;
        }
        parts.push(words.slice(from));
        return <li key={`${index}-${carry.line}`}>{parts}</li>;
      })}
    </ul>
  );
}

const clockOf = (value?: string | null) =>
  value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

// An attempt's raw log, inside its chapter in the story's Activity.
function RawActivity({
  projectId,
  task,
  studio,
  attempt,
  looks,
  handoff = true,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  attempt: AttemptSummary;
  looks: Map<string, AgentLook>;
  // Whether it shows the summary the attempt handed off, which a chapter ending with what it handed back leaves out.
  handoff?: boolean;
}) {
  const stream = useLiveStream(),
    [lines, setLines] = useState<LogEvent[] | null>(null),
    [failure, setFailure] = useState(''),
    lastSeq = useRef(0),
    // The lines the stream added, which New updates counts. The 300 lines shown stop growing, and a line's seq
    // numbers every event in the studio, other attempts' lines among them.
    [arrived, setArrived] = useState(0),
    // The whole log replaces the last 300 lines when the director asks for it, a page of 500 at a time.
    [whole, setWhole] = useState<{ count: number; total: number | null; loading: boolean; error: string } | null>(null),
    limit = whole && !whole.loading && !whole.error ? Infinity : lineLimit,
    loaded = lines !== null,
    live = running(attempt.status),
    // A reader at the end follows new lines; one reading further up keeps their place, with New updates.
    [attach, follow] = useFollow({ mode: 'box', count: arrived, live }),
    { jump } = follow,
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
        setArrived(count => count + 1);
      },
    });
    stream.watchLog(attempt.id, lastSeq.current);
    return () => {
      unsubscribe();
      stream.watchLog(null);
    };
  }, [loaded, live, stream, attempt.id, limit]);
  // A running attempt's log opens at its newest lines; a finished one opens at its start and never moves.
  useLayoutEffect(() => {
    if (loaded && live) jump();
  }, [loaded, live, jump]);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
        <div className="sd-follow">
          <pre ref={attach} className="sd-code sd-code--block" aria-label="Raw log">
            {lines.map(line => `${line.time} ${line.message}`).join('\n')}
          </pre>
          <NewUpdates follow={follow} />
        </div>
      )}
      {handoff && attempt.result?.summary && (
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
