// What the director can decide about a task, as the story page's "Where it stands" shows it (v1.0 item 23): one
// button for each action the controller serves with the task's read (TaskPage.actions, public/task-actions.js), in
// its order, with the closing ones behind More actions and Bring back to each older line under them. Each button asks
// the controller for one recorded step, sent to the route the action names with the values it carries; a note or a
// reason is asked for in a dialog first. The change it records refreshes the page.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { getJSON, send, type AttemptSummary, type Task, type TaskAction } from './api';
import { named, type BringBackTarget, type BringBackTargets } from './bring-back';
import { decisionState, fileRequest, sendIdeaLimit, storyIdea } from './decisions';
import { Icon } from './design/icons';
import { Modal } from './dialog';
import { NoteDialog, overReview } from './note-dialog';
import { reviewWait, storyFacts } from './stands';
import { storyPeople } from './story';
import { useToast } from './toast';
import { bringBackable, statusLabels, taskActions, type StudioState } from './studio-runs';
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

type Emphasis = TaskAction['emphasis'];
interface Action {
  key: string;
  label: string;
  emphasis: Emphasis;
  onClick?: () => void;
  // A closing action's line of what it does, under it in the More actions menu.
  does?: string;
}
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

// The checks a result's own report failed, each named once, as the controller's acceptAttempt finds them.
const failedChecks = (attempt: AttemptSummary) => [
  ...new Set((attempt.result?.checks ?? []).filter(check => check.status === 'fail').map(check => check.name)),
];

// The actions the page offers on a task: the ones its read served. A page the records of a command placed carries
// none (the controller's command answer holds each task's page without them) until the task is read again; until
// then it lists what the controller's own rules (public/task-actions.js, the ones the read runs) give for those
// records, so a decision shows its outcome at once, as before.
export const offeredActions = (served: TaskAction[] | undefined, task: Task, studio: StudioState) =>
  served ?? taskActions(task, studio);

// The values an action carries, as the body the controller takes for it.
const valuesOf = (action: TaskAction) =>
  Object.fromEntries(
    action.fields.filter(field => field.value !== undefined).map(field => [field.name, field.value] as const),
  );
// The value an action carries for one field.
const valueOf = (action: TaskAction, name: string) => action.fields.find(field => field.name === name)?.value;

// The words each kind of Deny asks with.
const denials: Record<string, { title: string; label?: string }> = {
  'deny-Deny work': { title: 'Deny this work?' },
  'deny-Withdraw approval and deny': { title: 'Withdraw the approval and deny this work?' },
  'deny-Close this step': { title: 'Close this step?', label: 'Note (optional)' },
};

// The decisions "Where it stands" offers, on their own row in the order the controller serves them; the closing
// actions behind More actions, each saying what it does; Try it in its own strip under them; and Bring back to each
// older line the controller serves.
export function TaskDecisions({
  projectId,
  task,
  studio,
  actions: served,
  direction,
  onEditFiles,
  onRevised,
}: {
  projectId: string;
  task: Task;
  studio: StudioState;
  // The actions the controller serves for the task (offeredActions), drawn in its order.
  actions: TaskAction[];
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
    client = useQueryClient(),
    toast = useToast(),
    [asking, setAsking] = useState<Asking | null>(null),
    // The run of the new idea a story was sent in as, which the page links to once the controller started it.
    [sentRun, setSentRun] = useState<string | null>(null),
    // Trying the story yourself, once its tests passed (try-actions.tsx).
    tryIt = useTry(projectId, task, studio),
    // The More actions menu's, and the Try it strip's, element ids.
    domId = useId();
  const id = encodeURIComponent(task.id),
    busy = request.isPending;
  // The records the dialogs and messages speak of; which buttons show is the controller's.
  const { latest, review, landed, mergeable, outdated } = decisionState(task, studio),
    { editor, reviewer } = storyPeople(task, studio),
    filesAsked = fileRequest(task, studio);
  // A story that landed reads where it can be brought back to: the lines each served Bring back reaches on the way,
  // which its confirmation names, and the controller's reason where it can't go. Until the new answer is read, the
  // last one stays on screen.
  const backable = bringBackable(task, studio),
    backUrl = `/api/tasks/${id}/bring-back?projectId=${encodeURIComponent(projectId)}`,
    backKey = [projectId, 'bring-back', backUrl] as const,
    { data: backData } = useQuery({
      queryKey: [...backKey, review?.sourceCarries],
      queryFn: ({ signal }) => getJSON<BringBackTargets>(backUrl, signal),
      placeholderData: previous => previous,
      enabled: backable,
    }),
    backRead = backable ? backData : undefined,
    [bringing, setBringing] = useState<{ action: TaskAction; line: string; through: string[] } | null>(null),
    bring = useMutation({
      mutationFn: ({ action, line }: { action: TaskAction; line: string }) =>
        send<Record<string, unknown>>(action.path, { projectId, ...valuesOf(action), line }, action.method),
      onSuccess: result => {
        setBringing(null);
        toast(`Bringing the fix back to ${((result.lines as string[] | undefined) ?? []).join(', then ')}.`);
        void client.invalidateQueries({ queryKey: backKey });
      },
    });
  // Sends an action as served: its route, with the values it carries and the director's words from its dialog.
  const sendAction = (action: TaskAction, words: Record<string, unknown> = {}, done?: Request['done']) =>
    request.mutate({ path: action.path, method: action.method, body: { ...valuesOf(action), ...words }, done });
  const ask = (action: TaskAction, question: Omit<Asking, 'send'>, field: string, done?: Request['done']) =>
    setAsking({ ...question, send: note => sendAction(action, { [field]: note }, done) });
  const sentBack = (sent: Record<string, unknown>, said: string) =>
    (sent.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
      ? `Sent ${task.id} back. It did not start: ${(sent.start as { reason?: string }).reason}`
      : said;
  // What pressing each served action does, by its key: its dialog, confirmation and message, as the page always had.
  // An action the page has no dialog for is sent as it is served.
  const press = (action: TaskAction): (() => void) => {
    const { key } = action;
    if (key.startsWith('deny-')) {
      const words = denials[key] ?? { title: `${action.label}?` };
      return () =>
        ask(
          action,
          {
            title: words.title,
            text: 'It will not run. Your note is recorded with the decision.',
            label: words.label ?? 'Decision note (optional)',
            submit: action.label,
          },
          'reason',
        );
    }
    if (key === 'allow-files')
      return () =>
        sendAction(action, {}, edited =>
          (edited.start as { ok?: boolean; reason?: string } | undefined)?.ok === false
            ? `Changed ${task.id}'s files. It did not start: ${(edited.start as { reason?: string }).reason}`
            : `Changed ${task.id}'s files and sent it back to ${filesAsked.editor}.`,
        );
    // The code moved past the story's plan: its remaining work goes in as a new idea, whose text the director may
    // edit first. Unchanged, the controller composes it itself, with the story's plain planned summary.
    if (key === 'send-as-idea') {
      const idea = storyIdea(task);
      return () =>
        setAsking({
          title: 'Close and send as a new idea?',
          text: 'The code moved on since this story was planned. It closes, and its remaining work goes in as a new idea on the same release, with fresh checks and a new plan.',
          label: 'The new idea',
          submit: 'Close and send as a new idea',
          required: true,
          initial: idea,
          limit: sendIdeaLimit,
          send: note =>
            sendAction(action, note === idea.trim() ? {} : { idea: note }, sent => {
              if (typeof sent.runId === 'string') setSentRun(sent.runId);
              return `Closed “${task.title}” and sent its work as a new idea.`;
            }),
        });
    }
    if (key === 'start' || key === 'start-past-limit') {
      const start = (words: Record<string, unknown> = {}, done?: () => void) =>
        sendAction(action, words, started => {
          done?.();
          return started?.queued
            ? /^Waiting for /.test(String(started.reason ?? ''))
              ? `Queued. ${started.reason} It starts by itself when it can.`
              : 'Queued behind busy work. It starts by itself when its agent, resources and an execution slot are free.'
            : 'Started.';
        });
      // Past its attempt limit, the director's Start runs it again and may point the next attempt at the fix.
      if (key === 'start-past-limit')
        return () =>
          setAsking({
            title: 'Start it again?',
            text: 'It runs past its attempt limit. The next attempt gets this note as its direction, along with everything the work did so far.',
            label: 'Note for the next attempt (optional)',
            submit: 'Start assignment',
            initial: direction,
            // The controller records a direction of up to 24000 characters, so a long one can still be edited here.
            limit: 24000,
            send: note => start({ direction: note }, onRevised),
          });
      return () => start();
    }
    if (key === 'cancel') return () => sendAction(action, {}, () => 'Cancellation requested.');
    if (key === 'accept') {
      // A planning result is accepted with the proposal it returned.
      if (action.path.endsWith('/accept-proposal')) return () => sendAction(action);
      // A result whose own checks failed is accepted over them with the director's reason, where the controller
      // requires one.
      if (action.fields.some(field => field.name === 'overReason' && field.required)) {
        const failed = latest ? failedChecks(latest) : [];
        return () =>
          ask(
            action,
            {
              title: 'Accept over a failed check?',
              text: `Its own ${failed.length === 1 ? 'check' : 'checks'} failed: ${failed.join(', ')}. Your reason is recorded with the acceptance.`,
              label: 'Why accept it anyway',
              submit: 'Accept over a failed check',
              required: true,
              // The controller records a reason of up to 2000 characters.
              limit: 2000,
            },
            'overReason',
            () => 'Accepted over a failed check.',
          );
      }
      return () => sendAction(action, {}, () => 'Result accepted.');
    }
    if (key === 'revise')
      return () =>
        ask(
          action,
          {
            title: 'Request a revision?',
            text: 'The next attempt gets this note as its direction, along with everything the work did so far.',
            label: 'What to change',
            submit: 'Request revision',
            required: true,
            initial: direction,
            // The controller records a direction of up to 24000 characters, so a long one can still be edited here.
            limit: 24000,
          },
          'direction',
          () => {
            onRevised?.();
            return 'Revision requested with your direction.';
          },
        );
    if (key === 'integrate')
      return () =>
        sendAction(action, {}, result =>
          result.state === 'waiting'
            ? 'Integration approved. It runs when active work finishes.'
            : result.state === 'verifying'
              ? 'Integration approved. The controller is formatting and testing the change before it writes and commits it.'
              : result.state === 'failed'
                ? `Integration did not complete: ${String(result.error ?? '')}`
                : 'Reviewed source integrated.',
        );
    // A story whose integration stopped on a conflict (1.1 step 3), or that fails only merged onto what landed after
    // it was tested (October 27), goes back to its editor with its change merged onto the current source.
    if (key === 'merge')
      return () =>
        sendAction(
          action,
          {},
          () => `${editor} merges the change onto the current source; then it is tested and reviewed again.`,
        );
    // A fix integrated on an older line is carried to the next newer one, or marked not needed there (1.1 step 4); a
    // fix brought back to an older line (`back`) goes through the same steps, in words of bringing it back.
    if (key === 'carry' || key === 'carry-skip') {
      const line = String(valueOf(action, 'line') ?? ''),
        back = !!review?.sourceCarries?.find(item => item.line === line)?.back;
      if (key === 'carry')
        return () =>
          sendAction(action, {}, () => (back ? `Bringing the fix back to ${line}.` : `Carrying the fix to ${line}.`));
      return () =>
        ask(
          action,
          {
            title: `Not needed on ${line}?`,
            text: back
              ? `${line} won't get the fix brought back. Your reason is kept with the story, and any older line it was going on to still gets it.`
              : `${line} won't get this fix. Your reason is kept with the story, and any newer line is still offered it.`,
            label: 'Why',
            submit: 'Skip it',
            required: true,
          },
          'reason',
          () => (back ? `Not bringing the fix back to ${line}.` : `Not needed on ${line}.`),
        );
    }
    // The director may overrule a review that passed (the canvas's Story board, the director's yes on October 23).
    // A pass has no blocking findings by definition, but its summary and notes go back with the story, and the next
    // attempt reads the whole history; the director's note is needed where the controller requires one.
    if (key === 'send-back-passed') {
      const passNotes = (review?.candidateReviewNotes as unknown[] | undefined)?.length ?? 0,
        required = !!action.fields.find(field => field.name === 'note')?.required;
      return () =>
        ask(
          action,
          {
            title: `Send it back to ${editor}?`,
            text: `${editor} starts another attempt with ${reviewer}'s passing review${passNotes ? ` and its ${passNotes} ${passNotes === 1 ? 'note' : 'notes'}` : ''}, everything the story did so far and your note. Nothing is integrated.`,
            label: required ? `What ${editor} should change` : 'Your note (optional)',
            submit: `Send back to ${editor}`,
            required,
          },
          'note',
          sent => sentBack(sent, `Sent ${task.id} back to ${editor}.`),
        );
    }
    if (key === 'send-back')
      return () =>
        ask(
          action,
          {
            title: `Send it back to ${editor}?`,
            text: `${editor} gets ${reviewer}'s findings and starts another attempt. Add a note if you want to say more.`,
            label: 'Your note (optional)',
            submit: `Send back to ${editor}`,
          },
          'note',
          sent => sentBack(sent, `Sent ${task.id} back to ${editor} with ${reviewer}'s findings.`),
        );
    if (key === 'over') return () => ask(action, overReview(reviewer), 'overrideReason');
    if (key === 'propose')
      return () => sendAction(action, {}, () => 'Proposed work is in Planned. Approve each task you want done.');
    if (key === 'close')
      return () => {
        const done = task.status === 'done';
        if (
          confirm(
            `Close ${task.id} without ${done ? 'integrating it' : 'accepting a result'}? Its recorded attempts are kept${done ? ', and the source is free for the next story' : ''}. It cannot run again.`,
          )
        )
          sendAction(
            action,
            { reason: done ? 'Closed without integrating.' : 'Closed without accepting a result.' },
            () => `Closed ${task.id}.`,
          );
      };
    return () => sendAction(action);
  };
  // What a closing action does, under it in the More actions menu.
  const doesOf = (action: TaskAction) =>
    action.key.startsWith('deny-')
      ? 'It will not run; a note you add is kept with the decision.'
      : action.key === 'close'
        ? task.status === 'done'
          ? 'Keeps its attempts and frees the source for the next story; it cannot run again.'
          : task.status === 'review'
            ? 'Keeps its attempts without accepting a result; it cannot run again.'
            : 'Keeps its attempts; it cannot run again.'
        : undefined;
  // The question card's send button and the Allow commands form are drawn where the page shows them; Bring back's
  // lines under the decisions.
  const elsewhere = (action: TaskAction) =>
    ['answer', 'allow-commands'].includes(action.key) || action.key.startsWith('bring-back');
  const listed: Action[] = [];
  for (const action of served.filter(item => !elsewhere(item))) {
    listed.push({
      key: action.key,
      label: action.label,
      emphasis: action.emphasis,
      onClick: press(action),
      ...(action.closing ? { does: doesOf(action) ?? '' } : {}),
    });
    // A blocked editor's file request may be changed in the story's file form before it is approved (MP-021).
    if (action.key === 'allow-files' && onEditFiles)
      listed.push({ key: 'edit-files', label: 'Edit the file list', emphasis: 'default', onClick: onEditFiles });
  }
  // Each served Bring back, to the line it carries or, for one served without a line, to each line the bring-back read
  // can reach; a line the read no longer reaches is not offered, and the read's reasons stay in their place.
  const reaching = (backRead?.lines ?? []).filter(
      (target): target is Extract<BringBackTarget, { through: string[] }> => 'through' in target,
    ),
    bringBacks = served
      .filter(action => action.key.startsWith('bring-back'))
      .flatMap(action => {
        const line = valueOf(action, 'line');
        return (typeof line === 'string' ? reaching.filter(target => target.line === line) : reaching).map(target => ({
          action,
          line: target.line,
          through: target.through,
          label: typeof line === 'string' ? action.label : `Bring back to ${target.line}`,
        }));
      }),
    backReasons = (backRead?.lines ?? []).filter(
      (target): target is Extract<BringBackTarget, { reason: string }> => !('through' in target),
    );
  // The decisions keep their row in the served order; the closing actions go behind More actions. While a candidate
  // that passed its tests is reviewed, the row says when Integrate and Send back come.
  const sorted = listed.filter(action => action.does === undefined),
    closing = listed.filter(action => action.does !== undefined),
    waiting = reviewWait(storyFacts(task, studio)),
    menu = `${domId}-more`;
  const decision = (action: Action) => (
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
  const closeBringing = () => {
    setBringing(null);
    bring.reset();
  };
  return (
    <>
      {(sorted.length > 0 || closing.length > 0 || waiting) && (
        <div className="sd-stands__actions" role="group" aria-label="Decisions">
          {waiting && <span className="sd-stands__wait">{waiting}</span>}
          {sorted.map(decision)}
          {closing.length > 0 && (
            <button
              type="button"
              className="sd-btn sd-btn--ghost sd-stands__more"
              aria-label="More actions"
              popoverTarget={menu}
            >
              <Icon name="more" size={20} />
            </button>
          )}
        </div>
      )}
      {closing.length > 0 && (
        <div id={menu} popover="auto" className="sd-menu" role="menu" aria-label="More actions">
          <div className="sd-menu__list">
            {closing.map((action, index) => (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                className="sd-btn sd-btn--ghost sd-menu__item"
                aria-labelledby={`${menu}-${index}`}
                aria-describedby={`${menu}-${index}-does`}
                disabled={busy}
                onClick={() => {
                  document.getElementById(menu)?.hidePopover?.();
                  action.onClick?.();
                }}
              >
                <span id={`${menu}-${index}`}>{action.label}</span>
                <span id={`${menu}-${index}-does`} className="sd-meta">
                  {action.does}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {filesAsked.problem && !outdated && (
        <p className="sd-stands__detail" style={{ margin: 0, flex: '1 1 100%' }}>
          {`The files ${filesAsked.editor || 'the agent'} asked for cannot be allowed as asked: ${filesAsked.problem}`}
        </p>
      )}
      {sentRun && (
        <Link className="sd-btn" to="/p/$projectId/runs/$runId" params={{ projectId, runId: sentRun }}>
          Open the new idea's run
        </Link>
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
      {tryIt && (
        <section className="sd-stands__try" aria-labelledby={`${domId}-try`}>
          <div className="sd-stands__try-head">
            <span id={`${domId}-try`} className="sd-eyebrow">
              Try it yourself
            </span>
          </div>
          <div className="sd-stands__try-actions">
            <TryButtons state={tryIt} />
          </div>
          <TryNotes state={tryIt} />
        </section>
      )}
      {(bringBacks.length > 0 || backReasons.length > 0) && (
        <ul
          aria-label="Bring back"
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-6)',
          }}
        >
          {bringBacks.map(item => (
            <BringBackLine
              key={`${item.action.key} ${item.line}`}
              label={item.label}
              through={item.through.filter(line => line !== item.line)}
              busy={bring.isPending}
              onPick={() => setBringing(item)}
            />
          ))}
          {backReasons.map(target => (
            <li key={target.line} className="sd-meta">
              {target.reason}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={bringing !== null}
        onClose={closeBringing}
        closable={!bring.isPending}
        title={bringing ? `Bring back to ${bringing.line}?` : ''}
      >
        {bringing && (
          <>
            <p style={{ margin: 0 }}>
              {`An older release gets this change: the fix is applied to ${bringing.through.join(', then ')}, one line at a time when the project's source is free. A line where it conflicts gets a story of its own.`}
            </p>
            {bring.error && (
              <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
                {bring.error.message}
              </p>
            )}
            <div className="sd-dialog__actions">
              <button
                type="button"
                className="sd-btn sd-btn--primary"
                disabled={bring.isPending}
                onClick={() => bring.mutate(bringing)}
              >
                {`Bring back to ${bringing.line}`}
              </button>
              <button type="button" className="sd-btn sd-btn--ghost" disabled={bring.isPending} onClick={closeBringing}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Modal>
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

// One older line a served Bring back reaches: its button, with the lines in between it also reaches.
function BringBackLine({
  label,
  through,
  busy,
  onPick,
}: {
  label: string;
  through: string[];
  busy: boolean;
  onPick: () => void;
}) {
  const noteId = useId();
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
      <button
        type="button"
        className="sd-btn sd-btn--sm"
        disabled={busy}
        aria-describedby={through.length ? noteId : undefined}
        onClick={onPick}
      >
        {label}
      </button>
      {through.length > 0 && (
        <span id={noteId} className="sd-meta">
          Also reaches {named(through)}, the {through.length === 1 ? 'line' : 'lines'} in between.
        </span>
      )}
    </li>
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
  verification?: {
    totals?: { pass?: number; tests?: number };
    formatter?: string;
    outputs?: { install?: string; format?: string; build?: string; errors?: string };
  };
}

// What each verification step printed, in the order they run, named in plain words.
const printedOutputs = [
  ['install', 'What the install printed'],
  ['format', 'What the formatter printed'],
  ['build', 'What the build printed'],
  ['errors', 'What the test run printed as errors'],
] as const;

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
    totals = journal.verification?.totals,
    outputs = journal.verification?.outputs;
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
      {printedOutputs.map(([name, label]) =>
        outputs?.[name] ? (
          <details
            key={name}
            className="sd-disclosure"
            open={name === 'errors' && journal.state === 'rejected' ? true : undefined}
          >
            <summary>{label}</summary>
            <pre className="sd-code sd-code--block sd-code--wrap">{outputs[name]}</pre>
          </details>
        ) : null,
      )}
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
