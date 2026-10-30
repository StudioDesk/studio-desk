// Ideas (v1.0 item 23, area 6; the canvas draws no board for it, so this is the redesign's language applied to the
// list): every idea sent to the project, newest first, each with where its journey stands and its stories as dots,
// opening its own page. Find narrows by the idea's words; the filters show what is open, what waits for the
// director and what finished; archived ideas are behind their own toggle. Until an idea's plan is official, its row
// tells where the planning stands instead (planning.ts): Planning, Waiting for you, or the stop.
import { Link } from '@tanstack/react-router';
import { Fragment, useState, type ReactNode } from 'react';
import { AgentAvatar } from './design/avatar';
import { plural } from './evidence';
import { agentState } from './faces';
import { journeyChip, journeyStories } from './journey';
import { workerName } from './names';
import { requestNewIdea } from './new-idea';
import { planningOf, type Planning } from './planning';
import type { RunStory, StudioState } from './studio-runs';
import { agentLooks } from './today';
import { useNow } from './use-now';

const finishedLabels = ['Integrated', 'Finished', 'Stopped', 'Cancelled', 'Closed'];
const planningTones = { planning: 'live', you: 'you', stopped: 'bad' } as const;
// Where an open idea's planning stands. An idea stopped on its plan goes on once the director acts, so its row
// tells that stop's reason and what to do too.
const planningFor = (entry: IdeaEntry, now: number) =>
  !finishedLabels.includes(entry.run.outcome.label) || entry.run.outcome.label === 'Stopped'
    ? planningOf(entry.run, entry.state, now)
    : null;
const day = (value: string) =>
  new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const words = (run: RunStory) => {
  const line = (run.brief || run.title).trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 140).replace(/\s+\S*$/, '')}…` : line;
};
type Filter = 'open' | 'calls' | 'finished' | 'all';

export interface IdeaEntry {
  run: RunStory;
  // The records the idea is read from: the live set's, or its finished page's.
  state: StudioState;
}

// The planning's words on the row: the planner's face and name with the minutes so far, or the question's first line,
// or the stop's reason and what to do.
function PlanningWords({ projectId, state, planning }: { projectId: string; state: StudioState; planning: Planning }) {
  if (planning.state !== 'planning') return <>{planning.text}</>;
  const looks = agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
    look = looks.get(planning.workerId ?? ''),
    step = state.tasks.find(task => task.id === planning.taskId);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-6)', verticalAlign: 'middle' }}>
      {look && <AgentAvatar look={look} size={22} state={agentState(state, planning.workerId, step)} ring={false} />}
      {[workerName(state, planning.workerId), planning.minutes ? `${planning.minutes} min` : '']
        .filter(Boolean)
        .join(' · ')}
    </span>
  );
}

function IdeaRow({ projectId, entry, planning }: { projectId: string; entry: IdeaEntry; planning: Planning | null }) {
  const { run, state } = entry,
    open = !finishedLabels.includes(run.outcome.label),
    chip = planning ? { tone: planningTones[planning.state], label: planning.label } : journeyChip(run, state),
    stories = journeyStories(run, state),
    done = stories.filter(story => story.chip.tone === 'ok').length,
    source = stories.some(story => story.task.kind === 'studio-development:change'),
    meta: ReactNode[] = [
      `Sent ${day(run.startedAt)}`,
      ...(planning
        ? [<PlanningWords key="planning" projectId={projectId} state={state} planning={planning} />]
        : [
            stories.length ? `${stories.length} ${plural(stories.length, 'story', 'stories')}` : run.name,
            stories.length ? `${done} of ${stories.length} ${source ? 'integrated' : 'accepted'}` : '',
          ]),
      run.archive?.archived ? 'archived' : '',
    ].filter(Boolean);
  return (
    <Link
      className={`sd-card sd-idearow${chip.tone === 'you' ? ' sd-idearow--you' : chip.tone === 'live' ? ' sd-idearow--live' : ''}${run.archive?.archived ? ' sd-idearow--muted' : ''}`}
      to="/p/$projectId/runs/$runId"
      params={{ projectId, runId: run.id }}
    >
      <span className="sd-idearow__main">
        <span className="sd-idearow__title">“{words(run)}”</span>
        <span className="sd-meta">
          {meta.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && ' · '}
              {part}
            </Fragment>
          ))}
        </span>
      </span>
      <span className="sd-idearow__side">
        <span
          className={`sd-chip sd-chip--${open || planning ? chip.tone : run.outcome.tone === 'ok' ? 'ok' : run.outcome.tone === 'bad' ? 'bad' : 'wait'}`}
        >
          <span className="sd-chip__dot"></span>
          {open || planning ? chip.label : run.outcome.label}
        </span>
        {stories.length > 0 && (
          <span
            className="sd-rundots"
            role="img"
            aria-label={stories.map(story => `Story ${story.number}: ${story.chip.label}`).join(', ')}
          >
            {stories.map(story => (
              <i
                key={story.task.id}
                className={
                  { ok: 'sd-rundots__ok', live: 'sd-rundots__live', you: 'sd-rundots__you', bad: 'sd-rundots__bad' }[
                    story.chip.tone as string
                  ]
                }
              ></i>
            ))}
          </span>
        )}
      </span>
    </Link>
  );
}

export function IdeasList({
  projectId,
  projectName,
  ideas,
  archived,
  more,
  loadingMore,
  onMore,
}: {
  projectId: string;
  projectName: string;
  ideas: IdeaEntry[];
  archived: IdeaEntry[];
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all'),
    [search, setSearch] = useState(''),
    [showArchived, setShowArchived] = useState(false),
    // The clock for a planning idea's minutes, ticking only while work runs.
    now = useNow(
      ideas.some(entry => entry.state.attempts.some(attempt => ['running', 'stopping'].includes(attempt.status))),
    ),
    planning = new Map([...ideas, ...archived].map(entry => [entry.run.id, planningFor(entry, now)]));
  const kind = (entry: IdeaEntry): Filter[] => {
    const open = !finishedLabels.includes(entry.run.outcome.label),
      // An idea whose planning waits for the director is a call, whether or not its run names it.
      calls = entry.run.needsYou.some(item => item.requiresDirector) || planning.get(entry.run.id)?.state === 'you';
    return ['all', open ? 'open' : 'finished', ...(calls ? (['calls'] as const) : [])];
  };
  const found = (entry: IdeaEntry) =>
    !search.trim() || `${entry.run.brief} ${entry.run.title}`.toLowerCase().includes(search.trim().toLowerCase());
  const shown = [...ideas, ...(showArchived ? archived : [])].filter(
    entry => kind(entry).includes(filter) && found(entry),
  );
  const count = (id: Filter) => ideas.filter(entry => kind(entry).includes(id)).length;
  return (
    <div className="sd-ideaspage">
      <header className="sd-boardhead">
        <div className="sd-boardhead__text">
          <h1 className="sd-boardhead__title">Ideas</h1>
          <p>Every idea you sent to {projectName}, newest first.</p>
        </div>
        <div className="sd-boardhead__tools">
          <button type="button" className="sd-btn sd-btn--sm sd-btn--primary" onClick={requestNewIdea}>
            New idea
          </button>
        </div>
      </header>
      <div className="sd-toolbar">
        <input
          className="sd-find"
          type="search"
          aria-label="Find an idea"
          placeholder="Find an idea"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {(
          [
            ['all', 'All', ''],
            ['open', 'Open', 'var(--live-dot)'],
            ['calls', 'Your calls', 'var(--you-dot)'],
            ['finished', 'Finished', 'var(--ok-dot)'],
          ] as const
        ).map(([id, label, dot]) => (
          <button
            key={id}
            type="button"
            className="sd-filter"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
          >
            {dot && <span className="sd-filter__dot" style={{ background: dot }}></span>}
            {label} <b>{count(id)}</b>
          </button>
        ))}
      </div>
      <div className="sd-idealist">
        {shown.length ? (
          shown.map(entry => (
            <IdeaRow
              key={entry.run.id}
              projectId={projectId}
              entry={entry}
              planning={planning.get(entry.run.id) ?? null}
            />
          ))
        ) : (
          <div className="sd-card sd-empty">
            {ideas.length || archived.length
              ? 'No idea matches.'
              : 'No ideas yet. Send one from Today, and its journey shows here.'}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
        {more && (
          <button type="button" className="sd-btn sd-btn--sm" disabled={loadingMore} onClick={onMore}>
            {loadingMore ? 'Loading older ideas…' : 'Show older ideas'}
          </button>
        )}
        {archived.length > 0 && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? 'Hide' : 'Show'} {archived.length} archived {plural(archived.length, 'idea', 'ideas')}
          </button>
        )}
      </div>
    </div>
  );
}
