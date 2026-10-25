// Ideas (v1.0 item 23, area 6; the canvas draws no board for it, so this is the redesign's language applied to the
// list): every idea sent to the project, newest first, each with where its journey stands and its stories as dots,
// opening its own page. Find narrows by the idea's words; the filters show what is open, what waits for the
// director and what finished; archived ideas are behind their own toggle.
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { plural } from './evidence';
import { journeyChip, journeyStories } from './journey';
import { requestNewIdea } from './new-idea';
import type { RunStory, StudioState } from './studio-runs';

const finishedLabels = ['Integrated', 'Finished', 'Stopped', 'Cancelled', 'Closed'];
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

function IdeaRow({ projectId, entry }: { projectId: string; entry: IdeaEntry }) {
  const { run, state } = entry,
    open = !finishedLabels.includes(run.outcome.label),
    chip = journeyChip(run, state),
    stories = journeyStories(run, state),
    done = stories.filter(story => story.chip.tone === 'ok').length,
    source = stories.some(story => story.task.kind === 'studio-development:change');
  return (
    <Link
      className={`sd-card sd-idearow${chip.tone === 'you' ? ' sd-idearow--you' : chip.tone === 'live' ? ' sd-idearow--live' : ''}${run.archive?.archived ? ' sd-idearow--muted' : ''}`}
      to="/p/$projectId/runs/$runId"
      params={{ projectId, runId: run.id }}
    >
      <span className="sd-idearow__main">
        <span className="sd-idearow__title">“{words(run)}”</span>
        <span className="sd-meta">
          {[
            `Sent ${day(run.startedAt)}`,
            stories.length ? `${stories.length} ${plural(stories.length, 'story', 'stories')}` : run.name,
            stories.length ? `${done} of ${stories.length} ${source ? 'integrated' : 'accepted'}` : '',
            run.archive?.archived ? 'archived' : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className="sd-idearow__side">
        <span
          className={`sd-chip sd-chip--${open ? chip.tone : run.outcome.tone === 'ok' ? 'ok' : run.outcome.tone === 'bad' ? 'bad' : 'wait'}`}
        >
          <span className="sd-chip__dot"></span>
          {open ? chip.label : run.outcome.label}
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
    [showArchived, setShowArchived] = useState(false);
  const kind = (entry: IdeaEntry): Filter[] => {
    const open = !finishedLabels.includes(entry.run.outcome.label),
      calls = entry.run.needsYou.some(item => item.requiresDirector);
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
          shown.map(entry => <IdeaRow key={entry.run.id} projectId={projectId} entry={entry} />)
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
