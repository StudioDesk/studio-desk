// Edit the team: one team, beside the flow on the Agents page in the agent editor's place and never in a dialog, with
// the team in the address (?team=<id>, or ?team=new to start a new one): what it is for, who is on it and what it is
// told. Save the team sends the project's whole organization with only this team and its agents changed
// (organization.ts); Undo puts back the saved team without sending anything; Remove the team asks in place first. A
// team groups agents and grants them nothing. A change reaches work that starts after the save, and recorded attempts
// keep what they ran with. Kinds of work are given from an agent's Does list.
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { send, type Execution, type Team, type Worker } from './api';
import type { AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Icon } from './design/icons';
import { plural } from './evidence';
import { cleanExecution, ExecutionFields } from './execution-fields';
import {
  addTeam,
  organizationBody,
  removeTeam,
  replaceTeam,
  useSaveOrganization,
  type OrganizationMember,
} from './organization';
import { useTold } from './rules';
import type { StudioState } from './studio-runs';
import { useToast } from './toast';

// An agent's part in the team: its role, what it is responsible for and its staffing roles.
type Part = Omit<OrganizationMember, 'teamId'>;
interface TeamDraft {
  team: Team;
  members: Part[];
}

const agentName = (worker: Worker) => worker.displayName ?? worker.id;
const teamName = (team: Team) => team.name.trim() || 'New team';
// Staffing roles as typed, "reviewer, engineer", as the list the controller takes.
const roleList = (text: string) => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map(role => role.trim())
      .filter(Boolean),
  ),
];
// A new team's identity, made when it is first saved.
const newTeamId = () => `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
// The part an agent the studio has takes in a team until the director changes it, as Edit the teams gave it.
const contributor = {
  role: 'Project contributor',
  responsibility: 'Perform bounded project work and submit evidence for director review.',
};

const sectionStyle = { flex: '1 1 300px', minWidth: 0, gap: 'var(--space-10)' } as const;
const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-8)',
} as const;

export function TeamEditor({
  projectId,
  state,
  teamId,
  looks,
  adding = false,
}: {
  projectId: string;
  state: StudioState;
  teamId: string;
  looks: Map<string, AgentLook>;
  adding?: boolean;
}) {
  const toast = useToast(),
    navigate = useNavigate(),
    save = useSaveOrganization(projectId),
    body = organizationBody(state),
    revision = body.expectedRevision,
    // A new team takes its identity when it is first saved, so once the saved organization holds it, it is found.
    [named, setNamed] = useState<string | null>(null),
    id = teamId === 'new' ? (named ?? teamId) : teamId,
    savedTeam = body.teams.find(team => team.id === id),
    isNew = !savedTeam;
  const saved: TeamDraft = {
      team: savedTeam ?? { id, name: '', mark: '', purpose: '', goal: '', outcome: '', leadId: null },
      members: body.members
        .filter(member => member.teamId === id)
        .map(({ workerId, role, responsibility, roles }) => ({ workerId, role, responsibility, roles })),
    },
    // The director's edits, none until a field changes, so the fields follow the saved team until then.
    [draft, setDraft] = useState<TeamDraft | null>(null),
    // Agents made here, before the state lists them, and the organization revision the last one was saved at.
    [made, setMade] = useState<{ workers: Worker[]; revision: number }>({ workers: [], revision: 0 }),
    // The revision a save went from: until the saved organization moves past it, the fields show what was sent.
    [sent, setSent] = useState<number | null>(null),
    waiting = sent !== null && revision === sent,
    value = sent !== null && !waiting ? saved : (draft ?? saved),
    changed = JSON.stringify(value) !== JSON.stringify(saved),
    [picking, setPicking] = useState(adding),
    [making, setMaking] = useState(false),
    [removing, setRemoving] = useState(false),
    name = teamName(value.team),
    field = useId();
  // The agents the studio has, without deleted ones, and any made here before the state shows them.
  const listed = (state.employeeDirectory?.length ? state.employeeDirectory : state.workers).filter(
      worker => !worker.deletedAt,
    ),
    directory = [...listed, ...made.workers.filter(worker => !listed.some(item => item.id === worker.id))],
    agent = (workerId: string) => directory.find(worker => worker.id === workerId) ?? { id: workerId },
    others = directory.filter(worker => !value.members.some(member => member.workerId === worker.id)),
    // The saved organization a save starts from, at the revision an agent made here was saved at.
    start = () => ({ ...body, expectedRevision: Math.max(revision, made.revision) });
  // Saved, a new team opens under its own address once the saved organization holds it.
  useEffect(() => {
    if (teamId === 'new' && savedTeam)
      void navigate({ to: '/p/$projectId/agents', params: { projectId }, search: { team: id }, replace: true });
  }, [teamId, savedTeam, navigate, projectId, id]);
  if (teamId !== 'new' && !savedTeam)
    return (
      <p role="status" className="sd-meta">
        This team is not in the project.
      </p>
    );
  const edit = (change: (current: TeamDraft) => TeamDraft) => {
    save.reset();
    setSent(null);
    setDraft(change(value));
  };
  const setField = (key: 'name' | 'mark' | 'purpose' | 'goal' | 'outcome' | 'leadId', text: string) =>
    edit(current => ({ ...current, team: { ...current.team, [key]: key === 'leadId' ? text || null : text } }));
  // An agent is in one team of a project: one brought in keeps the part it had in its other team.
  const bringIn = (workerId: string) => {
    const part = body.members.find(member => member.workerId === workerId);
    edit(current => ({
      ...current,
      members: [
        ...current.members,
        part
          ? { workerId, role: part.role, responsibility: part.responsibility, roles: part.roles }
          : { workerId, ...contributor, roles: [] },
      ],
    }));
    setPicking(false);
  };
  const takeOff = (workerId: string) =>
    edit(current => ({
      team: current.team.leadId === workerId ? { ...current.team, leadId: null } : current.team,
      members: current.members.filter(member => member.workerId !== workerId),
    }));
  const submit = () => {
    const ident = isNew ? newTeamId() : id,
      team = { ...value.team, id: ident, name: value.team.name.trim() },
      from = start();
    if (isNew) setNamed(ident);
    save.mutate(replaceTeam(isNew ? addTeam(from, team) : from, team, value.members), {
      onSuccess: () => {
        setSent(revision);
        toast(`${team.name} ${isNew ? 'added' : 'saved'}. Work that starts from now on follows it.`);
      },
    });
  };
  const remove = () =>
    save.mutate(removeTeam(start(), id), {
      onSuccess: () => {
        toast(`${saved.team.name} removed. Its agents are out of ${state.project.name}'s flow.`);
        void navigate({ to: '/p/$projectId/agents', params: { projectId } });
      },
    });
  const undo = () => {
    save.reset();
    setSent(null);
    setDraft(null);
    setRemoving(false);
  };
  const leaving = saved.members.map(member => agentName(agent(member.workerId)));
  return (
    <section className="sd-agentdetail" aria-label={isNew ? 'A new team' : `Edit ${saved.team.name}`}>
      <div className="sd-card sd-agenthead">
        <input
          className="sd-teammark sd-teammark--field"
          aria-label="Mark"
          value={value.team.mark ?? ''}
          placeholder={name.slice(0, 2).toUpperCase()}
          maxLength={3}
          autoComplete="off"
          onChange={event => setField('mark', event.target.value.toUpperCase())}
        />
        <div className="sd-agenthead__text">
          <h2 className="sd-agenthead__name">{isNew ? 'A new team' : saved.team.name}</h2>
          <input
            className="sd-input"
            aria-label="Team name"
            placeholder="Name the team"
            value={value.team.name}
            required
            maxLength={100}
            autoComplete="off"
            autoFocus={isNew}
            onChange={event => setField('name', event.target.value)}
          />
          {!isNew && !removing && (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
              <button
                type="button"
                className="sd-btn sd-btn--sm sd-btn--danger"
                disabled={save.isPending}
                onClick={() => {
                  save.reset();
                  setRemoving(true);
                }}
              >
                <Icon name="trash" size={16} />
                Remove the team
              </button>
            </span>
          )}
        </div>
        <p className="sd-agenthead__note">A team groups agents; it grants them nothing.</p>
        {removing && (
          <div className="sd-callout" role="group" aria-label={`Remove ${saved.team.name}?`}>
            <span
              className="sd-callout__text"
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' }}
            >
              <b>Remove {saved.team.name}?</b>
              <span>
                {leaving.length
                  ? `Its agents leave ${state.project.name}'s flow: ${leaving.join(', ')}. Their kinds of work go back to being chosen each time, until they join another team.`
                  : `It has no agents, so no one leaves ${state.project.name}'s flow.`}{' '}
                Work already recorded keeps what it ran with.
              </span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
                <button
                  type="button"
                  className="sd-btn sd-btn--sm sd-btn--danger"
                  disabled={save.isPending}
                  onClick={remove}
                >
                  Remove {saved.team.name}
                </button>
                <button
                  type="button"
                  className="sd-btn sd-btn--sm sd-btn--ghost"
                  disabled={save.isPending}
                  onClick={() => {
                    save.reset();
                    setRemoving(false);
                  }}
                >
                  Keep it
                </button>
              </span>
            </span>
          </div>
        )}
      </div>
      <div className="sd-agentgrid">
        <section
          className="sd-card sd-sidecard sd-sidecard--roomy"
          aria-labelledby={`${field}-for`}
          style={sectionStyle}
        >
          <h2 id={`${field}-for`} className="sd-sidecard__title">
            What it&apos;s for
          </h2>
          <span className="sd-meta">Its agents read these with every assignment.</span>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor={`${field}-purpose`}>
              Purpose
            </label>
            <textarea
              id={`${field}-purpose`}
              className="sd-textarea"
              value={value.team.purpose ?? ''}
              maxLength={4000}
              placeholder="What the team is for"
              onChange={event => setField('purpose', event.target.value)}
            />
          </div>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor={`${field}-goal`}>
              Goal
            </label>
            <textarea
              id={`${field}-goal`}
              className="sd-textarea"
              value={value.team.goal ?? ''}
              maxLength={4000}
              onChange={event => setField('goal', event.target.value)}
            />
          </div>
          <div className="sd-field">
            <label className="sd-field__label" htmlFor={`${field}-outcome`}>
              Done when
            </label>
            <textarea
              id={`${field}-outcome`}
              className="sd-textarea"
              value={value.team.outcome ?? ''}
              maxLength={4000}
              onChange={event => setField('outcome', event.target.value)}
            />
          </div>
        </section>
        <section
          className="sd-card sd-sidecard sd-sidecard--roomy"
          aria-labelledby={`${field}-who`}
          style={sectionStyle}
        >
          <h2 id={`${field}-who`} className="sd-sidecard__title">
            Who&apos;s on it
          </h2>
          {value.members.length ? (
            <ul aria-label={`${name}'s agents`} style={listStyle}>
              {value.members.map(member => {
                const worker = agent(member.workerId),
                  look = looks.get(member.workerId);
                return (
                  <li key={member.workerId} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-10)' }}>
                    {look && <AgentAvatar look={look} size={36} ring={false} />}
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', flex: '1 1 0' }}>
                      <b>{agentName(worker)}</b>
                      <input
                        className="sd-input"
                        aria-label={`${agentName(worker)}'s role`}
                        value={member.role}
                        required
                        maxLength={160}
                        onChange={event =>
                          edit(current => ({
                            ...current,
                            members: current.members.map(item =>
                              item.workerId === member.workerId ? { ...item, role: event.target.value } : item,
                            ),
                          }))
                        }
                      />
                    </span>
                    <button
                      type="button"
                      className="sd-btn sd-btn--sm sd-btn--ghost"
                      aria-label={`Remove ${agentName(worker)} from ${name}`}
                      onClick={() => takeOff(member.workerId)}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="sd-meta">No agents in this team yet.</span>
          )}
          <div className="sd-field">
            <label className="sd-field__label" htmlFor={`${field}-lead`}>
              Who leads
            </label>
            <select
              id={`${field}-lead`}
              className="sd-select"
              value={value.team.leadId ?? ''}
              onChange={event => setField('leadId', event.target.value)}
            >
              <option value="">No one leads it yet</option>
              {value.members.map(member => (
                <option key={member.workerId} value={member.workerId}>
                  {agentName(agent(member.workerId))}
                </option>
              ))}
            </select>
          </div>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              aria-expanded={picking}
              onClick={() => {
                setMaking(false);
                setPicking(!picking);
              }}
            >
              <Icon name="plus" size={16} />
              Add an agent
            </button>
            <button
              type="button"
              className="sd-btn sd-btn--sm"
              aria-expanded={making}
              disabled={isNew}
              onClick={() => {
                setPicking(false);
                setMaking(!making);
              }}
            >
              <Icon name="plus" size={16} />
              Make a new one
            </button>
          </span>
          {isNew && <span className="sd-meta">Save the team first, then make a new agent for it.</span>}
          {picking &&
            (others.length ? (
              <ul aria-label="Agents the studio has" className="sd-agentpick" style={listStyle}>
                {others.map(worker => {
                  const look = looks.get(worker.id),
                    from = body.teams.find(
                      team => team.id === body.members.find(member => member.workerId === worker.id)?.teamId,
                    );
                  return (
                    <li key={worker.id}>
                      <button type="button" className="sd-agentrow" onClick={() => bringIn(worker.id)}>
                        {look && <AgentAvatar look={look} size={40} ring={false} />}
                        <span className="sd-agentrow__text">
                          <b>{agentName(worker)}</b>
                          <span className="sd-meta">
                            {from
                              ? `Moves from ${from.name}`
                              : worker.projectId
                                ? 'Not on a team'
                                : 'Not in this project yet'}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <span className="sd-meta">Every agent the studio has is already on this team.</span>
            ))}
          {making && !isNew && (
            <NewAgent
              projectId={projectId}
              state={state}
              team={saved.team}
              expectedRevision={Math.max(revision, made.revision)}
              onMade={({ worker, revision: next }, roles) => {
                // The agent is saved as the organization's next revision; the rest of the draft still waits.
                setMade(current => ({ workers: [...current.workers, worker], revision: next }));
                edit(current => ({
                  ...current,
                  members: [
                    ...current.members.filter(member => member.workerId !== worker.id),
                    {
                      workerId: worker.id,
                      role: worker.jobTitle ?? '',
                      responsibility: worker.responsibility ?? '',
                      roles,
                    },
                  ],
                }));
                setMaking(false);
                toast(`${agentName(worker)} joined ${saved.team.name}. Your other changes still wait for you to save.`);
              }}
              onClose={() => setMaking(false)}
            />
          )}
        </section>
        <TeamTold projectId={projectId} state={state} team={saved.team} isNew={isNew} members={saved.members} />
      </div>
      <div className="sd-editbar">
        {save.error ? (
          <p role="alert" className="sd-editbar__text" style={{ color: 'var(--bad)', fontWeight: 600 }}>
            {save.error.message}
          </p>
        ) : (
          <span className="sd-editbar__text sd-meta">
            {waiting
              ? 'Saved. Work that starts from now on follows it.'
              : 'Nothing changes until you save. Saving changes work that starts afterwards; recorded attempts keep what they ran with.'}
          </span>
        )}
        <button
          type="button"
          className="sd-btn sd-btn--ghost"
          disabled={!changed || waiting || save.isPending}
          onClick={undo}
        >
          Undo
        </button>
        <button
          type="button"
          className="sd-btn sd-btn--primary"
          disabled={(!changed && !isNew) || waiting || save.isPending || !value.team.name.trim()}
          onClick={submit}
        >
          Save the team
        </button>
      </div>
    </section>
  );
}

// What the team is told: its rules as its lead, or else its first agent, reads them, and their revision; with no agent
// on the team yet, its instructions.
function TeamTold({
  projectId,
  state,
  team,
  isNew,
  members,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  isNew: boolean;
  members: Part[];
}) {
  const reader = members.find(member => member.workerId === team.leadId)?.workerId ?? members[0]?.workerId,
    id = useId();
  return (
    <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby={`${id}-told`} style={sectionStyle}>
      <h2 id={`${id}-told`} className="sd-sidecard__title">
        Is told
      </h2>
      {isNew ? (
        <span className="sd-meta">A new team&apos;s rules start when it is saved.</span>
      ) : reader ? (
        <TeamRules projectId={projectId} state={state} team={team} reader={reader} />
      ) : (
        <>
          <span className="sd-meta">No agent on {team.name} reads its rules yet.</span>
          <Link
            className="sd-btn sd-btn--sm"
            style={{ alignSelf: 'flex-start' }}
            to="/p/$projectId/agents/instructions"
            params={{ projectId }}
            search={{ open: `team:${team.id}` }}
          >
            Open the team&apos;s rules
          </Link>
        </>
      )}
    </section>
  );
}

function TeamRules({
  projectId,
  state,
  team,
  reader,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  reader: string;
}) {
  const { data: view, error } = useTold(projectId, reader),
    set = view?.layers.find(layer => layer.layer === 'team'),
    worker = [...state.workers, ...(state.employeeDirectory ?? [])].find(item => item.id === reader),
    name = worker?.displayName ?? reader;
  return (
    <>
      {set ? (
        <span style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)' }}>
          <span>
            {team.name}&apos;s rules: {set.rules.length} {plural(set.rules.length, 'rule')}
          </span>
          <span className="sd-meta">revision {set.revision}</span>
        </span>
      ) : (
        <span className="sd-meta">
          {error ? error.message : view === null ? `${name} is not in this project's records.` : 'Reading its rules…'}
        </span>
      )}
      {set?.draft?.current && (
        <span className="sd-meta">A draft of its rules waits; it changes nothing until it is published.</span>
      )}
      <span className="sd-meta">As {name} reads them, with every assignment.</span>
      <Link
        className="sd-btn sd-btn--sm"
        style={{ alignSelf: 'flex-start' }}
        to="/p/$projectId/agents/$workerId/told"
        params={{ projectId, workerId: reader }}
      >
        Open the team&apos;s rules
      </Link>
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
// page.
function NewAgent({
  projectId,
  state,
  team,
  expectedRevision,
  onMade,
  onClose,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  expectedRevision: number;
  onMade: (made: { worker: Worker; revision: number }, roles: string[]) => void;
  onClose: () => void;
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
        <button type="button" className="sd-btn sd-btn--ghost" disabled={make.isPending} onClick={onClose}>
          Cancel
        </button>
      </span>
    </form>
  );
}
