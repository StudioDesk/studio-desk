// The board, as the canvas's Board draws it (v1.0 item 23): five columns from proposed to done, each card saying
// where its task stands and why, with a search, filters for open work, your calls, working and waiting, a filter by
// person, lanes by idea or by person, and a list. Dragging a Planned card to Ready approves it. Open work comes from
// the live set; done work a page at a time, its newest three shown until the rest is asked for, kept in the address.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { send } from './api';
import { columns, cardOf, found, matches, newest, type Card, type ColumnId, type Filter } from './board';
import { withSettled } from './board-page';
import { AgentAvatar } from './design/avatar';
import { Icon } from './design/icons';
import { agentState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { plural } from './evidence';
import { requestNewIdea } from './new-idea';
import { useSettled, useSettledCounts } from './records';
import { active, liveSummary, settled, type StudioState } from './studio-runs';
import { agentLooks } from './today';
import { useToast } from './toast';

// An idea's color on its cards: the project hues, never the orange that marks the director's calls.
const ideaHues = ['var(--live-dot)', 'var(--project-2)', 'var(--agent-morgan)', 'var(--agent-eli)', 'var(--ok-dot)'];
const notes: Record<ColumnId, string> = {
  planned: 'drag to Ready to approve',
  ready: 'approved, queued',
  progress: '',
  review: 'checked, then yours',
  done: 'newest first',
};
const taskType = 'text/x-studio-task';

export function Board({
  projectId,
  state,
  accepted,
  closed,
}: {
  projectId: string;
  state: StudioState;
  accepted: boolean;
  closed: boolean;
}) {
  const toast = useToast(),
    navigate = useNavigate(),
    router = useRouter(),
    counts = useSettledCounts(projectId),
    done = useSettled(projectId, 'accepted', true),
    closedPages = useSettled(projectId, 'closed', closed),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState<Filter>('open'),
    [people, setPeople] = useState<string[]>([]),
    [lanes, setLanes] = useState<'none' | 'idea' | 'person'>('none'),
    [view, setView] = useState<'board' | 'list'>('board'),
    [dropping, setDropping] = useState(false),
    looks = useMemo(
      () => agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
      [projectId, state.workers, state.employeeDirectory],
    );
  // The React compiler memoizes this; the live set and every loaded page of settled work.
  const board = withSettled(state, [...(done.data?.pages ?? []), ...(closedPages.data?.pages ?? [])]),
    stories = liveSummary(state).stories,
    cards = board.tasks
      .map(task => cardOf(task, board, stories, closed))
      .filter((card): card is Card => !!card)
      .sort(newest(board));
  const approve = useMutation({
    mutationFn: (taskId: string) => send(`/api/tasks/${encodeURIComponent(taskId)}/approve-work`, { projectId }),
    onSuccess: () => toast('Approved. It joins Ready.'),
    onError: failure => toast(failure.message),
  });
  // What the live set holds that is settled is counted with the settled lists, not twice.
  const liveSettled = new Set(state.tasks.filter(task => settled(task, state.attempts)).map(task => task.id)),
    doneTotal =
      (counts.data?.accepted ?? 0) +
      state.tasks.filter(task => task.status === 'done' && !task.closed && !liveSettled.has(task.id)).length,
    cancelled = state.tasks.filter(task => task.status === 'cancelled' && !task.closed),
    closedCount = (counts.data?.closed ?? 0) + cancelled.length;
  const count = (which: Filter) => cards.filter(card => matches(card, which)).length,
    shown = cards.filter(
      card =>
        (card.column === 'done' ? filter === 'open' || !!card.task.closed : matches(card, filter)) &&
        found(card, search) &&
        (!people.length || people.includes(card.workerId ?? '')),
    ),
    workers = state.workers.filter(worker => worker.enabled !== false);
  const setAddress = (next: { accepted?: true; closed?: true }) =>
    void navigate({
      to: '/p/$projectId/board',
      params: { projectId },
      search: previous => ({ ...previous, ...next }),
      replace: true,
    });
  const column = (id: ColumnId, laneCards: Card[], lane = false) => {
    const own = laneCards.filter(card => card.column === id),
      // Done shows its newest three until the rest is asked for; closed work, when shown, always shows.
      shut = (card: Card) => !!card.task.closed || ['denied', 'cancelled'].includes(card.task.status),
      doneShown =
        id === 'done' && !accepted ? [...own.filter(card => !shut(card)).slice(0, 3), ...own.filter(shut)] : own,
      more = doneTotal - doneShown.filter(card => !card.task.closed).length,
      busy = state.tasks.filter(active).length,
      drop = id === 'ready';
    return (
      <section
        key={id}
        className={`sd-col${drop && dropping ? ' sd-col--drop' : ''}`}
        aria-label={lane ? undefined : columns.find(item => item.id === id)!.name}
        onDragOver={
          drop
            ? (event: DragEvent) => {
                if (!event.dataTransfer.types.includes(taskType)) return;
                event.preventDefault();
                setDropping(true);
              }
            : undefined
        }
        onDragLeave={drop ? () => setDropping(false) : undefined}
        onDrop={
          drop
            ? (event: DragEvent) => {
                const taskId = event.dataTransfer.getData(taskType);
                setDropping(false);
                if (taskId) {
                  event.preventDefault();
                  approve.mutate(taskId);
                }
              }
            : undefined
        }
      >
        {!lane && (
          <div className="sd-colhead">
            <span className="sd-colhead__name">{columns.find(item => item.id === id)!.name}</span>
            <span className="sd-colhead__count">{id === 'done' ? doneTotal : own.length}</span>
            <span className="sd-meta sd-colhead__note">
              {id === 'progress'
                ? `${busy} of ${state.maxParallel ?? 1} ${plural(state.maxParallel ?? 1, 'slot')} busy`
                : notes[id]}
            </span>
          </div>
        )}
        {doneShown.map(card => (
          <BoardCard
            key={card.task.id}
            projectId={projectId}
            card={card}
            looks={looks}
            stories={stories.map(s => s.id)}
          />
        ))}
        {!own.length && id === 'planned' && !lane && (
          <div className="sd-empty">
            Nothing proposed. A new idea lands here as stories for you to approve.
            <button
              type="button"
              className="sd-link"
              onClick={() => {
                router.history.push(`/p/${projectId}`);
                requestNewIdea();
              }}
            >
              Send an idea
            </button>
          </div>
        )}
        {id === 'done' && !lane && filter === 'open' && (
          <>
            {!accepted && more > 0 && (
              <button type="button" className="sd-btn sd-btn--sm" onClick={() => setAddress({ accepted: true })}>
                {more} more done
              </button>
            )}
            {accepted && done.hasNextPage && (
              <button
                type="button"
                className="sd-btn sd-btn--sm"
                disabled={done.isFetchingNextPage}
                onClick={() => void done.fetchNextPage()}
              >
                Show more done
              </button>
            )}
            {accepted && (
              <button
                type="button"
                className="sd-btn sd-btn--sm sd-btn--ghost"
                onClick={() => setAddress({ accepted: undefined })}
              >
                Show only the newest
              </button>
            )}
          </>
        )}
        {id === 'done' && !lane && view !== 'list' && (
          <ClosedSwitch closed={closed} closedCount={closedCount} setAddress={setAddress} />
        )}
      </section>
    );
  };
  const laneGroups: { key: string; head: ReactNode; cards: Card[] }[] =
    lanes === 'idea'
      ? [
          ...stories
            .map((story, index) => ({
              key: story.id,
              head: (
                <>
                  <span className="sd-ideadot" style={{ background: ideaHues[index % ideaHues.length] }}></span>
                  <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: story.id }}>
                    {story.brief ? `“${story.brief.split('\n')[0]!.slice(0, 90)}”` : story.title}
                  </Link>
                </>
              ),
              cards: shown.filter(card => card.idea?.runId === story.id),
            }))
            .filter(group => group.cards.length),
          { key: 'none', head: <span>Not part of an idea</span>, cards: shown.filter(card => !card.idea) },
        ].filter(group => group.cards.length)
      : lanes === 'person'
        ? workers
            .map(worker => ({
              key: worker.id,
              head: (
                <>
                  {looks.get(worker.id) && (
                    <AgentAvatar
                      look={looks.get(worker.id)!}
                      size={26}
                      state={agentState(state, worker.id)}
                      ring={false}
                    />
                  )}
                  <span>{worker.displayName ?? worker.id}</span>
                  <span className="sd-meta">{worker.jobTitle}</span>
                </>
              ),
              cards: shown.filter(card => card.workerId === worker.id),
            }))
            .filter(group => group.cards.length)
        : [];
  const filters: [Filter, string, string | null][] = [
    ['open', 'Open work', null],
    ['calls', 'Your calls', 'var(--you-dot)'],
    ['working', 'Working', 'var(--live-dot)'],
    ['waiting', 'Waiting', 'var(--wait-dot)'],
  ];
  return (
    <div className="sd-boardpage">
      <header className="sd-boardhead">
        <div className="sd-boardhead__text">
          <h1 className="sd-boardhead__title">Board</h1>
          <p>Every task in {state.project.name}, from proposed to done.</p>
        </div>
        <div className="sd-boardhead__tools">
          <div className="sd-segmented sd-wide-only" role="group" aria-label="Lanes">
            {(
              [
                ['none', 'No lanes'],
                ['idea', 'Lanes by idea'],
                ['person', 'Lanes by person'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={lanes === id} onClick={() => setLanes(id)}>
                {label}
              </button>
            ))}
          </div>
          <div className="sd-segmented" role="group" aria-label="View">
            {(
              [
                ['board', 'Board'],
                ['list', 'List'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={view === id} onClick={() => setView(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="sd-toolbar">
        <input
          className="sd-find"
          type="search"
          aria-label="Find a task"
          placeholder="Find a task or file"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        {filters.map(([id, label, dot]) => (
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
        <span className="sd-toolbar__rule sd-wide-only" aria-hidden="true"></span>
        <span style={{ display: 'inline-flex', gap: '2px' }} role="group" aria-label="Filter by person">
          {workers.map(worker => {
            const look = looks.get(worker.id),
              on = people.includes(worker.id);
            return (
              <button
                key={worker.id}
                type="button"
                className="sd-face"
                aria-pressed={on}
                aria-label={worker.displayName ?? worker.id}
                title={worker.displayName ?? worker.id}
                onClick={() => setPeople(on ? people.filter(id => id !== worker.id) : [...people, worker.id])}
              >
                {look && <AgentAvatar look={look} size={30} state={agentState(state, worker.id)} ring={false} />}
              </button>
            );
          })}
        </span>
      </div>
      <Paused projectId={projectId} state={state} />
      {view === 'list' ? (
        <BoardList projectId={projectId} cards={shown} looks={looks} />
      ) : lanes === 'none' ? (
        <div className="sd-kanbanwrap" role="region" aria-label="Board columns" tabIndex={0}>
          <div className="sd-kanban">{columns.map(item => column(item.id, shown))}</div>
        </div>
      ) : (
        <div className="sd-kanbanwrap" role="region" aria-label="Board lanes" tabIndex={0}>
          <div className="sd-kanban" style={{ minHeight: 0 }} aria-hidden="true">
            {columns.map(item => (
              <div key={item.id} className="sd-colhead">
                <span className="sd-colhead__name">{item.name}</span>
              </div>
            ))}
          </div>
          {laneGroups.map(group => (
            <section key={group.key} aria-label={typeof group.head === 'string' ? group.head : undefined}>
              <div className="sd-lanehead">{group.head}</div>
              <div className="sd-kanban sd-kanban--lane">{columns.map(item => column(item.id, group.cards, true))}</div>
            </section>
          ))}
          {!laneGroups.length && <p className="sd-meta">Nothing matches.</p>}
        </div>
      )}
      {(view === 'list' || lanes !== 'none') && (
        <div>
          <ClosedSwitch closed={closed} closedCount={closedCount} setAddress={setAddress} />
        </div>
      )}
    </div>
  );
}

function BoardCard({
  projectId,
  card,
  looks,
  stories,
}: {
  projectId: string;
  card: Card;
  looks: Map<string, AgentLook>;
  stories: string[];
}) {
  const look = looks.get(card.workerId ?? ''),
    tone = card.chip?.tone,
    variant =
      tone === 'you'
        ? ' sd-kcard--you'
        : tone === 'live'
          ? ' sd-kcard--live'
          : card.task.closed
            ? ' sd-kcard--muted'
            : '',
    draggable =
      card.column === 'planned' && (card.task.approval as { status?: string } | undefined)?.status === 'pending';
  return (
    <Link
      className={`sd-kcard${variant}`}
      to="/p/$projectId/tasks/$taskId"
      params={{ projectId, taskId: card.task.id }}
      draggable={draggable || undefined}
      onDragStart={draggable ? event => event.dataTransfer.setData(taskType, card.task.id) : undefined}
    >
      <span className="sd-kcard__top">
        <span className="sd-eyebrow">{card.eyebrow}</span>
        {card.chip && !card.waits && card.column !== 'ready' ? (
          <span className={`sd-chip${tone === 'wait' ? '' : ` sd-chip--${tone}`}`}>
            <span className="sd-chip__dot"></span>
            {card.chip.label}
          </span>
        ) : (
          <span className="sd-mono sd-meta sd-kcard__id">{card.task.id}</span>
        )}
      </span>
      <span className="sd-kcard__title">{card.task.title}</span>
      {card.waits && (
        <span className="sd-chip sd-chip--wrap" style={{ alignSelf: 'flex-start' }}>
          <span className="sd-chip__dot"></span>
          {card.waits}
        </span>
      )}
      {card.running && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <span className="sd-bar sd-bar--thin" aria-hidden="true">
            <span className="sd-bar__part sd-bar__part--live" style={{ width: `${card.running.share}%` }}></span>
          </span>
          <span className="sd-meta" style={{ fontSize: '12px', display: 'flex', justifyContent: 'space-between' }}>
            <span>attempt {card.running.attempt}</span>
            <span>{card.running.used}</span>
          </span>
        </span>
      )}
      {card.asks && card.asks.length > 0 && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'center' }}>
          <span className="sd-meta" style={{ fontSize: '12.5px' }}>
            Stopped, asks for
          </span>
          {card.asks.map(item => (
            <span key={item.path} className={`sd-file${item.sign === '+' ? ' sd-file--add' : ' sd-file--del'}`}>
              {item.sign} {item.path}
            </span>
          ))}
        </span>
      )}
      {card.change && (
        <span
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center', fontSize: '12.5px' }}
        >
          {card.change.added !== undefined && (
            <>
              <b style={{ color: 'var(--add)' }}>+{card.change.added}</b>
              <b style={{ color: 'var(--del)' }}>−{card.change.removed}</b>
            </>
          )}
          {card.change.tests && <span className="sd-meta">· {card.change.tests} ·</span>}
          <span className="sd-chip sd-chip--ok sd-chip--inline">
            <span className="sd-chip__dot"></span>Passed
          </span>
        </span>
      )}
      {card.blocking && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', alignItems: 'center' }}>
          <span className="sd-chip sd-chip--bad sd-chip--inline">
            <span className="sd-chip__dot"></span>
            {card.blocking.count} blocking
          </span>
          {card.blocking.place && <span className="sd-file">{card.blocking.place}</span>}
        </span>
      )}
      {card.commit && (
        <span style={{ display: 'flex', gap: 'var(--space-6)', alignItems: 'center' }}>
          <span className="sd-file">{card.commit}</span>
          {card.since && <span className="sd-meta">{card.since}</span>}
        </span>
      )}
      {card.idea ? (
        <span className="sd-kcard__from">
          <span
            className="sd-ideadot"
            style={{ background: ideaHues[Math.max(0, stories.indexOf(card.idea.runId)) % ideaHues.length] }}
          ></span>
          <span>{card.idea.text}</span>
        </span>
      ) : (
        !card.commit &&
        card.since && (
          <span className="sd-kcard__from">
            <span className="sd-ideadot" style={{ background: 'var(--line-2)' }}></span>
            <span>{card.since}</span>
          </span>
        )
      )}
      {card.foot && (
        <span className="sd-kcard__foot">
          {look && <AgentAvatar look={look} size={22} state={card.face} ring={false} />}
          {card.foot}
        </span>
      )}
    </Link>
  );
}

// The same work as a list, one row a task.
function BoardList({ projectId, cards, looks }: { projectId: string; cards: Card[]; looks: Map<string, AgentLook> }) {
  if (!cards.length) return <p className="sd-meta">Nothing matches.</p>;
  // Open work first, in the columns' order, each column's newest first.
  const order = columns.map(item => item.id),
    rows = [...cards].sort((a, b) => order.indexOf(a.column) - order.indexOf(b.column));
  return (
    <section
      className="sd-card"
      style={{ padding: 'var(--space-6) var(--space-8)', overflowX: 'auto' }}
      aria-label="Work list"
    >
      <table className="sd-table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Where</th>
            <th>Idea</th>
            <th>Who</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(card => {
            const look = looks.get(card.workerId ?? '');
            return (
              <tr key={card.task.id}>
                <td>
                  <span className="sd-eyebrow" style={{ display: 'block', fontSize: '11px' }}>
                    {card.eyebrow}
                  </span>
                  <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: card.task.id }}>
                    {card.task.title}
                  </Link>
                </td>
                <td>
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-4)',
                      alignItems: 'flex-start',
                    }}
                  >
                    <span>{columns.find(item => item.id === card.column)!.name}</span>
                    {card.chip && (
                      <span
                        className={`sd-chip sd-chip--inline${card.chip.tone === 'wait' ? '' : ` sd-chip--${card.chip.tone}`}`}
                      >
                        <span className="sd-chip__dot"></span>
                        {card.waits ?? card.chip.label}
                      </span>
                    )}
                  </span>
                </td>
                <td className="sd-meta">{card.idea?.text ?? (card.commit ? '' : (card.since ?? ''))}</td>
                <td>
                  <span style={{ display: 'flex', gap: 'var(--space-8)', alignItems: 'center' }}>
                    {look && <AgentAvatar look={look} size={22} state={card.face} ring={false} />}
                    <span className="sd-meta">{card.foot}</span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// While work is paused, nothing queued starts: the board says so above its columns, with the way to resume. While
// it runs there is nothing to say; the filters count what works and waits, and Settings pauses it (the director,
// October 24: the board's footnote "feels like it was just strapped on").
function Paused({ projectId, state }: { projectId: string; state: StudioState }) {
  const toast = useToast(),
    everywhere = !!state.paused,
    resume = useMutation({
      mutationFn: () =>
        everywhere
          ? send('/api/control', { projectId, paused: false })
          : send('/api/pipeline', { projectId, action: 'resume' }),
      onError: failure => toast(failure.message),
    });
  if (!everywhere && state.pipelineEnabled !== false) return null;
  return (
    <div className="sd-callout" role="status">
      <span className="sd-callout__icon">
        <Icon name="clock" size={22} weight={2.2} />
      </span>
      <span className="sd-callout__text">
        <b>{everywhere ? 'New work is paused in every project.' : 'This project is paused.'}</b>{' '}
        <span style={{ color: 'var(--ink-2)' }}>
          Nothing queued starts until you resume; work that is running finishes.
        </span>
      </span>
      <button type="button" className="sd-btn sd-btn--sm" disabled={resume.isPending} onClick={() => resume.mutate()}>
        {everywhere ? 'Resume all work' : 'Resume this project'}
      </button>
    </div>
  );
}

// Closed and cancelled work, behind its own switch, under what is done.
function ClosedSwitch({
  closed,
  closedCount,
  setAddress,
}: {
  closed: boolean;
  closedCount: number;
  setAddress: (next: { accepted?: true; closed?: true }) => void;
}) {
  if (!closedCount) return null;
  return (
    <button
      type="button"
      className="sd-btn sd-btn--sm sd-btn--ghost"
      style={{ whiteSpace: 'normal', lineHeight: 1.25 }}
      onClick={() => setAddress({ closed: closed ? undefined : true })}
    >
      {closed ? `Hide ${closedCount} closed or cancelled` : `${closedCount} closed or cancelled`}
    </button>
  );
}
