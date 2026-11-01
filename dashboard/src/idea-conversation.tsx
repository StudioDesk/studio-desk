// An idea's planning conversation on its page (conversation.ts reads it from the records): the director's idea in their
// own bubble, the checks line, each plan the planner sent with its numbered cards, its questions with their answers
// in place, the director's replies between plans and a line for each plan attempt that stopped. A question still
// waiting is answered in place, with Today's question card and Answer box. The plan step's own page supplies its
// attempts with their files, and each plan's file is read once and kept. While the idea is in planning, the director
// replies under it and makes the plan official, each with the plan step's own recorded step: a reply is its revise
// with the reply as direction, then its start; Make it official is its accept. An accepted plan whose steps all
// still wait keeps these controls: a reply plans again and sets those steps aside; Make it official approves them.
import { notifyManager, useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode } from 'react';
import { getJSON, send, taskUrl, type AttemptSummary, type Task, type TaskPage } from './api';
import { named } from './bring-back';
import { conversation, planArtifact, type ConversationEntry, type IdeaFile, type MarkedCard } from './conversation';
import { decisionState } from './decisions';
import { AgentAvatar } from './design/avatar';
import type { AgentLook } from './design/agent-kit.js';
import { IdeaBox } from './design/idea-box';
import { artifactUrl, TextReader } from './files';
import { projectColor } from './frame';
import { fileSize } from './idea-composer';
import { clockOf } from './journey';
import { workerName } from './names';
import { waitingSteps } from './plan-talk';
import { AnswerBox, QuestionCard } from './question-card';
import { waitingQuestion } from './questions';
import { queryKeys } from './records';
import type { ReleaseOf } from './release-chip';
import type { RunStory, StudioState } from './studio-runs';
import { useToast } from './toast';
import { useNow } from './use-now';

const planKinds = ['studio-development:breakdown', 'general:plan'];
// An attempt that finished with a plan, as conversation.ts reads it; only these plans' files are read.
const planned = ['review', 'accepted', 'revision_requested'];

// The idea's plan step among its steps that are not stories, if it has one.
export const planStepOf = (steps: Task[]) => steps.find(task => planKinds.includes(task.kind));

// The records with the plan step's own page in place of its task and attempts, which carry their files.
function withPage(state: StudioState, page: TaskPage): StudioState {
  const id = page.task.id;
  return {
    ...state,
    tasks: state.tasks.map(task => (task.id === id ? page.task : task)),
    attempts: [...state.attempts.filter(attempt => attempt.taskId !== id), ...page.attempts],
  };
}

// The planner: the agent of the plan step's latest attempt, else the step's own.
function plannerOf(plan: Task, attempts: AttemptSummary[]) {
  const latest = attempts
    .filter(attempt => attempt.taskId === plan.id)
    .sort((a, b) => Date.parse(String(a.startedAt ?? '')) - Date.parse(String(b.startedAt ?? '')))
    .at(-1);
  return latest?.workerId ?? plan.workerId;
}

// "a software engineer", "an engineer".
const withArticle = (words: string) => `${/^[aeiou]/i.test(words) ? 'an' : 'a'} ${words}`;

// The project's enabled agents holding a staffing role.
const holders = (state: StudioState, role: string) =>
  state.workers.filter(
    worker => worker.enabled !== false && (worker as { roles?: string[] }).roles?.includes(role) && !worker.deletedAt,
  );

// Who builds a card: the agent it names, else the project's one enabled agent holding its role, else the role in
// words.
function builderOf(state: StudioState, card: MarkedCard) {
  if (card.builderIs === 'worker') return workerName(state, card.builder);
  const holding = holders(state, card.builder);
  if (holding.length === 1) return workerName(state, holding[0]!.id);
  const label = state.roles?.find(role => role.id === card.builder)?.label ?? card.builder.replace(/[-_]+/g, ' ');
  return withArticle(label.toLowerCase());
}

// Who reviews the cards: the project's one reviewer, else a reviewer.
function reviewerOf(state: StudioState) {
  const holding = holders(state, 'reviewer');
  return holding.length === 1 ? workerName(state, holding[0]!.id) : 'a reviewer';
}

// A file the director attached, downloaded from the idea's inputs as Your idea links it.
function inputUrl(projectId: string, runId: string, file: IdeaFile) {
  const where = file as IdeaFile & { projectId?: string; runId?: string };
  return `/api/projects/${encodeURIComponent(where.projectId ?? projectId)}/runs/${encodeURIComponent(where.runId ?? runId)}/inputs/${encodeURIComponent(file.id)}?projectId=${encodeURIComponent(projectId)}`;
}

async function planText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The recorded file could not be read (${response.status}).`);
  return response.text();
}

// What the controller's start answered, as the plan step's Start says it (task-decisions.tsx): started, or queued and
// why.
const startedToast = (started: Record<string, unknown>) =>
  started.queued
    ? /^Waiting for /.test(String(started.reason ?? ''))
      ? `Queued. ${started.reason} It starts by itself when it can.`
      : 'Queued behind busy work. It starts by itself when its agent, resources and an execution slot are free.'
    : 'Started.';

// What the controller's answer to a question says, as Today's Your calls says it (today-page.tsx): the planner
// continues, or why the answer's start was refused.
function answerToast(sent: Record<string, unknown>, name: string) {
  const start = sent.start as { ok?: boolean; reason?: string } | null | undefined;
  return start?.ok === false
    ? `Answer sent. It did not start: ${start.reason}`
    : `Answer sent. ${name} continues from its saved work with it.`;
}

const live = ['running', 'stopping'];

// The conversation, titled for the planner: "Talk to Mara". It reads the plan step's page, then each plan's file. While
// a planning attempt runs, a line under the last message says the planner is replying and for how long; until the plan
// is official or while its accepted steps all wait for approval, the reply box and Make it official follow.
export function IdeaConversation({
  projectId,
  run,
  state,
  plan,
  looks,
}: {
  projectId: string;
  run: RunStory;
  state: StudioState;
  plan: Task;
  looks: Map<string, AgentLook>;
}) {
  const id = useId(),
    page = useQuery({
      queryKey: queryKeys.task(projectId, plan.id),
      queryFn: ({ signal }) => getJSON<TaskPage>(taskUrl(projectId, plan.id), signal),
    }),
    // Until the plan step's page is read, its attempts may come without their files; a page that cannot be read
    // leaves the records the idea already has.
    records = page.data ? withPage(state, page.data) : page.isError ? state : null,
    files = (records?.attempts ?? []).flatMap(attempt => {
      const file = attempt.taskId === plan.id && planned.includes(attempt.status) ? planArtifact(attempt) : null;
      return file ? [{ attemptId: attempt.id, file }] : [];
    }),
    reads = useQueries({
      queries: files.map(({ attemptId, file }) => ({
        queryKey: [projectId, 'file', attemptId, file.path, file.hash],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          planText(artifactUrl(projectId, attemptId, file.path), signal),
        staleTime: Infinity,
      })),
    }),
    texts: Record<string, string> = {},
    reading = new Set<string>();
  files.forEach(({ attemptId }, index) => {
    const read = reads[index];
    if (read?.data !== undefined) texts[attemptId] = read.data;
    else if (read?.isPending) reading.add(attemptId);
  });
  const entries = records ? conversation(run, records, texts) : [],
    planner = workerName(state, plannerOf(plan, (records ?? state).attempts)),
    word = plan.kind === 'studio-development:breakdown' ? 'Story' : 'Step',
    reviewer = reviewerOf(state),
    face = (workerId: string) => {
      const look = looks.get(workerId);
      return look ? <AgentAvatar look={look} size={34} state="idle" ring={false} /> : null;
    },
    // The planning attempt that runs or stops, whose minutes follow the clock while it does.
    replying = (records ?? state).attempts.find(attempt => attempt.taskId === plan.id && live.includes(attempt.status)),
    now = useNow(!!replying),
    started = Date.parse(String(replying?.startedAt ?? '')),
    took = Number.isFinite(started) ? ` · ${Math.max(1, Math.round((now - started) / 60000))} min so far` : '';
  return (
    <section className="sd-card sd-happened" aria-labelledby={`${id}-title`}>
      <div className="sd-happened__head">
        <h2 id={`${id}-title`} className="sd-section-title sd-section-title--sm">
          Talk to {planner}
        </h2>
      </div>
      {records ? (
        <ol
          aria-label={`Your conversation with ${planner}`}
          style={{
            listStyle: 'none',
            margin: '0 0 12px',
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-14)',
          }}
        >
          {entries.map((entry, index) => (
            <Message
              key={index}
              projectId={projectId}
              runId={run.id}
              state={state}
              records={records}
              entry={entry}
              face={face}
              word={word}
              reviewer={reviewer}
              reading={reading}
            />
          ))}
        </ol>
      ) : (
        <p className="sd-meta" role="status" style={{ margin: '0 0 12px' }}>
          Reading the conversation…
        </p>
      )}
      {records && replying && (
        <div className="sd-say" style={{ alignItems: 'center', margin: '0 0 12px' }}>
          {face(replying.workerId ?? plan.workerId ?? '')}
          <span className="sd-typing" aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
          </span>
          <span className="sd-meta">
            {planner} is replying{took}
          </span>
        </div>
      )}
      <Reply
        projectId={projectId}
        run={run}
        state={state}
        records={records ?? state}
        plan={plan}
        planner={planner}
        word={word}
        replying={!!replying}
      />
    </section>
  );
}

// Under the conversation while the idea is in planning: the reply box, on only while the plan step is in review with
// a finished planning attempt, as the controller's revise accepts only that, and otherwise saying why in one line; then
// Make it official, the plan step's approval, with where the plan lands. An accepted plan whose steps all wait has
// a waiting mode: reply plans again, setting them aside; Make it official approves each in dependency order. Once
// any step starts or is decided, neither control shows.
function Reply({
  projectId,
  run,
  state,
  records,
  plan,
  planner,
  word,
  replying,
}: {
  projectId: string;
  run: RunStory;
  state: StudioState;
  // The records with the plan step's own page, once it is read.
  records: StudioState;
  plan: Task;
  planner: string;
  word: string;
  replying: boolean;
}) {
  const textId = useId(),
    toast = useToast(),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    id = encodeURIComponent(plan.id),
    step = records.tasks.find(task => task.id === plan.id) ?? plan,
    // The decision the plan step's own page offers for it in review (task-decisions.tsx), under the same conditions.
    { latest, plan: proposal } = decisionState(step, records),
    inReview = step.status === 'review' && !!latest && !live.includes(latest.status) && !replying,
    asked = !!waitingQuestion(step, records.attempts),
    waiting = waitingSteps(step, records.tasks),
    canWait = waiting.length > 0 && !replying && !asked,
    index = state.projects.findIndex(project => project.id === projectId),
    release = (state.runs.find(item => item.id === run.id)?.release as ReleaseOf | undefined)?.version;
  // The reply is the plan step's revision with the director's words, then its start; a refused revision keeps the
  // reply and starts nothing, and a refused start leaves the recorded reply for the plan step's own page.
  const reply = useMutation({
    mutationFn: async (direction: string) => {
      if (waiting.length) {
        const sent = await send<{ start: Record<string, unknown> }>(`/api/tasks/${id}/replan`, {
          projectId,
          direction,
        });
        return sent.start.ok === false
          ? `Your reply is recorded. It did not start: ${sent.start.reason}`
          : startedToast(sent.start);
      }
      await send(`/api/tasks/${id}/revise`, { projectId, direction });
      try {
        return startedToast(await send<Record<string, unknown>>(`/api/tasks/${id}/start`, { projectId }));
      } catch (failure) {
        return `Your reply is recorded. It did not start: ${(failure as Error).message}`;
      }
    },
    onSuccess: message => {
      setText('');
      toast(message);
    },
    onError: failure => setError(failure.message),
  });
  // Make it official: accept-proposal for a legacy plan step with its plan, else accept, as the plan step's page sends.
  const accept = useMutation({
    mutationFn: ({ action, body }: { action: string; body: Record<string, unknown>; done?: string }) =>
      send<Record<string, unknown>>(`/api/tasks/${id}/${action}`, { projectId, ...body }),
    onSuccess: (_, { done }) => {
      if (done) toast(done);
    },
    onError: failure => toast(failure.message),
  });
  // Keep the accepted plan's order among independent steps, even when the live records arrive in another order.
  // Each approval is its own controller action; a refusal leaves earlier approvals recorded and stops the batch.
  const approve = useMutation({
    mutationFn: async () => {
      const order = (step.proposedTaskIds as string[] | undefined) ?? [],
        place = (task: Task) => (order.includes(task.id) ? order.indexOf(task.id) : order.length),
        remaining = [...waiting].sort((a, b) => place(a) - place(b)),
        count = (n: number) =>
          `Approved ${n} ${word === 'Story' ? (n === 1 ? 'story' : 'stories') : n === 1 ? 'step' : 'steps'}.`;
      let approved = 0;
      while (remaining.length) {
        const next = remaining.findIndex(task => !remaining.some(other => task.dependencies?.includes(other.id)));
        if (next < 0) throw new Error('The plan’s steps depend on each other; approve them on their own pages.');
        const task = remaining.splice(next, 1)[0]!;
        try {
          await send(`/api/tasks/${encodeURIComponent(task.id)}/approve-work`, { projectId });
        } catch (failure) {
          return `Could not approve “${task.title}”: ${(failure as Error).message} ${count(approved)}`;
        }
        approved++;
      }
      return count(approved);
    },
    onSuccess: message => toast(message),
    onError: failure => toast(failure.message),
  });
  if ((step.status === 'done' && !waiting.length) || step.closed || step.status === 'denied') return null;
  const why = replying
    ? `${planner} is replying; you can reply once the plan arrives.`
    : asked
      ? `${planner} asked you a question; answer it first.`
      : ['blocked', 'failed', 'cancelled'].includes(step.status)
        ? 'The plan step stopped; start it again from its page to reply.'
        : `You can reply once ${planner} sends a plan.`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '12px' }}>
      <IdeaBox
        textId={textId}
        label={`Reply to ${planner}`}
        placeholder={`Tell ${planner} what to change in the plan.`}
        accent={projectColor(state.projects[index], index).background}
        text={text}
        onText={value => {
          setText(value);
          setError('');
        }}
        error={error}
        sendLabel={`Send to ${planner}`}
        note={
          canWait
            ? `${planner} plans again with your words; the waiting steps are set aside.`
            : inReview
              ? `${planner} revises the plan with your words.`
              : why
        }
        busy={reply.isPending || approve.isPending || !(inReview || canWait)}
        onSend={() => reply.mutate(text.trim())}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)' }}>
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={waiting.length ? !canWait || reply.isPending || approve.isPending : !inReview || accept.isPending}
          onClick={() =>
            waiting.length
              ? approve.mutate()
              : proposal && latest
                ? accept.mutate({
                    action: 'accept-proposal',
                    body: { attemptId: latest.id, proposalHash: proposal.hash },
                  })
                : accept.mutate({ action: 'accept', body: {}, done: 'Result accepted.' })
          }
        >
          Make it official
        </button>
        <span className="sd-meta">
          {waiting.length
            ? `${release ? `Lands in ${release} · the` : 'The'} plan’s steps start once approved`
            : release
              ? `Lands in ${release} · nothing starts until you make it official`
              : 'Nothing starts until you make it official'}
        </span>
      </div>
    </div>
  );
}

// One entry of the conversation, in its place.
function Message({
  projectId,
  runId,
  state,
  records,
  entry,
  face,
  word,
  reviewer,
  reading,
}: {
  projectId: string;
  runId: string;
  state: StudioState;
  // The records with the plan step's own page, which hold the asking attempt.
  records: StudioState;
  entry: ConversationEntry;
  face: (workerId: string) => ReactNode;
  word: string;
  reviewer: string;
  reading: Set<string>;
}) {
  const at = clockOf(entry.at);
  switch (entry.type) {
    case 'idea':
      return (
        <li className="sd-say sd-say--mine" aria-label="Your idea">
          <div className="sd-bubble sd-bubble--mine" style={{ display: 'flex', flexDirection: 'column' }}>
            <TextReader text={entry.words} markdown />
            {entry.files.length > 0 && (
              <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginTop: '8px' }}>
                {entry.files.map(file => (
                  <span
                    key={file.id}
                    style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'baseline' }}
                  >
                    <a className="sd-link" href={inputUrl(projectId, runId, file)} download>
                      {file.name}
                    </a>
                    <span className="sd-meta" style={{ marginTop: 0 }}>
                      {[file.mediaType, typeof file.byteLength === 'number' ? fileSize(file.byteLength) : '']
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                ))}
              </span>
            )}
            <span className="sd-meta">You · {at}</span>
          </div>
        </li>
      );
    case 'checks':
      return <li className="sd-event sd-event--center">{entry.text}</li>;
    case 'planner':
      return (
        <li className="sd-say" aria-label={`${entry.name}'s plan`}>
          {face(entry.workerId)}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-10)' }}>
            <div className="sd-bubble">
              <span className="sd-bubble__lead">{entry.name}</span>
              {entry.summary && <span className="sd-bubble__words">{entry.summary}</span>}
              <div className="sd-meta" style={{ marginTop: '2px' }}>
                {at}
              </div>
            </div>
            {entry.cards ? (
              <ol
                aria-label={`${entry.name}'s ${word === 'Story' ? 'stories' : 'steps'}`}
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-8)',
                }}
              >
                {entry.cards.map(card => (
                  <PlanCard
                    key={card.key}
                    card={card}
                    word={word}
                    builder={builderOf(state, card)}
                    reviewer={reviewer}
                  />
                ))}
              </ol>
            ) : (
              <p className="sd-meta" role="status" style={{ margin: 0 }}>
                {reading.has(entry.attemptId) ? 'Reading the plan…' : 'This plan could not be read.'}
              </p>
            )}
          </div>
        </li>
      );
    case 'question': {
      const task = entry.waiting ? records.tasks.find(item => item.id === entry.taskId) : undefined,
        asking = task && records.attempts.find(attempt => attempt.id === entry.attemptId);
      if (task && asking)
        return <Asking projectId={projectId} records={records} task={task} attempt={asking} name={entry.name} />;
      return (
        <li className="sd-say" aria-label={`${entry.name}'s question`}>
          {face(entry.workerId)}
          <div className="sd-bubble">
            <span className="sd-meta">{entry.name} asked you</span>
            <span className="sd-bubble__lead" style={{ color: 'var(--you)' }}>
              {entry.ask}
            </span>
            {entry.why && <span className="sd-bubble__words">{entry.why}</span>}
            {entry.options.length > 0 && (
              <ul aria-label={`${entry.name}'s options`} style={{ margin: 'var(--space-8) 0 0', paddingLeft: '20px' }}>
                {entry.options.map((option, index) => (
                  <li key={index}>
                    <b>{option.label}</b>
                    {option.detail && ` ${option.detail}`}
                    {entry.recommended === index && (
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
              {at}
            </div>
          </div>
        </li>
      );
    }
    case 'answer':
      return entry.by === 'auto-mode' ? (
        <li className="sd-event sd-event--center">
          <span className="sd-chip sd-chip--brand sd-chip--inline">Auto mode</span>
          <span>
            Chose {entry.words} · {at}
          </span>
        </li>
      ) : (
        <li className="sd-say sd-say--mine" aria-label="Your answer">
          <div className="sd-bubble sd-bubble--mine">
            <span className="sd-bubble__lead">
              {entry.replaces === 'auto-mode' ? "Changed auto mode's answer" : 'You answered'}
            </span>
            {entry.words && <span className="sd-bubble__words">{entry.words}</span>}
            <div className="sd-meta">You · {at}</div>
          </div>
        </li>
      );
    case 'director':
      return (
        <li className="sd-say sd-say--mine" aria-label="Your reply">
          <div className="sd-bubble sd-bubble--mine">
            <span className="sd-bubble__words" style={{ marginTop: 0 }}>
              {entry.words}
            </span>
            <div className="sd-meta">You · {at}</div>
          </div>
        </li>
      );
    case 'stopped':
      return (
        <li className="sd-event sd-event--center">
          <span>
            {entry.text} {entry.next}
          </span>
          <Link className="sd-link" to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: entry.taskId }}>
            Open the plan step
          </Link>
        </li>
      );
  }
}

// The planner's question while it waits, answered in place: Today's question card with its Answer box inside, which
// posts the plan step's answer as Your calls does. The answer's records put the answer under the question and, once
// the plan step runs, the planner replying, without leaving the conversation.
function Asking({
  projectId,
  records,
  task,
  attempt,
  name,
}: {
  projectId: string;
  records: StudioState;
  task: Task;
  attempt: AttemptSummary;
  name: string;
}) {
  const toast = useToast();
  return (
    <li aria-label={`${name}'s question`}>
      <QuestionCard projectId={projectId} state={records} task={task} attempt={attempt}>
        <AnswerBox
          projectId={projectId}
          state={records}
          task={task}
          attempt={attempt}
          onSent={sent => notifyManager.schedule(() => toast(answerToast(sent, name)))}
        />
      </QuestionCard>
    </li>
  );
}

// One card of a plan: "Story 2" or "Step 2", marked when it changed after the director's reply, with its title, what
// it does, who builds and reviews it and what it builds on.
function PlanCard({
  card,
  word,
  builder,
  reviewer,
}: {
  card: MarkedCard;
  word: string;
  builder: string;
  reviewer: string;
}) {
  const [first, ...rest] = card.does.trim().split(/\n\s*\n/);
  return (
    <li className={`sd-storycard${card.changed ? ' sd-storycard--you' : ''}`}>
      <span className="sd-storycard__head">
        <span className="sd-eyebrow">
          {word} {card.number}
        </span>
        {card.changed && <span className="sd-chip sd-chip--brand sd-chip--inline">Changed after your reply</span>}
      </span>
      <span className="sd-storycard__title">{card.title}</span>
      {first && <span style={{ color: 'var(--ink-2)', fontSize: '14px', whiteSpace: 'pre-wrap' }}>{first}</span>}
      {rest.length > 0 && (
        <details style={{ color: 'var(--ink-2)', fontSize: '14px' }}>
          <summary className="sd-link" style={{ fontSize: '13px' }}>
            All of what it does
          </summary>
          <span style={{ display: 'block', marginTop: 'var(--space-6)', whiteSpace: 'pre-wrap' }}>
            {rest.join('\n\n')}
          </span>
        </details>
      )}
      <span className="sd-storycard__foot" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 0 }}>
        <span className="sd-meta">
          Built by {builder} · reviewed by {reviewer}
        </span>
        {card.buildsOn.length > 0 && <span className="sd-meta">Builds on {named(card.buildsOn.map(String))}</span>}
      </span>
    </li>
  );
}
