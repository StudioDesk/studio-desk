// The activity log (v1.0 item 23; built in the redesign's language, as an idea's What happened): every event the
// controller recorded in the project, newest first, grouped by day and read a page at a time. What an agent did in
// an attempt is in that attempt's trace, not here.
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { activityUrl, getJSON, type ActivityPage as Activity, type LogEvent } from './api';
import { Icon, type IconName } from './design/icons';
import { Heading } from './layout';
import { queryKeys } from './records';
import { useStreamReady } from './stream-context';

// An event's tone, from its kind: what passed or was decided, what stopped, what began, and the rest plainly. A
// review and an employee's own test run say in their words whether they passed.
const passed = [
    'accepted',
    'source_integrated',
    'integration_reconciled',
    'reconciled',
    'pipeline_finished',
    'work_approved',
    'commands_approved',
    'project_created',
  ],
  stopped = [
    'failed',
    'blocked',
    'quarantined',
    'interrupted',
    'integration_uncertain',
    'cleanup_failed',
    'resource_conflict',
    'work_denied',
    'work_closed',
  ],
  began = [
    'started',
    'workflow_started',
    'candidate_checks',
    'source_verifying',
    'integration_requested',
    'autonomy_retry',
  ];
function toneOf({ kind, message }: LogEvent): ['ok' | 'bad' | 'live' | '', IconName] {
  if (kind === 'review' || kind === 'employee_tests') {
    if (/verdict is pass\b|(\d+)\/\1 tests passed/.test(message)) return ['ok', 'check'];
    if (/needs-work|blocked|fail/.test(message)) return ['bad', 'blocked'];
  }
  if (passed.includes(kind)) return ['ok', 'check'];
  if (stopped.includes(kind)) return ['bad', 'blocked'];
  if (began.includes(kind)) return ['live', 'play'];
  return ['', 'dash'];
}
// Structured records (an attempt's phases and checkpoints) belong to its trace, never to a list of sentences.
const sentence = (event: LogEvent) => !event.message.trimStart().startsWith('{');
const dayOf = (time: string) => {
  const date = new Date(time),
    today = new Date();
  const days = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86400000,
  );
  return days === 0
    ? 'Today'
    : days === 1
      ? 'Yesterday'
      : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

export function ActivityLogPage({ projectId }: { projectId: string }) {
  const activity = useInfiniteQuery({
      enabled: useStreamReady(),
      queryKey: queryKeys.activity(projectId),
      queryFn: ({ signal, pageParam }) => getJSON<Activity>(activityUrl(projectId, pageParam), signal),
      initialPageParam: null as number | null,
      getNextPageParam: page => page.next,
    }),
    events = (activity.data?.pages.flatMap(page => page.events) ?? []).filter(sentence),
    days: [string, LogEvent[]][] = [];
  for (const event of events) {
    const day = dayOf(event.time);
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(event);
    else days.push([day, [event]]);
  }
  return (
    <div className="sd-orgpage">
      <Heading
        crumbs={[
          <Link key="settings" to="/p/$projectId/settings" params={{ projectId }}>
            Settings
          </Link>,
        ]}
        here="Activity log"
        title="Activity log"
        lead="Everything the controller recorded in this project, newest first. What an agent did in an attempt, step by step, is in its trace."
      />
      <section className="sd-card sd-happened sd-loglist" aria-label="Recorded events">
        {activity.error ? (
          <p role="alert">The activity could not be loaded: {activity.error.message}</p>
        ) : activity.isPending ? (
          <p className="sd-meta" role="status">
            Reading the recorded events…
          </p>
        ) : !events.length ? (
          <p className="sd-meta">Nothing recorded yet.</p>
        ) : (
          days.map(([day, list], index) => (
            <div key={day}>
              <div className="sd-group" style={index === 0 ? { borderTop: 0, paddingTop: 0 } : undefined}>
                <span className="sd-eyebrow">{day}</span>
              </div>
              <ol className="sd-timeline">
                {list.map(event => {
                  const [tone, icon] = toneOf(event);
                  return (
                    <li key={event.seq}>
                      <span className="sd-timeline__time">
                        {new Date(event.time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </span>
                      <span className={`sd-timeline__icon${tone ? ` sd-timeline__icon--${tone}` : ''}`}>
                        <Icon name={icon} size={14} weight={2.4} />
                      </span>
                      <span className="sd-timeline__body">
                        <span>{event.message}</span>
                        {event.task_id && (
                          <span className="sd-meta">
                            <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: event.task_id }}>
                              {event.task_id}
                            </Link>
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))
        )}
        {activity.hasNextPage && (
          <button
            type="button"
            className="sd-btn sd-btn--sm sd-btn--ghost"
            style={{ alignSelf: 'flex-start', marginTop: 'var(--space-10)' }}
            disabled={activity.isFetchingNextPage}
            onClick={() => void activity.fetchNextPage()}
          >
            {activity.isFetchingNextPage ? 'Reading…' : 'Show older events'}
          </button>
        )}
      </section>
    </div>
  );
}
