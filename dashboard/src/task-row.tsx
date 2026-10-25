// A piece of work as the agents' and teams' pages list it.
import { Link } from '@tanstack/react-router';
import { isSourceStory } from './story';
import { active, statusLabels, type liveSummary, type StudioState } from './studio-runs';
import { placeIn } from './today';

// A piece of work in a list: its place (Story 2, or its ID), its title as a link and its status.
export function TaskRow({
  projectId,
  task,
  stories,
}: {
  projectId: string;
  task: StudioState['tasks'][number];
  stories: ReturnType<typeof liveSummary>['stories'];
}) {
  const place = placeIn(stories, task);
  return (
    <div className="sd-row" style={{ alignItems: 'center' }}>
      <span className="sd-row__text">
        <span className="sd-eyebrow" style={{ fontSize: '11px' }}>
          {place && place.index > 0 ? `Story ${place.index}` : isSourceStory(task) ? 'Story' : task.id}
        </span>
        <Link
          to="/p/$projectId/tasks/$taskId"
          params={{ projectId, taskId: task.id }}
          style={{ fontWeight: 600, color: 'var(--ink)', textDecoration: 'none' }}
        >
          {task.title}
        </Link>
      </span>
      <span
        className={`sd-chip sd-chip--inline${active(task) ? ' sd-chip--live' : task.status === 'done' ? ' sd-chip--ok' : ''}`}
      >
        <span className="sd-chip__dot"></span>
        {statusLabels[task.status] ?? task.status}
      </span>
    </div>
  );
}
