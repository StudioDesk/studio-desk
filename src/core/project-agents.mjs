// Agents that belong to a project (1.0.1; the director, October 25: "Managing agents per project (adding, deleting,
// and editing) is a key feature"). An agent made in a project works only there, so its name, CLI, face and
// instructions change nothing in any other project. The studio's starting agents stay shared by every project.
// Deleting an agent takes it out of its project's teams and keeps its record, so the work it did still names it.
import { randomUUID } from 'node:crypto';
import { applyWorkerExecution } from './execution.mjs';
import { organizationConfiguration, saveProjectOrganization } from './project-organization.mjs';
import { validateRoleList } from './staffing.mjs';

const key = id => 'project-organization:' + id,
  live = ['starting', 'running', 'stopping', 'quarantined'],
  faceParts = ['body', 'color', 'eyes', 'mouth', 'top', 'detail'];

// Whether a project sees an agent: a shared one, or one of its own, either way not deleted.
export const seenBy = (worker, projectId) => !worker.deletedAt && (!worker.projectId || worker.projectId === projectId);
// The studio's shared agents, the ones a new project's team is made from.
export const sharedAgents = org => ({
  ...org,
  workers: org.workers.filter(worker => !worker.projectId && !worker.deletedAt),
});
// What a project's records can name: shared agents and its own, deleted ones included so old work keeps its names.
export const directoryFor = (org, projectId) =>
  org.workers.filter(worker => !worker.projectId || worker.projectId === projectId);

// A face is six part numbers from 0 to 9, or null for the one the agent kit picks.
export function validFace(look) {
  if (
    look !== null &&
    (!look ||
      typeof look !== 'object' ||
      Array.isArray(look) ||
      Object.keys(look).length !== faceParts.length ||
      faceParts.some(part => !Number.isInteger(look[part]) || look[part] < 0 || look[part] > 9))
  )
    throw new Error('A face is six part numbers from 0 to 9: body, color, eyes, mouth, top and detail.');
  return look === null ? null : Object.fromEntries(faceParts.map(part => [part, look[part]]));
}

// A name the director can tell apart: distinct among the agents every project that sees this one also sees. A
// shared agent is seen everywhere, so its name is checked against every agent; a project's own, against that
// project's.
export function agentName(org, value, { projectId, except } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40)
    throw new Error('Give the agent a name of at most 40 characters.');
  const name = value.trim(),
    clash = org.workers.find(
      worker =>
        worker.id !== except &&
        !worker.deletedAt &&
        (projectId === undefined || seenBy(worker, projectId)) &&
        (worker.displayName ?? '').toLowerCase() === name.toLowerCase(),
    );
  if (clash) throw new Error(`There is already an agent named ${clash.displayName}. Choose another name.`);
  return name;
}

// Text the director gives; a blank optional field takes its fallback.
function text(value, label, max, fallback) {
  const blank = value === undefined || (typeof value === 'string' && !value.trim());
  if (blank && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} is missing or too long.`);
  return value.trim();
}

// The project's saved organization, in the shape its save takes, so an agent joins or leaves it as a new revision.
function savedShape(store, projectId) {
  const config = organizationConfiguration(store, projectId);
  if (config.inherited) throw new Error("Save this project's teams once before changing its agents.");
  return {
    config,
    teams: config.teams.map(({ id, name, mark, purpose, goal, outcome, leadId }) => ({
      id,
      name,
      mark,
      purpose,
      goal,
      outcome,
      leadId,
    })),
  };
}

// POST /api/projects/:id/agents: a new agent in one of the project's teams, with its CLI, face and first
// instructions, saved as the project's next organization revision. Returns { worker, revision }.
export function createProjectAgent(store, registries, projectId, data) {
  const takes = [
    'projectId',
    'expectedRevision',
    'displayName',
    'jobTitle',
    'responsibility',
    'teamId',
    'roles',
    'provider',
    'model',
    'effort',
    'mode',
    'look',
    'instructions',
  ];
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).some(field => !takes.includes(field))
  )
    throw new Error('A new agent takes its name, job title, team, CLI and, optionally, its face and instructions.');
  store.project(projectId);
  const { config, teams } = savedShape(store, projectId);
  if (data.expectedRevision !== config.revision)
    throw new Error('Project organization changed. Refresh before saving.');
  const org = store.organization(),
    team = config.teams.find(item => item.id === data.teamId);
  if (!team) throw new Error("Choose one of this project's teams for the agent.");
  const displayName = agentName(org, data.displayName, { projectId }),
    jobTitle = text(data.jobTitle, 'Job title', 160),
    responsibility = text(
      data.responsibility,
      'What the agent is responsible for',
      4000,
      'Does the work this project gives it and hands its files and summary on.',
    ),
    roles = data.roles === undefined ? [] : validateRoleList(data.roles, 'Staffing roles'),
    look = data.look === undefined ? null : validFace(data.look),
    instructions = text(
      data.instructions,
      'Instructions',
      48000,
      `${jobTitle}: ${responsibility}\nUse only the recorded assignment scope and controller-granted tools. Submit results for validation and director acceptance.`,
    );
  if (typeof data.provider !== 'string' || !data.provider) throw new Error('Choose the CLI the agent runs on.');
  let id;
  do id = 'W-' + randomUUID().slice(0, 8);
  while (org.workers.some(worker => worker.id === id));
  const worker = {
    id,
    name: jobTitle,
    team: team.name,
    cli: '',
    role: jobTitle,
    model: '',
    workspace: 'Per-attempt output folder',
    tools: ['Private assignment files'],
    paused: false,
    displayName,
    jobTitle,
    responsibility,
    provider: '',
    enabled: true,
    configVersion: 1,
    projectId,
    createdAt: new Date().toISOString(),
  };
  // Its CLI is checked as an agent's page checks a change of CLI; the label is that CLI's name.
  applyWorkerExecution(registries.adapters, worker, {
    provider: data.provider,
    model: data.model ?? '',
    effort: data.effort ?? '',
    mode: data.mode ?? '',
  });
  worker.cli = registries.adapters.get(worker.provider).name;
  if (look) worker.look = look;
  let saved;
  store.tx(() => {
    store.setOrganization({ ...org, workers: [...org.workers, worker] });
    saved = saveProjectOrganization(
      store,
      registries,
      projectId,
      {
        expectedRevision: config.revision,
        teams,
        members: [
          ...config.members,
          { workerId: id, teamId: team.id, role: jobTitle, responsibility, ...(roles.length ? { roles } : {}) },
        ],
        taskKinds: [...config.taskKinds],
        kindOwners: structuredClone(config.kindOwners || {}),
      },
      true,
    );
    // Its first instructions are revision 1 of its own document in this project.
    const doc = saved.instructions.employees[id];
    doc.text = instructions;
    doc.history = [{ ...doc.history[0], text: instructions, note: 'Its first instructions' }];
    store.putSetting(key(projectId), saved);
    store.event('agent_created', null, null, `${displayName} joined ${team.name} as ${jobTitle}.`, projectId);
  });
  return { worker, revision: saved.revision };
}

// POST /api/projects/:id/agents/:workerId/delete: one of the project's own agents leaves its teams for good. It is
// refused while the agent runs, holds a resource or has open work, and for the project's last agent. The record
// stays, so the work it did still names it.
export function deleteProjectAgent(store, registries, projectId, workerId, data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Object.keys(data).some(field => !['projectId', 'expectedRevision'].includes(field))
  )
    throw new Error("Deleting an agent takes the project's organization revision.");
  store.project(projectId);
  const org = store.organization(),
    worker = org.workers.find(item => item.id === workerId && !item.deletedAt);
  if (!worker) throw Object.assign(new Error('There is no such agent.'), { status: 404 });
  const name = worker.displayName ?? worker.id;
  if (!worker.projectId)
    throw new Error(`${name} is shared by every project. Take ${name} off this project's teams instead.`);
  if (worker.projectId !== projectId) throw new Error(`${name} belongs to another project.`);
  const { config, teams } = savedShape(store, projectId);
  if (data.expectedRevision !== config.revision)
    throw new Error('Project organization changed. Refresh before saving.');
  const attempts = store.allAttempts().filter(attempt => attempt.workerId === workerId);
  if (
    attempts.some(
      attempt =>
        live.includes(attempt.status) ||
        (['interrupted', 'uncertain'].includes(attempt.status) && !attempt.reconciledAt),
    )
  )
    throw new Error(`${name} is working. Let the run finish, or stop it, before deleting ${name}.`);
  const ids = new Set(attempts.map(attempt => attempt.id));
  if (store.leases().some(lease => ids.has(lease.attemptId)))
    throw new Error(`${name} still holds a resource. Wait for its work to finish before deleting ${name}.`);
  const open = store
    .tasks()
    .filter(task => task.workerId === workerId && !['done', 'denied'].includes(task.status) && !task.closed);
  if (open.length)
    throw new Error(
      `${name} still has ${open.length === 1 ? 'a task' : `${open.length} tasks`} open: ${open
        .slice(0, 3)
        .map(task => task.title)
        .join('; ')}${open.length > 3 ? '; …' : ''}. Close ${open.length === 1 ? 'it' : 'them'} or let ${
        open.length === 1 ? 'it' : 'them'
      } finish first.`,
    );
  const members = config.members.filter(member => member.workerId !== workerId);
  if (!members.length) throw new Error(`${name} is this project's only agent. Add another before deleting ${name}.`);
  let saved;
  store.tx(() => {
    store.setOrganization({
      ...org,
      workers: org.workers.map(item =>
        item.id === workerId ? { ...item, enabled: false, deletedAt: new Date().toISOString() } : item,
      ),
    });
    saved = saveProjectOrganization(
      store,
      registries,
      projectId,
      {
        expectedRevision: config.revision,
        teams: teams.map(team => (team.leadId === workerId ? { ...team, leadId: null } : team)),
        members,
        taskKinds: [...config.taskKinds],
        kindOwners: Object.fromEntries(
          Object.entries(config.kindOwners || {}).filter(([, owner]) => owner !== workerId),
        ),
      },
      true,
    );
    store.event('agent_deleted', null, null, `${name} was deleted. The work ${name} did keeps its name.`, projectId);
  });
  return { deleted: workerId, revision: saved.revision };
}
