// Today (the canvas's Today and Today on a phone, v1.0 item 23): the page's sentence, the New idea box, the calls
// only the director can make with their evidence and the real actions, what moves without them, who is on the
// floor and what shipped today. Every action asks the controller for the same recorded step the task page would.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { send, type AttemptSummary, type Task, type Worker } from './api';
import { askedPaths, commandRequest, decisionState, fileRequest } from './decisions';
import { plural, took, totalsOf, diffStatOf, sandboxed, openPhaseOf, testingPhases } from './evidence';
import { AgentAvatar } from './design/avatar';
import type { AgentLook, AgentState } from './design/agent-kit.js';
import { Icon } from './design/icons';
import { agentState } from './faces';
import { projectColor } from './frame';
import { CycleWarning } from './home-page';
import { workerName } from './names';
import { NoteDialog, overReview } from './note-dialog';
import { finishedState, useFinished, useStudio } from './records';
import {
  active,
  integrationAction,
  isCleanup,
  isHold,
  liveSummary,
  runStories,
  type CleanupItem,
  type HoldItem,
  type HomeItem,
  type NeedsItem,
  type RunStory,
  type StudioState,
} from './studio-runs';
import { FirstRunGuide, guideOf } from './first-run-guide';
import { attemptName } from './story-tabs';
import { TodayIdea } from './today-idea';
import {
  agentLooks,
  callsTitle,
  dayLine,
  floorSentence,
  greeting,
  lastDone,
  placeIn,
  quoted,
  shippedToday,
  when,
} from './today';
import { useToast } from './toast';

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

// One recorded step at a time, with the controller's answer as a toast.
function useAct(projectId: string) {
  const toast = useToast();
  const request = useMutation({
    mutationFn: ({ path, body = {} }: { path: string; body?: Record<string, unknown>; done?: Done }) =>
      send<Record<string, unknown>>(path, { projectId, ...body }),
    onSuccess: (result, { done }) => {
      const message = done?.(result);
      if (message) toast(message);
    },
    onError: failure => toast(failure.message),
  });
  return {
    busy: request.isPending,
    act: (path: string, body?: Record<string, unknown>, done?: Done) => request.mutate({ path, body, done }),
  };
}
type Done = (result: Record<string, unknown>) => string | void;
const taskPath = (task: Task, step: string) => `/api/tasks/${encodeURIComponent(task.id)}/${step}`;

interface Action {
  label: string;
  // The phone design's shorter words, when it has them.
  short?: string;
  emphasis: 'primary' | 'default' | 'quiet';
  onClick?: () => void;
  task?: string;
}

// The quieter choices behind "More choices" on a phone; on a wider screen they show in the row.
function MoreChoices({ actions, projectId }: { actions: Action[]; projectId: string }) {
  const id = useId();
  if (!actions.length) return null;
  return (
    <>
      <button
        type="button"
        className="sd-btn sd-btn--ghost sd-decision__more"
        aria-label="More choices"
        popoverTarget={id}
      >
        <Icon name="more" />
      </button>
      <div id={id} popover="auto" className="sd-menu">
        <div className="sd-menu__list">
          {actions.map(action => (
            <ActionButton key={action.label} action={action} projectId={projectId} menu={id} />
          ))}
        </div>
      </div>
    </>
  );
}

function ActionButton({ action, projectId, menu }: { action: Action; projectId: string; menu?: string }) {
  const className = `sd-btn${action.emphasis === 'primary' ? ' sd-btn--primary' : action.emphasis === 'quiet' ? ' sd-btn--ghost' : ''}`,
    words = action.short ? (
      <>
        <span className="sd-wide-only">{action.label}</span>
        <span className="sd-narrow-only">{action.short}</span>
      </>
    ) : (
      action.label
    );
  if (action.task)
    return (
      <Link className={className} to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: action.task }}>
        {words}
      </Link>
    );
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (menu) document.getElementById(menu)?.hidePopover?.();
        action.onClick?.();
      }}
    >
      {words}
    </button>
  );
}

// A call only the director can make (the design system's DecisionCard): what kind of call and when, the title and
// where it comes from, its evidence, then the actions with what happens next.
function Decision({
  projectId,
  chip,
  time,
  title,
  origin,
  children,
  actions,
  note,
  busy,
}: {
  projectId: string;
  chip: ReactNode;
  time: string;
  title: string;
  origin?: ReactNode;
  children?: ReactNode;
  actions: Action[];
  note?: string;
  busy: boolean;
}) {
  const quiet = actions.filter(action => action.emphasis === 'quiet');
  return (
    <article className="sd-card sd-decision" aria-busy={busy}>
      <div className="sd-decision__head">
        {chip}
        <span className="sd-meta sd-decision__time">{time}</span>
      </div>
      <div className="sd-decision__heading">
        <h3 className="sd-decision__title">{title}</h3>
        {origin && <div className="sd-meta sd-wide-only">{origin}</div>}
      </div>
      {children}
      <div className="sd-decision__actions">
        {actions.map(action => (
          <ActionButton key={action.label} action={action} projectId={projectId} />
        ))}
        <MoreChoices actions={quiet} projectId={projectId} />
        {note && <span className="sd-meta sd-decision__note">{note}</span>}
      </div>
    </article>
  );
}

const chip = (tone: 'you' | 'brand' | 'bad' | 'wait', label: string, icon?: ReactNode) => (
  <span className={`sd-chip${tone === 'wait' ? '' : ` sd-chip--${tone}`}`}>
    {icon ?? <span className="sd-chip__dot"></span>}
    {label}
  </span>
);

// "Story 3 of 4 · from your idea “I can't read…”", the idea a link to its journey.
function Origin({ projectId, place }: { projectId: string; place: ReturnType<typeof placeIn> }) {
  if (!place) return null;
  return (
    <>
      {place.index > 0 && `Story ${place.index} of ${place.total} · `}from your idea{' '}
      <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: place.run.id }}>
        {quoted(place.run.brief, 64)}
      </Link>
    </>
  );
}

// An agent's words on a call: its face beside a speech bubble.
function Said({ look, state, children }: { look?: AgentLook; state?: AgentState; children: ReactNode }) {
  return (
    <div className="sd-message">
      {look && <AgentAvatar look={look} state={state} size={36} />}
      <div className="sd-bubble" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
        {children}
      </div>
    </div>
  );
}

// A finding as "path:line: words" shows the place as a file chip.
function Finding({ text }: { text: string }) {
  const match = /^([\w./-]+:\d+(?:-\d+)?):\s*(.*)$/s.exec(text);
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center' }}>
        <span className="sd-chip sd-chip--bad sd-chip--inline sd-wide-only">
          <span className="sd-chip__dot"></span>Blocking
        </span>
        {match && <span className="sd-file">{match[1]}</span>}
      </div>
      <div style={{ textWrap: 'pretty' }}>{match ? match[2] : text}</div>
    </>
  );
}

interface CallProps {
  projectId: string;
  state: StudioState;
  stories: RunStory[];
  looks: Map<string, AgentLook>;
}

function closeAction(task: Task, act: ReturnType<typeof useAct>['act'], label: string): Action {
  return {
    label,
    emphasis: 'quiet',
    onClick: () => {
      const done = task.status === 'done';
      if (
        confirm(
          `Close “${task.title}” without ${done ? 'integrating it' : 'accepting a result'}? Its recorded attempts are kept${done ? ', and the source is free for the next story' : ''}. It cannot run again.`,
        )
      )
        act(
          taskPath(task, 'close'),
          { reason: done ? 'Closed without integrating.' : 'Closed without accepting a result.' },
          () => `Closed “${task.title}”.`,
        );
    },
  };
}

// A story with a passing review, ready to integrate: the change, its tests and the review.
function IntegrateCall({ projectId, state, stories, looks, task }: CallProps & { task: Task }) {
  const { act, busy } = useAct(projectId),
    decision = decisionState(task, state),
    review = decision.review!,
    reviewItem = decision.reviewItem!,
    candidate = state.attempts.find(
      attempt => attempt.id === (review.candidateReview as { attemptId?: string } | undefined)?.attemptId,
    ),
    stat = diffStatOf(candidate),
    totals = totalsOf(candidate),
    inSandbox = sandboxed(candidate),
    reviewer = workerName(state, review.workerId),
    editor = workerName(state, candidate?.workerId ?? task.workerId),
    notes = (review.candidateReviewNotes as string[] | undefined)?.length ?? 0,
    again = /again/.test(integrationAction(state, task, review)),
    built = took(candidate),
    reviewed = took(review);
  const changeShare = stat && stat.added + stat.removed ? (stat.added / (stat.added + stat.removed)) * 100 : 100;
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip(
        'brand',
        again ? 'Ready to integrate again' : 'Ready to integrate',
        <Icon name="merge" size={14} weight={2.4} />,
      )}
      time={when(review.finishedAt)}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        {
          label: again ? 'Integrate again' : 'Integrate',
          emphasis: 'primary',
          onClick: () =>
            act(taskPath(task, 'integrate-source'), { attemptId: review.id, reviewHash: reviewItem.hash }, result =>
              result.state === 'waiting'
                ? 'Integration approved. It runs when active work finishes.'
                : result.state === 'verifying'
                  ? 'Integration approved. The controller is formatting and testing the change before it writes and commits it.'
                  : result.state === 'failed'
                    ? `Integration did not complete: ${String(result.error ?? '')}`
                    : 'Reviewed source integrated.',
            ),
        },
        { label: 'See the change', emphasis: 'default', task: task.id },
        ...(decision.closable ? [closeAction(task, act, 'Close without integrating')] : []),
      ]}
      note={
        built && reviewed
          ? `Built by ${editor} in ${built} min · reviewed in ${reviewed} min`
          : built
            ? `Built by ${editor} in ${built} min`
            : undefined
      }
    >
      <div className="sd-decision__tiles">
        <Link className="sd-tile" to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }}>
          <span className="sd-eyebrow">Change</span>
          {stat ? (
            <>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-8)' }}>
                <b className="sd-tile__value" style={{ color: 'var(--add)' }}>
                  +{stat.added}
                </b>
                <b className="sd-tile__value" style={{ color: 'var(--del)' }}>
                  −{stat.removed}
                </b>
              </span>
              <span className="sd-bar" aria-hidden="true">
                <span className="sd-bar__part sd-bar__part--ok" style={{ width: `${changeShare}%` }}></span>
                <span className="sd-bar__part sd-bar__part--bad" style={{ width: `${100 - changeShare}%` }}></span>
              </span>
              <span className="sd-meta">
                {stat.files} {plural(stat.files, 'file')}
              </span>
            </>
          ) : (
            <>
              <b className="sd-tile__value">Read it</b>
              <span className="sd-meta">its size was not recorded</span>
            </>
          )}
        </Link>
        <Link className="sd-tile" to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: task.id }}>
          <span className="sd-eyebrow">Tests</span>
          {totals?.tests ? (
            <>
              <b className="sd-tile__value">
                {totals.pass} / {totals.tests}
              </b>
              <span className="sd-bar" aria-hidden="true">
                <span
                  className="sd-bar__part sd-bar__part--ok"
                  style={{ width: `${((totals.pass ?? 0) / totals.tests) * 100}%` }}
                ></span>
                <span
                  className="sd-bar__part sd-bar__part--bad"
                  style={{ width: `${100 - ((totals.pass ?? 0) / totals.tests) * 100}%` }}
                ></span>
              </span>
              <span className="sd-meta">{inSandbox ? 'passed in the sandbox' : 'passed without a sandbox'}</span>
            </>
          ) : (
            <>
              <b className="sd-tile__value">Passed</b>
              <span className="sd-meta">{inSandbox ? 'in the sandbox' : 'without a sandbox'}</span>
            </>
          )}
        </Link>
        <Link
          className="sd-tile"
          to="/p/$projectId/tasks/$taskId"
          params={{ projectId, taskId: task.id }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: '12px' }}
        >
          {looks.get(review.workerId ?? '') && (
            <span className="sd-wide-only" style={{ display: 'inline-flex' }}>
              <AgentAvatar
                look={looks.get(review.workerId ?? '')!}
                state={agentState(state, review.workerId, task)}
                size={40}
              />
            </span>
          )}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <span className="sd-eyebrow">
              <span className="sd-wide-only">{reviewer}'s review</span>
              <span className="sd-narrow-only">Review</span>
            </span>
            <span className="sd-chip sd-chip--ok sd-wide-only" style={{ alignSelf: 'flex-start' }}>
              <span className="sd-chip__dot"></span>
              Passed{notes ? ` · ${notes} ${plural(notes, 'note')}` : ''}
            </span>
            <b className="sd-tile__value sd-narrow-only" style={{ color: 'var(--ok)' }}>
              Passed
            </b>
          </span>
        </Link>
      </div>
    </Decision>
  );
}

// The review asked for changes: send the story back, or integrate over the review with a reason.
function ChangesCall({ projectId, state, stories, looks, task }: CallProps & { task: Task }) {
  const { act, busy } = useAct(projectId),
    [asking, setAsking] = useState(false),
    decision = decisionState(task, state),
    stage = decision.stage!,
    review = state.attempts.find(attempt => attempt.id === stage.review?.attemptId),
    candidate = state.attempts.find(
      attempt => attempt.id === (review?.candidateReview as { attemptId?: string } | undefined)?.attemptId,
    ),
    findings = (review?.candidateReviewFindings as string[] | undefined) ?? [],
    reviewer = workerName(state, review?.workerId),
    editor = workerName(state, candidate?.workerId ?? task.workerId),
    totals = totalsOf(candidate);
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', 'Changes requested')}
      time={when(review?.finishedAt)}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        {
          label: `Send back to ${editor}`,
          emphasis: 'primary',
          onClick: () =>
            act(taskPath(task, 'send-back'), { note: '' }, sent =>
              (sent.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
                ? `Sent “${task.title}” back. It did not start: ${(sent.start as { reason?: string }).reason}`
                : `Sent “${task.title}” back to ${editor} with ${reviewer}'s findings.`,
            ),
        },
        {
          label: 'Integrate over the review',
          short: 'Integrate anyway',
          emphasis: 'default',
          onClick: () => setAsking(true),
        },
        ...(decision.closable ? [closeAction(task, act, 'Close the story')] : []),
      ]}
      note={`${editor} gets ${reviewer}'s findings.`}
    >
      {findings.length > 0 && (
        <Said look={looks.get(review?.workerId ?? '')} state={agentState(state, review?.workerId, task)}>
          <Finding text={findings[0]!} />
          {findings.length > 1 && (
            <span className="sd-meta">
              and {findings.length - 1} more {plural(findings.length - 1, 'finding')}
            </span>
          )}
        </Said>
      )}
      {totals?.tests ? (
        <div className="sd-meta sd-wide-only">
          Tests passed {totals.pass} of {totals.tests}.
        </div>
      ) : null}
      <NoteDialog
        open={asking}
        {...overReview(reviewer)}
        onClose={() => setAsking(false)}
        onSubmit={reason => {
          setAsking(false);
          act(taskPath(task, 'integrate-source'), {
            attemptId: stage.review?.attemptId,
            reviewHash: stage.review?.hash,
            overrideReason: reason,
          });
        }}
      />
    </Decision>
  );
}

// The editor stopped for files its story does not have: approve them as asked, or edit the list on the story.
function FileRequestCall({
  projectId,
  state,
  stories,
  looks,
  task,
  item,
}: CallProps & { task: Task; item: NeedsItem }) {
  const { act, busy } = useAct(projectId),
    { requested, request, offered, worked, editor } = fileRequest(task, state);
  if (!request || !requested) return <GenericCall {...{ projectId, state, stories, looks, task, item }} />;
  const asked = askedPaths(task, request);
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', asked.length === 1 ? 'Needs one more file' : `Needs ${asked.length} more files`)}
      time={when(requested.finishedAt)}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        {
          label: 'Allow and continue',
          emphasis: 'primary',
          onClick: () =>
            act(
              taskPath(task, 'edit-scope'),
              { ...offered, reason: request.reason, keepWork: worked, request: requested.id },
              edited =>
                (edited.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
                  ? `Changed “${task.title}”'s files. It did not start: ${(edited.start as { reason?: string }).reason}`
                  : `Changed “${task.title}”'s files and sent it back to ${editor}.`,
            ),
        },
        { label: 'Edit the file list', emphasis: 'default', task: task.id },
      ]}
      note={worked ? `${editor} keeps the work done so far.` : `${editor} starts again with these files.`}
    >
      <Said look={looks.get(requested.workerId ?? '')} state={agentState(state, requested.workerId, task)}>
        <div style={{ textWrap: 'pretty' }}>{request.reason}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center' }}>
          <span className="sd-meta">Asks to edit</span>
          {asked.map(({ path, sign, note }) => (
            <span key={path} className={`sd-file${sign === '+' ? ' sd-file--add' : ' sd-file--del'}`}>
              {sign} {path}
              {note}
            </span>
          ))}
        </div>
      </Said>
    </Decision>
  );
}

// Claude Code refused commands the editor tried: approve them as the rules shown, or choose on the story.
function CommandCall({ projectId, state, stories, looks, task, item }: CallProps & { task: Task; item: NeedsItem }) {
  const { act, busy } = useAct(projectId),
    { rules, valid } = commandRequest(item),
    attempt = state.attempts.find(record => record.id === item.attemptId),
    editor = workerName(state, attempt?.workerId ?? task.workerId);
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', rules.length === 1 ? 'Needs a command' : `Needs ${rules.length} commands`)}
      time={when(attempt?.finishedAt)}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        ...(valid
          ? [
              {
                label: 'Allow and continue',
                emphasis: 'primary' as const,
                onClick: () =>
                  act(
                    taskPath(task, 'allow-commands'),
                    { attemptId: item.attemptId, commands: rules },
                    () => 'Commands approved. The work starts again from what it left.',
                  ),
              },
            ]
          : []),
        { label: 'Choose the commands', emphasis: valid ? 'default' : 'primary', task: task.id },
      ]}
      note="Every Claude agent may run them from now on."
    >
      <Said look={looks.get(attempt?.workerId ?? '')} state={agentState(state, attempt?.workerId, task)}>
        {item.details[0] && <div style={{ textWrap: 'pretty' }}>{item.details[0]}</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)', alignItems: 'center' }}>
          <span className="sd-meta">{editor} asks to run</span>
          {(item.commands ?? []).map(command => (
            <span key={command} className="sd-file">
              {command}
            </span>
          ))}
        </div>
      </Said>
    </Decision>
  );
}

// Proposed work waiting for the director's approval.
function ApproveCall({ projectId, state, stories, task, item }: CallProps & { task: Task; item: NeedsItem }) {
  const { act, busy } = useAct(projectId);
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', 'Approve the work')}
      time={when(String(task.createdAt ?? ''))}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        {
          label: 'Approve work',
          emphasis: 'primary',
          onClick: () => act(taskPath(task, 'approve-work'), {}, () => `Approved “${task.title}”.`),
        },
        { label: 'Open the story', emphasis: 'default', task: task.id },
        {
          label: 'Deny work',
          emphasis: 'quiet',
          onClick: () => {
            if (confirm(`Deny “${task.title}”? It will not run.`))
              act(taskPath(task, 'deny-work'), { reason: '' }, () => `Denied “${task.title}”.`);
          },
        },
      ]}
      note={`${workerName(state, task.workerId)} starts it once you approve.`}
    >
      <p style={{ margin: 0, color: 'var(--ink-2)', textWrap: 'pretty' }}>{item.reason}</p>
    </Decision>
  );
}

// A result waiting to be accepted.
function AcceptCall({ projectId, state, stories, looks, task }: CallProps & { task: Task }) {
  const { act, busy } = useAct(projectId),
    decision = decisionState(task, state),
    latest = decision.latest!,
    summary = (latest.result as { summary?: string } | undefined)?.summary;
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', 'Accept the result')}
      time={when(latest.finishedAt)}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={[
        decision.plan
          ? {
              label: 'Accept planning result',
              emphasis: 'primary',
              onClick: () =>
                act(taskPath(task, 'accept-proposal'), { attemptId: latest.id, proposalHash: decision.plan!.hash }),
            }
          : {
              label: 'Accept result',
              emphasis: 'primary',
              onClick: () => act(taskPath(task, 'accept'), {}, () => 'Result accepted.'),
            },
        { label: 'Open the result', emphasis: 'default', task: task.id },
        ...(decision.closable ? [closeAction(task, act, 'Close without accepting')] : []),
      ]}
    >
      {summary && (
        <Said look={looks.get(latest.workerId ?? '')} state={agentState(state, latest.workerId, task)}>
          {summary}
        </Said>
      )}
    </Decision>
  );
}

// Any other call: what happened and what to do, with the way to the story where the action is. Start assignment,
// which is all a step waiting for the director needs when every step waits for them (the recovery drill, October
// 24), is a button of its own.
function GenericCall({ projectId, stories, task, item }: CallProps & { task: Task; item: NeedsItem }) {
  const { act, busy } = useAct(projectId),
    start: Action[] =
      item.action === 'Start assignment'
        ? [
            {
              label: 'Start assignment',
              emphasis: 'primary',
              onClick: () =>
                act(taskPath(task, 'start'), {}, started =>
                  started?.queued
                    ? 'Queued. It starts by itself when its agent, resources and an execution slot are free.'
                    : 'Started.',
                ),
            },
            { label: 'Open the story', emphasis: 'default', task: task.id },
          ]
        : [];
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('you', item.action ?? 'Needs you')}
      time={when(String(task.updatedAt ?? task.createdAt ?? ''))}
      title={task.title}
      origin={<Origin projectId={projectId} place={placeIn(stories, task)} />}
      actions={
        start.length
          ? start
          : [
              {
                label: item.action ? `Open to use ${item.action}` : 'Open the story',
                emphasis: 'primary',
                task: task.id,
              },
            ]
      }
    >
      <p style={{ margin: 0, color: 'var(--ink-2)', textWrap: 'pretty' }}>
        {item.reason} {item.next}
      </p>
    </Decision>
  );
}

// A CLI's usage hold with no known reset: one card for the CLI.
function HoldCall({ projectId, state, item }: { projectId: string; state: StudioState; item: HoldItem }) {
  const { act, busy } = useAct(projectId);
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('bad', 'Usage hold')}
      time=""
      title={`${item.label} usage hold`}
      actions={[
        {
          label: `Clear ${item.label} hold after the CLI is usable`,
          emphasis: 'primary',
          onClick: () => act('/api/control', { clearQuota: item.provider }, () => `${item.label} hold cleared.`),
        },
      ]}
      note={item.next}
    >
      <p style={{ margin: 0, color: 'var(--ink-2)', textWrap: 'pretty' }}>{item.reason}</p>
      {item.taskIds.length > 0 && (
        <ul className="sd-fold__list" style={{ margin: 0 }} aria-label="Waiting on it">
          {item.taskIds.map(id => (
            <li key={id}>
              <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: id }}>
                {state.tasks.find(task => task.id === id)?.title ?? id}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Decision>
  );
}

// Unstarted steps that wait on stopped work: close them, or recover what they wait on.
function CleanupCall({ projectId, state, item }: { projectId: string; state: StudioState; item: CleanupItem }) {
  const { act, busy } = useAct(projectId),
    count = item.members.length;
  return (
    <Decision
      projectId={projectId}
      busy={busy}
      chip={chip('wait', 'Clean up')}
      time=""
      title={`${count} unstarted ${plural(count, 'step')} ${count === 1 ? 'waits' : 'wait'} on stopped work`}
      origin={
        <>
          from your idea{' '}
          <Link to="/p/$projectId/runs/$runId" params={{ projectId, runId: item.run.id }}>
            {quoted(item.run.brief, 64)}
          </Link>
        </>
      }
      actions={[
        {
          label: `Close ${count} unstarted ${plural(count, 'step')}`,
          emphasis: 'default',
          onClick: () => {
            if (confirm(`Close ${count} unstarted ${plural(count, 'step')}? Nothing that already ran is changed.`))
              act(
                '/api/tasks/close',
                { taskIds: item.taskIds, reason: 'Closed from the run story.' },
                () => `Closed ${count} unstarted ${plural(count, 'step')}.`,
              );
          },
        },
      ]}
      note="Or recover the stopped work they wait on, from its story."
    >
      <ul className="sd-fold__list" style={{ margin: 0 }}>
        {item.members.map(member => (
          <li key={member.taskId}>
            <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: member.taskId }}>
              {state.tasks.find(task => task.id === member.taskId)?.title ?? member.taskId}
            </Link>
            <span className="sd-meta">{member.reason}</span>
          </li>
        ))}
      </ul>
    </Decision>
  );
}

function Call(props: CallProps & { item: HomeItem }) {
  const { item, state, projectId } = props;
  if (isHold(item)) return <HoldCall projectId={projectId} state={state} item={item} />;
  if (isCleanup(item)) return <CleanupCall projectId={projectId} state={state} item={item} />;
  const task = state.tasks.find(record => record.id === item.taskId);
  if (!task) return null;
  const decision = decisionState(task, state);
  if (decision.integrable && decision.review && decision.reviewItem) return <IntegrateCall {...props} task={task} />;
  if (decision.returnable && decision.stage?.review) return <ChangesCall {...props} task={task} />;
  if (item.kind === 'scope-request') return <FileRequestCall {...props} task={task} item={item} />;
  if (item.kind === 'command-request') return <CommandCall {...props} task={task} item={item} />;
  if (decision.approval?.status === 'pending' && !decision.awaited)
    return <ApproveCall {...props} task={task} item={item} />;
  if (task.status === 'review' && decision.latest) return <AcceptCall {...props} task={task} />;
  return <GenericCall {...props} task={task} item={item} />;
}

// The clock for elapsed minutes, a tick each half minute.
function useNow(every = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [every]);
  return now;
}

const working: Record<string, { chip: string; line: string; strip: string }> = {
  'studio-development:checks': { chip: 'Running checks', line: 'running the source checks', strip: 'checking' },
  'studio-development:breakdown': { chip: 'Planning', line: 'planning the stories', strip: 'planning' },
  'studio-development:change': { chip: 'Working', line: 'editing and testing', strip: 'working' },
  'studio-development:change-review': { chip: 'Reviewing', line: 'reviewing the change', strip: 'reviewing' },
  'general:plan': { chip: 'Planning', line: 'planning the work', strip: 'planning' },
  'general:work': { chip: 'Working', line: 'doing the work', strip: 'working' },
  'general:review': { chip: 'Reviewing', line: 'reviewing the work', strip: 'reviewing' },
};

interface FloorAgent {
  worker: Worker;
  name: string;
  look: AgentLook;
  task?: Task;
  attempt?: AttemptSummary;
}

function floorOf(state: StudioState, looks: Map<string, AgentLook>): FloorAgent[] {
  return state.workers
    .filter(worker => worker.enabled !== false)
    .map(worker => {
      const attempt = state.attempts.find(
        item => item.workerId === worker.id && ['running', 'stopping'].includes(item.status),
      );
      return {
        worker,
        name: workerName(state, worker.id),
        look: looks.get(worker.id)!,
        attempt,
        task: attempt ? state.tasks.find(task => task.id === attempt.taskId) : undefined,
      };
    });
}

// On the floor: each working agent's card, then the free agents with what they last did.
function Floor({
  projectId,
  state,
  stories,
  agents,
}: {
  projectId: string;
  state: StudioState;
  stories: RunStory[];
  agents: FloorAgent[];
}) {
  const now = useNow(),
    busy = agents.filter(agent => agent.task && agent.attempt),
    free = agents.filter(agent => !agent.task),
    verifying = state.attempts.filter(attempt => attempt.sourceIntegration?.state === 'verifying');
  return (
    <>
      {busy.map(({ worker, name, look, task, attempt }) => {
        const said = (attempt!.lastSay as { text?: string; at?: string } | undefined)?.text
            ? (attempt!.lastSay as { text: string; at: string })
            : null,
          phase = openPhaseOf(attempt),
          words =
            phase && testingPhases.includes(phase)
              ? { chip: 'Running tests', line: 'now testing', strip: 'testing' }
              : phase === 'source.edit'
                ? { chip: 'Editing', line: 'editing', strip: 'editing' }
                : (working[(attempt!.assignment as { kind?: string } | undefined)?.kind ?? task!.kind] ??
                  working['general:work']!),
          step = attemptName(
            task!,
            state.attempts.filter(item => item.taskId === task!.id),
            attempt!,
            true,
          ),
          elapsed = attempt!.startedAt ? now - Date.parse(attempt!.startedAt) : 0,
          limit = task!.maxSeconds ? task!.maxSeconds * 1000 : null;
        return (
          <section key={worker.id} className="sd-card sd-card--live sd-floor-live" aria-label={`${name} is working`}>
            <div className="sd-floor-live__who">
              <AgentAvatar look={look} state="working" size={48} />
              <div style={{ minWidth: 0 }}>
                <div>
                  <span className="sd-floor-live__name">{name}</span>{' '}
                  {worker.jobTitle && <span className="sd-meta">· {worker.jobTitle}</span>}
                </div>
                <span className="sd-chip sd-chip--live">
                  <span className="sd-chip__dot"></span>
                  {words.chip}
                </span>
              </div>
            </div>
            <Link
              className="sd-floor-live__story"
              to="/p/$projectId/tasks/$taskId"
              params={{ projectId, taskId: task!.id }}
            >
              {task!.title}
            </Link>
            {/* The agent's latest words, as the controller keeps them while it runs (item 21's lastSay, at most
                every ten seconds). Plain text, never markup. */}
            {said && (
              <div className="sd-bubble" style={{ flex: 'none' }}>
                {said.text}
                <div className="sd-meta" style={{ marginTop: '2px' }}>
                  {new Date(said.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
              <div className="sd-meta sd-floor-live__line">
                <span>
                  {step} · {words.line}
                </span>
                {limit && (
                  <span>
                    {minutes(elapsed)} of {minutes(limit)} min
                  </span>
                )}
              </div>
              <span className="sd-bar" aria-hidden="true">
                <span
                  className="sd-bar__part sd-bar__part--live"
                  style={{ width: `${limit ? Math.min(100, Math.max(4, (elapsed / limit) * 100)) : 30}%` }}
                ></span>
              </span>
            </div>
            <Link
              className="sd-btn sd-btn--sm"
              style={{ alignSelf: 'flex-start' }}
              to="/p/$projectId/tasks/$taskId"
              params={{ projectId, taskId: task!.id }}
            >
              Watch {name} work
            </Link>
          </section>
        );
      })}
      {verifying.map(attempt => (
        <section
          key={attempt.id}
          className="sd-card sd-card--live sd-floor-live"
          aria-label="The controller is integrating"
        >
          <div className="sd-floor-live__who">
            <span className="sd-floor-live__name">The controller</span>
            <span className="sd-chip sd-chip--live">
              <span className="sd-chip__dot"></span>
              Integrating
            </span>
          </div>
          <Link
            className="sd-floor-live__story"
            to="/p/$projectId/tasks/$taskId"
            params={{ projectId, taskId: attempt.taskId }}
          >
            {state.tasks.find(task => task.id === attempt.taskId)?.title ?? attempt.taskId}
          </Link>
          <span className="sd-meta">It formats the change and runs every test; it commits only if they all pass.</span>
        </section>
      ))}
      {free.length > 0 && (
        <section className="sd-card sd-floor-list" aria-label="Free agents">
          {free.map(({ worker, name, look }) => {
            const last = lastDone(state, stories, worker);
            return (
              <div key={worker.id} className="sd-floor-row">
                <AgentAvatar look={look} state={agentState(state, worker.id)} size={36} />
                <div className="sd-floor-row__text">
                  <b>{name}</b> {worker.jobTitle && <span className="sd-meta">· {worker.jobTitle}</span>}
                  {last && (
                    <div className="sd-meta">
                      {last.words} · {when(last.at)}
                    </div>
                  )}
                </div>
                <span className="sd-chip">{worker.paused ? 'Paused' : 'Free'}</span>
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}

// On a phone, the floor is a row of faces at the top of Today.
function FloorStrip({ projectId, agents }: { projectId: string; agents: FloorAgent[] }) {
  return (
    <section aria-label="On the floor" className="sd-narrow-only">
      <div className="sd-floor-strip">
        {agents.map(({ worker, name, look, task }) => {
          const words = task ? (working[task.kind] ?? working['general:work']!) : null;
          const face = (
            <>
              <span className={`sd-floor-strip__ring${task ? ' sd-floor-strip__ring--live' : ''}`}>
                <AgentAvatar look={look} state={task ? 'working' : 'idle'} size={50} ring={false} />
              </span>
              {name}
              <span className={`sd-floor-strip__state${task ? ' sd-floor-strip__state--live' : ''}`}>
                {words ? words.strip : worker.paused ? 'paused' : 'free'}
              </span>
            </>
          );
          return task ? (
            <Link
              key={worker.id}
              className="sd-floor-strip__who"
              to="/p/$projectId/tasks/$taskId"
              params={{ projectId, taskId: task.id }}
            >
              {face}
            </Link>
          ) : (
            <span key={worker.id} className="sd-floor-strip__who">
              {face}
            </span>
          );
        })}
      </div>
    </section>
  );
}

// Shipped today: each idea whose stories all integrated today, in the director's words, with its commits, or other
// work whose last result was accepted today, with how many results it made; the four
// newest, and the way to the rest. A card beside the calls, or on a phone, a list under them.
const shownShipped = 4;
function Shipped({
  projectId,
  shipped,
  pending,
  phone = false,
}: {
  projectId: string;
  shipped: ReturnType<typeof shippedToday>;
  pending: boolean;
  phone?: boolean;
}) {
  const more = shipped.length - shownShipped,
    rest = more > 0 && (
      <Link className="sd-cardlist__row sd-meta" to="/p/$projectId/runs" params={{ projectId }}>
        {more} more shipped today
      </Link>
    );
  if (phone)
    return shipped.length ? (
      <section className="sd-card sd-cardlist" aria-labelledby="shipped-phone">
        <h2 id="shipped-phone" className="sd-cardlist__title" style={{ marginBottom: 'var(--space-6)' }}>
          Shipped today
        </h2>
        {shipped.slice(0, shownShipped).map(({ story, at }) => (
          <Link
            key={story.id}
            className="sd-cardlist__row sd-cardlist__row--line"
            to="/p/$projectId/runs/$runId"
            params={{ projectId, runId: story.id }}
          >
            <span className="sd-chip sd-chip--ok" style={{ padding: '0 7px' }} aria-label="Shipped">
              <span className="sd-chip__dot"></span>
            </span>
            <span className="sd-cardlist__label">{quoted(story.brief, 48).slice(1, -1)}</span>
            <span className="sd-meta">{when(at)}</span>
          </Link>
        ))}
        {rest}
      </section>
    ) : null;
  return (
    <>
      <section className="sd-card sd-cardlist" aria-labelledby="shipped">
        <div className="sd-cardlist__head">
          <h2 id="shipped" className="sd-cardlist__title">
            Shipped today
          </h2>
          <Link to="/p/$projectId/runs" params={{ projectId }}>
            All ideas
          </Link>
        </div>
        {shipped.slice(0, shownShipped).map(({ story, commits, results, at }) => (
          // Each integrated story is one commit.
          <Link
            key={story.id}
            className="sd-cardlist__row"
            to="/p/$projectId/runs/$runId"
            params={{ projectId, runId: story.id }}
          >
            <span className="sd-cardlist__label">{quoted(story.brief)}</span>
            <span className="sd-cardlist__meta">
              <span className="sd-chip sd-chip--ok">
                <span className="sd-chip__dot"></span>
                {commits.length
                  ? `${commits.length} ${plural(commits.length, 'story', 'stories')}`
                  : `${results} ${plural(results, 'result')}`}
              </span>
              {commits[0] && <span className="sd-file">{commits[0]}</span>}
              {commits.length > 1 && <span className="sd-file">+{commits.length - 1}</span>}
              <span className="sd-meta">{when(at)}</span>
            </span>
          </Link>
        ))}
        {rest}
        {!shipped.length && (
          <span className="sd-meta" style={{ paddingTop: 'var(--space-6)' }}>
            {pending ? 'Loading what shipped…' : 'Nothing has shipped yet today.'}
          </span>
        )}
      </section>
    </>
  );
}

// What moves without the director: folded under the calls. Work a call already lists (a usage hold's waiting work,
// a cleanup's steps) waits on that call, so it is not here.
function Moving({
  projectId,
  state,
  items,
  calls,
}: {
  projectId: string;
  state: StudioState;
  items: HomeItem[];
  calls: HomeItem[];
}) {
  const listed = new Set(calls.flatMap(call => (isHold(call) || isCleanup(call) ? call.taskIds : []))),
    waits = items.filter(
      (item): item is NeedsItem & { run?: RunStory } => !isHold(item) && !isCleanup(item) && !listed.has(item.taskId),
    );
  if (!waits.length) return null;
  return (
    <details className="sd-fold">
      <summary>
        <span className="sd-chip">
          <span className="sd-chip__dot"></span>
          {waits.length}
        </span>
        <span className="sd-wide-only">Moving on their own, nothing to do</span>
        <span className="sd-narrow-only">Moving on their own</span>
      </summary>
      <ul className="sd-fold__list">
        {waits.map(item => (
          <li key={item.taskId}>
            <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: item.taskId }}>
              {state.tasks.find(task => task.id === item.taskId)?.title ?? item.taskId}
            </Link>
            <span className="sd-meta">{item.next.replace(/^Nothing is needed from you\.\s*/, '')}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function TodayPage({ projectId }: { projectId: string }) {
  const { state, error, shell } = useStudio(projectId),
    finished = useFinished(projectId, 3);
  const earlier = useMemo(
    () => (shell && finished.data ? finishedState(shell, finished.data.pages.slice(0, 1)) : null),
    [shell, finished.data],
  );
  const finishedStories = useMemo(() => (earlier ? runStories(earlier) : []), [earlier]);
  const looks = useMemo(() => (state ? agentLooks(projectId, state.workers) : new Map()), [projectId, state]);
  if (error)
    return (
      <p role="alert" className="sd-meta">
        The project could not be loaded: {error.message}
      </p>
    );
  if (!state)
    return (
      <p role="status" className="sd-meta">
        Loading the project…
      </p>
    );
  const { stories, items, decisions } = liveSummary(state),
    calls = items.filter(item => item.requiresDirector),
    waits = items.filter(item => !item.requiresDirector),
    allStories = [...stories, ...finishedStories],
    shipped = shippedToday(allStories, [...state.attempts, ...(earlier?.attempts ?? [])]),
    agents = floorOf(state, looks),
    kinds = state.organizationConfiguration?.taskKinds ?? [],
    // The project's idea intake in the controller's order (src/server.mjs /api/intake): source checks and a
    // breakdown first, then the planner; without either there is no box.
    intake = kinds.includes('studio-development:breakdown') ? 'source' : kinds.includes('general:plan') ? 'plan' : null,
    index = state.projects.findIndex(project => project.id === projectId),
    // A sample from the first run offers its suggested ideas until it has one.
    ideas = allStories.length,
    suggestions = ideas ? undefined : guideOf(projectId)?.suggestions;
  const props: CallProps = { projectId, state, stories: allStories, looks };
  return (
    <>
      <header className="sd-pagehead">
        <div className="sd-pagehead__text">
          <div className="sd-eyebrow">{dayLine()}</div>
          <h1 className="sd-pagehead__title">
            <span className="sd-wide-only">
              {greeting()} {callsTitle(decisions)}
            </span>
            <span className="sd-narrow-only">
              {greeting()} {callsTitle(decisions, true)}
            </span>
          </h1>
          <p className="sd-pagehead__lead sd-wide-only">{floorSentence(state, allStories, shipped.length)}</p>
        </div>
        <Link className="sd-btn sd-wide-only" to="/p/$projectId/board" params={{ projectId }}>
          <Icon name="search" size={18} weight={2.2} />
          Find work
        </Link>
      </header>
      <CycleWarning projectId={projectId} state={state} />
      {intake && shell && (
        <TodayIdea
          projectId={projectId}
          shell={shell}
          intake={intake}
          accent={projectColor(state.projects[index], index).background}
          suggestions={suggestions}
        />
      )}
      <FirstRunGuide projectId={projectId} sent={ideas > 0} />
      <FloorStrip projectId={projectId} agents={agents} />
      <div className="sd-columns">
        <section className="sd-columns__main" aria-labelledby="calls">
          <div className="sd-section-head">
            <h2 id="calls" className="sd-section-title">
              Your calls
            </h2>
            {decisions > 0 && (
              <span className="sd-chip sd-chip--you">
                <span className="sd-chip__dot"></span>
                {decisions} waiting on you
              </span>
            )}
          </div>
          {calls.map(item => (
            <Call
              key={isHold(item) ? `hold:${item.provider}` : isCleanup(item) ? `cleanup:${item.run.id}` : item.taskId}
              {...props}
              item={item}
            />
          ))}
          {!calls.length && (
            <div className="sd-card sd-card--quiet" style={{ padding: 'var(--space-16) 18px', color: 'var(--ink-2)' }}>
              Nothing is waiting on you.{' '}
              {state.tasks.some(active)
                ? 'The team is working; their calls appear here.'
                : 'Send an idea, and the calls it needs appear here.'}
            </div>
          )}
          <Moving projectId={projectId} state={state} items={waits} calls={calls} />
        </section>
        <aside className="sd-columns__side sd-wide-only" aria-label="On the floor">
          <h2 className="sd-section-title">On the floor</h2>
          <Floor projectId={projectId} state={state} stories={allStories} agents={agents} />
          <Shipped projectId={projectId} shipped={shipped} pending={finished.isPending} />
        </aside>
      </div>
      <div className="sd-narrow-only">
        <Shipped projectId={projectId} shipped={shipped} pending={finished.isPending} phone />
      </div>
    </>
  );
}
