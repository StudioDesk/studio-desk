// The teams (v1.0 item 23; the canvas has no board for them, so they are built in the redesign's language): the
// project's teams as cards with their agents' faces, and a team's own page with its goal, its agents and its work.
// Edit the teams opens a team's editor beside the flow on the Agents page (team-editor.tsx), one team at a time; the
// kinds of work are given from an agent's Does list, and the model tiers are in Settings, under Command-line tools.
// A team groups agents; it grants no tools.
import { Link, Navigate } from '@tanstack/react-router';
import { useMemo, type ReactNode } from 'react';
import type { PeopleSummary, Task, Team, Worker } from './api';
import type { AgentLook } from './design/agent-kit.js';
import { AgentAvatar } from './design/avatar';
import { Icon } from './design/icons';
import { agentState } from './faces';
import { Heading } from './layout';
import { usePeople, useSettled, useStudio } from './records';
import { active, liveSummary, type StudioState } from './studio-runs';
import { TaskRow } from './task-row';
import { agentLooks } from './today';

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

// Edit the teams, and the address that opened it (?edit=true), lead to the team editor beside the flow: the first
// team's, or a new team's while the project has none.
const editTeam = (projectId: string, teamId: string) => ({
  to: '/p/$projectId/agents' as const,
  params: { projectId },
  search: { team: teamId },
});

export function TeamsPage({ projectId, editing }: { projectId: string; editing: boolean }) {
  const { state, error } = useStudio(projectId),
    { data: people } = usePeople(projectId),
    looks = useLooks(projectId, state),
    first = state?.teams?.[0]?.id ?? 'new';
  if (state && editing) return <Navigate {...editTeam(projectId, first)} replace />;
  return (
    <div className="sd-orgpage">
      <Heading
        crumbs={[agentsCrumb(projectId)]}
        here="Teams"
        title="Teams"
        lead="Each team has a purpose and a goal, and its agents do the work. A team groups agents; it grants them nothing."
        tools={
          state && (
            <Link className="sd-btn sd-btn--sm" {...editTeam(projectId, first)}>
              <Icon name="pencil" size={16} />
              Edit the teams
            </Link>
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
            <Link className="sd-btn sd-btn--sm" {...editTeam(projectId, team.id)}>
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
