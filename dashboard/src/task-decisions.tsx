// What the director can decide about a task: the current dashboard's task actions (app-dialogs.js
// renderTaskModal, proposedWorkActions, closeStartedAction and the source story's decisions), under the same
// conditions, as the story page's "Where it stands" shows them (v1.0 item 23). Each button asks the controller for
// one recorded step; the change it records refreshes the page. A note or a reason is asked for in a dialog.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { send, type Task } from './api';
import { decisionState, fileRequest } from './decisions';
import { NoteDialog, overReview } from './note-dialog';
import { storyPeople } from './story';
import { useToast } from './toast';
import { integrationAction, statusLabels, type StudioState } from './studio-runs';

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
  send: (note: string) => void;
}

// The decisions "Where it stands" offers, primary first as the design orders them.
export function TaskDecisions({
  projectId,
  task,
  studio,
  direction,
  onEditFiles,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  direction: string;
  // Opens the story's file form, where a file request can be changed before it is approved.
  onEditFiles?: () => void;
}) {
  const request = useRequest(projectId),
    [asking, setAsking] = useState<Asking | null>(null);
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
      plan,
      proposal,
    } = decisionState(task, studio),
    { editor, reviewer } = storyPeople(task, studio),
    filesAsked = fileRequest(task, studio);
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
  )
    actions.push({
      key: 'start',
      label: 'Start assignment',
      emphasis: approval?.status === 'pending' || filesAsked.request ? 'default' : 'primary',
      onClick: () =>
        act('start', {}, started =>
          started?.queued
            ? /^Waiting for /.test(String(started.reason ?? ''))
              ? `Queued. ${started.reason} It starts by itself when it can.`
              : 'Queued behind busy work. It starts by itself when its agent, resources and an execution slot are free.'
            : 'Started.',
        ),
    });
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
        onClick: () => act('revise', { direction }, () => 'Revision requested with your direction.'),
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
  if (integrable && review && reviewItem)
    actions.push({
      key: 'integrate',
      label: /again/.test(integrationAction(studio, task, review)) ? 'Integrate again' : 'Integrate',
      emphasis: 'primary',
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
  return (
    <>
      {sorted.length > 0 && (
        <div className="sd-stands__actions">
          {sorted.map(action =>
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
            ),
          )}
        </div>
      )}
      <NoteDialog
        open={asking !== null}
        title={asking?.title ?? ''}
        text={asking?.text ?? ''}
        label={asking?.label ?? ''}
        submit={asking?.submit ?? ''}
        required={asking?.required}
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
// tasks it proposed, the step it was proposed from, its sprint and its task type's notice.
export function DecisionNotes({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  // Approval is separate from accepting the report that proposed the work, which matters only while it waits for
  // approval; a task type's notice is about starting, so it shows only before the first attempt.
  const { awaited, approval } = decisionState(task, studio),
    proposedFrom =
      approval?.status === 'pending' ? (task.proposalReference as { taskId?: string } | undefined)?.taskId : undefined,
    proposed = (task.proposedTaskIds as string[] | undefined) ?? [],
    notice = task.lastAttemptId ? undefined : studio.taskKinds[task.kind]?.executionNotice,
    sprint = task.sprintId
      ? (studio.sprints?.find(item => item.id === task.sprintId)?.name ?? String(task.sprintId))
      : null;
  if (!awaited && !proposedFrom && !proposed.length && !notice && !sprint && !task.queued) return null;
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
      {sprint && <span>Sprint: {sprint}</span>}
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

// A reviewed change's integration: who approved it, its commit and verification, and the full record.
export function IntegrationJournal({ journal }: { journal: Journal }) {
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
