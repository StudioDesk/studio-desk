// A fresh install's starting organization (v1.0 item 24, MP-027): no projects and no starter tasks, and five agents
// whose work any project can use. No projects yet makes the first project from a sample or Add a project, and the
// CLI chosen there is set on the agents. The game organization stays available as the `game-studio` preset.

const agents = [
  {
    id: 'W-01',
    displayName: 'Mara',
    title: 'Planner',
    team: 'product',
    responsibility: "Turn the director's ideas into small plans the director approves before any work starts.",
    instructions:
      "Plan each idea as the smallest set of steps that delivers it, each with a clear outcome someone can check. Name who should do each step from the project's team. Say what you assumed and what the director should decide; never start the work yourself.",
  },
  {
    id: 'W-02',
    displayName: 'Eli',
    title: 'Engineer',
    team: 'engineering',
    responsibility: 'Make the approved change in its own copy of the repository and show that it works.',
    instructions:
      "Change only the files your story lists, in the repository's existing style. Add or update tests that show the change works, run them, and hand off with a plain summary of what changed and what you checked.",
  },
  {
    id: 'W-06',
    displayName: 'Avery',
    title: 'Checks',
    team: 'quality',
    responsibility: "Run the project's checks on a copy and report what they measured.",
    instructions:
      'Run the checks you are given exactly as they are and report what they measured, passes and failures alike. Never change the work you check.',
  },
  {
    id: 'W-07',
    displayName: 'Morgan',
    title: 'Reviewer',
    team: 'quality',
    responsibility: 'Review each piece of work independently before it goes in or reaches the director.',
    instructions:
      'Review the work against its brief and acceptance criteria and the evidence it hands you. Send it back only for real problems, naming each one and where it is; put anything else in your notes.',
  },
  {
    id: 'W-09',
    displayName: 'Juno',
    title: 'Writer',
    team: 'writing',
    responsibility: 'Write what the plan asks for, from the files and notes the director provides.',
    instructions:
      'Write for the reader the brief names, in the voice its style notes describe. Use only facts from the files you are given, and say what was missing instead of inventing it. Return the writing as a file with a short summary.',
  },
];

const teams = [
  {
    id: 'product',
    name: 'Product',
    mark: 'PR',
    leadId: 'W-01',
    purpose: "Turn the director's ideas into plans the director approves.",
  },
  {
    id: 'engineering',
    name: 'Engineering',
    mark: 'EN',
    leadId: 'W-02',
    purpose: 'Make approved changes to code, with tests.',
  },
  {
    id: 'writing',
    name: 'Writing',
    mark: 'WR',
    leadId: 'W-09',
    purpose: 'Write what approved plans ask for.',
  },
  {
    id: 'quality',
    name: 'Quality',
    mark: 'QA',
    leadId: 'W-07',
    purpose: 'Check and review work independently.',
  },
];

const companyInstructions =
  "Do one approved assignment well. Use the brief, the accepted inputs and the files you are given, stay within the assignment's scope, and hand off a result someone can check, with a plain summary of what you did and what you could not do. The director decides; ask through your result rather than guessing.";

const document = (scope, id, text, publishedAt) => ({
  scope,
  id,
  revision: 1,
  text,
  publishedAt,
  draft: null,
  history: [{ revision: 1, text, publishedAt, note: 'Initial instructions' }],
});

export function firstRunOrganization() {
  const publishedAt = Date.now();
  return {
    schemaVersion: 1,
    version: 4,
    paused: false,
    manual: false,
    quota: {},
    maxParallel: 2,
    company: {
      name: 'Studio desk',
      mission: 'Turn plain-language ideas into reviewed work.',
      milestone: '',
      outcome: '',
      goalTaskIds: [],
    },
    teams: teams.map(team => ({ ...team, goal: '', outcome: '', goalTaskIds: [] })),
    workers: agents.map(agent => ({
      id: agent.id,
      name: agent.title,
      team: teams.find(team => team.id === agent.team).name,
      cli: 'Claude Code',
      role: agent.title,
      model: '',
      workspace: 'Per-attempt output folder',
      tools: ['Private assignment files'],
      paused: false,
      displayName: agent.displayName,
      jobTitle: agent.title,
      responsibility: agent.responsibility,
      provider: 'claude',
      enabled: true,
    })),
    instructions: {
      company: document('company', 'company', companyInstructions, publishedAt),
      teams: Object.fromEntries(teams.map(team => [team.id, document('team', team.id, team.purpose, publishedAt)])),
      employees: Object.fromEntries(
        agents.map(agent => [agent.id, document('employee', agent.id, agent.instructions, publishedAt)]),
      ),
    },
  };
}

export const firstRunOrganizationPreset = {
  id: 'first-run',
  version: 'first-run-v1',
  create: firstRunOrganization,
  // A fresh install with this preset starts with no projects (No projects yet), not the legacy project.
  projects: [],
};
