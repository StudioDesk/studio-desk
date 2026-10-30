// Add an agent, the Agents page's own panel (?add=true): beside the flow in the agent editor's place, or on a phone
// under the page's buttons. The agent joins one of the project's teams, the first one chosen until the director picks
// another: an agent the studio has, found in a list it searches, or a new one made here. Either way it is saved at
// once as the organization's next revision, and its editor opens; Cancel goes back to the agents and sends nothing.
// The two choices are a team editor's Add an agent too (team-editor.tsx), where an agent picked joins the team's draft.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { send, type Execution, type Team, type Worker } from './api';
import type { AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Icon } from './design/icons';
import { cleanExecution, ExecutionFields } from './execution-fields';
import { organizationBody, replaceTeam, useSaveOrganization } from './organization';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';

const agentName = (worker: Worker) => worker.displayName ?? worker.id;
const jobOf = (worker: Worker) => worker.jobTitle || worker.role || '';
// Staffing roles as typed, "reviewer, engineer", as the list the controller takes.
const roleList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map(role => role.trim())
      .filter(Boolean),
  ),
];
// The part an agent the studio has takes in a team until the director changes it, as Edit the teams gave it.
export const contributor = {
  role: 'Project contributor',
  responsibility: 'Perform bounded project work and submit evidence for director review.',
};

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-8)',
} as const;

export function AddAgent({
  projectId,
  state,
  looks,
  phone = false,
}: {
  projectId: string;
  state: StudioState;
  looks: Map<string, AgentLook>;
  phone?: boolean;
}) {
  const toast = useToast(),
    navigate = useNavigate(),
    save = useSaveOrganization(projectId),
    body = organizationBody(state),
    teams = state.teams ?? [],
    [teamId, setTeamId] = useState(teams[0]?.id ?? ''),
    team = teams.find(item => item.id === teamId) ?? teams[0],
    id = useId(),
    panel = useRef<HTMLElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  // Opened, the panel takes focus, and on a phone, where it opens under the page's buttons, comes into view.
  useEffect(() => {
    heading.current?.focus({ preventScroll: phone });
    if (phone) panel.current?.scrollIntoView?.({ block: 'start' });
  }, [phone]);
  // The agents the studio has, without deleted ones and any already in the project's organization.
  const others = (state.employeeDirectory?.length ? state.employeeDirectory : state.workers).filter(
    worker => !worker.deletedAt && !body.members.some(member => member.workerId === worker.id),
  );
  const joined = (worker: Worker, to: Team) => {
    toast(`${agentName(worker)} joined ${to.name}`);
    void navigate({ to: '/p/$projectId/agents/$workerId', params: { projectId, workerId: worker.id } });
  };
  // An agent the studio has joins the team with its own job, or a contributor's, and every other part stays saved.
  const pick = (worker: Worker) => {
    if (!team) return;
    const members = body.members
      .filter(member => member.teamId === team.id)
      .map(({ workerId, role, responsibility, roles }) => ({ workerId, role, responsibility, roles }));
    save.mutate(
      replaceTeam(body, body.teams.find(item => item.id === team.id) ?? team, [
        ...members,
        {
          workerId: worker.id,
          role: jobOf(worker) || contributor.role,
          responsibility: worker.responsibility || contributor.responsibility,
          roles: [],
        },
      ]),
      { onSuccess: () => joined(worker, team) },
    );
  };
  return (
    <section ref={panel} className="sd-agentdetail" aria-labelledby={`${id}-title`}>
      <div className="sd-card sd-agenthead">
        <div className="sd-agenthead__text">
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="sd-agenthead__name">
            Add an agent
          </h2>
          <span className="sd-meta">
            The agent joins one of {state.project.name}&apos;s teams and takes work from its flow.
          </span>
        </div>
        <div
          style={{
            flexBasis: '100%',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            gap: 'var(--space-10)',
          }}
        >
          {team ? (
            <div className="sd-field" style={{ flex: '1 1 220px', minWidth: 0 }}>
              <label className="sd-field__label" htmlFor={`${id}-team`}>
                Team
              </label>
              <select
                id={`${id}-team`}
                className="sd-select"
                value={team.id}
                disabled={save.isPending}
                onChange={event => {
                  save.reset();
                  setTeamId(event.target.value);
                }}
              >
                {teams.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}>
              <span className="sd-meta">
                {state.project.name} has no teams yet. Add a team first, and its agents join it.
              </span>
              <Link
                className="sd-btn sd-btn--sm"
                style={{ alignSelf: 'flex-start' }}
                to="/p/$projectId/agents"
                params={{ projectId }}
                search={{ team: 'new' }}
              >
                <Icon name="plus" size={16} />
                Add a team
              </Link>
            </span>
          )}
          <button
            type="button"
            className="sd-btn sd-btn--ghost"
            disabled={save.isPending}
            onClick={() => void navigate({ to: '/p/$projectId/agents', params: { projectId } })}
          >
            Cancel
          </button>
        </div>
      </div>
      {team && (
        <AddChoices
          projectId={projectId}
          state={state}
          team={team}
          agents={others}
          looks={looks}
          onPick={pick}
          everyone={`Every agent the studio has is already in ${state.project.name}.`}
          busy={save.isPending}
          error={save.error}
          expectedRevision={body.expectedRevision}
          onMade={({ worker }) => joined(worker, team)}
        />
      )}
    </section>
  );
}

// The two ways to add an agent to a team, side by side: an agent the studio has, from the agents given, found by a
// name, a job or what it does and handed to onPick; or a new one for the team, saved at once as the organization's
// next revision and handed to onMade. A team not saved yet gets a new agent once it is. With onCancel, the choices
// have a Cancel of their own.
export function AddChoices({
  projectId,
  state,
  team,
  agents,
  looks,
  onPick,
  from,
  everyone,
  busy = false,
  error = null,
  unsaved = false,
  expectedRevision,
  onMade,
  onCancel,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  agents: Worker[];
  looks: Map<string, AgentLook>;
  onPick: (worker: Worker) => void;
  // A line under an agent's job saying where it comes from.
  from?: (worker: Worker) => string;
  // What shows when there is no agent to give.
  everyone: string;
  busy?: boolean;
  error?: Error | null;
  unsaved?: boolean;
  expectedRevision: number;
  onMade: (made: { worker: Worker; revision: number }, roles: string[]) => void;
  onCancel?: () => void;
}) {
  const [words, setWords] = useState(''),
    id = useId(),
    terms = words.toLowerCase().split(/\s+/).filter(Boolean),
    shown = agents.filter(worker => {
      const text = [agentName(worker), jobOf(worker), worker.responsibility ?? ''].join(' ').toLowerCase();
      return terms.every(term => text.includes(term));
    });
  return (
    <>
      <div className="sd-addagent">
        <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby={`${id}-has`}>
          <h3 id={`${id}-has`} className="sd-sidecard__title">
            An agent the studio has
          </h3>
          {agents.length ? (
            <>
              <div className="sd-field">
                <label className="sd-field__label" htmlFor={`${id}-find`}>
                  Find an agent
                </label>
                <span className="sd-agentfind">
                  <Icon name="search" size={18} />
                  <input
                    id={`${id}-find`}
                    type="search"
                    className="sd-input"
                    placeholder="A name, a job or what it does"
                    value={words}
                    autoComplete="off"
                    onChange={event => setWords(event.target.value)}
                  />
                </span>
              </div>
              {error && (
                <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
                  {error.message}
                </p>
              )}
              {shown.length ? (
                <ul aria-label="Agents the studio has" className="sd-agentpick" style={listStyle}>
                  {shown.map(worker => {
                    const look = looks.get(worker.id),
                      job = jobOf(worker);
                    return (
                      <li key={worker.id}>
                        <button type="button" className="sd-agentrow" disabled={busy} onClick={() => onPick(worker)}>
                          {look && <AgentAvatar look={look} size={40} ring={false} />}
                          <span className="sd-agentrow__text">
                            <b>{agentName(worker)}</b>
                            {job && <span className="sd-meta">{job}</span>}
                            {worker.responsibility && <span className="sd-meta">{worker.responsibility}</span>}
                            {from && <span className="sd-meta">{from(worker)}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p role="status" className="sd-meta" style={{ margin: 0 }}>
                  No agent the studio has matches “{words.trim()}”.
                </p>
              )}
            </>
          ) : (
            <span className="sd-meta">{everyone}</span>
          )}
        </section>
        <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby={`${id}-new`}>
          <h3 id={`${id}-new`} className="sd-sidecard__title">
            Make a new one
          </h3>
          {unsaved ? (
            <span className="sd-meta">Save the team first, then make a new agent for it.</span>
          ) : (
            <NewAgent
              projectId={projectId}
              state={state}
              team={team}
              expectedRevision={expectedRevision}
              onMade={onMade}
            />
          )}
        </section>
      </div>
      {onCancel && (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
          <button type="button" className="sd-btn sd-btn--sm sd-btn--ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </span>
      )}
    </>
  );
}

// The CLI a new agent starts on: the one most of the project's agents run on, else the first signed-in CLI.
function usualProvider(state: StudioState) {
  const adapters = state.adapters ?? {},
    choices = Object.values(adapters).filter(adapter => adapter.workerSelectable && adapter.id !== 'mock'),
    counts = new Map<string, number>();
  for (const worker of state.workers)
    if (worker.provider && choices.some(adapter => adapter.id === worker.provider))
      counts.set(worker.provider, (counts.get(worker.provider) ?? 0) + 1);
  return (
    [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ??
    choices.find(adapter => adapter.available)?.id ??
    choices[0]?.id ??
    Object.keys(adapters)[0] ??
    ''
  );
}

// A new agent for a saved team: its name, its job here, the CLI it runs on and what it is told. It is saved at once as
// the organization's next revision and belongs to this project; its face is the agent kit's until one is chosen on its
// page. It has no Cancel of its own: the panel or the choices it is in have one.
function NewAgent({
  projectId,
  state,
  team,
  expectedRevision,
  onMade,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  expectedRevision: number;
  onMade: (made: { worker: Worker; revision: number }, roles: string[]) => void;
}) {
  const adapters = state.adapters ?? {},
    [name, setName] = useState(''),
    [title, setTitle] = useState(''),
    [responsibility, setResponsibility] = useState(''),
    [roles, setRoles] = useState(''),
    [instructions, setInstructions] = useState(''),
    [execution, setExecution] = useState<Execution>(() => ({
      provider: usualProvider(state),
      model: '',
      effort: '',
      mode: '',
    }));
  const make = useMutation({
    mutationFn: () =>
      send<{ worker: Worker; revision: number }>(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
        projectId,
        expectedRevision,
        displayName: name,
        jobTitle: title,
        responsibility,
        teamId: team.id,
        roles: roleList(roles),
        ...cleanExecution(adapters, execution),
        instructions,
      }),
    onSuccess: made => onMade(made, roleList(roles)),
  });
  return (
    <form
      className="sd-editpanel sd-card"
      aria-label={`A new agent for ${team.name}`}
      onSubmit={event => {
        event.preventDefault();
        make.mutate();
      }}
    >
      <h3 style={{ margin: 0 }}>A new agent for {team.name}</h3>
      <p className="sd-meta" style={{ margin: 0 }}>
        It belongs to {state.project.name}: its name, CLI and instructions change nothing in any other project.
      </p>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="new-agent-name">
          Name
        </label>
        <input
          id="new-agent-name"
          className="sd-input"
          value={name}
          required
          maxLength={40}
          autoComplete="off"
          onChange={event => setName(event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="new-agent-title">
          Job title
        </label>
        <input
          id="new-agent-title"
          className="sd-input"
          value={title}
          required
          maxLength={160}
          placeholder="For example: Copywriter"
          autoComplete="off"
          onChange={event => setTitle(event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="new-agent-responsibility">
          What it is responsible for
        </label>
        <textarea
          id="new-agent-responsibility"
          className="sd-textarea"
          value={responsibility}
          maxLength={4000}
          onChange={event => setResponsibility(event.target.value)}
        />
      </div>
      <ExecutionFields adapters={adapters} value={execution} onChange={setExecution} />
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="new-agent-roles">
          Staffing roles
        </label>
        <input
          id="new-agent-roles"
          className="sd-input"
          value={roles}
          list="staffing-roles-new"
          maxLength={2000}
          placeholder="For example: writer"
          onChange={event => setRoles(event.target.value)}
        />
        <datalist id="staffing-roles-new">
          {(state.roles ?? []).map(role => (
            <option key={role.id} value={role.id}>
              {role.label}
            </option>
          ))}
        </datalist>
        <span className="sd-meta">
          The names a plan&apos;s steps can ask for, so the planner can give this agent work.
        </span>
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor="new-agent-instructions">
          What it is told
        </label>
        <textarea
          id="new-agent-instructions"
          className="sd-textarea"
          rows={6}
          value={instructions}
          maxLength={48000}
          placeholder="Its own instructions, after the project's and its team's. Edit them later on its told page."
          onChange={event => setInstructions(event.target.value)}
        />
      </div>
      {make.error && (
        <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
          {make.error.message}
        </p>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
        <button type="submit" className="sd-btn sd-btn--primary" disabled={make.isPending}>
          {make.isPending ? 'Making…' : 'Make the agent'}
        </button>
      </span>
    </form>
  );
}
