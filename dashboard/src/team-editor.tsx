// Edit the team: one team, beside the flow on the Agents page in the agent editor's place and never in a dialog, with
// the team in the address (?team=<id>, or ?team=new to start a new one): what it is for, who is on it and what it is
// told. Save the team sends the project's whole organization with only this team and its agents changed
// (organization.ts); Undo puts back the saved team without sending anything; Remove the team asks in place first. A
// team groups agents and grants them nothing. A change reaches work that starts after the save, and recorded attempts
// keep what they ran with. Kinds of work are given from an agent's Does list. Who's on it's Add an agent opens the
// Agents page panel's two choices for this team (add-agent.tsx): an agent the studio has joins the draft, and a new
// one is saved at once and joins it too.
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { AddChoices, contributor } from './add-agent';
import type { Team, Worker } from './api';
import type { AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Icon } from './design/icons';
import { plural } from './evidence';
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
// A new team's identity, made when it is first saved.
const newTeamId = () => `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    // Add an agent's two choices, open from the address's add=true.
    [choosing, setChoosing] = useState(adding),
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
    comesFrom = (worker: Worker) => {
      const from = body.teams.find(
        team => team.id === body.members.find(member => member.workerId === worker.id)?.teamId,
      );
      return from ? `Moves from ${from.name}` : worker.projectId ? 'Not on a team' : 'Not in this project yet';
    },
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
    setChoosing(false);
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
              aria-expanded={choosing}
              onClick={() => setChoosing(!choosing)}
            >
              <Icon name="plus" size={16} />
              Add an agent
            </button>
          </span>
          {choosing && (
            <AddChoices
              projectId={projectId}
              state={state}
              team={saved.team}
              agents={others}
              looks={looks}
              onPick={worker => bringIn(worker.id)}
              from={comesFrom}
              everyone="Every agent the studio has is already on this team."
              unsaved={isNew}
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
                setChoosing(false);
                toast(`${agentName(worker)} joined ${saved.team.name}. Your other changes still wait for you to save.`);
              }}
              onCancel={() => setChoosing(false)}
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
