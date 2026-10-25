import { recordProject } from './projects.mjs';
import { validateRoleList } from './staffing.mjs';
import { validateTierSettings } from './execution.mjs';

const key = id => 'project-organization:' + id;
const clone = value => structuredClone(value);
function fields(value, allowed) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(field => !allowed.includes(field))
  )
    throw new Error('Unsupported project organization fields.');
}
function text(value, label, max = 4000, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error(`${label} is missing or too long.`);
  return value.trim();
}
function document(scope, id, content) {
  const publishedAt = new Date().toISOString();
  return {
    scope,
    id,
    revision: 1,
    text: content,
    publishedAt,
    draft: null,
    history: [{ revision: 1, text: content, publishedAt, note: 'Initial project instructions' }],
  };
}
export function projectOrganization(store, projectId) {
  const org = store.organization(),
    project = store.project(projectId),
    config = store.setting(key(projectId));
  if (!config) return org;
  const workers = config.members.map(member => {
    const worker = org.workers.find(worker => worker.id === member.workerId),
      team = config.teams.find(team => team.id === member.teamId);
    return {
      ...worker,
      teamId: team.id,
      team: team.name,
      role: member.role,
      jobTitle: member.role,
      responsibility: member.responsibility,
      roles: [...(member.roles || [])],
    };
  });
  return {
    ...org,
    company: {
      ...org.company,
      name: project.name,
      mission: project.goal,
      milestone: project.goal,
      outcome: project.direction,
      goalTaskIds: [],
    },
    teams: clone(config.teams),
    workers,
    instructions: clone(config.instructions),
    sharedCompanyInstructions: org.instructions.company,
    projectOrganization: { projectId, revision: config.revision },
    kindOwners: clone(config.kindOwners),
    taskKinds: [...config.taskKinds],
    tiers: clone(config.tiers || {}),
  };
}
export function projectCatalog(store, registries, projectId) {
  const configured = store.setting(key(projectId));
  return registries.workflows
    .list()
    .filter(definition => !configured || configured.taskKinds.includes(definition.kind));
}
export function assertProjectKind(store, registries, projectId, kind) {
  registries.workflows.get(kind);
  if (!projectCatalog(store, registries, projectId).some(definition => definition.kind === kind))
    throw new Error('This task type is not enabled for the selected project. Configure its task types first.');
}
export function organizationConfiguration(store, projectId) {
  const saved = store.setting(key(projectId));
  if (saved) return saved;
  const org = store.organization();
  return {
    revision: 0,
    inherited: true,
    teams: clone(org.teams),
    // Only the shared agents: one that belongs to a project never joins another (1.0.1).
    members: org.workers
      .filter(worker => !worker.projectId && !worker.deletedAt)
      .map(worker => ({
        workerId: worker.id,
        teamId: org.teams.find(team => team.name === worker.team).id,
        role: worker.jobTitle || worker.role,
        responsibility: worker.responsibility,
      })),
    taskKinds: null,
    kindOwners: {},
  };
}
export function saveProjectOrganization(store, registries, projectId, data, withinTransaction = false) {
  store.project(projectId);
  fields(data, ['expectedRevision', 'teams', 'members', 'taskKinds', 'kindOwners', 'tiers']);
  const previous = store.setting(key(projectId));
  if (data.expectedRevision !== (previous?.revision || 0))
    throw new Error('Project organization changed. Refresh before saving.');
  if (
    !Array.isArray(data.teams) ||
    !data.teams.length ||
    data.teams.length > 30 ||
    !Array.isArray(data.members) ||
    !data.members.length ||
    data.members.length > 100
  )
    throw new Error('Choose 1 to 30 teams and 1 to 100 existing employees.');
  const ids = new Set(),
    names = new Set(),
    org = store.organization();
  const teams = data.teams.map(team => {
    fields(team, ['id', 'name', 'mark', 'purpose', 'goal', 'outcome', 'leadId']);
    if (
      typeof team.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(team.id) ||
      ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(team.id) ||
      ids.has(team.id)
    )
      throw new Error('Team identities must be unique safe identifiers.');
    const name = text(team.name, 'Team name', 100, true);
    if (names.has(name.toLowerCase())) throw new Error('Team names must be distinct.');
    ids.add(team.id);
    names.add(name.toLowerCase());
    return {
      id: team.id,
      name,
      mark: text(team.mark || name.slice(0, 2).toUpperCase(), 'Team mark', 8),
      purpose: text(team.purpose || '', 'Team purpose'),
      goal: text(team.goal || '', 'Team goal'),
      outcome: text(team.outcome || '', 'Team outcome'),
      leadId: team.leadId || null,
      goalTaskIds: previous?.teams.find(item => item.id === team.id)?.goalTaskIds || [],
    };
  });
  const employees = new Set();
  const members = data.members.map(member => {
    fields(member, ['workerId', 'teamId', 'role', 'responsibility', 'roles']);
    const worker = org.workers.find(item => item.id === member.workerId);
    if (!worker || worker.deletedAt || employees.has(member.workerId) || !ids.has(member.teamId))
      throw new Error('Each project member must be one existing employee in one selected team.');
    // An agent made in a project works only there (1.0.1).
    if (worker.projectId && worker.projectId !== projectId)
      throw new Error(`${worker.displayName ?? worker.id} belongs to another project.`);
    employees.add(member.workerId);
    // Staffing roles are stable IDs that nodes name (MP-015). An editor that omits them keeps
    // the member's saved roles; an empty list clears them.
    const roles =
      member.roles === undefined
        ? previous?.members.find(saved => saved.workerId === member.workerId)?.roles || []
        : validateRoleList(member.roles, 'Member staffing roles');
    return {
      workerId: member.workerId,
      teamId: member.teamId,
      role: text(member.role, 'Project role', 160, true),
      responsibility: text(member.responsibility, 'Project responsibility', 4000, true),
      ...(roles.length ? { roles } : {}),
    };
  });
  for (const team of teams)
    if (team.leadId !== null && !members.some(member => member.workerId === team.leadId && member.teamId === team.id))
      throw new Error('A team lead must belong to that project team.');
  if (
    !Array.isArray(data.taskKinds) ||
    !data.taskKinds.length ||
    data.taskKinds.length > 100 ||
    new Set(data.taskKinds).size !== data.taskKinds.length
  )
    throw new Error('Choose distinct registered task types for this project.');
  data.taskKinds.forEach(kind => registries.workflows.get(kind));
  fields(data.kindOwners || {}, data.taskKinds);
  for (const owner of Object.values(data.kindOwners || {}))
    if (!members.some(member => member.workerId === owner && org.workers.find(worker => worker.id === owner).enabled))
      throw new Error('Default task owners must be enabled project members.');
  // Model tier settings for future attempts. An editor that omits them keeps the saved settings.
  const tiers =
    data.tiers === undefined ? clone(previous?.tiers || {}) : validateTierSettings(registries.adapters, data.tiers);
  const instructions = previous
    ? clone(previous.instructions)
    : {
        company: document(
          'company',
          'company',
          'Work toward this project’s recorded goal and direction. Propose bounded, evidence-based work for director approval. The controller owns dispatch, permissions, reservations and acceptance.',
        ),
        teams: {},
        employees: {},
      };
  for (const team of teams)
    instructions.teams[team.id] ||= document(
      'team',
      team.id,
      `${team.name}: ${team.purpose || 'Coordinate bounded project work.'}\nGoal: ${team.goal}\nReturn validated artifacts and surface blockers to the director. Team membership does not grant tool permissions.`,
    );
  for (const member of members)
    instructions.employees[member.workerId] ||= document(
      'employee',
      member.workerId,
      `${member.role}: ${member.responsibility}\nUse only the recorded assignment scope and controller-granted tools. Submit results for validation and director acceptance.`,
    );
  for (const doc of [
    instructions.company,
    ...Object.values(instructions.teams),
    ...Object.values(instructions.employees),
  ])
    doc.projectId = projectId;
  const config = {
    revision: (previous?.revision || 0) + 1,
    teams,
    members,
    taskKinds: [...data.taskKinds],
    kindOwners: clone(data.kindOwners || {}),
    ...(Object.keys(tiers).length ? { tiers } : {}),
    instructions,
    history: [
      ...(previous?.history || []),
      {
        revision: (previous?.revision || 0) + 1,
        teams: clone(teams),
        members: clone(members),
        taskKinds: [...data.taskKinds],
        kindOwners: clone(data.kindOwners || {}),
        ...(Object.keys(tiers).length ? { tiers: clone(tiers) } : {}),
        savedAt: new Date().toISOString(),
      },
    ],
  };
  const commit = () => {
    store.putSetting(key(projectId), config);
    const effective = projectOrganization(store, projectId);
    // The director's membership edit changes future organization context, not
    // the selected employee, work scope, approval or any recorded attempt.
    for (const task of store
      .tasks()
      .filter(
        task =>
          recordProject(task) === projectId &&
          !['done', 'denied'].includes(task.status) &&
          !store.attempts(task.id).length,
      )) {
      const worker = effective.workers.find(worker => worker.id === task.workerId);
      if (!worker) continue;
      updateUnstartedOwner(task, worker, effective.projectOrganization);
      store.putTask(task);
    }
  };
  if (withinTransaction) commit();
  else store.tx(commit);
  store.event(
    'project_organization_updated',
    null,
    null,
    'Project teams, roles and task types saved. Unstarted assignments follow their selected employee’s project team; work scopes, decisions and recorded attempts are preserved.',
    projectId,
  );
  return config;
}
function updateUnstartedOwner(task, worker, organization) {
  if (
    task.team !== worker.team ||
    task.workerId !== worker.id ||
    task.proposedConfiguration?.teamId !== worker.teamId
  ) {
    task.ownerHistory = [
      ...(task.ownerHistory || []),
      {
        workerId: task.workerId,
        team: task.team,
        proposedConfiguration: task.proposedConfiguration,
        changedAt: new Date().toISOString(),
        reason: 'Director updated project ownership',
      },
    ];
  }
  task.workerId = worker.id;
  task.team = worker.team;
  task.teamId = worker.teamId;
  if (task.proposedConfiguration)
    task.proposedConfiguration = { ...task.proposedConfiguration, team: worker.team, teamId: worker.teamId };
  task.organizationReference = organization;
}
export function reassignProjectDraft(store, registries, task, workerId) {
  if (task.status !== 'backlog' || task.approval?.status !== 'pending' || store.attempts(task.id).length)
    throw new Error('Only undecided, unstarted Planned work can change project owner.');
  const org = projectOrganization(store, recordProject(task)),
    worker = org.workers.find(worker => worker.id === workerId && worker.enabled);
  assertProjectKind(store, registries, recordProject(task), task.kind);
  if (!worker) throw new Error('Choose an enabled employee in this project.');
  updateUnstartedOwner(task, worker, org.projectOrganization);
  if (task.proposedConfiguration)
    task.proposedConfiguration = {
      team: worker.team,
      teamId: worker.teamId,
      provider: worker.provider,
      model: worker.model || '',
    };
  store.putTask(task);
  store.event(
    'project_owner_updated',
    task.id,
    null,
    'Director changed the Planned task’s project owner; approval is still pending.',
  );
  return task;
}
export function saveProjectInstructions(store, projectId, org) {
  const config = store.setting(key(projectId));
  if (!config) return store.setOrganization(org);
  config.instructions = org.instructions;
  store.putSetting(key(projectId), config);
}

// A project for work that is not code starts with a team that takes ideas from its New idea box (v1.0 criterion 6,
// found in the README-only fresh install, where it had no planner and so no idea box): a planner, the agents who
// do the steps and an independent reviewer, with the general planning, work and review types. The planner and the
// reviewer are the agents titled so, or else the first and the last enabled agent; every other one does the work.
// With fewer than three enabled agents, or without the general types, it keeps the plain team it always had.
const generalKinds = ['general:plan', 'general:work', 'general:review'],
  slug = title =>
    String(title ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
export function genericProjectConfiguration(org, registries) {
  const enabled = org.workers.filter(worker => worker.enabled),
    titled = pattern => enabled.find(worker => pattern.test(worker.jobTitle ?? '')),
    planner = titled(/plan|product owner|producer/i) ?? enabled[0],
    reviewer = [titled(/review/i), enabled.at(-1)].find(worker => worker && worker !== planner),
    doers = enabled.filter(worker => worker !== planner && worker !== reviewer),
    team = { id: 'project-team', name: 'Project team', purpose: 'Deliver bounded work for this project.' };
  // The plain general type, for work the director assigns by hand, stays in either catalog.
  const plain = registries.workflows
    .list()
    .filter(definition => definition.kind === 'general')
    .map(definition => definition.kind);
  if (!doers.length || !generalKinds.every(kind => registries.workflows.find(kind)))
    return {
      expectedRevision: 0,
      teams: [team],
      members: enabled.map(worker => ({
        workerId: worker.id,
        teamId: team.id,
        role: 'Project contributor',
        responsibility: 'Perform bounded project assignments and return evidence for director review.',
      })),
      taskKinds: plain,
      kindOwners: {},
    };
  const member = (worker, roles, responsibility) => ({
    workerId: worker.id,
    teamId: team.id,
    role: worker.jobTitle || roles[0],
    responsibility,
    roles,
  });
  return {
    expectedRevision: 0,
    teams: [team],
    members: [
      member(planner, ['planner'], 'Plans each idea into steps the director approves.'),
      // A role named for the agent's title, so the planner can give a writing step to the writer, and the general one.
      ...doers.map(worker =>
        member(
          worker,
          [...new Set([slug(worker.jobTitle), 'worker'].filter(Boolean))],
          'Does the steps the plan gives it and hands its files and summary on.',
        ),
      ),
      member(reviewer, ['reviewer'], 'Reviews each step independently before the director accepts it.'),
    ],
    taskKinds: [...generalKinds, ...plain],
    kindOwners: {},
  };
}
