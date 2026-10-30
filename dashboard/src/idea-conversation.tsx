// An idea's planning conversation on its page (conversation.ts reads it from the records): the director's idea in their
// own bubble, the checks line, each plan the planner sent with its numbered cards, its questions with their answers
// in place, the director's replies between plans and a line for each plan attempt that stopped. The plan step's own
// page supplies its attempts with their files, and each plan's file is read once and kept. Nothing here sends.
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';
import { getJSON, taskUrl, type AttemptSummary, type Task, type TaskPage } from './api';
import { named } from './bring-back';
import { conversation, planArtifact, type ConversationEntry, type IdeaFile, type MarkedCard } from './conversation';
import { AgentAvatar } from './design/avatar';
import type { AgentLook } from './design/agent-kit.js';
import { artifactUrl, TextReader } from './files';
import { fileSize } from './idea-composer';
import { clockOf } from './journey';
import { workerName } from './names';
import { queryKeys } from './records';
import type { RunStory, StudioState } from './studio-runs';

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

// The conversation, titled for the planner: "Talk to Mara". It reads the plan step's page, then each plan's file.
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
    };
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
    </section>
  );
}

// One entry of the conversation, in its place.
function Message({
  projectId,
  runId,
  state,
  entry,
  face,
  word,
  reviewer,
  reading,
}: {
  projectId: string;
  runId: string;
  state: StudioState;
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
    case 'question':
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
            {entry.waiting && (
              <Link
                className="sd-btn sd-btn--sm"
                style={{ marginTop: 'var(--space-8)' }}
                to="/p/$projectId"
                params={{ projectId }}
                hash="calls"
              >
                Answer
              </Link>
            )}
            <div className="sd-meta" style={{ marginTop: '2px' }}>
              {at}
            </div>
          </div>
        </li>
      );
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
