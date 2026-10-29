// Whole organization saves for the editors that each change one part of a project's organization. The controller
// (saveProjectOrganization in src/core/project-organization.mjs) refuses a save without teams, members or taskKinds
// and kindOwners that are not enabled members, and keeps the saved tiers and member roles only when they are left
// out; so every change starts from the saved organization's whole body, changes one part and sends all of it.
import { useMutation } from '@tanstack/react-query';
import { send, type Member, type Team, type Tiers, type Worker } from './api';
import type { StudioState } from './studio-runs';

export type OrganizationTeam = Omit<Team, 'goalTaskIds'>;
export type OrganizationMember = Required<Omit<Member, 'teamId'>> & { teamId: string };
export interface OrganizationBody {
  expectedRevision: number;
  teams: OrganizationTeam[];
  members: OrganizationMember[];
  taskKinds: string[];
  kindOwners: Record<string, string>;
  // Left out, the saved tiers stay; an empty object clears them.
  tiers?: Tiers;
}

// The agents the project can have, without deleted ones, as Edit the teams lists them.
const directoryOf = (state: StudioState): Worker[] =>
  (state.employeeDirectory?.length ? state.employeeDirectory : state.workers).filter(worker => !worker.deletedAt);

// A team's goal work is the controller's to keep: a save sends the team's own fields only.
const teamFields = ({ id, name, mark, purpose, goal, outcome, leadId }: Team): OrganizationTeam => ({
  id,
  name,
  mark,
  purpose,
  goal,
  outcome,
  leadId: leadId || null,
});

// A kind of work keeps its default agent only while that agent is still in the project.
const ownedByMembers = (kindOwners: Record<string, string>, members: OrganizationMember[]) =>
  Object.fromEntries(
    Object.entries(kindOwners).filter(([, owner]) => members.some(member => member.workerId === owner)),
  );

// The saved organization as Edit the teams sends it unchanged: every agent in a team with its part, the kinds of work
// the project takes and their default agents (enabled members only), and no tiers, so the saved ones stay.
export function organizationBody(state: StudioState): OrganizationBody {
  const config = state.organizationConfiguration ?? {},
    directory = directoryOf(state);
  const members = directory.flatMap(worker => {
    const member = config.members?.find(item => item.workerId === worker.id);
    return member?.teamId
      ? [
          {
            workerId: worker.id,
            teamId: member.teamId,
            role: member.role ?? 'Project contributor',
            responsibility:
              member.responsibility ?? 'Perform bounded project work and submit evidence for director review.',
            roles: [...new Set(member.roles ?? [])],
          },
        ]
      : [];
  });
  const taskKinds = config.taskKinds ?? Object.keys(state.taskKinds),
    kindOwners = config.kindOwners ?? {},
    enabled = (id: string | undefined) =>
      !!id && members.some(member => member.workerId === id) && !!directory.find(worker => worker.id === id)?.enabled;
  return {
    expectedRevision: config.revision ?? 0,
    teams: (config.teams ?? []).map(teamFields),
    members,
    taskKinds,
    kindOwners: Object.fromEntries(
      taskKinds.filter(kind => enabled(kindOwners[kind])).map(kind => [kind, kindOwners[kind]!]),
    ),
  };
}

// Gives a kind of work to an agent: the project takes it from now on if it did not, and the agent is its default.
export const giveKind = (body: OrganizationBody, kind: string, workerId: string): OrganizationBody => ({
  ...body,
  taskKinds: body.taskKinds.includes(kind) ? body.taskKinds : [...body.taskKinds, kind],
  kindOwners: { ...body.kindOwners, [kind]: workerId },
});

// Replaces a team's fields and its agents with their parts. An agent is in one team of a project, so one brought in
// leaves its other team and that team's lead; one left out leaves the project with its kinds of work; and the lead
// stays only while it is one of the team's agents.
export function replaceTeam(
  body: OrganizationBody,
  team: Team,
  members: Omit<OrganizationMember, 'teamId'>[],
): OrganizationBody {
  const joining = new Set(members.map(member => member.workerId)),
    next = [
      ...body.members.filter(member => member.teamId !== team.id && !joining.has(member.workerId)),
      ...members.map(member => ({ ...member, teamId: team.id })),
    ],
    replaced = teamFields(team);
  if (replaced.leadId && !joining.has(replaced.leadId)) replaced.leadId = null;
  return {
    ...body,
    teams: body.teams.map(item =>
      item.id === team.id ? replaced : item.leadId && joining.has(item.leadId) ? { ...item, leadId: null } : item,
    ),
    members: next,
    kindOwners: ownedByMembers(body.kindOwners, next),
  };
}

// Adds a team with no agents yet, so with no lead.
export const addTeam = (body: OrganizationBody, team: Team): OrganizationBody => ({
  ...body,
  teams: [...body.teams, { ...teamFields(team), leadId: null }],
});

// A team's agents leave the project's organization with it, and their kinds of work go back to being chosen each
// time.
export function removeTeam(body: OrganizationBody, teamId: string): OrganizationBody {
  const members = body.members.filter(member => member.teamId !== teamId);
  return {
    ...body,
    teams: body.teams
      .filter(team => team.id !== teamId)
      .map(team =>
        team.leadId && !members.some(member => member.workerId === team.leadId) ? { ...team, leadId: null } : team,
      ),
    members,
    kindOwners: ownedByMembers(body.kindOwners, members),
  };
}

// Sets the model tiers as Edit the teams saves them: each field trimmed, and an empty field, a CLI with no fields
// and a tier with no CLIs left out. An empty result clears the saved tiers.
export function setTiers(body: OrganizationBody, tiers: Tiers): OrganizationBody {
  const cleaned: Tiers = {};
  for (const [tier, providers] of Object.entries(tiers)) {
    for (const [provider, fields] of Object.entries(providers)) {
      const settings = Object.fromEntries(
        Object.entries(fields)
          .map(([field, value]) => [field, value?.trim() ?? ''] as const)
          .filter(([, value]) => value),
      );
      if (Object.keys(settings).length) (cleaned[tier] ??= {})[provider] = settings;
    }
  }
  return { ...body, tiers: cleaned };
}

// Saves a whole organization as the project's next revision; the controller's change event brings the new one in.
export function useSaveOrganization(projectId: string) {
  return useMutation({
    mutationFn: (body: OrganizationBody) =>
      send(`/api/projects/${encodeURIComponent(projectId)}/organization`, { projectId, ...body }, 'PATCH'),
  });
}
