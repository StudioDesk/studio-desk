// The card beside another project's tile on the project rail (the attention indicator, October 29): pointing at the
// tile or focusing it shows the project's mark, its name, how many calls wait and a line for each call, saying what
// to do and where, in the order the project's Today lists them; each line links to its call's page in the project.
// The card reads nothing itself: the rail has read the project's shell and live set, and the card follows them as
// the rail reads them again.
import { useQuery } from '@tanstack/react-query';
import {
  useMemo,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type PointerEventHandler,
  type Ref,
} from 'react';
import { getJSON, shellUrl, type Project, type Shell } from './api';
import { decisionState } from './decisions';
import { initials, projectColor } from './frame';
import type { ProjectCalls } from './rail-calls';
import { queryKeys, readLive } from './records';
import {
  isCarry,
  isCleanup,
  isHold,
  isRelease,
  isResume,
  liveSummary,
  type HomeItem,
  type RunStory,
  type StudioState,
} from './studio-runs';
import { placeIn, quoted } from './today';

const plural = (count: number, one: string, many = one + 's') => (count === 1 ? one : many);

// An idea in the director's words, or its title when it has none.
const idea = (run: RunStory) => (run.brief.trim() ? quoted(run.brief, 56) : run.title);

// A step that proposes the stories: approving it approves the plan.
const planning = (kind: string) => /(^|:)(plan|breakdown)$/.test(kind);

export interface CallLine {
  key: string;
  // What to do, as the call Today shows for it asks.
  verb: string;
  // Where: the idea in the director's words, or the task's title.
  where: string | null;
  // The call's page, after the project's address (/p/<id>): its idea's page, the step's own page outside any idea, the
  // Releases page for a stopped release, the story's page for a stopped carry, or Today at Your calls for a hold, a
  // project's resume or a call with neither.
  to: string;
}

const ideaPage = (run: RunStory) => `/runs/${encodeURIComponent(run.id)}`;

// One call in a line: what to do, chosen the way Today's Call chooses the call's card, and where it is.
export function callLine(item: HomeItem, state: StudioState, stories: RunStory[]): CallLine {
  if (isHold(item)) {
    const waiting = item.taskIds.length;
    return {
      key: `hold:${item.provider}`,
      verb: `Clear the ${item.label} hold`,
      where: waiting ? `${waiting} ${plural(waiting, 'step waits', 'steps wait')} on it` : null,
      to: '#calls',
    };
  }
  // The project held after a restart, with the stories that wait only for its resume, links to Today at Your calls.
  if (isResume(item)) {
    const waiting = item.taskIds.length;
    return {
      key: `resume:${item.projectId}`,
      verb: 'Resume this project',
      where: waiting ? `${waiting} ${plural(waiting, 'story waits', 'stories wait')} on it` : null,
      to: '#calls',
    };
  }
  // A milestone's stopped release links to the Releases page, where it is released again.
  if (isRelease(item))
    return {
      key: `release:${item.milestoneId}`,
      verb: `Release ${item.version} again`,
      where: null,
      to: '/releases',
    };
  // A story's turned-down or stopped carry links to the story's own page.
  if (isCarry(item))
    return {
      key: `carry:${item.taskId}`,
      verb: `${item.back ? 'Bring back' : 'Carry'} to ${item.line} again`,
      where: item.title,
      to: `/tasks/${encodeURIComponent(item.taskId)}`,
    };
  if (isCleanup(item)) {
    const count = item.members.length;
    return {
      key: `cleanup:${item.run.id}`,
      verb: `Close ${count} unstarted ${plural(count, 'step')}`,
      where: idea(item.run),
      to: ideaPage(item.run),
    };
  }
  const task = state.tasks.find(record => record.id === item.taskId),
    place = task ? placeIn(stories, task) : null,
    line = (verb: string): CallLine => ({
      key: item.taskId,
      verb,
      where: place ? idea(place.run) : (task?.title ?? item.taskId),
      to: place ? ideaPage(place.run) : task ? `/tasks/${encodeURIComponent(task.id)}` : '#calls',
    });
  if (!task) return line(item.action ?? 'Open the story');
  const decision = decisionState(task, state);
  if (decision.integrable && decision.review && decision.reviewItem) return line('Try and integrate');
  if (decision.returnable && decision.stage?.review) return line('Look at the requested changes');
  if (item.kind === 'scope-request') return line('Answer a file request');
  if (item.kind === 'command-request') return line('Answer a command request');
  if (item.kind === 'question') return line('Answer a question');
  if (decision.approval?.status === 'pending' && !decision.awaited)
    return line(planning(task.kind) ? 'Approve the plan' : 'Approve the story');
  if (task.status === 'review' && decision.latest) return line('Accept the result');
  // Stopped work, in its own words: Start assignment, Reconcile interrupted attempt and the like.
  return line(item.action ?? 'Open the story');
}

// Where the card goes: beside the tile, fixed to the window so the rail's scrolling never clips it. A tile in the
// window's upper half hangs the card from its top, and one lower down stands it on its bottom; the card scrolls
// within the room it has.
export interface CardPlace {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
}
const margin = 12;
export function cardPlace(tile: Pick<DOMRect, 'top' | 'bottom' | 'right'>, height = window.innerHeight): CardPlace {
  return tile.top < height / 2
    ? { left: tile.right, top: tile.top, maxHeight: height - tile.top - margin }
    : { left: tile.right, bottom: height - tile.bottom, maxHeight: tile.bottom - margin };
}

// The project's records as the rail read them, followed as it reads them again; never read here.
function useRead(projectId: string) {
  const shell = useQuery({
      queryKey: queryKeys.shell(projectId),
      queryFn: ({ signal }) => getJSON<Shell>(shellUrl(projectId), signal),
      enabled: false,
    }),
    live = useQuery({
      queryKey: queryKeys.live(projectId),
      queryFn: ({ signal }) => readLive(projectId, signal),
      enabled: false,
    });
  return useMemo<StudioState | null>(
    () => (shell.data && live.data ? { ...shell.data, ...live.data } : null),
    [shell.data, live.data],
  );
}

export function RailCard({
  ref,
  project,
  position,
  calls,
  place,
  go,
  onPointerLeave,
  onBlur,
  onKeyDown,
}: {
  ref?: Ref<HTMLDivElement>;
  project: Project;
  // The project's place on the rail, which gives its mark's color.
  position: number;
  calls: ProjectCalls;
  place: CardPlace;
  // A click on a link in the card, the project's name or a call's line, by the frame's rule for its links: a plain
  // click opens the page in the app and closes the card, and any other click is the browser's.
  go: (href: string) => MouseEventHandler<HTMLAnchorElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  onBlur?: FocusEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
}) {
  const state = useRead(project.id),
    stories = state ? liveSummary(state).stories : [],
    lines = state ? calls.items.map(item => callLine(item, state, stories)) : [];
  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Calls in ${project.name}`}
      className="sd-railcard"
      style={place}
      onPointerLeave={onPointerLeave}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
    >
      <div className="sd-card sd-railcard__card">
        <div className="sd-railcard__head">
          <span className="sd-railcard__mark" style={projectColor(project, position)} aria-hidden="true">
            {initials(project.name)}
          </span>
          <div className="sd-railcard__title">
            <a className="sd-railcard__name" href={`/p/${project.id}`} onClick={go(`/p/${project.id}`)}>
              {project.name}
            </a>
            <span className="sd-chip sd-chip--you">
              <span className="sd-chip__dot"></span>
              {calls.count} {plural(calls.count, 'call')} for you
            </span>
          </div>
        </div>
        <ul className="sd-railcard__calls">
          {lines.map(line => {
            const href = `/p/${project.id}${line.to}`;
            return (
              <li key={line.key}>
                <a className="sd-railcard__call" href={href} onClick={go(href)}>
                  <b>{line.verb}</b>
                  {line.where && (
                    <>
                      {' '}
                      <span className="sd-meta">{line.where}</span>
                    </>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
