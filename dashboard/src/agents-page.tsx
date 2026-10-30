// The agents (the canvas's Employees board, v1.0 item 23): how the work flows through the project's teams, from the
// project's own records, beside the picked agent's editor (agent-editor.tsx) or, with a team in the address, that
// team's editor (team-editor.tsx). The flow starts with the director sending an idea, goes through each team in its
// saved order with its agents as cards, and ends with the director integrating what passed review; below it, what the
// agents are told and the kinds of work the project does not take. An agent is a set of instructions and a CLI; it is
// not reserved, and runs several attempts at once, each its own process and record.
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { AttemptSummary, Team, Worker } from './api';
import { AgentEditor, isReview, kindLabel, kindOwners, runsOn, toldSets } from './agent-editor';
import { AgentAvatar } from './design/avatar';
import { agentState } from './faces';
import type { AgentLook } from './design/agent-kit.js';
import { Clapper, Icon } from './design/icons';
import { plural } from './evidence';
import { useStudio } from './records';
import { useTold } from './rules';
import type { StudioState } from './studio-runs';
import { TeamEditor } from './team-editor';
import { agentLooks } from './today';

// The team being edited, `new` for a new one, and whether its Add an agent starts open.
interface Editing {
  team?: string;
  adding?: boolean;
}

export function AgentsPage({ projectId, workerId, team, adding }: { projectId: string; workerId?: string } & Editing) {
  const { state, error } = useStudio(projectId);
  if (error) return <p role="alert">The project could not be loaded: {error.message}</p>;
  if (!state)
    return (
      <p role="status" className="sd-meta">
        Loading the agents…
      </p>
    );
  return <Agents projectId={projectId} state={state} workerId={workerId} team={team} adding={adding} />;
}

function Agents({
  projectId,
  state,
  workerId,
  team,
  adding,
}: { projectId: string; state: StudioState; workerId?: string } & Editing) {
  const looks = useMemo(
      () => agentLooks(projectId, [...state.workers, ...(state.employeeDirectory ?? [])]),
      [projectId, state.workers, state.employeeDirectory],
    ),
    workers = state.workers,
    // Without a choice in the address, the page opens on an agent at work, as the canvas does, else the first; with
    // a team in it, on that team's editor.
    chosen = team
      ? undefined
      : (workers.find(worker => worker.id === workerId) ??
        (workerId
          ? undefined
          : (workers.find(worker => agentState(state, worker.id) === 'working') ??
            workers.find(worker => worker.enabled !== false) ??
            workers[0])));
  // What they're told reads for the agent picked, else the first.
  const told = chosen ?? workers[0];
  return (
    <div className="sd-agentspage">
      <div className="sd-agents">
        <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Flow projectId={projectId} state={state} looks={looks} current={chosen?.id} />
          {told && <FlowTold projectId={projectId} worker={told} />}
          <NotInFlow state={state} />
        </div>
        {team ? (
          <TeamEditor
            // Another team, or Add an agent from the flow, opens the editor afresh.
            key={adding ? `${team}:add` : team}
            projectId={projectId}
            state={state}
            teamId={team}
            looks={looks}
            adding={!!adding}
          />
        ) : chosen ? (
          <AgentEditor
            key={chosen.id}
            projectId={projectId}
            state={state}
            worker={chosen}
            look={looks.get(chosen.id)}
          />
        ) : (
          <p role="status" className="sd-meta">
            This agent is not in the project.
          </p>
        )}
      </div>
    </div>
  );
}

// What the agent is running in this project, one line for each attempt in the order they started ("Working on: Build
// the board", "Reviewing: Write the guide"), or why it is not working.
function rowState(state: StudioState, worker: Worker) {
  const started = (attempt: AttemptSummary) => Date.parse(String(attempt.startedAt ?? '')) || 0,
    running = state.attempts
      .filter(item => item.workerId === worker.id && ['running', 'stopping'].includes(item.status))
      .sort((a, b) => started(a) - started(b));
  if (worker.enabled === false) return { tone: 'wait', lines: [{ key: 'off', text: 'No CLI connected' }] };
  if (running.length)
    return {
      tone: 'live',
      lines: running.map(attempt => ({
        key: attempt.id,
        text: `${isReview(attempt) ? 'Reviewing' : 'Working on'}: ${
          state.tasks.find(task => task.id === attempt.taskId)?.title ?? attempt.taskId
        }`,
      })),
    };
  if (worker.paused) return { tone: 'wait', lines: [{ key: 'paused', text: 'Paused' }] };
  return { tone: 'wait', lines: [{ key: 'free', text: 'Free' }] };
}

// Adding a team, adding an agent and editing a team open the team's editor beside the flow, the team in the address.
function EditTeam({
  projectId,
  team,
  adding = false,
  icon,
  children,
}: {
  projectId: string;
  team: string;
  adding?: boolean;
  icon: 'plus' | 'pencil';
  children: string;
}) {
  return (
    <Link
      className={`sd-btn sd-btn--sm${icon === 'pencil' ? ' sd-btn--ghost' : ''}`}
      to="/p/$projectId/agents"
      params={{ projectId }}
      search={adding ? { team, add: true } : { team }}
    >
      <Icon name={icon} size={16} />
      {children}
    </Link>
  );
}

const Arrow = () => (
  <span className="sd-pipe__arrow" aria-hidden="true" style={{ display: 'flex', paddingLeft: '14px' }}>
    <Icon name="down" size={18} weight={2.6} />
  </span>
);
const stepStyle = { display: 'flex', flexDirection: 'column', gap: 'var(--space-8)' } as const;

// The director's ends of the flow: sending an idea, and integrating what passed review.
function You({ does, first = false }: { does: string; first?: boolean }) {
  return (
    <li style={stepStyle}>
      {!first && <Arrow />}
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-10)' }}>
        <h2 className="sd-pipe__step sd-pipe__step--you" style={{ margin: 0 }}>
          <Clapper size={26} />
          You
        </h2>
        <span className="sd-meta">{does}</span>
      </span>
    </li>
  );
}

// How the work flows through the project: the director, each team in its saved order with its agents, the director.
function Flow({
  projectId,
  state,
  looks,
  current,
}: {
  projectId: string;
  state: StudioState;
  looks: Map<string, AgentLook>;
  current?: string;
}) {
  const teams = state.teams ?? [],
    owners = kindOwners(state);
  return (
    <section
      aria-labelledby="agents-title"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-14)' }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-10)',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <h1 id="agents-title" className="sd-sidecard__title" style={{ fontSize: '21px' }}>
            Agents
          </h1>
          <span className="sd-meta">How the work flows through {state.project.name}&apos;s teams</span>
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-8)' }}>
          <EditTeam projectId={projectId} team="new" icon="plus">
            Add a team
          </EditTeam>
          {/* An agent the studio has, or a new one, joins the project in one of its teams: the first one's Who's on
              it opens with Add an agent. */}
          <EditTeam projectId={projectId} team={teams[0]?.id ?? 'new'} adding icon="plus">
            Add an agent
          </EditTeam>
        </span>
      </div>
      <ol
        aria-label="How the work flows"
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-8)',
        }}
      >
        <You first does="Send an idea" />
        {teams.length ? (
          teams.map(team => (
            <FlowTeam
              key={team.id}
              projectId={projectId}
              state={state}
              team={team}
              looks={looks}
              owners={owners}
              current={current}
            />
          ))
        ) : (
          <li style={stepStyle}>
            <Arrow />
            <span className="sd-meta">
              {state.project.name} has no teams yet. Add a team, and its agents do the work between your idea and its
              integration.
            </span>
          </li>
        )}
        <You does="Integrate what passed review" />
      </ol>
    </section>
  );
}

// One team's step: its mark, name, purpose and lead, and its agents side by side.
function FlowTeam({
  projectId,
  state,
  team,
  looks,
  owners,
  current,
}: {
  projectId: string;
  state: StudioState;
  team: Team;
  looks: Map<string, AgentLook>;
  owners: Record<string, string>;
  current?: string;
}) {
  const members = state.workers.filter(worker =>
      worker.teamId ? worker.teamId === team.id : worker.team === team.name,
    ),
    lead = [...state.workers, ...(state.employeeDirectory ?? [])].find(worker => worker.id === team.leadId);
  return (
    <li style={stepStyle}>
      <Arrow />
      <section className="sd-card sd-teamcard" aria-labelledby={`flow-team-${team.id}`}>
        <div className="sd-teamcard__head">
          <span className="sd-teammark" aria-hidden="true">
            {team.mark || team.name.slice(0, 2).toUpperCase()}
          </span>
          <h2 id={`flow-team-${team.id}`} className="sd-teamcard__name">
            <Link to="/p/$projectId/agents/teams/$teamId" params={{ projectId, teamId: team.id }}>
              {team.name}
            </Link>
          </h2>
          <EditTeam projectId={projectId} team={team.id} icon="pencil">
            Edit the team
          </EditTeam>
        </div>
        {team.purpose && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{team.purpose}</p>}
        <span className="sd-meta">
          {team.leadId ? `Led by ${lead?.displayName ?? team.leadId}` : 'No one leads it yet.'}
        </span>
        {members.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-10)' }}>
            {members.map(worker => (
              <AgentCard
                key={worker.id}
                projectId={projectId}
                state={state}
                worker={worker}
                look={looks.get(worker.id)}
                does={Object.keys(owners)
                  .filter(kind => owners[kind] === worker.id)
                  .map(kind => kindLabel(state, kind))}
                current={worker.id === current}
              />
            ))}
          </div>
        ) : (
          <span className="sd-meta">No agents in this team yet.</span>
        )}
      </section>
    </li>
  );
}

// An agent in its team: what it does, what it runs on and whether it is free, a link to its page.
function AgentCard({
  projectId,
  state,
  worker,
  look,
  does,
  current,
}: {
  projectId: string;
  state: StudioState;
  worker: Worker;
  look?: AgentLook;
  does: string[];
  current: boolean;
}) {
  const now = rowState(state, worker);
  return (
    <Link
      className="sd-agentrow"
      aria-current={current ? 'page' : undefined}
      to="/p/$projectId/agents/$workerId"
      params={{ projectId, workerId: worker.id }}
      style={{
        flex: '1 1 200px',
        minWidth: 0,
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 'var(--space-6)',
        border: '1.5px solid var(--line)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {look && <AgentAvatar look={look} size={40} state={agentState(state, worker.id)} ring={false} />}
        <span className="sd-agentrow__text">
          <b>{worker.displayName ?? worker.id}</b>
          {worker.jobTitle && <span className="sd-meta">{worker.jobTitle}</span>}
        </span>
      </span>
      <span className="sd-meta">Does: {does.length ? does.join(', ') : 'no kind of work of its own'}</span>
      {worker.enabled !== false && <span className="sd-meta">Runs on: {runsOn(state, worker)}</span>}
      {/* Plain text, one line each: the card is a link to the agent, so its running work is not a link of its own. */}
      {now.lines.map(line => (
        <span
          key={line.key}
          className="sd-meta"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-6)' }}
        >
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              flex: 'none',
              background: now.tone === 'live' ? 'var(--live-dot)' : 'var(--wait-dot)',
            }}
          ></span>
          {line.text}
        </span>
      ))}
    </Link>
  );
}

// What the agents are told, for the one picked: the project's rules, its team's and its own, with how many each
// holds as published.
function FlowTold({ projectId, worker }: { projectId: string; worker: Worker }) {
  const { data: view, error } = useTold(projectId, worker.id),
    name = worker.displayName ?? worker.id;
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="flow-told"
      style={{ gap: 'var(--space-10)' }}
    >
      <h2 id="flow-told" className="sd-sidecard__title">
        What they&apos;re told
      </h2>
      {view ? (
        <>
          <span className="sd-meta">What {view.agent.name} reads with each piece of work:</span>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-6)',
            }}
          >
            {toldSets.map(([layer, label]) => {
              const set = view.layers.find(item => item.layer === layer);
              return (
                set && (
                  <li key={layer} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-8)' }}>
                    <span>{label(view)}</span>
                    <span className="sd-meta">
                      {set.rules.length} {plural(set.rules.length, 'rule')}
                      {set.draft?.current ? ' · a draft waits' : ''}
                    </span>
                  </li>
                )
              );
            })}
          </ul>
        </>
      ) : (
        <span className="sd-meta">
          {error
            ? error.message
            : view === null
              ? `${name} is not in this project's records.`
              : "Reading what they're told…"}
        </span>
      )}
      <Link
        className="sd-btn sd-btn--sm"
        style={{ alignSelf: 'flex-start' }}
        to="/p/$projectId/agents/instructions"
        params={{ projectId }}
      >
        Open the rules
      </Link>
    </section>
  );
}

// The kinds of work the studio has that the project does not take, so no agent in the flow is given them. A project
// still on the shared organization takes every kind.
function NotInFlow({ state }: { state: StudioState }) {
  const takes = state.organizationConfiguration?.taskKinds,
    outside = takes ? Object.keys(state.taskKinds).filter(kind => !takes.includes(kind)) : [];
  return (
    <section
      className="sd-card sd-sidecard sd-sidecard--roomy"
      aria-labelledby="flow-outside"
      style={{ gap: 'var(--space-10)' }}
    >
      <h2 id="flow-outside" className="sd-sidecard__title">
        Not in this flow
      </h2>
      {outside.length ? (
        <>
          <span className="sd-meta">
            The studio has these kinds of work, and {state.project.name} does not take them. Each is turned on from an
            agent&apos;s Does list.
          </span>
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'var(--space-6)',
            }}
          >
            {outside.map(kind => (
              <li key={kind} className="sd-chip">
                {kindLabel(state, kind)}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <span className="sd-meta">{state.project.name} takes every kind of work the studio has.</span>
      )}
    </section>
  );
}
