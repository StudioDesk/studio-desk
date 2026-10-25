// An idea's journey (the canvas's Idea board and its phone board, v1.0 item 23): what the idea is doing now, the
// stages from Sent to Shipped, its stories in order, what happened in plain sentences with a view of only the stops
// and decisions, the idea in full, who worked on it and what landed. Its actions are the run page's: pausing the
// project, archiving a finished idea and closing what is left of one.
import { useMutation, useQueries } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getJSON, send, taskUrl, type TaskPage } from './api';
import { AgentAvatar } from './design/avatar';
import { agentState } from './faces';
import { Icon, type IconName } from './design/icons';
import { artifactUrl, FileViewer, TextReader, type ViewerEntry } from './files';
import { fileSize } from './idea-composer';
import {
  clockOf,
  firstSentence,
  happened,
  journeyChip,
  journeyStages,
  journeyStories,
  runRecords,
  whoWorked,
  type HappenedEntry,
  type JourneyStage,
  type JourneyStory,
} from './journey';
import { plural } from './evidence';
import { produced } from './produced';
import { integratesController } from './story';
import type { RunStory, StudioState } from './studio-runs';
import { agentLooks, counted } from './today';
import { useToast } from './toast';
import { queryKeys } from './records';
import { useNarrow } from './use-narrow';

const finishedLabels = ['Integrated', 'Finished', 'Stopped', 'Cancelled', 'Closed'];

interface DirectorInput {
  id: string;
  name: string;
  mediaType: string;
  byteLength: number;
  projectId: string;
  runId: string;
}

export function IdeaPage({ projectId, run, state }: { projectId: string; run: RunStory; state: StudioState }) {
  const narrow = useNarrow(),
    looks = useMemo(
      () => agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
      [projectId, state.workers, state.employeeDirectory],
    ),
    stages = journeyStages(run, state),
    stories = journeyStories(run, state),
    groups = happened(run, state),
    people = whoWorked(run, state),
    chip = journeyChip(run, state),
    { stories: storyTasks, tasks: runTasks } = runRecords(run, state),
    serial = storyTasks.every(
      (task, index) => index === 0 || (task.dependencies ?? []).includes(storyTasks[index - 1]!.id),
    ),
    source = stories.some(story => story.task.kind === 'studio-development:change'),
    inputs = run.directorInputs as DirectorInput[],
    // Finished work's attempts come without their files; each such step's own page has them, read once and kept
    // with it.
    bare = run.taskIds.filter(taskId => {
      const tried = state.attempts.filter(attempt => attempt.taskId === taskId);
      return tried.length > 0 && tried.every(attempt => !attempt.artifacts);
    }),
    pages = useQueries({
      queries: bare.map(taskId => ({
        queryKey: queryKeys.task(projectId, taskId),
        queryFn: ({ signal }: { signal: AbortSignal }) => getJSON<TaskPage>(taskUrl(projectId, taskId), signal),
      })),
    }),
    filed = pages.flatMap(page => page.data?.attempts ?? []),
    made = produced(
      run,
      filed.length
        ? { ...state, attempts: state.attempts.map(attempt => filed.find(item => item.id === attempt.id) ?? attempt) }
        : state,
    ),
    finished = finishedLabels.includes(run.outcome.label),
    sent = `You sent this at ${clockOf(run.startedAt)}`,
    attached = inputs.length ? `${inputs.length} ${plural(inputs.length, 'file')} attached` : 'no files attached';
  const cards = (inside = false) =>
    stories.map((story, index) => (
      <Fragment key={story.task.id}>
        {!inside && index > 0 && (
          <span className="sd-lane__arrow" aria-hidden="true">
            <Icon name="arrow" size={22} weight={2.6} />
          </span>
        )}
        <StoryCard projectId={projectId} story={story} />
      </Fragment>
    ));
  return (
    <article className="sd-ideapage">
      <div className="sd-backbar">
        <Link
          className="sd-btn sd-btn--ghost"
          style={{ padding: '0 12px', gap: 'var(--space-4)' }}
          to="/p/$projectId/runs"
          params={{ projectId }}
        >
          <Icon name="back" size={20} weight={2.4} />
          Ideas
        </Link>
        <span className="sd-meta sd-backbar__place">{state.project.name}</span>
        {narrow && <IdeaActions projectId={projectId} run={run} state={state} compact />}
      </div>
      <nav className="sd-crumbs" aria-label="You are here">
        <Link to="/p/$projectId/runs" params={{ projectId }}>
          Ideas
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{state.project.name}</span>
      </nav>
      <header className="sd-ideahead">
        <div className="sd-ideahead__text">
          <div className="sd-ideahead__meta">
            <span className={`sd-chip sd-chip--${chip.tone}`} style={{ alignSelf: 'flex-start' }}>
              <span className="sd-chip__dot"></span>
              {chip.label}
            </span>
            <span className="sd-meta sd-wide-only">
              {sent} · {attached}
            </span>
          </div>
          <h1 className="sd-ideahead__title">{firstSentence(run.brief) || run.title}</h1>
          <span className="sd-meta sd-narrow-only">{sent}</span>
          {finished && run.outcome.text && (
            <span style={{ color: 'var(--ink-2)', maxWidth: '72ch' }}>{run.outcome.text}</span>
          )}
        </div>
        {!narrow && <IdeaActions projectId={projectId} run={run} state={state} />}
      </header>
      <section className="sd-card sd-journey" aria-label="Journey">
        <ol className="sd-journey__track">
          {stages.map(stage => (
            <li key={stage.label} className={`sd-journey__station sd-journey__station--${stage.state}`}>
              <span className="sd-journey__node" aria-hidden="true">
                <Icon name={stationIcon(stage)} size={narrow ? 18 : 20} weight={stage.state === 'done' ? 3 : 2.4} />
              </span>
              <span className="sd-journey__body">
                <b className="sd-journey__label">{stage.label}</b>{' '}
                <span className="sd-meta sd-journey__note">{stage.note}</span>
                {narrow && stage.icon === 'build' && <span className="sd-journey__stories">{cards(true)}</span>}
              </span>
            </li>
          ))}
        </ol>
      </section>
      {!narrow && stories.length > 0 && (
        <section aria-labelledby="idea-stories" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 'var(--space-10)' }}>
            <h2 id="idea-stories" className="sd-section-title sd-section-title--sm">
              {stories.length === 1
                ? 'One story'
                : `${counted(stories.length)} stories${serial ? ', one after another' : ''}`}
            </h2>
            {stories.length > 1 && serial && (
              <span className="sd-meta">
                Each starts when the one before it is {source ? 'integrated' : 'accepted'}.
              </span>
            )}
          </div>
          <div className="sd-lane">{cards()}</div>
        </section>
      )}
      {made.length > 0 && (
        <section aria-labelledby="idea-produced" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 'var(--space-10)',
            }}
          >
            <h2 id="idea-produced" className="sd-section-title sd-section-title--sm">
              What it produced
            </h2>
            <span className="sd-meta">{producedLine(made)}</span>
          </div>
          <FileViewer projectId={projectId} entries={made} />
        </section>
      )}
      {narrow ? (
        <>
          <Stops groups={groups} />
          <details className="sd-card" style={{ padding: '4px 16px' }}>
            <summary
              style={{ minHeight: '48px', display: 'flex', alignItems: 'center', fontWeight: 700, cursor: 'pointer' }}
            >
              Your idea, in full
            </summary>
            <div style={{ color: 'var(--ink-2)', paddingBottom: '14px' }}>
              <TextReader text={run.brief} markdown />
            </div>
          </details>
        </>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '28px', alignItems: 'flex-start' }}>
          <Happened projectId={projectId} groups={groups} />
          <aside
            style={{ flex: '2 1 320px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-16)' }}
          >
            <YourIdea projectId={projectId} brief={run.brief} inputs={inputs} />
            {people.length > 0 && (
              <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="idea-who">
                <h2 id="idea-who" className="sd-sidecard__title">
                  Who worked on it
                </h2>
                {people.map(person => (
                  <div key={person.workerId} className="sd-person">
                    {looks.get(person.workerId) && (
                      <AgentAvatar
                        look={looks.get(person.workerId)!}
                        size={30}
                        state={agentState(state, person.workerId, [...runTasks.values()])}
                        ring={false}
                      />
                    )}
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b>{person.name}</b> <span className="sd-meta">{person.did}</span>
                    </span>
                    <span className="sd-meta">{person.time}</span>
                  </div>
                ))}
              </section>
            )}
            {source && <Landed stories={stories} finished={finished} selfHosted={integratesController(state)} />}
          </aside>
        </div>
      )}
    </article>
  );
}

// "3 things made, a review and 6 records".
function producedLine(entries: ViewerEntry[]) {
  const count = (group: ViewerEntry['group']) => entries.filter(entry => entry.group === group).length,
    made = count('made'),
    reviews = count('review'),
    records = count('record');
  return [
    made ? `${made} ${plural(made, 'thing')} made` : '',
    reviews ? (reviews === 1 ? 'a review' : `${reviews} reviews`) : '',
    records ? `${records} ${plural(records, 'record')}` : '',
  ]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
}

const stationIcon = (stage: JourneyStage): IconName =>
  stage.state === 'done'
    ? 'check'
    : stage.icon === 'build'
      ? 'build'
      : stage.icon === 'flag'
        ? 'flag'
        : stage.label === 'Checked'
          ? 'test'
          : stage.label === 'Planned'
            ? 'ideas'
            : 'arrow';

function StoryCard({ projectId, story }: { projectId: string; story: JourneyStory }) {
  const started = story.segments.slice(1).some(segment => segment !== 'todo'),
    variant =
      story.chip.tone === 'live'
        ? ' sd-storycard--live'
        : story.chip.tone === 'you'
          ? ' sd-storycard--you'
          : !started && story.chip.tone === 'wait'
            ? ' sd-storycard--todo'
            : '';
  return (
    <Link
      className={`sd-storycard${variant}`}
      to="/p/$projectId/tasks/$taskId"
      params={{ projectId, taskId: story.task.id }}
    >
      <span className="sd-storycard__head">
        <span className="sd-eyebrow">Story {story.number}</span>
        <span className={`sd-chip${story.chip.tone === 'wait' ? '' : ` sd-chip--${story.chip.tone}`}`}>
          <span className="sd-chip__dot"></span>
          {story.chip.label}
        </span>
      </span>
      <span className="sd-storycard__title">{story.task.title}</span>
      <span className="sd-segments" aria-hidden="true">
        {story.segments.map((segment, index) => (
          <i key={index} className={segment === 'todo' ? undefined : `sd-segments__${segment}`}></i>
        ))}
      </span>
      <span className="sd-storycard__foot">
        {story.commit && <span className="sd-file">{story.commit}</span>}
        <span className="sd-meta">{story.foot}</span>
      </span>
    </Link>
  );
}

const entryIcons: Record<HappenedEntry['icon'], IconName> = {
  send: 'arrow',
  check: 'check',
  merge: 'merge',
  pause: 'clock',
  play: 'play',
  stop: 'alert',
  test: 'test',
  note: 'note',
};

function Entry({ projectId, entry }: { projectId: string; entry: HappenedEntry }) {
  const plain = ['send', 'play'].includes(entry.icon);
  return (
    <li>
      <span className="sd-timeline__time">{clockOf(entry.at)}</span>
      <span className={`sd-timeline__icon${plain ? '' : ` sd-timeline__icon--${entry.tone}`}`}>
        <Icon name={entryIcons[entry.icon]} size={14} weight={entry.icon === 'check' ? 3 : 2.4} />
      </span>
      <span className="sd-timeline__body">
        <span>
          <b>{entry.lead}</b>
          {entry.commit && (
            <>
              {' '}
              as <span className="sd-file">{entry.commit}</span>
            </>
          )}{' '}
          {entry.text && (
            <span
              className={entry.commit ? 'sd-meta' : undefined}
              style={entry.commit ? undefined : { color: 'var(--ink-2)' }}
            >
              {entry.text}
            </span>
          )}
        </span>
        {entry.quote && <span className="sd-timeline__quote">{entry.quote}</span>}
        {entry.failures?.map(failure => (
          <span key={failure} className="sd-timeline__quote">
            {failure}
          </span>
        ))}
        {entry.links && entry.links.length > 0 && (
          <span style={{ display: 'flex', gap: 'var(--space-6)', flexWrap: 'wrap' }}>
            {entry.links.map((link, index) => (
              <a
                key={link.path}
                className={`sd-btn sd-btn--sm${index > 0 ? ' sd-btn--ghost' : ''}`}
                href={artifactUrl(projectId, link.attemptId, link.path)}
                download
              >
                {link.label}
              </a>
            ))}
          </span>
        )}
        {entry.live && entry.taskId && (
          <Link
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            to="/p/$projectId/tasks/$taskId"
            params={{ projectId, taskId: entry.taskId }}
          >
            Watch live
          </Link>
        )}
      </span>
    </li>
  );
}

// What happened, everything or only the stops and decisions.
function Happened({ projectId, groups }: { projectId: string; groups: ReturnType<typeof happened> }) {
  const [only, setOnly] = useState(false),
    id = useId();
  return (
    <section className="sd-card sd-happened" aria-labelledby={`${id}-title`} style={{ flex: '3 1 560px', minWidth: 0 }}>
      <div className="sd-happened__head">
        <h2 id={`${id}-title`} className="sd-section-title sd-section-title--sm">
          What happened
        </h2>
        <div className="sd-filters" role="group" aria-label="Show">
          <button type="button" aria-pressed={!only} onClick={() => setOnly(false)}>
            Everything
          </button>
          <button type="button" aria-pressed={only} onClick={() => setOnly(true)}>
            Only stops and decisions
          </button>
        </div>
      </div>
      {groups.map(group => {
        const entries = only ? group.entries.filter(entry => entry.stop || entry.decision) : group.entries;
        if (!entries.length) return null;
        return (
          <Fragment key={group.key}>
            <div className="sd-group">
              <span className="sd-eyebrow">{group.title}</span>
              {group.chip && (
                <span
                  className={`sd-chip sd-chip--inline${group.chip.tone === 'wait' ? '' : ` sd-chip--${group.chip.tone}`}`}
                >
                  <span className="sd-chip__dot"></span>
                  {group.chip.label}
                </span>
              )}
            </div>
            <ol className="sd-timeline">
              {entries.map((entry, index) => (
                <Entry key={index} projectId={projectId} entry={entry} />
              ))}
            </ol>
          </Fragment>
        );
      })}
      {only && !groups.some(group => group.entries.some(entry => entry.stop || entry.decision)) && (
        <p className="sd-meta" style={{ margin: '0 0 12px' }}>
          Nothing stopped, and nothing waited for a decision.
        </p>
      )}
    </section>
  );
}

// On a phone: the stops along the way, or everything.
function Stops({ groups }: { groups: ReturnType<typeof happened> }) {
  const [all, setAll] = useState(false),
    entries = groups.flatMap(group => group.entries).filter(entry => all || entry.stop);
  return (
    <section className="sd-card sd-happened" aria-labelledby="idea-stops">
      <div className="sd-happened__head">
        <h2 id="idea-stops" className="sd-sidecard__title">
          {all ? 'Everything that happened' : 'Stops along the way'}
        </h2>
        <button type="button" className="sd-link" onClick={() => setAll(!all)}>
          {all ? 'Only stops' : 'Everything'}
        </button>
      </div>
      {entries.length ? (
        entries.map((entry, index) => (
          <div
            key={index}
            className="sd-row"
            style={{ display: 'grid', gridTemplateColumns: '62px minmax(0, 1fr)', gap: 'var(--space-10)' }}
          >
            <span className="sd-meta" style={{ paddingTop: '1px' }}>
              {clockOf(entry.at)}
            </span>
            <span>
              <b>{entry.lead}</b>
              {entry.commit && ` as ${entry.commit}`}{' '}
              {entry.text && <span style={{ color: 'var(--ink-2)' }}>{entry.text}</span>}
            </span>
          </div>
        ))
      ) : (
        <p className="sd-meta" style={{ margin: '0 0 10px' }}>
          No stops so far.
        </p>
      )}
    </section>
  );
}

// The idea in the director's own words, folded past its first part, with the files they attached.
function YourIdea({ projectId, brief, inputs }: { projectId: string; brief: string; inputs: DirectorInput[] }) {
  const [open, setOpen] = useState(false),
    [long, setLong] = useState(false),
    body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !open) setLong(element.scrollHeight > element.clientHeight + 4);
  }, [brief, open]);
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="idea-yours"
      style={{ gap: 'var(--space-10)' }}
    >
      <h2 id="idea-yours" className="sd-sidecard__title">
        Your idea
      </h2>
      <div
        ref={body}
        style={{
          color: 'var(--ink-2)',
          textWrap: 'pretty',
          ...(open ? {} : { maxHeight: '340px', overflow: 'hidden' }),
        }}
      >
        <TextReader text={brief} markdown />
      </div>
      {(long || open) && (
        <button type="button" className="sd-link" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Read all of it'}
        </button>
      )}
      {inputs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <span className="sd-eyebrow">Files you attached</span>
          {inputs.map(item => (
            <span
              key={item.id}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'baseline' }}
            >
              <a
                href={`/api/projects/${encodeURIComponent(item.projectId)}/runs/${encodeURIComponent(item.runId)}/inputs/${encodeURIComponent(item.id)}?projectId=${encodeURIComponent(projectId)}`}
                download
              >
                {item.name}
              </a>
              <span className="sd-meta">
                {item.mediaType} · {fileSize(item.byteLength)}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// The commits so far, with the stories they came from.
function Landed({
  stories,
  finished,
  selfHosted,
}: {
  stories: JourneyStory[];
  finished: boolean;
  selfHosted: boolean;
}) {
  const landed = stories.filter(story => story.commit),
    left = stories.length - landed.length;
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="idea-landed"
      style={{ gap: 'var(--space-10)' }}
    >
      <h2 id="idea-landed" className="sd-sidecard__title">
        {finished ? 'What landed' : 'Landed so far'}
      </h2>
      {landed.length ? (
        landed.map(story => (
          <span
            key={story.task.id}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center', minWidth: 0 }}
          >
            <span className="sd-file">{story.commit}</span>
            <span
              className="sd-meta"
              style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '1 1 0' }}
            >
              {story.task.title}
            </span>
          </span>
        ))
      ) : (
        <span className="sd-meta">Nothing has landed yet.</span>
      )}
      {!finished && left > 0 && (
        <span className="sd-meta">
          The rest lands one story at a time.{selfHosted ? ' Promote the stable copy to run it.' : ''}
        </span>
      )}
    </section>
  );
}

// Pause or resume the project, and the idea's quieter actions behind More: archive a finished idea, or close
// what is left of it.
function IdeaActions({
  projectId,
  run,
  state,
  compact = false,
}: {
  projectId: string;
  run: RunStory;
  state: StudioState;
  compact?: boolean;
}) {
  const toast = useToast(),
    id = useId(),
    paused = !!state.project.dispatchPaused,
    archived = !!run.archive?.archived,
    canArchive = !!run.archive && finishedLabels.includes(run.outcome.label),
    closable = run.needsYou.filter(item => item.canClose).map(item => item.taskId),
    open = !finishedLabels.includes(run.outcome.label);
  const request = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown>; done: string }) =>
      send(path, { projectId, ...body }),
    onSuccess: (_, { done }) => toast(done),
    onError: failure => toast(failure.message),
  });
  const pause = () =>
      request.mutate({
        path: '/api/pipeline',
        body: { action: paused ? 'resume' : 'pause' },
        done: paused ? 'The project runs again.' : 'Paused. Running work finishes; nothing new starts.',
      }),
    archive = () =>
      request.mutate({
        path: `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.id)}/${archived ? 'restore' : 'archive'}`,
        body: {},
        done: archived ? 'Idea restored.' : 'Idea archived.',
      }),
    close = () => {
      if (
        confirm(
          `Close ${closable.length} unstarted ${plural(closable.length, 'story', 'stories')} of this idea? Nothing that already ran is changed.`,
        )
      )
        request.mutate({
          path: '/api/tasks/close',
          body: { taskIds: closable, reason: 'Closed from the idea.' },
          done: `Closed ${closable.length} unstarted ${plural(closable.length, 'story', 'stories')}.`,
        });
    };
  const more = [
    ...(compact && open ? [{ label: paused ? 'Resume this project' : 'Pause this project', onClick: pause }] : []),
    ...(archived || canArchive
      ? [{ label: archived ? 'Restore this idea' : 'Archive this idea', onClick: archive }]
      : []),
    ...(closable.length ? [{ label: `Close what is left (${closable.length})`, onClick: close }] : []),
  ];
  return (
    <div className="sd-ideahead__actions">
      {!compact && open && (
        <button type="button" className="sd-btn" disabled={request.isPending} onClick={pause}>
          {paused ? 'Resume this project' : 'Pause this project'}
        </button>
      )}
      {more.length > 0 && (
        <>
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            style={{ width: '48px', padding: 0 }}
            aria-label="More actions"
            popoverTarget={`${id}-more`}
          >
            <Icon name="more" size={20} />
          </button>
          <div id={`${id}-more`} popover="auto" className="sd-menu" role="menu" aria-label="More actions">
            <div className="sd-menu__list">
              {more.map(item => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className="sd-btn sd-btn--ghost"
                  disabled={request.isPending}
                  onClick={item.onClick}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
