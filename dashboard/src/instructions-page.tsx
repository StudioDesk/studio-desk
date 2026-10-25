// What each agent is told (v1.0 item 23; built in the redesign's language, after the canvas's "What Eli is told"
// and its draft card): the project's instructions, each team's and each agent's, listed beside the one open. An
// agent reads them in that order. Each has a published revision and its history, and a draft that reaches no
// attempt until it is published. They are read only on this page and the agent's.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getJSON, instructionsUrl, send, type InstructionDoc, type InstructionsPage as Instructions } from './api';
import { AgentAvatar } from './design/avatar';
import { StudioMark } from './design/icons';
import { TextReader } from './files';
import { Heading } from './layout';
import { queryKeys, useStudio } from './records';
import { useStreamReady } from './stream-context';
import { agentLooks } from './today';
import { useToast } from './toast';

type Scope = 'company' | 'team' | 'agent';
interface Entry {
  scope: Scope;
  id: string;
  name: string;
  title: string;
  layer: string;
  doc: InstructionDoc;
}

export function useInstructions(projectId: string) {
  return useQuery({
    enabled: useStreamReady(),
    queryKey: queryKeys.instructions(projectId),
    queryFn: ({ signal }) => getJSON<Instructions>(instructionsUrl(projectId), signal),
  });
}

// `initial` names the instructions open, as `team:<id>`, so a team or an agent links straight to its own.
export function InstructionsPage({ projectId, initial }: { projectId: string; initial?: string }) {
  const { state, error: stateError } = useStudio(projectId),
    { data, error } = useInstructions(projectId),
    looks = useMemo(
      () => (state ? agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]) : null),
      [projectId, state],
    );
  const head = (
    <Heading
      crumbs={[
        <Link key="agents" to="/p/$projectId/agents" params={{ projectId }}>
          Agents
        </Link>,
      ]}
      here="Instructions"
      title="Instructions"
      lead="What each agent is told: the project's instructions, then its team's, then its own. A published revision reaches work that starts after it; a draft changes nothing until you publish it."
    />
  );
  if (error || stateError || !data || !state)
    return (
      <div className="sd-orgpage">
        {head}
        {error || stateError ? (
          <p role="alert">The instructions could not be loaded: {(error ?? stateError)!.message}</p>
        ) : (
          <p role="status" className="sd-meta">
            Reading the instructions…
          </p>
        )}
      </div>
    );
  const { instructions } = data,
    project = state.project.name,
    entries: Entry[] = [
      {
        scope: 'company' as const,
        id: 'company',
        name: 'The project',
        title: `What every agent in ${project} is told`,
        layer: 'Every agent in the project reads this first, then its team’s instructions and its own.',
        doc: instructions.company,
      },
      ...(state.teams ?? []).map(team => ({
        scope: 'team' as const,
        id: team.id,
        name: team.name,
        title: `What the ${team.name} team is told`,
        layer: `Each agent in ${team.name} reads this after the project’s instructions and before its own.`,
        doc: instructions.teams[team.id]!,
      })),
      ...state.workers.map(worker => ({
        scope: 'agent' as const,
        id: worker.id,
        name: worker.displayName ?? worker.id,
        title: `What ${worker.displayName ?? worker.id} is told`,
        layer: `${worker.displayName ?? worker.id} reads this last, after the project’s instructions and ${worker.team ?? 'its team'}’s.`,
        doc: instructions.employees[worker.id]!,
      })),
    ].filter(entry => entry.doc),
    [scope, id] = (initial ?? '').split(':'),
    chosen = entries.find(entry => entry.scope === scope && entry.id === id) ?? entries[0];
  const row = (entry: Entry) => {
    const team = entry.scope === 'team' ? state.teams?.find(item => item.id === entry.id) : undefined,
      look = entry.scope === 'agent' ? looks?.get(entry.id) : undefined;
    return (
      <Link
        key={`${entry.scope}:${entry.id}`}
        className="sd-agentrow"
        to="/p/$projectId/agents/instructions"
        params={{ projectId }}
        search={{ open: `${entry.scope}:${entry.id}` }}
        aria-current={entry === chosen ? 'page' : undefined}
        activeOptions={{ exact: true, includeSearch: true }}
      >
        {entry.scope === 'company' ? (
          <StudioMark size={36} />
        ) : team ? (
          <span className="sd-teammark" aria-hidden="true">
            {team.mark ?? team.name.slice(0, 2).toUpperCase()}
          </span>
        ) : (
          look && <AgentAvatar look={look} size={36} />
        )}
        <span className="sd-agentrow__text">
          <b>{entry.name}</b>
          <span className="sd-meta">
            revision {entry.doc.revision}
            {entry.doc.draft ? ' · a draft waits' : ''}
          </span>
        </span>
      </Link>
    );
  };
  const group = (label: string, scope: Scope) => {
    const rows = entries.filter(entry => entry.scope === scope);
    return (
      rows.length > 0 && (
        <>
          <span className="sd-eyebrow sd-agentlist__group">{label}</span>
          {rows.map(row)}
        </>
      )
    );
  };
  return (
    <div className="sd-orgpage">
      {head}
      <div className="sd-agents">
        <nav className="sd-card sd-agentlist" aria-label="Instructions">
          {group('This project', 'company')}
          {group('Teams', 'team')}
          {group('Agents', 'agent')}
        </nav>
        {chosen && <Doc key={`${chosen.scope}:${chosen.id}`} projectId={projectId} entry={chosen} />}
      </div>
    </div>
  );
}

const day = (value?: string) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
type Revision = InstructionDoc['history'][number] & { publishedAt?: string };

// The open instructions: what is published, the draft waiting with Publish, and the revisions before. The editor's
// text is its own, so a refresh of the records never replaces what the director is typing.
function Doc({ projectId, entry }: { projectId: string; entry: Entry }) {
  const { doc } = entry,
    client = useQueryClient(),
    toast = useToast(),
    [editing, setEditing] = useState(false),
    [text, setText] = useState(doc.draft?.text ?? doc.text),
    [note, setNote] = useState(''),
    // The controller names an agent's instructions as an employee's.
    base = `/api/instructions/${entry.scope === 'agent' ? 'employee' : entry.scope}/${encodeURIComponent(entry.id)}`,
    next = doc.revision + 1;
  const act = useMutation({
    mutationFn: async (action: 'draft' | 'publish' | 'discard') => {
      // Publishing publishes the draft as written: an unsaved edit is saved as the draft first.
      if (action === 'draft' || (action === 'publish' && doc.draft?.text !== text))
        await send(`${base}/draft`, { projectId, baseRevision: doc.revision, text });
      if (action === 'publish') await send(`${base}/publish`, { projectId, baseRevision: doc.revision, text, note });
      if (action === 'discard') await send(`${base}/discard`, { projectId, baseRevision: doc.revision });
      return action;
    },
    onSuccess: action => {
      setEditing(false);
      if (action === 'publish') {
        setNote('');
        toast(`Revision ${next} published. Work that starts from now on reads it.`);
      } else if (action === 'draft') toast('Draft saved. Nothing changes until you publish it.');
      else setText(doc.text);
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.instructions(projectId) }),
    onError: error => toast(error.message),
  });
  const busy = act.isPending,
    history = doc.history as Revision[],
    earlier = history.filter(item => item.revision !== doc.revision).reverse(),
    published = history.find(item => item.revision === doc.revision);
  return (
    <section className="sd-card sd-doc sd-agentdetail" aria-labelledby="doc-title">
      <div className="sd-doc__head">
        <h2 id="doc-title" className="sd-doc__title">
          {entry.title}
        </h2>
        <span className="sd-chip">
          revision {doc.revision}
          {published?.publishedAt ? ` · ${day(published.publishedAt)}` : ''}
        </span>
      </div>
      <span className="sd-meta">{entry.layer}</span>
      {editing ? (
        <>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="instruction-text">
              The draft
            </label>
            <textarea
              id="instruction-text"
              className="sd-textarea sd-doc__editor"
              value={text}
              disabled={busy}
              onChange={event => setText(event.target.value)}
            />
          </div>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor="instruction-note">
              What changed, for the history
            </label>
            <input
              id="instruction-note"
              className="sd-input"
              maxLength={500}
              placeholder="Say why, so the next reader knows"
              value={note}
              disabled={busy}
              onChange={event => setNote(event.target.value)}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
            <button
              type="button"
              className="sd-btn sd-btn--primary"
              disabled={busy || !text.trim()}
              onClick={() => act.mutate('publish')}
            >
              Publish revision {next}
            </button>
            <button
              type="button"
              className="sd-btn"
              disabled={busy || !text.trim()}
              onClick={() => act.mutate('draft')}
            >
              Save the draft
            </button>
            <button
              type="button"
              className="sd-btn sd-btn--ghost"
              disabled={busy}
              onClick={() => {
                setText(doc.draft?.text ?? doc.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sd-doc__text">
            <TextReader text={doc.text} markdown />
          </div>
          {doc.draft ? (
            <div className="sd-draft">
              <span className="sd-eyebrow">A draft · revision {next} once published</span>
              <p className="sd-draft__text">{doc.draft.text}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
                <button
                  type="button"
                  className="sd-btn sd-btn--sm sd-btn--primary"
                  disabled={busy}
                  onClick={() => act.mutate('publish')}
                >
                  Publish revision {next}
                </button>
                <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={() => setEditing(true)}>
                  Edit first
                </button>
                <button
                  type="button"
                  className="sd-btn sd-btn--sm sd-btn--ghost"
                  disabled={busy}
                  onClick={() => act.mutate('discard')}
                >
                  Discard the draft
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          )}
        </>
      )}
      {earlier.length > 0 && (
        <details className="sd-disclosure">
          <summary>
            {earlier.length} earlier {earlier.length === 1 ? 'revision' : 'revisions'}
          </summary>
          <ul className="sd-history">
            {earlier.map(item => (
              <li key={item.revision}>
                <b>
                  Revision {item.revision}
                  {item.publishedAt ? ` · ${day(item.publishedAt)}` : ''}
                </b>
                {item.note && <span className="sd-meta">{item.note}</span>}
                <details className="sd-disclosure">
                  <summary>Read it</summary>
                  <div className="sd-doc__text">
                    <TextReader text={item.text} markdown />
                  </div>
                </details>
                <button
                  type="button"
                  className="sd-btn sd-btn--sm sd-btn--ghost"
                  style={{ alignSelf: 'flex-start' }}
                  disabled={busy}
                  onClick={() => {
                    setText(item.text);
                    setEditing(true);
                  }}
                >
                  Start a draft from it
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
