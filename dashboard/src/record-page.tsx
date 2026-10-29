// Everything recorded about one attempt, a page of its own that the story's Details card links to: the task and
// what it reserves, the attempt ids, the candidate's and the diff's hashes, the instructions it ran with, what it
// received, the file downloads and the log, the integration journal and the attempt's whole record. It reads the
// task's page and the project's records as the story does, and the attempt's full record.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { getJSON, taskUrl, type TaskPage } from './api';
import { useAttemptDetail } from './attempt-record';
import { Icon } from './design/icons';
import { queryKeys, useStudio } from './records';
import { attemptName, RecordPanel } from './story-tabs';
import { useStreamReady } from './stream-context';
import { liveSummary } from './studio-runs';
import { Crumbs, withPage } from './task-page';
import { placeIn } from './today';

export function RecordPage({ projectId, taskId, attemptId }: { projectId: string; taskId: string; attemptId: string }) {
  const { data, error, isPending } = useQuery({
      enabled: useStreamReady(),
      queryKey: queryKeys.task(projectId, taskId),
      queryFn: ({ signal }) => getJSON<TaskPage>(taskUrl(projectId, taskId), signal),
    }),
    { state } = useStudio(projectId),
    studio = useMemo(() => (state && data ? withPage(state, data) : null), [state, data]),
    attempt = data?.attempts.find(item => item.id === attemptId),
    detail = useAttemptDetail(projectId, attemptId, !!attempt),
    full = detail.data?.id === attemptId ? detail.data : undefined,
    place = data && state ? placeIn(liveSummary(state).stories, data.task) : undefined,
    idea = place ? { runId: place.run.id, brief: place.run.brief } : null,
    story = { taskId, label: place && place.index > 0 ? `Story ${place.index}` : taskId };
  if (error)
    return (
      <article className="sd-storypage">
        <Crumbs projectId={projectId} here="Record" story={story} />
        <h1 className="sd-storyhead__title">Record unavailable</h1>
        <p role="alert">The story could not be loaded: {error.message}</p>
      </article>
    );
  if (isPending || !studio || !state)
    return (
      <article className="sd-storypage">
        <Crumbs projectId={projectId} here="Record" story={story} />
        <p role="status" className="sd-meta">
          Loading the record…
        </p>
      </article>
    );
  const { task, attempts } = data,
    latest = attempts.find(item => item.id === task.lastAttemptId) ?? attempts.at(-1),
    name = attempt ? attemptName(task, attempts, attempt) : '';
  return (
    <article className="sd-storypage">
      <div className="sd-backbar">
        <Link
          className="sd-btn sd-btn--ghost"
          style={{ padding: '0 12px', gap: 'var(--space-4)' }}
          to="/p/$projectId/tasks/$taskId"
          params={{ projectId, taskId }}
        >
          <Icon name="back" size={20} weight={2.4} />
          Story
        </Link>
        <span className="sd-meta sd-backbar__place">{name || 'Record'}</span>
      </div>
      <Crumbs
        projectId={projectId}
        here={attempt ? `Record of ${name.toLowerCase()}` : 'Record'}
        idea={idea}
        story={story}
      />
      <header className="sd-storyhead">
        <div className="sd-storyhead__kind sd-wide-only">
          <span className="sd-mono sd-meta">{attemptId}</span>
        </div>
        <h1 className="sd-storyhead__title">Everything recorded about this attempt</h1>
        <span style={{ color: 'var(--ink-2)', fontSize: '14px' }}>
          {[task.title, name].filter(Boolean).join(' · ')}
        </span>
      </header>
      <section className="sd-card" aria-label="The record">
        {attempt ? (
          <RecordPanel
            projectId={projectId}
            task={task}
            studio={studio}
            shown={attempt}
            full={full}
            latest={attempt.id === latest?.id}
          />
        ) : (
          <div className="sd-tabpanel">
            <p role="alert" style={{ margin: 0 }}>
              This attempt is not one of the story&apos;s.{' '}
              <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId }}>
                Back to the story
              </Link>
            </p>
          </div>
        )}
      </section>
    </article>
  );
}
