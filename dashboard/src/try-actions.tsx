// Trying a story yourself from its "Where it stands" banner (1.2 step 7), in its "Try it yourself" strip once the
// story's tests passed: one line saying where trying the story stands, then only that state's buttons: Try it, Run
// and Open folder while the copy holds the story, and Open and Stop while its app runs. A copy holding the director's
// own edits, and a Run outside the sandbox not yet confirmed for the project, each ask before anything more is sent.
// Only the director's click sends anything; the controller owns the copy and its Run (src/connectors/try-copy.mjs).
import type { ReactNode } from 'react';
import { Refusal, type Task, type TryPlace, type TryRun } from './api';
import { named } from './bring-back';
import { Modal } from './dialog';
import { plural } from './evidence';
import { storyPeople } from './story';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';
import { triedState, tryOffered, useTryAction, useTryView, type TryRequest } from './try-it';
import { useNow } from './use-now';

const places: Record<TryPlace, string> = { 'built-in': 'in the built-in sandbox', computer: 'on this computer' };
// The director's edited files are named as the controller's message names them: the first 20, then how many more.
const shownEdits = 20;
const listed = (files: string[]) =>
  files.length > shownEdits
    ? `${files.slice(0, shownEdits).join(', ')} and ${files.length - shownEdits} more`
    : named(files);

// What a refusal asks of the director: the files holding their own edits that keep Try it from moving the copy, or to
// confirm a Run outside the sandbox. Any other refusal asks nothing and shows the controller's message.
const editsIn = (error: unknown, request?: TryRequest) =>
  request?.action === 'try' && error instanceof Refusal && Array.isArray(error.fields.edits)
    ? error.fields.edits.map(String)
    : null;
const outsideIn = (error: unknown, request?: TryRequest) =>
  request?.action === 'run' && error instanceof Refusal && error.fields.confirm === 'outside';

// The banner's Try it for one story, shared by its buttons in the decisions' row and its lines under them; null on a
// story that does not offer Try it, for which nothing is read.
export function useTry(projectId: string, task: Task, studio: StudioState) {
  const offered = tryOffered(task, studio),
    view = useTryView(projectId, offered),
    action = useTryAction(projectId),
    toast = useToast();
  if (!offered) return null;
  const copy = view.data?.copy ?? null,
    tried = triedState(view.data, task.id),
    asked = action.variables,
    edits = editsIn(action.error, asked),
    outside = outsideIn(action.error, asked);
  return {
    task,
    copy,
    tried,
    // The copy holds an earlier candidate of this story, such as one tried before the story was sent back: once
    // nothing runs, Try it moves it to the current one.
    earlier: tried.state !== 'not-tried' && copy?.candidateAttemptId !== storyPeople(task, studio).candidate?.id,
    // This story's last Run, running or ended, which says where it ran.
    run: copy?.taskId === task.id ? copy.run : null,
    // Until the view is read, Try it waits: the copy may already hold the story, or run it.
    reading: view.isPending,
    busy: action.isPending,
    edits,
    outside,
    failure: action.error && !edits && !outside ? action.error.message : null,
    send: (request: TryRequest) =>
      action.mutate(request, {
        onSuccess: () => {
          if (request.action === 'open') toast("Opened the try copy's folder.");
        },
        onError: (error: Error) => {
          if (!editsIn(error, request) && !outsideIn(error, request)) toast(error.message);
        },
      }),
    // Leaves the copy as it is and sends nothing: the answer to a prompt is dropped.
    dismiss: () => action.reset(),
  };
}
export type TryState = NonNullable<ReturnType<typeof useTry>>;

// How long a Run has run: whole minutes, and hours past the hour.
const ranFor = (ms: number) => {
  const minutes = Math.floor(ms / 60000),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  if (minutes < 1) return 'less than a minute';
  if (!hours) return `${minutes} ${plural(minutes, 'minute')}`;
  return `${hours} ${plural(hours, 'hour')}${rest ? ` ${rest} ${plural(rest, 'minute')}` : ''}`;
};

// How the story's last Run ended, as the controller records it.
const ending = (run: TryRun) =>
  run.stopped
    ? `was stopped: ${run.stopped}`
    : run.error
      ? `could not run: ${run.error}`
      : `ended${run.exitCode !== null && run.exitCode !== undefined ? ` with exit code ${run.exitCode}` : ''}.`;

// Where trying the story stands, said once at the head of its strip: not tried yet, in the try copy (merged onto its
// line at the tip, or held as built with the files that conflicted), an earlier candidate there, or its app starting
// or running, where and for how long; then how its last Run ended. Nothing until the try view is read.
function TryLine({ state }: { state: TryState }) {
  const { copy, tried, earlier, run, reading } = state,
    running = tried.state === 'running' && run?.state === 'running' ? run : null,
    // The clock ticks only while the running time is said.
    now = useNow(!!running?.address);
  if (reading) return null;
  const which = earlier ? ' an earlier candidate of this story' : '',
    started = Date.parse(running?.startedAt ?? '');
  let said: ReactNode;
  if (!copy || tried.state === 'not-tried') said = 'Not tried yet.';
  else if (running?.address)
    said = (
      <>
        Running{which} at <span className="sd-mono">{running.address}</span>, {places[running.place]}
        {Number.isFinite(started) && `, for ${ranFor(Math.max(0, now - started))}`}.
      </>
    );
  else if (running)
    said = `Starting${which} ${places[running.place]}${running.installing ? ', its packages installed first' : ''}.`;
  else if (earlier) said = 'The try copy holds an earlier candidate of this story. Try it moves it to this one.';
  else if (copy.merged)
    said = (
      <>
        In the try copy, merged onto {copy.branch} at <span className="sd-mono">{copy.tip.slice(0, 7)}</span>.
      </>
    );
  else
    said = `In the try copy, held as built: its change conflicts with ${copy.branch}${
      copy.conflicts.length ? ` in ${named(copy.conflicts)}` : ''
    }.`;
  return (
    <div style={{ flex: '1 1 100%' }}>
      <p className="sd-stands__try-state" style={{ margin: 0 }}>
        {said}
      </p>
      {run && run.state !== 'running' && (
        <p className="sd-meta" style={{ margin: 0 }}>
          The last Run, {places[run.place]}, {ending(run)}
        </p>
      )}
    </div>
  );
}

// The strip's line on where trying the story stands, then only that state's buttons: Try it, Run and Open folder
// while the copy holds the story, and Open (once the app printed its address) and Stop while it runs.
export function TryButtons({ state }: { state: TryState }) {
  return (
    <>
      <TryLine state={state} />
      <TryActions state={state} />
    </>
  );
}

function TryActions({ state }: { state: TryState }) {
  const { task, tried, earlier, reading, busy, send } = state;
  if (tried.state === 'running')
    return (
      <>
        {tried.address && /^https?:\/\//i.test(tried.address) && (
          <a className="sd-btn" href={tried.address} target="_blank" rel="noreferrer">
            Open
          </a>
        )}
        <button type="button" className="sd-btn" disabled={busy} onClick={() => send({ action: 'stop' })}>
          Stop
        </button>
      </>
    );
  if (tried.state === 'in-copy' && !earlier)
    return (
      <>
        <button type="button" className="sd-btn" disabled={busy} onClick={() => send({ action: 'run' })}>
          Run
        </button>
        <button type="button" className="sd-btn" disabled={busy} onClick={() => send({ action: 'open' })}>
          Open folder
        </button>
      </>
    );
  return (
    <button
      type="button"
      className="sd-btn"
      disabled={busy || reading}
      onClick={() => send({ action: 'try', taskId: task.id })}
    >
      Try it
    </button>
  );
}

// The notes under the strip's buttons: the director's own edits with Keep them and Discard, a refusal's message, and
// the one ask to run outside the sandbox.
export function TryNotes({ state }: { state: TryState }) {
  const { task, edits, outside, failure, busy, send, dismiss } = state,
    line = { margin: 0, flex: '1 1 100%' };
  return (
    <>
      {edits && (
        <div
          style={{ ...line, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}
          role="group"
          aria-label="Your edits in the try copy"
        >
          <span className="sd-stands__detail">The try copy holds your own edits: {listed(edits)}.</span>
          <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={dismiss}>
            Keep them
          </button>
          <button
            type="button"
            className="sd-btn sd-btn--sm"
            disabled={busy}
            onClick={() => send({ action: 'try', taskId: task.id, discard: true })}
          >
            Discard them and try this story
          </button>
        </div>
      )}
      {failure && (
        <p role="alert" className="sd-stands__detail" style={line}>
          {failure}
        </p>
      )}
      {/* Closed by Escape or its ×, it sends nothing, as Cancel does; Confirm's request leaves its answer. */}
      <Modal
        open={outside}
        onClose={() => {
          if (outside) dismiss();
        }}
        title="Run outside the sandbox?"
      >
        <p style={{ margin: 0 }}>
          Run runs the agents' code on this computer, outside the sandbox, with your access. You confirm this once for
          this project.
        </p>
        <div className="sd-dialog__actions">
          <button
            type="button"
            className="sd-btn sd-btn--primary"
            onClick={() => send({ action: 'run', confirmOutside: true })}
          >
            Confirm
          </button>
          <button type="button" className="sd-btn sd-btn--ghost" onClick={dismiss}>
            Cancel
          </button>
        </div>
      </Modal>
    </>
  );
}
