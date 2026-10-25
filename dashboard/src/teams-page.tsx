// The teams (v1.0 item 23; the canvas has no board for them, so they are built in the redesign's language): the
// project's teams as cards with their agents' faces, and a team's own page with its goal, its agents and its work.
// Edit the teams turns the same cards into the project's organization, edited in place: each team's fields, its
// agents with a + for one the studio already has or a new one that belongs to this project (1.0.1), an Add a team
// card, and below them the kinds of work the project takes and the model tiers. A team groups agents; it grants no tools. A change reaches work that starts after it
// is saved, and recorded attempts keep what they ran with.
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  send,
  type Adapter,
  type Execution,
  type PeopleSummary,
  type Task,
  type Team,
  type Tiers,
  type Worker,
} from './api';
import type { AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Dialog } from './design/dialog';
import { Icon } from './design/icons';
import { cleanExecution, ExecutionFields, modeLabels, offeredModes } from './execution-fields';
import { agentState } from './faces';
import { Heading } from './layout';
import { usePeople, useSettled, useStudio } from './records';
import { active, liveSummary, type StudioState } from './studio-runs';
import { TaskRow } from './task-row';
import { agentLooks } from './today';
import { useToast } from './toast';

const agentsCrumb = (projectId: string) => (
  <Link key="agents" to="/p/$projectId/agents" params={{ projectId }}>
    Agents
  </Link>
);
const teamsCrumb = (projectId: string) => (
  <Link key="teams" to="/p/$projectId/agents/teams" params={{ projectId }}>
    Teams
  </Link>
);
const open = (task: Task) => !['done', 'denied'].includes(task.status) && !task.closed;

// How far a team has got with its goal: its goal work accepted, the live set's record first.
function goalProgress(state: StudioState, people: PeopleSummary | undefined, ids: string[] = []) {
  const tasks = ids
    .map(id => state.tasks.find(task => task.id === id) ?? people?.goals[id])
    .filter((task): task is Task => !!task);
  return { total: tasks.length, done: tasks.filter(task => task.status === 'done').length };
}

function useLooks(projectId: string, state: StudioState | null) {
  return useMemo(
    () =>
      state
        ? agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])])
        : new Map<string, AgentLook>(),
    [projectId, state],
  );
}

function Loading({ error, children }: { error: Error | null; children: ReactNode }) {
  return error ? (
    <p role="alert">The project could not be loaded: {error.message}</p>
  ) : (
    <p role="status" className="sd-meta">
      {children}
    </p>
  );
}

// Whether the page is editing is part of the address, so Add an agent and a team's own page open it that way.
export function TeamsPage({
  projectId,
  editing,
  onEditing,
}: {
  projectId: string;
  editing: boolean;
  onEditing: (editing: boolean) => void;
}) {
  const { state, error } = useStudio(projectId),
    { data: people } = usePeople(projectId),
    looks = useLooks(projectId, state);
  if (state && editing)
    return (
      <div className="sd-orgpage">
        <TeamsEdit projectId={projectId} state={state} looks={looks} onDone={() => onEditing(false)} />
      </div>
    );
  return (
    <div className="sd-orgpage">
      <Heading
        crumbs={[agentsCrumb(projectId)]}
        here="Teams"
        title="Teams"
        lead="Each team has a purpose and a goal, and its agents do the work. A team groups agents; it grants them nothing."
        tools={
          state && (
            <button type="button" className="sd-btn sd-btn--sm" onClick={() => onEditing(true)}>
              <Icon name="pencil" size={16} />
              Edit the teams
            </button>
          )
        }
      />
      {state ? (
        <div className="sd-teamgrid">
          {(state.teams ?? []).map(team => (
            <TeamCard key={team.id} projectId={projectId} state={state} people={people} team={team} looks={looks} />
          ))}
        </div>
      ) : (
        <Loading error={error}>Loading the teams…</Loading>
      )}
    </div>
  );
}

// An agent's face with its name and role, a link to its page.
function Face({
  projectId,
  state,
  worker,
  look,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  look?: AgentLook;
}) {
  return (
    <Link className="sd-teamface" to="/p/$projectId/agents/$workerId" params={{ projectId, workerId: worker.id }}>
      {look && <AgentAvatar look={look} size={44} state={agentState(state, worker.id)} />}
      {worker.displayName ?? worker.id}
      <span className="sd-meta">{worker.jobTitle}</span>
    </Link>
  );
}

function Goal({ team, progress }: { team: Team; progress: { total: number; done: number } }) {
  if (!team.goal && !progress.total) return null;
  return (
    <div className="sd-teamcard__goal">
      <span className="sd-eyebrow">Goal</span>
      {team.goal && <span>{team.goal}</span>}
      {progress.total > 0 && (
        <>
          <span className="sd-bar" aria-hidden="true">
            <span
              className="sd-bar__part sd-bar__part--ok"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            ></span>
          </span>
          <span className="sd-meta">
            {progress.done} of {progress.total} of its goal&apos;s work accepted
          </span>
        </>
      )}
    </div>
  );
}

function TeamCard({
  projectId,
  state,
  people,
  team,
  looks,
}: {
  projectId: string;
  state: StudioState;
  people?: PeopleSummary;
  team: Team;
  looks: ReturnType<typeof useLooks>;
}) {
  const members = state.workers.filter(worker => worker.team === team.name),
    work = state.tasks.filter(task => task.team === team.name),
    working = work.some(active),
    openWork = work.filter(open).length,
    lead = members.find(worker => worker.id === team.leadId);
  return (
    <article className="sd-card sd-teamcard" aria-labelledby={`team-${team.id}`}>
      <div className="sd-teamcard__head">
        <span className="sd-teammark" aria-hidden="true">
          {team.mark ?? team.name.slice(0, 2).toUpperCase()}
        </span>
        <h2 id={`team-${team.id}`} className="sd-teamcard__name">
          <Link to="/p/$projectId/agents/teams/$teamId" params={{ projectId, teamId: team.id }}>
            {team.name}
          </Link>
        </h2>
        <span className={`sd-chip${working ? ' sd-chip--live' : ''}`}>
          <span className="sd-chip__dot"></span>
          {working ? 'Working' : openWork ? `${openWork} open` : 'Free'}
        </span>
      </div>
      {team.purpose && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{team.purpose}</p>}
      <Goal team={team} progress={goalProgress(state, people, team.goalTaskIds)} />
      {members.length ? (
        <div className="sd-teamfaces">
          {members.map(worker => (
            <Face key={worker.id} projectId={projectId} state={state} worker={worker} look={looks.get(worker.id)} />
          ))}
        </div>
      ) : (
        <span className="sd-meta">No agents in this team yet.</span>
      )}
      <div className="sd-teamcard__foot">
        {lead && <span className="sd-meta">Led by {lead.displayName ?? lead.id}</span>}
        <Link
          className="sd-btn sd-btn--sm sd-btn--ghost"
          to="/p/$projectId/agents/instructions"
          params={{ projectId }}
          search={{ open: `team:${team.id}` }}
        >
          <Icon name="file" size={16} />
          What the team is told
        </Link>
      </div>
    </article>
  );
}

export function TeamPage({ projectId, teamId }: { projectId: string; teamId: string }) {
  const { state, error } = useStudio(projectId),
    { data: people } = usePeople(projectId),
    looks = useLooks(projectId, state),
    team = state?.teams?.find(item => item.id === teamId),
    accepted = useSettled(projectId, 'accepted', !!team, { team: team?.name });
  if (!state || !team)
    return (
      <div className="sd-orgpage">
        <Heading crumbs={[agentsCrumb(projectId), teamsCrumb(projectId)]} here={teamId} title="Team" />
        <Loading error={error}>{state ? 'This team is not in the project.' : 'Loading the team…'}</Loading>
      </div>
    );
  const members = state.workers.filter(worker => worker.team === team.name),
    stories = liveSummary(state).stories,
    work = state.tasks.filter(task => task.team === team.name && open(task)),
    delivered = (accepted.data?.pages ?? []).flatMap(page => page.tasks);
  return (
    <div className="sd-orgpage">
      <Heading
        crumbs={[agentsCrumb(projectId), teamsCrumb(projectId)]}
        here={team.name}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-14)' }}>
            <span className="sd-teammark sd-teammark--lg" aria-hidden="true">
              {team.mark ?? team.name.slice(0, 2).toUpperCase()}
            </span>
            {team.name}
          </span>
        }
        lead={team.purpose}
        tools={
          <>
            <Link
              className="sd-btn sd-btn--sm sd-btn--ghost"
              to="/p/$projectId/agents/instructions"
              params={{ projectId }}
              search={{ open: `team:${team.id}` }}
            >
              <Icon name="file" size={16} />
              What the team is told
            </Link>
            <Link
              className="sd-btn sd-btn--sm"
              to="/p/$projectId/agents/teams"
              params={{ projectId }}
              search={{ edit: true }}
            >
              <Icon name="pencil" size={16} />
              Edit the teams
            </Link>
          </>
        }
      />
      <div className="sd-agentgrid">
        <section
          className="sd-card sd-sidecard sd-sidecard--roomy"
          style={{ flex: '3 1 360px', minWidth: 0 }}
          aria-labelledby="team-work"
        >
          <h2 id="team-work" className="sd-sidecard__title">
            The team&apos;s work
          </h2>
          {work.length ? (
            <div>
              {work.map(task => (
                <TaskRow key={task.id} projectId={projectId} task={task} stories={stories} />
              ))}
            </div>
          ) : (
            <span className="sd-meta">Nothing open now.</span>
          )}
          <span className="sd-eyebrow" style={{ marginTop: 'var(--space-8)' }}>
            Delivered
          </span>
          {accepted.error ? (
            <p role="alert">Its accepted work could not be loaded: {accepted.error.message}</p>
          ) : accepted.isPending ? (
            <span className="sd-meta" role="status">
              Reading its accepted work…
            </span>
          ) : delivered.length ? (
            <div>
              {delivered.map(task => (
                <TaskRow key={task.id} projectId={projectId} task={task} stories={stories} />
              ))}
            </div>
          ) : (
            <span className="sd-meta">Nothing accepted yet.</span>
          )}
          {accepted.hasNextPage && (
            <button
              type="button"
              className="sd-btn sd-btn--sm sd-btn--ghost"
              style={{ alignSelf: 'flex-start' }}
              disabled={accepted.isFetchingNextPage}
              onClick={() => void accepted.fetchNextPage()}
            >
              Show older
            </button>
          )}
        </section>
        <aside
          style={{ flex: '1 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}
        >
          {(team.goal || team.outcome) && (
            <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="team-goal">
              <h2 id="team-goal" className="sd-sidecard__title">
                Its goal
              </h2>
              <Goal team={team} progress={goalProgress(state, people, team.goalTaskIds)} />
              {team.outcome && (
                <span style={{ color: 'var(--ink-2)', fontSize: '14.5px' }}>
                  <b style={{ color: 'var(--ink)' }}>When it is done:</b> {team.outcome}
                </span>
              )}
            </section>
          )}
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="team-agents">
            <h2 id="team-agents" className="sd-sidecard__title">
              Its agents
            </h2>
            {members.length ? (
              <div className="sd-teamfaces">
                {members.map(worker => (
                  <Face
                    key={worker.id}
                    projectId={projectId}
                    state={state}
                    worker={worker}
                    look={looks.get(worker.id)}
                  />
                ))}
              </div>
            ) : (
              <span className="sd-meta">No agents in this team yet.</span>
            )}
            {team.leadId && (
              <span className="sd-meta">
                {members.find(worker => worker.id === team.leadId)?.displayName ?? team.leadId} leads the team.
              </span>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

// Edit the teams: the project's teams, which team each agent is in with its role, the kinds of work the project
// takes with their default agents, and the model tiers, saved together as the project's next organization revision.
const tierNames = ['light', 'standard', 'deep'] as const;
type TierField = 'model' | 'effort' | 'mode';
interface MemberDraft {
  teamId: string;
  role: string;
  responsibility: string;
  roles: string;
}
interface Draft {
  expectedRevision: number;
  teams: Team[];
  members: Record<string, MemberDraft>;
  taskKinds: string[];
  kindOwners: Record<string, string>;
  tiers: Tiers;
}
const tierWords: Record<(typeof tierNames)[number], string> = {
  light: 'Light work',
  standard: 'Standard work',
  deep: 'Deep work',
};
const tierFields = (adapter: Adapter): TierField[] => [
  'model',
  ...(adapter.efforts?.length ? (['effort'] as const) : []),
  ...(offeredModes(adapter).length > 1 ? (['mode'] as const) : []),
];
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

// Each edit starts from the saved organization: every agent the studio has, in a team or not in this project.
function savedDraft(state: StudioState, directory: Worker[]): Draft {
  const config = state.organizationConfiguration ?? {};
  return {
    expectedRevision: config.revision ?? 0,
    teams: (config.teams ?? []).map(({ id, name, mark, purpose, goal, outcome, leadId }) => ({
      id,
      name,
      mark,
      purpose,
      goal,
      outcome,
      leadId,
    })),
    members: Object.fromEntries(
      directory.map(worker => {
        const member = config.members?.find(item => item.workerId === worker.id);
        return [
          worker.id,
          {
            teamId: member?.teamId ?? '',
            role: member?.role ?? 'Project contributor',
            responsibility:
              member?.responsibility ?? 'Perform bounded project work and submit evidence for director review.',
            roles: (member?.roles ?? []).join(', '),
          },
        ];
      }),
    ),
    taskKinds: config.taskKinds ?? Object.keys(state.taskKinds),
    kindOwners: config.kindOwners ?? {},
    tiers: structuredClone(config.tiers ?? {}),
  };
}

function TeamsEdit({
  projectId,
  state,
  looks,
  onDone,
}: {
  projectId: string;
  state: StudioState;
  looks: ReturnType<typeof useLooks>;
  onDone: () => void;
}) {
  // The agents this project can have, without deleted ones, and any made during this edit before the state shows
  // them.
  const config = state.organizationConfiguration ?? {},
    [made, setMade] = useState<Worker[]>([]),
    listed = (state.employeeDirectory?.length ? state.employeeDirectory : state.workers).filter(
      worker => !worker.deletedAt,
    ),
    directory = [...listed, ...made.filter(worker => !listed.some(item => item.id === worker.id))],
    toast = useToast(),
    [draft, setDraft] = useState<Draft>(() => savedDraft(state, directory)),
    // The kinds of work the project took when the edit began come first, and the rest wait behind their own line,
    // so a kind turned on or off stays where it is.
    [taken] = useState(() => new Set(draft.taskKinds)),
    // The agent whose part in its team is open, the team an agent is being brought into, and the team a new agent
    // is being made for.
    [part, setPart] = useState<string | null>(null),
    [adding, setAdding] = useState<string | null>(null),
    [making, setMaking] = useState<string | null>(null),
    // A team just added takes the cursor in its name.
    fresh = useRef<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      send(`/api/projects/${encodeURIComponent(projectId)}/organization`, { projectId, ...body }, 'PATCH'),
    onSuccess: () => {
      toast('Teams saved. Work that starts from now on follows them.');
      onDone();
    },
  });
  const defaults = useMutation({
    mutationFn: () =>
      send(`/api/projects/${encodeURIComponent(projectId)}/organization`, {
        projectId,
        preset: 'studio-development',
        expectedRevision: 0,
      }),
    onSuccess: () => {
      toast('Software project teams set up.');
      onDone();
    },
    onError: error => toast(error.message),
  });
  const placed = (id: string) => !!draft.members[id]?.teamId,
    busy = save.isPending || defaults.isPending;
  // The CLIs the project's agents use, each with the fields it offers. Settings for a CLI no agent uses are kept.
  const providers = new Set(directory.filter(worker => placed(worker.id)).map(worker => worker.provider)),
    adapters = Object.values(state.adapters ?? {}).filter(
      adapter => adapter.workerSelectable && adapter.id !== 'mock' && providers.has(adapter.id),
    );
  // A kind of work goes by default only to an enabled agent in the project; one taken out of it goes back to being
  // chosen each time.
  const owners = directory.filter(worker => placed(worker.id) && worker.enabled),
    ownerOf = (kind: string) =>
      owners.some(worker => worker.id === draft.kindOwners[kind]) ? draft.kindOwners[kind]! : '';
  const submit = () => {
    const tiers: Tiers = structuredClone(draft.tiers);
    for (const tier of tierNames) {
      for (const adapter of adapters) {
        const settings = Object.fromEntries(
          tierFields(adapter)
            .map(field => [field, draft.tiers[tier]?.[adapter.id]?.[field]?.trim() ?? ''] as const)
            .filter(([, value]) => value),
        );
        if (Object.keys(settings).length) (tiers[tier] ??= {})[adapter.id] = settings;
        else delete tiers[tier]?.[adapter.id];
      }
      if (tiers[tier] && !Object.keys(tiers[tier]).length) delete tiers[tier];
    }
    save.mutate({
      expectedRevision: draft.expectedRevision,
      teams: draft.teams.map(team => ({ ...team, leadId: team.leadId || null })),
      // Every placed agent in the draft, a new one included even before the state lists it.
      members: Object.entries(draft.members)
        .filter(([, member]) => member.teamId)
        .map(([workerId, member]) => ({
          workerId,
          teamId: member.teamId,
          role: member.role,
          responsibility: member.responsibility,
          roles: roleList(member.roles),
        })),
      taskKinds: draft.taskKinds,
      kindOwners: Object.fromEntries(draft.taskKinds.filter(kind => ownerOf(kind)).map(kind => [kind, ownerOf(kind)])),
      // An explicit empty object clears saved tiers; with no agent's CLI shown they are left untouched.
      ...(adapters.length ? { tiers } : {}),
    });
  };
  const setTeam = (id: string, field: keyof Team, value: string) =>
    setDraft(current => ({
      ...current,
      teams: current.teams.map(team => (team.id === id ? { ...team, [field]: value } : team)),
    }));
  const setMember = (id: string, field: keyof MemberDraft, value: string) =>
    setDraft(current => ({
      ...current,
      members: { ...current.members, [id]: { ...current.members[id]!, [field]: value } },
    }));
  // An agent is in one team of a project: bringing it into a team takes it out of the other and off that team's
  // lead, and taking it off a team takes it out of the project.
  const place = (workerId: string, teamId: string) =>
    setDraft(current => ({
      ...current,
      teams: current.teams.map(team =>
        team.leadId === workerId && team.id !== teamId ? { ...team, leadId: null } : team,
      ),
      members: { ...current.members, [workerId]: { ...current.members[workerId]!, teamId } },
    }));
  const addTeam = () => {
    const id = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    fresh.current = id;
    setDraft(current => ({
      ...current,
      teams: [...current.teams, { id, name: '', mark: '', purpose: '', goal: '', outcome: '', leadId: null }],
    }));
  };
  // A team's agents leave the project with it, until they are brought into another team.
  const removeTeam = (id: string) =>
    setDraft(current => ({
      ...current,
      teams: current.teams.filter(team => team.id !== id),
      members: Object.fromEntries(
        Object.entries(current.members).map(([worker, member]) => [
          worker,
          member.teamId === id ? { ...member, teamId: '' } : member,
        ]),
      ),
    }));
  const setTier = (tier: string, provider: string, field: TierField, value: string) =>
    setDraft(current => ({
      ...current,
      tiers: {
        ...current.tiers,
        [tier]: { ...current.tiers[tier], [provider]: { ...current.tiers[tier]?.[provider], [field]: value } },
      },
    }));
  const kinds = Object.entries(state.taskKinds),
    kindRow = ([kind, definition]: (typeof kinds)[number]) => {
      const on = draft.taskKinds.includes(kind);
      return (
        <div key={kind} className="sd-setrow" style={{ alignItems: 'center' }}>
          <button
            type="button"
            className="sd-toggle"
            role="switch"
            aria-checked={on}
            aria-label={definition.label ?? kind}
            onClick={() =>
              setDraft(current => ({
                ...current,
                taskKinds: on ? current.taskKinds.filter(item => item !== kind) : [...current.taskKinds, kind],
              }))
            }
          />
          <span className="sd-setrow__text">
            <b>{definition.label ?? kind}</b>
            {definition.executionNotice && <span className="sd-meta">{definition.executionNotice}</span>}
          </span>
          <select
            aria-label={`Who does ${definition.label ?? kind}`}
            className="sd-select"
            style={{ width: 'auto', minWidth: '180px' }}
            disabled={!on}
            value={ownerOf(kind)}
            onChange={event =>
              setDraft(current => ({
                ...current,
                kindOwners: { ...current.kindOwners, [kind]: event.target.value },
              }))
            }
          >
            <option value="">Chosen each time</option>
            {owners.map(worker => (
              <option key={worker.id} value={worker.id}>
                {agentName(worker)}
              </option>
            ))}
          </select>
        </div>
      );
    };
  const partWorker = directory.find(worker => worker.id === part && placed(worker.id)),
    partTeam = partWorker && draft.teams.find(team => team.id === draft.members[partWorker.id]!.teamId),
    addingTeam = draft.teams.find(team => team.id === adding),
    makingTeam = draft.teams.find(team => team.id === making);
  return (
    <>
      <form
        className="sd-orgpage"
        aria-label="Edit the teams"
        onSubmit={event => {
          event.preventDefault();
          submit();
        }}
      >
        <Heading
          crumbs={[agentsCrumb(projectId)]}
          here="Teams"
          title={
            <>
              Teams{' '}
              <span className="sd-chip sd-chip--brand" style={{ verticalAlign: 'middle' }}>
                Editing
              </span>
            </>
          }
          lead={`Change ${state.project.name}'s teams in place, then save them. Work that starts after you save follows them; recorded attempts keep what they ran with.`}
          tools={
            config.inherited &&
            projectId === 'project-studio-desk' && (
              <button type="button" className="sd-btn sd-btn--sm" disabled={busy} onClick={() => defaults.mutate()}>
                Use the software project&apos;s teams
              </button>
            )
          }
        />
        <div className="sd-teamgrid">
          {draft.teams.map(team => {
            const members = directory.filter(worker => draft.members[worker.id]?.teamId === team.id),
              field = (name: string) => `team-${team.id}-${name}`;
            return (
              <section key={team.id} className="sd-card sd-teamcard sd-teamcard--edit" aria-label={teamName(team)}>
                <div className="sd-teamcard__head">
                  <input
                    className="sd-teammark sd-teammark--field"
                    aria-label={`${teamName(team)}'s mark`}
                    value={team.mark ?? ''}
                    placeholder={(team.name.trim() || 'New team').slice(0, 2).toUpperCase()}
                    maxLength={3}
                    autoComplete="off"
                    onChange={event => setTeam(team.id, 'mark', event.target.value.toUpperCase())}
                  />
                  <input
                    id={field('name')}
                    ref={element => {
                      if (element && fresh.current === team.id) {
                        fresh.current = null;
                        element.focus();
                      }
                    }}
                    className="sd-input sd-teamcard__namefield"
                    aria-label="Team name"
                    placeholder="Name the team"
                    value={team.name}
                    required
                    maxLength={100}
                    autoComplete="off"
                    onChange={event => setTeam(team.id, 'name', event.target.value)}
                  />
                  <button
                    type="button"
                    className="sd-btn sd-btn--sm sd-btn--ghost sd-btn--icon"
                    aria-label={`Remove ${team.name.trim() || 'this team'}`}
                    title={`Remove ${team.name.trim() || 'this team'}`}
                    onClick={() => removeTeam(team.id)}
                  >
                    <Icon name="trash" size={18} />
                  </button>
                </div>
                <div className="sd-field">
                  <label className="sd-field__label" htmlFor={field('purpose')}>
                    Purpose
                  </label>
                  <textarea
                    id={field('purpose')}
                    className="sd-textarea"
                    value={team.purpose ?? ''}
                    maxLength={4000}
                    placeholder="What the team is for"
                    onChange={event => setTeam(team.id, 'purpose', event.target.value)}
                  />
                </div>
                <div className="sd-teamcard__goal">
                  <div className="sd-field">
                    <label className="sd-field__label" htmlFor={field('goal')}>
                      Goal
                    </label>
                    <textarea
                      id={field('goal')}
                      className="sd-textarea"
                      value={team.goal ?? ''}
                      maxLength={4000}
                      onChange={event => setTeam(team.id, 'goal', event.target.value)}
                    />
                  </div>
                  <div className="sd-field">
                    <label className="sd-field__label" htmlFor={field('outcome')}>
                      When it is done
                    </label>
                    <textarea
                      id={field('outcome')}
                      className="sd-textarea"
                      value={team.outcome ?? ''}
                      maxLength={4000}
                      onChange={event => setTeam(team.id, 'outcome', event.target.value)}
                    />
                  </div>
                </div>
                <div className="sd-field">
                  <span className="sd-field__label" id={field('agents')}>
                    Agents
                  </span>
                  <div className="sd-teamfaces" role="group" aria-labelledby={field('agents')}>
                    {members.map(worker => {
                      const look = looks.get(worker.id);
                      return (
                        <span key={worker.id} className="sd-teamface sd-teamface--edit">
                          <button
                            type="button"
                            className="sd-teamface__open"
                            title={`${agentName(worker)}'s part in ${teamName(team)}`}
                            onClick={() => setPart(worker.id)}
                          >
                            {look && <AgentAvatar look={look} size={44} />}
                            {agentName(worker)}
                            <span className="sd-meta">{draft.members[worker.id]!.role}</span>
                          </button>
                          <button
                            type="button"
                            className="sd-teamface__remove"
                            aria-label={`Take ${agentName(worker)} off ${teamName(team)}`}
                            title={`Take ${agentName(worker)} off ${teamName(team)}`}
                            onClick={() => place(worker.id, '')}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </span>
                      );
                    })}
                    <button
                      type="button"
                      className="sd-teamface sd-teamface--add"
                      aria-label={`Add an agent to ${teamName(team)}`}
                      onClick={() => setAdding(team.id)}
                    >
                      <span className="sd-teamface__plus" aria-hidden="true">
                        <Icon name="plus" size={20} />
                      </span>
                      Add
                    </button>
                  </div>
                </div>
                <div className="sd-field">
                  <label className="sd-field__label" htmlFor={field('lead')}>
                    Lead
                  </label>
                  <select
                    id={field('lead')}
                    className="sd-select"
                    value={team.leadId ?? ''}
                    onChange={event => setTeam(team.id, 'leadId', event.target.value)}
                  >
                    <option value="">No lead</option>
                    {members.map(worker => (
                      <option key={worker.id} value={worker.id}>
                        {agentName(worker)}
                      </option>
                    ))}
                  </select>
                </div>
              </section>
            );
          })}
          <button type="button" className="sd-teamcard--add" onClick={addTeam}>
            <span className="sd-teamcard__plus" aria-hidden="true">
              <Icon name="plus" size={22} />
            </span>
            Add a team
          </button>
        </div>
        <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="edit-kinds">
          <h2 id="edit-kinds" className="sd-sidecard__title">
            Kinds of work
          </h2>
          <p className="sd-meta" style={{ margin: 0 }}>
            What this project takes, and the agent each kind goes to unless a step names another.
          </p>
          {kinds.filter(([kind]) => taken.has(kind)).map(kindRow)}
          {kinds.some(([kind]) => !taken.has(kind)) && (
            <details className="sd-disclosure">
              <summary>
                {taken.size ? 'Other kinds of work' : 'Kinds of work'} (
                {kinds.filter(([kind]) => !taken.has(kind)).length})
              </summary>
              {kinds.filter(([kind]) => !taken.has(kind)).map(kindRow)}
            </details>
          )}
        </section>
        {adapters.length > 0 && (
          <section className="sd-card sd-sidecard sd-sidecard--roomy" aria-labelledby="edit-tiers">
            <h2 id="edit-tiers" className="sd-sidecard__title">
              Model tiers
            </h2>
            <p className="sd-meta" style={{ margin: 0 }}>
              The model, effort and way of working a kind of work asks for, for each command-line tool. Leave one blank
              for the agent&apos;s own setting.
            </p>
            {tierNames.map(tier => (
              <details key={tier} className="sd-disclosure">
                <summary>{tierWords[tier]}</summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-12)' }}>
                  {adapters.map(adapter => {
                    const settings = draft.tiers[tier]?.[adapter.id] ?? {},
                      prefix = `tier-${tier}-${adapter.id}`;
                    return (
                      <div key={adapter.id} className="sd-editpanel">
                        <b>{adapter.name}</b>
                        <div className="sd-fieldgrid">
                          <div className="sd-field">
                            <label className="sd-field__label" htmlFor={`${prefix}-model`}>
                              Model
                            </label>
                            <input
                              id={`${prefix}-model`}
                              className="sd-input"
                              value={settings.model ?? ''}
                              list={`${prefix}-models`}
                              maxLength={100}
                              autoComplete="off"
                              placeholder="The agent's own"
                              onChange={event => setTier(tier, adapter.id, 'model', event.target.value)}
                            />
                            <datalist id={`${prefix}-models`}>
                              {(adapter.models ?? []).map(model => (
                                <option key={model.id} value={model.id}>
                                  {model.label}
                                </option>
                              ))}
                            </datalist>
                          </div>
                          {tierFields(adapter)
                            .filter(field => field !== 'model')
                            .map(field => (
                              <div key={field} className="sd-field">
                                <label className="sd-field__label" htmlFor={`${prefix}-${field}`}>
                                  {field === 'effort' ? 'Effort' : 'Way of working'}
                                </label>
                                <select
                                  id={`${prefix}-${field}`}
                                  className="sd-select"
                                  value={settings[field] ?? ''}
                                  onChange={event => setTier(tier, adapter.id, field, event.target.value)}
                                >
                                  <option value="">The agent&apos;s own</option>
                                  {(field === 'effort' ? (adapter.efforts ?? []) : offeredModes(adapter)).map(value => (
                                    <option key={value} value={value}>
                                      {field === 'mode' ? (modeLabels[value] ?? value) : value}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))}
          </section>
        )}
        <p className="sd-meta" style={{ margin: 0 }}>
          What each team and agent is told is in Instructions, with its own drafts. How each agent runs is on its page:
          an agent made in this project runs only here, and a shared one runs the same way in every project.
        </p>
        <div className="sd-editbar">
          {save.error ? (
            <p role="alert" className="sd-editbar__text" style={{ color: 'var(--bad)', fontWeight: 600 }}>
              {save.error.message}
            </p>
          ) : (
            <span className="sd-editbar__text sd-meta">Nothing changes until you save.</span>
          )}
          <button type="button" className="sd-btn sd-btn--ghost" disabled={busy} onClick={onDone}>
            Cancel
          </button>
          <button type="submit" className="sd-btn sd-btn--primary" disabled={busy}>
            Save the teams
          </button>
        </div>
      </form>
      <Dialog
        open={!!partWorker && !!partTeam}
        label={partWorker && partTeam ? `${agentName(partWorker)} in ${teamName(partTeam)}` : ''}
        onClose={() => setPart(null)}
      >
        {partWorker && partTeam && (
          <form
            className="sd-dialog__form"
            onSubmit={event => {
              event.preventDefault();
              setPart(null);
            }}
          >
            <h2 className="sd-dialog__title">
              {agentName(partWorker)} in {teamName(partTeam)}
            </h2>
            <PartFields
              worker={partWorker}
              member={draft.members[partWorker.id]!}
              roles={state.roles ?? []}
              onChange={(field, value) => setMember(partWorker.id, field, value)}
            />
            <div className="sd-dialog__actions">
              <button
                type="button"
                className="sd-btn sd-btn--ghost"
                onClick={() => {
                  place(partWorker.id, '');
                  setPart(null);
                }}
              >
                Take {agentName(partWorker)} off the team
              </button>
              <button type="submit" className="sd-btn sd-btn--primary">
                Done
              </button>
            </div>
          </form>
        )}
      </Dialog>
      <Dialog
        open={!!addingTeam}
        label={addingTeam ? `Add an agent to ${teamName(addingTeam)}` : ''}
        onClose={() => setAdding(null)}
      >
        {addingTeam && (
          <AgentPicker
            team={addingTeam}
            teams={draft.teams}
            agents={directory.filter(worker => draft.members[worker.id]?.teamId !== addingTeam.id)}
            members={draft.members}
            looks={looks}
            saved={(config.teams ?? []).some(team => team.id === addingTeam.id)}
            onPick={id => {
              place(id, addingTeam.id);
              setAdding(null);
            }}
            onNew={() => {
              setAdding(null);
              setMaking(addingTeam.id);
            }}
            onClose={() => setAdding(null)}
          />
        )}
      </Dialog>
      <Dialog
        open={!!makingTeam}
        label={makingTeam ? `A new agent for ${teamName(makingTeam)}` : ''}
        size="wide"
        onClose={() => setMaking(null)}
      >
        {makingTeam && (
          <NewAgent
            projectId={projectId}
            state={state}
            team={makingTeam}
            expectedRevision={draft.expectedRevision}
            onMade={({ worker, revision }, roles) => {
              // The agent is saved as the organization's next revision; the rest of the draft still waits.
              setMade(current => [...current, worker]);
              setDraft(current => ({
                ...current,
                expectedRevision: revision,
                members: {
                  ...current.members,
                  [worker.id]: {
                    teamId: makingTeam.id,
                    role: worker.jobTitle ?? '',
                    responsibility: worker.responsibility ?? '',
                    roles,
                  },
                },
              }));
              setMaking(null);
              toast(
                `${agentName(worker)} joined ${teamName(makingTeam)}. Your other changes still wait for you to save.`,
              );
            }}
            onClose={() => setMaking(null)}
          />
        )}
      </Dialog>
    </>
  );
}

// An agent's part in its team: its role, what it is responsible for, and the staffing roles a workflow step can ask
// for in place of an agent.
function PartFields({
  worker,
  member,
  roles,
  onChange,
}: {
  worker: Worker;
  member: MemberDraft;
  roles: { id: string; label?: string }[];
  onChange: (field: keyof MemberDraft, value: string) => void;
}) {
  return (
    <>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`member-${worker.id}-role`}>
          Role
        </label>
        <input
          id={`member-${worker.id}-role`}
          className="sd-input"
          value={member.role}
          required
          maxLength={160}
          onChange={event => onChange('role', event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`member-${worker.id}-responsibility`}>
          What {agentName(worker)} is responsible for
        </label>
        <textarea
          id={`member-${worker.id}-responsibility`}
          className="sd-textarea"
          value={member.responsibility}
          required
          maxLength={4000}
          onChange={event => onChange('responsibility', event.target.value)}
        />
      </div>
      <div className="sd-field">
        <label className="sd-field__label" htmlFor={`member-${worker.id}-roles`}>
          Staffing roles
        </label>
        <input
          id={`member-${worker.id}-roles`}
          className="sd-input"
          value={member.roles}
          list="staffing-roles"
          maxLength={2000}
          placeholder="For example: reviewer, engineer"
          onChange={event => onChange('roles', event.target.value)}
        />
        <datalist id="staffing-roles">
          {roles.map(role => (
            <option key={role.id} value={role.id}>
              {role.label}
            </option>
          ))}
        </datalist>
        <span className="sd-meta">
          Names a workflow step can ask for instead of an agent, such as reviewer. The studio picks an agent in this
          project holding the role, never the one whose work is being checked.
        </span>
      </div>
    </>
  );
}

// The agents to bring into a team: a new one that belongs to this project, or one the studio already has, from
// another team or from outside this project. A new agent joins a team that is saved, so a team added in this edit
// is saved first.
function AgentPicker({
  team,
  teams,
  agents,
  members,
  looks,
  saved,
  onPick,
  onNew,
  onClose,
}: {
  team: Team;
  teams: Team[];
  agents: Worker[];
  members: Record<string, MemberDraft>;
  looks: ReturnType<typeof useLooks>;
  saved: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sd-dialog__form">
      <h2 className="sd-dialog__title">Add an agent to {teamName(team)}</h2>
      <div className="sd-agentpick">
        <button
          type="button"
          className="sd-agentrow"
          disabled={!saved}
          style={saved ? undefined : { opacity: 0.6, cursor: 'default' }}
          onClick={onNew}
        >
          <span className="sd-agentrow__add" aria-hidden="true">
            <Icon name="plus" size={18} />
          </span>
          <span className="sd-agentrow__text">
            <b>New agent</b>
            <span className="sd-meta">
              {saved
                ? 'Made for this project: its name, CLI and instructions change nothing anywhere else'
                : 'Save the teams first, then make a new agent for this one'}
            </span>
          </span>
        </button>
      </div>
      {agents.length > 0 && <span className="sd-eyebrow">Agents the studio has</span>}
      {agents.length ? (
        <div className="sd-agentpick">
          {agents.map(worker => {
            const look = looks.get(worker.id),
              from = teams.find(item => item.id === members[worker.id]?.teamId);
            return (
              <button key={worker.id} type="button" className="sd-agentrow" onClick={() => onPick(worker.id)}>
                {look && <AgentAvatar look={look} size={40} ring={false} />}
                <span className="sd-agentrow__text">
                  <b>{agentName(worker)}</b>
                  <span className="sd-meta">
                    {from
                      ? `Moves from ${teamName(from)}`
                      : worker.projectId
                        ? 'Not on a team'
                        : 'Not in this project yet'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="sd-meta" style={{ margin: 0 }}>
          Every agent the studio has is already on this team.
        </p>
      )}
      <div className="sd-dialog__actions">
        <button type="button" className="sd-btn sd-btn--ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
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

// A new agent for one of the project's teams: its name, its job here, the CLI it runs on and what it is told. It is
// saved at once as the organization's next revision and belongs to this project; its face is the agent kit's until
// one is chosen on its page.
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
  onMade: (made: { worker: Worker; revision: number }, roles: string) => void;
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
    onSuccess: made => onMade(made, roleList(roles).join(', ')),
  });
  return (
    <form
      className="sd-dialog__form"
      onSubmit={event => {
        event.preventDefault();
        make.mutate();
      }}
    >
      <h2 className="sd-dialog__title">A new agent for {teamName(team)}</h2>
      <p className="sd-meta" style={{ margin: 0 }}>
        It belongs to {state.project.name}: its name, CLI and instructions change nothing in any other project.
      </p>
      <div className="sd-fieldgrid">
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
        <span className="sd-meta">The names a plan's steps can ask for, so the planner can give this agent work.</span>
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
          placeholder="Its own instructions, after the project's and its team's. Edit them later in Instructions."
          onChange={event => setInstructions(event.target.value)}
        />
      </div>
      {make.error && (
        <p role="alert" className="sd-meta" style={{ margin: 0, color: 'var(--bad)' }}>
          {make.error.message}
        </p>
      )}
      <div className="sd-dialog__actions">
        <button type="submit" className="sd-btn sd-btn--primary" disabled={make.isPending}>
          {make.isPending ? 'Making…' : 'Make the agent'}
        </button>
        <button type="button" className="sd-btn sd-btn--ghost" disabled={make.isPending} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
