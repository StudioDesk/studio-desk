// Explicit project defaults. This never replaces the shared employee directory.
export function developmentOrganization(org) {
  const enabled = org.workers.filter(worker => worker.enabled);
  if (enabled.length < 2) throw new Error('Studio desk development needs two enabled employees.');
  const choose = (id, fallback) => enabled.find(worker => worker.id === id) || fallback;
  const engineer = choose('W-02', enabled[0]),
    reviewer = choose(
      'W-07',
      enabled.find(worker => worker.id !== engineer.id),
    ),
    checker = choose('W-06', reviewer),
    product = choose('W-01', engineer);
  const members = [...new Set([product.id, engineer.id, checker.id, reviewer.id])].map(workerId => {
    const teamId =
      workerId === engineer.id
        ? 'engineering'
        : workerId === reviewer.id || workerId === checker.id
          ? 'quality'
          : 'product';
    const role =
      workerId === engineer.id
        ? 'Software engineer'
        : workerId === reviewer.id
          ? 'Software reviewer'
          : workerId === checker.id
            ? 'Test engineer'
            : 'Product owner';
    const responsibility =
      workerId === engineer.id
        ? 'Improve the local orchestration controller within approved source scope.'
        : workerId === reviewer.id
          ? 'Assess measured source evidence and propose bounded software improvements.'
          : workerId === checker.id
            ? 'Run reproducible source checks and report measured results.'
            : 'Refine project goals into bounded tasks for director sprint selection.';
    // Staffing roles the Studio desk task types name (MP-015); one person may hold several.
    const roles = [
      ...(workerId === product.id ? ['product-owner'] : []),
      ...(workerId === engineer.id ? ['engineer'] : []),
      ...(workerId === checker.id ? ['tester'] : []),
      ...(workerId === reviewer.id ? ['reviewer'] : []),
    ];
    return { workerId, teamId, role, responsibility, roles };
  });
  const teams = [
    {
      id: 'product',
      name: 'Product',
      purpose: 'Refine the next valuable pipeline improvements.',
      goal: 'Prepare bounded work for director approval.',
    },
    {
      id: 'engineering',
      name: 'Engineering',
      purpose: 'Improve the local orchestration software.',
      goal: 'Implement approved source improvements.',
    },
    {
      id: 'quality',
      name: 'Quality',
      purpose: 'Verify source behavior and review evidence.',
      goal: 'Supply reproducible checks and independent reviews.',
    },
  ].filter(team => members.some(member => member.teamId === team.id));
  teams.forEach(team => {
    team.leadId = members.find(member => member.teamId === team.id).workerId;
  });
  return {
    expectedRevision: 0,
    teams,
    members,
    taskKinds: [
      'general',
      'studio-development:checks',
      'studio-development:review',
      'studio-development:change',
      'studio-development:change-review',
      'studio-development:breakdown',
    ],
    kindOwners: {
      'studio-development:checks': checker.id,
      'studio-development:review': reviewer.id,
      'studio-development:change': engineer.id,
      'studio-development:change-review': reviewer.id,
      'studio-development:breakdown': product.id,
    },
  };
}

// A project for another git repository (1.0 step 4b): Studio desk's staffing, with neutral team
// purposes and responsibilities, which also become its generic published instructions. It takes ideas
// through the New idea box (checks, breakdown, stories), so it has no improvement review.
const repositoryTeams = {
  product: [
    "Turn the director's ideas into bounded stories for this repository.",
    'Prepare bounded work for director approval.',
  ],
  engineering: ['Change this repository within approved story scope.', 'Implement approved stories.'],
  quality: [
    "Measure this repository's tests and review candidates independently.",
    'Supply reproducible checks and independent reviews.',
  ],
};
const repositoryResponsibilities = {
  engineer: 'Change the repository within the approved story files and return reviewable changes with evidence.',
  reviewer: 'Assess measured evidence and candidate changes independently.',
  tester: "Run the repository's tests on a copy and report measured results.",
  'product-owner': "Break the director's ideas into bounded stories for approval.",
};
export function repositoryOrganization(org) {
  const config = developmentOrganization(org);
  for (const team of config.teams) [team.purpose, team.goal] = repositoryTeams[team.id];
  for (const member of config.members)
    member.responsibility = member.roles.map(role => repositoryResponsibilities[role]).join(' ');
  config.taskKinds = config.taskKinds.filter(kind => kind !== 'studio-development:review');
  delete config.kindOwners['studio-development:review'];
  return config;
}
