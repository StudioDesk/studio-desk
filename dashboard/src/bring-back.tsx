// Bringing a fix that landed on a newer line back to an older one (1.1, October 27), the director's word each time:
// the controller says which older lines the work can be brought back to, with the lines each one reaches on the way,
// or why it can't go there, and the director confirms a line before anything is sent. Work with nowhere to go back to
// (a project with one line, a story that has not landed) shows nothing. The story's page and the idea's page each
// supply the routes and the words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { getJSON, send } from './api';
import { Modal } from './dialog';
import { useToast } from './toast';

// The controller's answer: each older line, newest first, with the lines bringing the work back there applies it to
// (newest first, ending with the line itself), or why it can't go there.
type Reaching = { line: string; through: string[] };
export type BringBackTarget = Reaching | { line: string; reason: string };
export interface BringBackTargets {
  lines: BringBackTarget[];
  reason?: string;
}

export const named = (lines: string[]) =>
  lines.length > 1 ? `${lines.slice(0, -1).join(', ')} and ${lines.at(-1)}` : (lines[0] ?? '');

export function BringBack({
  projectId,
  url,
  path,
  watch,
  label,
  text,
  done,
}: {
  projectId: string;
  // Where the controller answers where the work can go back to, and where bringing it back to a line is sent.
  url: string;
  path: string;
  // The records whose change may change the answer, which is read again when they change.
  watch?: unknown;
  // A line's button, which the confirmation asks about.
  label: (line: string) => string;
  // The confirmation's words for a line and the lines it reaches.
  text: (target: Reaching) => string;
  // The toast once the controller planned it, from its answer.
  done: (result: Record<string, unknown>, line: string) => string;
}) {
  const client = useQueryClient(),
    toast = useToast(),
    [asking, setAsking] = useState<Reaching | null>(null),
    key = [projectId, 'bring-back', url] as const;
  // Until the new answer is read, the last one stays on screen.
  const { data } = useQuery({
    queryKey: [...key, watch],
    queryFn: ({ signal }) => getJSON<BringBackTargets>(url, signal),
    placeholderData: previous => previous,
  });
  const bring = useMutation({
    mutationFn: (line: string) => send<Record<string, unknown>>(path, { projectId, line }),
    onSuccess: (result, line) => {
      setAsking(null);
      toast(done(result, line));
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const close = () => {
    setAsking(null);
    bring.reset();
  };
  if (!data?.lines?.length) return null;
  return (
    <>
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
        {data.lines.map(target => (
          <Target key={target.line} target={target} label={label} busy={bring.isPending} onPick={setAsking} />
        ))}
      </ul>
      <Modal
        open={asking !== null}
        onClose={close}
        closable={!bring.isPending}
        title={asking ? `${label(asking.line)}?` : ''}
      >
        {asking && (
          <>
            <p style={{ margin: 0 }}>{text(asking)}</p>
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
                onClick={() => bring.mutate(asking.line)}
              >
                {label(asking.line)}
              </button>
              <button type="button" className="sd-btn sd-btn--ghost" disabled={bring.isPending} onClick={close}>
                Cancel
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

// One older line: its button, with the lines in between it also reaches, or the controller's reason in its place.
function Target({
  target,
  label,
  busy,
  onPick,
}: {
  target: BringBackTarget;
  label: (line: string) => string;
  busy: boolean;
  onPick: (target: Reaching) => void;
}) {
  const noteId = useId();
  if (!('through' in target)) return <li className="sd-meta">{target.reason}</li>;
  const between = target.through.filter(line => line !== target.line);
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-8)' }}>
      <button
        type="button"
        className="sd-btn sd-btn--sm"
        disabled={busy}
        aria-describedby={between.length ? noteId : undefined}
        onClick={() => onPick(target)}
      >
        {label(target.line)}
      </button>
      {between.length > 0 && (
        <span id={noteId} className="sd-meta">
          Also reaches {named(between)}, the {between.length === 1 ? 'line' : 'lines'} in between.
        </span>
      )}
    </li>
  );
}
