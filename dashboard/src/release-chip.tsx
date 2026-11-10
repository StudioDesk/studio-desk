// The release chip and its picker (1.1 step 6, the canvas's ReleaseChip): the release an idea or a story is for, its
// line when that is not the newest, and why it is there. The New idea box picks one before sending; a story's chip moves
// it until the story starts, then locks and says why. The picker lists the open milestones, says why any of them is out
// of reach, and the controller still decides: a refusal is shown in its words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import {
  getJSON,
  releasesUrl,
  send,
  type AttemptSummary,
  type Milestone,
  type ReleaseOverview,
  type RunRecord,
  type Task,
} from './api';
import { Icon } from './design/icons';
import { queryKeys } from './records';
import { useToast } from './toast';

const story = 'studio-development:change';

export interface ReleaseBy {
  type?: string;
}
export interface ReleaseOf {
  milestoneId?: string;
  version: string;
  line?: string | null;
  by?: ReleaseBy;
}
export interface ReleaseChoice {
  // A milestone's ID, or "auto" for the release the controller picks.
  id: string;
  version: string;
  line: string | null;
  note: string;
  // Why it cannot be picked, when it cannot.
  off?: string;
}

// The project's releases, read once for every chip on a page and with the Releases page; only a project on a git
// repository has them. They are read again with the project's other records when the studio reports a change to them.
export function useReleases(projectId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.releases(projectId),
    queryFn: ({ signal }) => getJSON<ReleaseOverview>(releasesUrl(projectId), signal),
    enabled,
    staleTime: 30_000,
  });
}

const versionOf = (text: string) => text.split('.').map(Number);
export const byVersion = (a: { version: string }, b: { version: string }) => {
  const [x, y] = [versionOf(a.version), versionOf(b.version)];
  return x[0]! - y[0]! || x[1]! - y[1]! || (x[2] ?? 0) - (y[2] ?? 0);
};
export const releaseKind = (version: string) => {
  const [, minor, patch] = versionOf(version);
  return patch ? 'Patch' : minor ? 'Minor' : 'Major';
};
// The release new work lands in when nobody picks one: the open milestone the controller marks next, by the rule it
// uses at intake.
export const nextRelease = (milestones: Milestone[]) =>
  milestones.filter(item => item.state === 'open' && item.next).sort(byVersion)[0];
export const newestBranch = (overview?: ReleaseOverview) => overview?.lines?.find(line => line.newest)?.branch ?? null;

// The open milestones, lowest version first, each with its kind, line and whether it is the next release.
export function releaseChoices(overview?: ReleaseOverview): ReleaseChoice[] {
  const milestones = overview?.milestones ?? [],
    next = nextRelease(milestones),
    newest = newestBranch(overview);
  return milestones
    .filter(item => item.state === 'open')
    .sort(byVersion)
    .map(item => ({
      id: item.id,
      version: item.version,
      line: item.line,
      note: [
        releaseKind(item.version),
        item.line ?? newest ?? 'the newest line',
        item.id === next?.id && 'the next release',
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}

// Why work is in its release, in a few words: only the director picks one (MP-032).
export function releaseReason(by?: ReleaseBy) {
  if (by?.type === 'director') return 'your pick';
  if (by?.type === 'default') return 'next release';
  return '';
}

// A story's release: its own once the director moved it, otherwise its idea's.
export const storyRelease = (task: Task, run?: RunRecord | null): ReleaseOf | null => {
  const own = task.release as ReleaseOf | undefined,
    idea = run?.release as ReleaseOf | undefined;
  if (own) return own;
  return idea ? { ...idea, line: (run?.line as string | undefined) ?? null } : null;
};
// The idea a task belongs to, among the runs the page holds.
export const runOfTask = (runs: RunRecord[], taskId: string) =>
  runs.find(run => (run.nodes as { taskId?: string }[] | undefined)?.some(node => node.taskId === taskId));
// A story has started once one of its build attempts exists; from then on its work stays on its branch.
export const storyStarted = (task: Task, attempts: AttemptSummary[]) =>
  attempts.some(
    attempt =>
      attempt.taskId === task.id &&
      (((attempt.assignment as { kind?: string } | undefined)?.kind ?? task.kind) as string) === story,
  );
// The stories it waits on or that wait on it: while it has any, it moves only within its line.
export const linkedStories = (task: Task, tasks: Task[]) =>
  tasks.filter(
    other =>
      other.id !== task.id &&
      other.kind === story &&
      ((task.dependencies ?? []).includes(other.id) || (other.dependencies ?? []).includes(task.id)),
  );

export function ReleaseChip({
  projectId,
  label,
  version,
  line,
  reason,
  compact = false,
  locked,
  choices,
  current,
  onPick,
  footer,
  busy = false,
}: {
  projectId: string;
  // What the picker is for: "Release for this story".
  label: string;
  version: string | null;
  // Shown when it is not the newest line.
  line: string | null;
  reason?: string;
  compact?: boolean;
  // Why it cannot change; the chip is then plain, with a lock.
  locked?: string;
  choices?: ReleaseChoice[];
  current?: string;
  onPick?: (choice: ReleaseChoice) => void;
  footer?: string;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false),
    wrap = useRef<HTMLSpanElement>(null),
    id = useId(),
    movable = !locked && !!onPick && !!choices?.length,
    shown = version ?? 'No release';
  // The picker closes on a click outside it or on Escape, and gives the focus back to the chip.
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    wrap.current?.querySelector<HTMLButtonElement>('.sd-relpick__item:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);
  const face = (
    <>
      <Icon name="tag" size={compact ? 12 : 14} weight={2.2} />
      <span>{shown}</span>
      {line && <span className="sd-relchip__line">{line}</span>}
      {!compact && reason && !locked && <span className="sd-relchip__why">· {reason}</span>}
      {locked && <Icon name="lock" size={13} weight={2.2} />}
    </>
  );
  if (!movable)
    return (
      <span
        className={`sd-relchip sd-relchip--still${compact ? ' sd-relchip--compact' : ''}`}
        title={locked ?? (reason ? `${shown} · ${reason}` : shown)}
        aria-label={`Release: ${shown}${line ? ` on ${line}` : ''}${locked ? `. ${locked}` : reason ? `, ${reason}` : ''}`}
      >
        {face}
      </span>
    );
  return (
    <span
      ref={wrap}
      className={`sd-relchip${compact ? ' sd-relchip--compact' : ''}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
          wrap.current?.querySelector<HTMLButtonElement>('.sd-relchip__button')?.focus();
        }
      }}
    >
      <button
        type="button"
        className="sd-relchip__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`Release: ${shown}${line ? ` on ${line}` : ''}${reason ? `, ${reason}` : ''}. Change`}
        disabled={busy}
        onClick={event => {
          // A chip on a card that opens a page changes the release without opening it.
          event.preventDefault();
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {face}
        <Icon name="down" size={14} weight={2.4} />
      </button>
      {open && (
        <div id={id} role="dialog" aria-label={label} className="sd-relpick">
          <span className="sd-relpick__head">{label}</span>
          {choices!.map(choice => {
            const on = choice.id === current;
            return (
              <button
                key={choice.id}
                type="button"
                className="sd-relpick__item"
                aria-pressed={on}
                disabled={!!choice.off}
                title={choice.off}
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setOpen(false);
                  if (!on) onPick!(choice);
                }}
              >
                <span className="sd-relpick__radio" aria-hidden="true"></span>
                <span className="sd-relpick__text">
                  <span>
                    <b>{choice.version}</b>
                    {choice.line && <span className="sd-relchip__line">{choice.line}</span>}
                  </span>
                  <span className="sd-meta">{choice.off ?? choice.note}</span>
                </span>
              </button>
            );
          })}
          <Link className="sd-relpick__new" to="/p/$projectId/releases" params={{ projectId }}>
            <Icon name="plus" size={16} weight={2.4} />
            New milestone…
          </Link>
          {footer && <span className="sd-relpick__foot">{footer}</span>}
        </div>
      )}
    </span>
  );
}

// A story's chip: where it is, why, and while it has not started, the milestones it can move to. Moving it is the
// controller's to allow; a refusal shows in its words.
export function StoryReleaseChip({
  projectId,
  task,
  run,
  tasks,
  attempts,
  compact,
}: {
  projectId: string;
  task: Task;
  run?: RunRecord | null;
  tasks: Task[];
  attempts: AttemptSummary[];
  compact?: boolean;
}) {
  const release = storyRelease(task, run),
    started = storyStarted(task, attempts),
    releases = useReleases(projectId, task.kind === story && !!release),
    client = useQueryClient(),
    toast = useToast(),
    move = useMutation({
      mutationFn: (choice: ReleaseChoice) =>
        send<Task>(`/api/tasks/${encodeURIComponent(task.id)}`, { projectId, release: choice.id }, 'PATCH'),
      onSuccess: (_, choice) => {
        toast(`${task.title} moves to ${choice.version}.`);
        void client.invalidateQueries({ queryKey: queryKeys.task(projectId, task.id) });
        void client.invalidateQueries({ queryKey: queryKeys.live(projectId) });
        void client.invalidateQueries({ queryKey: queryKeys.releases(projectId) });
      },
      onError: error => toast(error.message),
    });
  if (task.kind !== story || !release) return null;
  // A milestone and a story both name the branch they are on; one that names none is on the newest line.
  const newest = newestBranch(releases.data),
    linked = linkedStories(task, tasks),
    own = release.line ?? newest,
    choices = releaseChoices(releases.data).map(choice =>
      linked.length && (choice.line ?? newest) !== own
        ? {
            ...choice,
            off: `It is linked to ${linked.map(other => other.id).join(', ')} on ${own ?? 'its line'}, so it can't move to ${choice.line ?? newest ?? 'the newest line'} by itself.`,
          }
        : choice,
    );
  return (
    <ReleaseChip
      projectId={projectId}
      label="Release for this story"
      version={release.version}
      line={own && own !== newest ? own : null}
      reason={releaseReason(release.by)}
      compact={compact}
      locked={
        started
          ? `It has started on ${own ?? 'the newest line'}, so its work ships in ${release.version}. Only a story that has not started can move.`
          : undefined
      }
      choices={choices}
      current={release.milestoneId}
      onPick={choice => move.mutate(choice)}
      busy={move.isPending}
      footer="A story can move until it starts. It moves to another line only when no other story waits on it and it waits on none."
    />
  );
}
