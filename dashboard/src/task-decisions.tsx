// What the director can decide about a task: the current dashboard's task actions (app-dialogs.js
// renderTaskModal, proposedWorkActions, closeStartedAction and the source story's decisions), under the same
// conditions, as the story page's "Where it stands" shows them (v1.0 item 23). Each button asks the controller for
// one recorded step; the change it records refreshes the page. A note or a reason is asked for in a dialog.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { send, type Task } from './api';
import { BringBack } from './bring-back';
import { decisionState, fileRequest } from './decisions';
import { NoteDialog, overReview } from './note-dialog';
import { waitingQuestion } from './questions';
import { attemptsUsed, storyPeople } from './story';
import { useToast } from './toast';
import { integrationAction, statusLabels, type StudioState } from './studio-runs';
import { WholeTestRecord } from './test-record';
import { TryButtons, TryNotes, useTry } from './try-actions';

const busyJournal = ['verifying', 'preparing', 'prepared', 'applying', 'committing', 'needs-reconciliation'];

interface Request {
  path: string;
  body?: Record<string, unknown>;
  method?: 'POST' | 'PATCH';
  done?: (result: Record<string, unknown>) => string | void;
}

function useRequest(projectId: string) {
  const toast = useToast();
  return useMutation({
    mutationFn: ({ path, body = {}, method = 'POST' }: Request) =>
      send<Record<string, unknown>>(path, { projectId, ...body }, method),
    onSuccess: (result, { done }) => {
      const message = done?.(result);
      if (message) toast(message);
    },
    onError: failure => toast(failure.message),
  });
}

type Emphasis = 'primary' | 'default' | 'quiet';
interface Action {
  key: string;
  label: string;
  emphasis: Emphasis;
  onClick?: () => void;
  // A link to another task instead of a step.
  taskId?: string;
}
const order: Record<Emphasis, number> = { primary: 0, default: 1, quiet: 2 };
const buttonClass = (emphasis: Emphasis, small = false) =>
  `sd-btn${emphasis === 'primary' ? ' sd-btn--primary' : emphasis === 'quiet' ? ' sd-btn--ghost' : ''}${small ? ' sd-btn--sm' : ''}`;

interface Asking {
  title: string;
  text: string;
  label: string;
  submit: string;
  required?: boolean;
  initial?: string;
  limit?: number;
  send: (note: string) => void;
}

// The decisions "Where it stands" offers, primary first as the design orders them.
export function TaskDecisions({
  projectId,
  task,
  studio,
  direction,
  onEditFiles,
  onRevised,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  // The direction the page shows, its unsaved draft or the recorded one, which a revision request's note, or the
  // note of a Start past the attempt limit, starts from.
  direction: string;
  // Opens the story's file form, where a file request can be changed before it is approved.
  onEditFiles?: () => void;
  // Once the controller records a revision request, or a Start with a note, the page's draft gives way to the
  // direction it recorded.
  onRevised?: () => void;
}) {
  const request = useRequest(projectId),
    [asking, setAsking] = useState<Asking | null>(null),
    // Trying the story yourself, once its tests passed (try-actions.tsx).
    tryIt = useTry(projectId, task, studio);
  const id = encodeURIComponent(task.id),
    act = (step: string, body?: Record<string, unknown>, done?: Request['done']) =>
      request.mutate({ path: `/api/tasks/${id}/${step}`, body, done }),
    busy = request.isPending;
  // The conditions are shared with Today's calls (decisions.ts), so both offer the same decisions.
  const {
      live,
      explanation,
      latest,
      current,
      approval,
      awaited,
      closed,
      unsettled,
      closable,
      review,
      journal,
      reviewItem,
      integrable,
      stage,
      returnable,
      landed,
      mergeable,
      plan,
      proposal,
    } = decisionState(task, studio),
    { editor, reviewer } = storyPeople(task, studio),
    filesAsked = fileRequest(task, studio),
    // An agent's question waiting for an answer, which the page's Answer box sends; Start runs the work without one.
    asked = !!waitingQuestion(task, studio.attempts),
    // Counted as the page's attempt counter counts them; the controller sets no limit for a task without one.
    { used, allowed } = attemptsUsed(
      task,
      studio.attempts.filter(attempt => attempt.taskId === task.id),
    ),
    pastLimit = task.maxAttempts !== undefined && used >= allowed;
  const deny = (label: string, title: string, noteLabel = 'Decision note (optional)'): Action => ({
    key: `deny-${label}`,
    label,
    emphasis: 'default',
    onClick: () =>
      setAsking({
        title,
        text: 'It will not run. Your note is recorded with the decision.',
        label: noteLabel,
        submit: label,
        send: note => act('deny-work', { reason: note }),
      }),
  });
  const actions: Action[] = [];
  if (approval?.status === 'pending' && !awaited)
    actions.push(
      { key: 'approve', label: 'Approve work', emphasis: 'primary', onClick: () => act('approve-work') },
      deny('Deny work', 'Deny this work?'),
    );
  if (awaited) actions.push(deny('Deny work', 'Deny this work?'));
  if (approval?.status === 'approved' && !task.lastAttemptId)
    actions.push(deny('Withdraw approval and deny', 'Withdraw the approval and deny this work?'));
  if (!approval && !task.lastAttemptId && ['ready', 'blocked'].includes(task.status))
    actions.push({ ...deny('Close this step', 'Close this step?', 'Note (optional)'), emphasis: 'quiet' });
  // A blocked editor's file request, approved as asked in one step as Today approves it (MP-021).
  if (filesAsked.request && filesAsked.requested) {
    const { requested, offered, worked } = filesAsked;
    actions.push({
      key: 'allow-files',
      label: 'Allow and continue',
      emphasis: 'primary',
      onClick: () =>
        act(
          'edit-scope',
          { ...offered, reason: filesAsked.request!.reason, keepWork: worked, request: requested.id },
          edited =>
            (edited.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
              ? `Changed ${task.id}'s files. It did not start: ${(edited.start as { reason?: string }).reason}`
              : `Changed ${task.id}'s files and sent it back to ${filesAsked.editor}.`,
        ),
    });
    if (onEditFiles)
      actions.push({ key: 'edit-files', label: 'Edit the file list', emphasis: 'default', onClick: onEditFiles });
  }
  if (
    !live &&
    !closed &&
    explanation.kind !== 'fixed-limit' &&
    ['ready', 'blocked', 'failed', 'cancelled'].includes(task.status)
  ) {
    const start = (body: Record<string, unknown> = {}, done?: () => void) =>
      act('start', body, started => {
        done?.();
        return started?.queued
          ? /^Waiting for /.test(String(started.reason ?? ''))
            ? `Queued. ${started.reason} It starts by itself when it can.`
            : 'Queued behind busy work. It starts by itself when its agent, resources and an execution slot are free.'
          : 'Started.';
      });
    actions.push({
      key: 'start',
      label: 'Start assignment',
      emphasis: approval?.status === 'pending' || filesAsked.request || asked ? 'default' : 'primary',
      // Past its attempt limit, the director's Start runs it again and may point the next attempt at the fix.
      onClick: () =>
        pastLimit
          ? setAsking({
              title: 'Start it again?',
              text: 'It runs past its attempt limit. The next attempt gets this note as its direction, along with everything the work did so far.',
              label: 'Note for the next attempt (optional)',
              submit: 'Start assignment',
              initial: direction,
              // The controller records a direction of up to 24000 characters, so a long one can still be edited here.
              limit: 24000,
              send: note => start({ direction: note }, onRevised),
            })
          : start(),
    });
  }
  if (task.hold && !live && !closed && !['done', 'denied'].includes(task.status))
    actions.push({
      key: 'hold',
      label: 'Release hold',
      emphasis: 'default',
      onClick: () => request.mutate({ path: `/api/tasks/${id}`, body: { hold: false }, method: 'PATCH' }),
    });
  if (explanation.kind === 'dispatch-paused')
    actions.push({
      key: 'dispatch',
      label: 'Resume dispatch',
      emphasis: 'default',
      onClick: () => request.mutate({ path: '/api/control', body: { paused: false } }),
    });
  if (explanation.kind === 'pipeline-paused')
    actions.push({
      key: 'pipeline',
      label: 'Resume pipeline',
      emphasis: 'default',
      onClick: () => request.mutate({ path: '/api/pipeline', body: { action: 'resume' } }),
    });
  if (live)
    actions.push({
      key: 'cancel',
      label: 'Request cancellation',
      emphasis: 'default',
      onClick: () => act('cancel', {}, () => 'Cancellation requested.'),
    });
  if (task.status === 'review' && latest) {
    actions.push(
      plan
        ? {
            key: 'accept',
            label: 'Accept planning result',
            emphasis: 'primary',
            onClick: () => act('accept-proposal', { attemptId: latest.id, proposalHash: plan.hash }),
          }
        : {
            key: 'accept',
            label: 'Accept result',
            emphasis: 'primary',
            onClick: () => act('accept', {}, () => 'Result accepted.'),
          },
    );
    if (task.kind !== 'unreal-integration')
      actions.push({
        key: 'revise',
        label: 'Request revision',
        emphasis: 'default',
        onClick: () =>
          setAsking({
            title: 'Request a revision?',
            text: 'The next attempt gets this note as its direction, along with everything the work did so far.',
            label: 'What to change',
            submit: 'Request revision',
            required: true,
            initial: direction,
            // The controller records a direction of up to 24000 characters, so a long one can still be edited here.
            limit: 24000,
            send: note =>
              act('revise', { direction: note }, () => {
                onRevised?.();
                return 'Revision requested with your direction.';
              }),
          }),
      });
  }
  if (unsettled)
    actions.push({
      key: 'reconcile',
      label: 'Reconcile interrupted attempt',
      emphasis: 'default',
      onClick: () => act('reconcile'),
    });
  if (journal?.state && busyJournal.includes(journal.state))
    actions.push({
      key: 'restore',
      label: 'Reconcile source integration',
      emphasis: 'default',
      onClick: () => act('restore-source'),
    });
  // Where Merge onto the current source is offered, integrating again as it is comes second: it fails the same way.
  if (integrable && review && reviewItem)
    actions.push({
      key: 'integrate',
      label: /again/.test(integrationAction(studio, task, review)) ? 'Integrate again' : 'Integrate',
      emphasis: mergeable ? 'default' : 'primary',
      onClick: () =>
        act('integrate-source', { attemptId: review.id, reviewHash: reviewItem.hash }, result =>
          result.state === 'waiting'
            ? 'Integration approved. It runs when active work finishes.'
            : result.state === 'verifying'
              ? 'Integration approved. The controller is formatting and testing the change before it writes and commits it.'
              : result.state === 'failed'
                ? `Integration did not complete: ${String(result.error ?? '')}`
                : 'Reviewed source integrated.',
        ),
    });
  // A story whose integration stopped on a conflict (1.1 step 3), or that fails only merged onto what landed after it
  // was tested (October 27), goes back to its editor with its change merged onto the current source; a fix
  // integrated on an older line is carried to the next newer one, or marked not needed there (step 4), each through
  // the controller.
  if (mergeable)
    actions.push({
      key: 'merge',
      label: 'Merge onto the current source',
      emphasis: 'primary',
      onClick: () =>
        act(
          'merge-source',
          {},
          () => `${editor} merges the change onto the current source; then it is tested and reviewed again.`,
        ),
    });
  // A fix brought back to an older line (`back`) goes through the same carry steps, in words of bringing it back.
  const carry = review?.sourceCarries?.find(item => !['carried', 'skipped'].includes(item.state));
  if (
    carry &&
    (['rejected', 'needs-reconciliation'].includes(carry.state) || (carry.state === 'waiting' && !carry.approved))
  ) {
    const again = carry.state === 'waiting' ? '' : ' again';
    actions.push({
      key: 'carry',
      label: carry.back ? `Bring back to ${carry.line}${again}` : `Carry to ${carry.line}${again}`,
      emphasis: 'primary',
      onClick: () =>
        act('carry', { line: carry.line }, () =>
          carry.back ? `Bringing the fix back to ${carry.line}.` : `Carrying the fix to ${carry.line}.`,
        ),
    });
  }
  if (carry && ['waiting', 'rejected'].includes(carry.state))
    actions.push({
      key: 'carry-skip',
      label: `Not needed on ${carry.line}…`,
      emphasis: 'default',
      onClick: () =>
        setAsking({
          title: `Not needed on ${carry.line}?`,
          text: carry.back
            ? `${carry.line} won't get the fix brought back. Your reason is kept with the story, and any older line it was going on to still gets it.`
            : `${carry.line} won't get this fix. Your reason is kept with the story, and any newer line is still offered it.`,
          label: 'Why',
          submit: 'Skip it',
          required: true,
          send: note =>
            act('carry-skip', { line: carry.line, reason: note }, () =>
              carry.back ? `Not bringing the fix back to ${carry.line}.` : `Not needed on ${carry.line}.`,
            ),
        }),
    });
  // A story that landed may be brought back to an older line, at the director's word; a carry story brings back the
  // fix it carries instead, so it offers nothing.
  const backable = task.kind === 'studio-development:change' && !task.carryOf && journal?.state === 'integrated';
  // The director may overrule a review that passed (the canvas's Story board, the director's yes on October 23).
  // A pass has no blocking findings by definition, but its summary and notes go back with the story, and the next
  // attempt reads the whole history; the director's note is needed only when the review noted nothing.
  const passNotes = (review?.candidateReviewNotes as unknown[] | undefined)?.length ?? 0;
  if (integrable && stage?.review?.verdict === 'pass')
    actions.push({
      key: 'send-back-passed',
      label: `Send back to ${editor}`,
      emphasis: 'default',
      onClick: () =>
        setAsking({
          title: `Send it back to ${editor}?`,
          text: `${editor} starts another attempt with ${reviewer}'s passing review${passNotes ? ` and its ${passNotes} ${passNotes === 1 ? 'note' : 'notes'}` : ''}, everything the story did so far and your note. Nothing is integrated.`,
          label: passNotes ? 'Your note (optional)' : `What ${editor} should change`,
          submit: `Send back to ${editor}`,
          required: !passNotes,
          send: note =>
            act('send-back', { note }, sent =>
              (sent.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
                ? `Sent ${task.id} back. It did not start: ${(sent.start as { reason?: string }).reason}`
                : `Sent ${task.id} back to ${editor}.`,
            ),
        }),
    });
  if (returnable && stage?.review)
    actions.push(
      {
        key: 'send-back',
        label: `Send back to ${editor}`,
        emphasis: 'primary',
        onClick: () =>
          setAsking({
            title: `Send it back to ${editor}?`,
            text: `${editor} gets ${reviewer}'s findings and starts another attempt. Add a note if you want to say more.`,
            label: 'Your note (optional)',
            submit: `Send back to ${editor}`,
            send: note =>
              act('send-back', { note }, sent =>
                (sent.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
                  ? `Sent ${task.id} back. It did not start: ${(sent.start as { reason?: string }).reason}`
                  : `Sent ${task.id} back to ${editor} with ${reviewer}'s findings.`,
              ),
          }),
      },
      {
        key: 'over',
        label: 'Integrate over the review',
        emphasis: 'default',
        onClick: () =>
          setAsking({
            ...overReview(reviewer),
            send: reason =>
              act('integrate-source', {
                attemptId: stage.review?.attemptId,
                reviewHash: stage.review?.hash,
                overrideReason: reason,
              }),
          }),
      },
    );
  if (proposal && current)
    actions.push({
      key: 'propose',
      label: 'Show proposed tasks in Planned',
      emphasis: 'default',
      onClick: () =>
        act(
          'propose-work',
          { attemptId: current.id, proposalHash: proposal.hash },
          () => 'Proposed work is in Planned. Approve each task you want done.',
        ),
    });
  if (closable)
    actions.push({
      key: 'close',
      label:
        task.status === 'done'
          ? 'Close without integrating'
          : task.status === 'review'
            ? 'Close without accepting'
            : 'Close',
      emphasis: 'quiet',
      onClick: () => {
        const done = task.status === 'done';
        if (
          confirm(
            `Close ${task.id} without ${done ? 'integrating it' : 'accepting a result'}? Its recorded attempts are kept${done ? ', and the source is free for the next story' : ''}. It cannot run again.`,
          )
        )
          act(
            'close',
            { reason: done ? 'Closed without integrating.' : 'Closed without accepting a result.' },
            () => `Closed ${task.id}.`,
          );
      },
    });
  const sorted = [...actions].sort((a, b) => order[a.emphasis] - order[b.emphasis]);
  // Try it sits beside Send back, or without one before the quiet decisions, the others keeping their order.
  const sentBack = sorted.findIndex(action => action.key === 'send-back' || action.key === 'send-back-passed'),
    quiet = sorted.findIndex(action => action.emphasis === 'quiet'),
    tryAt = sentBack >= 0 ? sentBack + 1 : quiet >= 0 ? quiet : sorted.length;
  const decision = (action: Action) =>
    action.taskId ? (
      <Link
        key={action.key}
        className={buttonClass(action.emphasis)}
        to="/p/$projectId/tasks/$taskId"
        params={{ projectId, taskId: action.taskId }}
      >
        {action.label}
      </Link>
    ) : (
      <button
        key={action.key}
        type="button"
        className={buttonClass(action.emphasis)}
        disabled={busy}
        onClick={action.onClick}
      >
        {action.label}
      </button>
    );
  // What landed after the change was tested, as the controller names it (landedText): each story that landed, then
  // any commits made by hand.
  const byHand = landed ? landed.commits - landed.stories.length : 0,
    landedParts = landed
      ? [
          ...landed.stories.map(storyId => (
            <Link key={storyId} to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: storyId }}>
              {studio.tasks.find(other => other.id === storyId)?.title ?? storyId}
            </Link>
          )),
          ...(byHand > 0
            ? [<span key="by-hand">{`${byHand} ${byHand === 1 ? 'commit' : 'commits'} made by hand`}</span>]
            : []),
        ]
      : [];
  return (
    <>
      {(sorted.length > 0 || tryIt) && (
        <div className="sd-stands__actions">
          {sorted.slice(0, tryAt).map(decision)}
          {tryIt && <TryButtons state={tryIt} />}
          {sorted.slice(tryAt).map(decision)}
        </div>
      )}
      {mergeable && landed && (
        <p className="sd-stands__detail" style={{ margin: 0, flex: '1 1 100%' }}>
          It passed on its own but fails together with what landed after it was tested
          {landedParts.length > 0 && ': '}
          {landedParts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 && (index === landedParts.length - 1 ? ' and ' : ', ')}
              {part}
            </Fragment>
          ))}
          .
        </p>
      )}
      {tryIt && <TryNotes state={tryIt} />}
      {backable && (
        <BringBack
          projectId={projectId}
          url={`/api/tasks/${id}/bring-back?projectId=${encodeURIComponent(projectId)}`}
          path={`/api/tasks/${id}/bring-back`}
          watch={review?.sourceCarries}
          label={line => `Bring back to ${line}`}
          text={({ through }) =>
            `An older release gets this change: the fix is applied to ${through.join(', then ')}, one line at a time when the project's source is free. A line where it conflicts gets a story of its own.`
          }
          done={result => `Bringing the fix back to ${((result.lines as string[] | undefined) ?? []).join(', then ')}.`}
        />
      )}
      <NoteDialog
        open={asking !== null}
        title={asking?.title ?? ''}
        text={asking?.text ?? ''}
        label={asking?.label ?? ''}
        submit={asking?.submit ?? ''}
        required={asking?.required}
        initial={asking?.initial}
        limit={asking?.limit}
        onClose={() => setAsking(null)}
        onSubmit={note => {
          asking?.send(note);
          setAsking(null);
        }}
      />
      {request.error && (
        <p role="alert" className="sd-stands__detail">
          {request.error.message}
        </p>
      )}
    </>
  );
}

// What the decisions wait on or lead to, under "Where it stands": the step whose result this one needs, the
// tasks it proposed, the step it was proposed from and its task type's notice.
export function DecisionNotes({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  // Approval is separate from accepting the report that proposed the work, which matters only while it waits for
  // approval; a task type's notice is about starting, so it shows only before the first attempt.
  const { awaited, approval } = decisionState(task, studio),
    proposedFrom =
      approval?.status === 'pending' ? (task.proposalReference as { taskId?: string } | undefined)?.taskId : undefined,
    proposed = (task.proposedTaskIds as string[] | undefined) ?? [],
    notice = task.lastAttemptId ? undefined : studio.taskKinds[task.kind]?.executionNotice;
  if (!awaited && !proposedFrom && !proposed.length && !notice && !task.queued) return null;
  return (
    <div className="sd-meta" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {task.queued && <span>Queued for automatic dispatch after prerequisites and your approval.</span>}
      {awaited && (
        <span>
          This step uses the accepted result of{' '}
          <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: awaited.id }}>
            {awaited.title}
          </Link>
          , which is {statusLabels[awaited.status] ?? awaited.status}. Accept that result first; this step can then be
          approved.
        </span>
      )}
      {proposed.length > 0 && (
        <span>
          Proposed tasks:{' '}
          {proposed.map((item, index) => {
            const record = studio.tasks.find(other => other.id === item);
            return (
              <span key={item}>
                {index > 0 && ', '}
                <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: item }}>
                  {record?.title ?? item}
                </Link>
                {record && ` · ${statusLabels[record.status] ?? record.status}`}
              </span>
            );
          })}
        </span>
      )}
      {proposedFrom && (
        <span>
          Proposed from{' '}
          <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: proposedFrom }}>
            {proposedFrom}
          </Link>
          . Work approval is separate from accepting that report.
        </span>
      )}
      {notice && <span>{notice}</span>}
    </div>
  );
}

// Who a proposed step goes to, chosen before it is approved.
export function OwnerForm({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const request = useRequest(projectId),
    [owner, setOwner] = useState(task.workerId ?? '');
  if ((task.approval as { status?: string } | undefined)?.status !== 'pending' || task.lastAttemptId) return null;
  return (
    <form
      className="sd-detail"
      onSubmit={event => {
        event.preventDefault();
        request.mutate({
          path: `/api/tasks/${encodeURIComponent(task.id)}/project-owner`,
          body: { workerId: owner },
          done: () => 'Planned owner updated.',
        });
      }}
    >
      <label className="sd-eyebrow" htmlFor="task-owner">
        Project owner
      </label>
      <select id="task-owner" className="sd-select" value={owner} onChange={event => setOwner(event.target.value)}>
        {studio.workers
          .filter(worker => worker.enabled)
          .map(worker => (
            <option key={worker.id} value={worker.id}>
              {worker.displayName} · {worker.team} · {worker.jobTitle}
            </option>
          ))}
      </select>
      <button
        type="submit"
        className="sd-btn sd-btn--sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={request.isPending || owner === task.workerId}
      >
        Save owner
      </button>
    </form>
  );
}

// The instructions a future attempt would receive, and taking queued work out of the pipeline.
export function NextAttemptTools({ projectId, task }: { projectId: string; task: Task }) {
  const request = useRequest(projectId),
    [preview, setPreview] = useState<string | null>(null);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-6)' }}>
      <button
        type="button"
        className="sd-btn sd-btn--sm sd-btn--ghost"
        disabled={request.isPending}
        onClick={() =>
          request.mutate({
            path: '/api/preview',
            body: { taskId: task.id, workerId: task.workerId },
            done: bundle => void setPreview(String(bundle.text ?? '')),
          })
        }
      >
        Preview next instructions
      </button>
      {task.queued && (
        <button
          type="button"
          className="sd-btn sd-btn--sm sd-btn--ghost"
          disabled={request.isPending}
          onClick={() => request.mutate({ path: '/api/pipeline', body: { action: 'remove', taskIds: [task.id] } })}
        >
          Remove from pipeline
        </button>
      )}
      <PreviewDialog text={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

export interface Journal {
  state?: string;
  method?: string;
  approvedBy?: { type?: string; revision?: number };
  repository?: { commit?: string; branch?: string };
  verification?: { totals?: { pass?: number; tests?: number }; formatter?: string };
}

// A reviewed change's integration: who approved it, its commit and verification, and the full record, with the
// merge's whole test record once it recorded a verification. `attemptId` is the attempt holding the journal.
export function IntegrationJournal({
  projectId,
  attemptId,
  journal,
}: {
  projectId: string;
  attemptId: string;
  journal: Journal;
}) {
  const commit = journal.repository?.commit,
    totals = journal.verification?.totals;
  return (
    <>
      <p style={{ margin: 0, color: 'var(--ink-2)' }}>
        Source integration: <strong>{journal.state}</strong>
        {busyJournal.includes(journal.state ?? '') ? ' · in progress' : ''}.
        {journal.approvedBy?.type === 'policy' &&
          ` Approved by autonomy policy revision ${journal.approvedBy.revision} after the independent review passed.`}
        {commit && (
          <>
            {' '}
            Commit <span className="sd-mono">{commit.slice(0, 7)}</span> on {journal.repository?.branch}.
          </>
        )}
        {totals &&
          ` Verification: ${totals.pass}/${totals.tests} tests passed after ${
            journal.verification?.formatter ? `formatting with ${journal.verification.formatter}` : 'the merge'
          }.`}
      </p>
      <details className="sd-disclosure">
        <summary>Recorded source integration{journal.method === 'merge' ? '' : ' and backups'}</summary>
        <pre className="sd-code sd-code--block">{JSON.stringify(journal, null, 2)}</pre>
      </details>
      {journal.verification && <WholeTestRecord projectId={projectId} attemptId={attemptId} run="merge" />}
    </>
  );
}

// The instructions a future attempt would receive, in a dialog over the page.
function PreviewDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (text !== null && !element.open) {
      if (typeof element.showModal === 'function') element.showModal();
      else element.setAttribute('open', '');
    }
    if (text === null && element.open) {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    }
  }, [text]);
  return (
    <dialog
      ref={dialog}
      className="sd-dialog sd-dialog--wide"
      id="preview-dialog"
      aria-labelledby="preview-title"
      onClose={onClose}
    >
      <div className="sd-dialog__form">
        <h2 id="preview-title" className="sd-dialog__title">
          Instructions for a future attempt
        </h2>
        <p style={{ margin: 0, color: 'var(--ink-2)' }}>
          Published studio instructions and current assignment context. Exact staged input paths are allocated when the
          attempt starts.
        </p>
        <pre id="preview-text" className="sd-code sd-code--block">
          {text}
        </pre>
        <div className="sd-dialog__actions">
          <button type="button" className="sd-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
