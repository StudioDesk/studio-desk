// A code story's Tried by you tile and Try it tab (1.2 step 7), read from the project's try view (try-it.ts): what the
// try copy holds, its folder with Open folder, the start command and where Run runs, and while this story's Run runs,
// its address and what the start command printed. Try it, Run and Stop are the banner's; the tab only shows, and what
// the director found goes back with the story in Send back's note.
import { Link } from '@tanstack/react-router';
import type { Task } from './api';
import { storyPeople } from './story';
import type { StudioState } from './studio-runs';
import { quoted } from './today';
import { useToast } from './toast';
import { triedState, useTryAction, useTryOutput, useTryView } from './try-it';

// An address the app printed or the settings name opens as a link only when it is a web address.
const web = (address: string) => /^https?:\/\//i.test(address);

// The fourth summary tile: not tried yet, in the copy (merged onto its line, or as built), or running at its address.
export function TriedTile({ projectId, taskId, onShow }: { projectId: string; taskId: string; onShow: () => void }) {
  const view = useTryView(projectId).data,
    tried = triedState(view, taskId),
    other = view?.copy && view.copy.taskId !== taskId ? view.copy : null;
  return (
    <button type="button" className="sd-tile sd-tile--raised" onClick={onShow}>
      <span className="sd-eyebrow">
        <span className="sd-wide-only">Tried by you</span>
        <span className="sd-narrow-only">Tried</span>
      </span>
      <b className="sd-tile__value sd-tile__value--lg">
        {tried.state === 'running' ? 'Running' : tried.state === 'in-copy' ? 'In the copy' : 'Not tried yet'}
      </b>
      {tried.state === 'running' ? (
        <span className="sd-meta">{tried.address ?? 'Starting…'}</span>
      ) : tried.state === 'in-copy' ? (
        <span className="sd-meta">
          {tried.merged ? `Merged onto ${tried.branch}` : `As built, conflicting with ${tried.branch}`}
        </span>
      ) : (
        other && <span className="sd-meta">The copy holds {quoted(other.title, 48)}</span>
      )}
    </button>
  );
}

// The Try it tab: everything about the try copy as it concerns this story. It sends nothing but Open folder.
export function TryPanel({ projectId, task, studio }: { projectId: string; task: Task; studio: StudioState }) {
  const view = useTryView(projectId),
    tried = triedState(view.data, task.id),
    output = useTryOutput(projectId, tried.state === 'running'),
    open = useTryAction(projectId),
    toast = useToast(),
    { editor } = storyPeople(task, studio);
  if (view.error)
    return (
      <div className="sd-tabpanel">
        <p role="alert" style={{ margin: 0 }}>
          The try copy could not be read: {view.error.message}
        </p>
      </div>
    );
  if (!view.data)
    return (
      <div className="sd-tabpanel">
        <p role="status" className="sd-meta" style={{ margin: 0 }}>
          Reading the try copy…
        </p>
      </div>
    );
  const { settings, runsIn, copy } = view.data,
    [program, ...args] = settings.start ?? [],
    folder = copy?.folder ?? settings.folder,
    run = tried.state === 'running' ? copy?.run : null;
  return (
    <div className="sd-tabpanel">
      <dl className="sd-kv sd-kv--chips">
        <dt>The copy holds</dt>
        <dd>
          {!copy ? (
            'Nothing yet'
          ) : copy.taskId !== task.id ? (
            <span>
              Another story,{' '}
              <Link to="/p/$projectId/tasks/$taskId" params={{ projectId, taskId: copy.taskId }}>
                {copy.title}
              </Link>
            </span>
          ) : copy.merged ? (
            <span>
              This story, merged onto {copy.branch} at <span className="sd-mono">{copy.tip.slice(0, 7)}</span>
            </span>
          ) : (
            <>
              <span>This story as built: merging it onto {copy.branch} conflicts in</span>
              {copy.conflicts.map(file => (
                <span key={file} className="sd-file">
                  {file}
                </span>
              ))}
            </>
          )}
        </dd>
        <dt>Folder</dt>
        <dd>
          {folder ? <span className="sd-file sd-file--path">{folder}</span> : <span className="sd-meta">None yet</span>}
          {copy && (
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost"
              disabled={open.isPending}
              onClick={() => open.mutate({ action: 'open' }, { onError: failure => toast(failure.message) })}
            >
              Open folder
            </button>
          )}
        </dd>
        <dt>Start command</dt>
        <dd>
          {program ? (
            <>
              <span className="sd-file">{program}</span>
              {args.length > 0 && <span className="sd-meta">with</span>}
              {args.map((arg, index) => (
                <span key={index} className="sd-file">
                  {arg}
                </span>
              ))}
            </>
          ) : (
            <>
              <span>No start command is set.</span>
              <Link className="sd-link" to="/p/$projectId/settings" params={{ projectId }}>
                Set one in Settings
              </Link>
            </>
          )}
        </dd>
        <dt>Run runs</dt>
        <dd>
          <span>{runsIn === 'built-in' ? 'In the built-in sandbox' : 'On this computer, outside the sandbox'}</span>
          {runsIn === 'computer' && settings.runIn === 'built-in' && (
            <span className="sd-meta">The built-in sandbox here cannot let the app's address through.</span>
          )}
        </dd>
        {tried.state === 'running' && (
          <>
            <dt>Address</dt>
            <dd>
              {!tried.address ? (
                <span className="sd-meta">
                  {run?.installing ? 'Installing its packages first…' : 'Starting; it shows once the app prints it.'}
                </span>
              ) : web(tried.address) ? (
                <a href={tried.address} target="_blank" rel="noreferrer">
                  {tried.address}
                </a>
              ) : (
                <span className="sd-file">{tried.address}</span>
              )}
            </dd>
          </>
        )}
      </dl>
      {tried.state === 'running' && (
        <section
          aria-labelledby="try-output"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}
        >
          <span className="sd-eyebrow" id="try-output">
            What the start command printed
          </span>
          {output.data ? (
            <pre className="sd-code sd-code--block">{output.data}</pre>
          ) : (
            <span className="sd-meta">
              {output.error ? `The output could not be read: ${output.error.message}` : 'Nothing yet.'}
            </span>
          )}
        </section>
      )}
      <p className="sd-meta" style={{ margin: 0 }}>
        What you find when you try it goes in the note of Send back to {editor}, which sends the story back with it.
      </p>
    </div>
  );
}
