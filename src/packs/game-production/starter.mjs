export function gameStarterTasks({ organization }) {
  if (!['W-03', 'W-07'].every(id => organization.workers.some(worker => worker.id === id)))
    throw new Error('Game starter tasks need W-03 and W-07; select no workflow starters for a different organization.');
  const common = {
    status: 'ready',
    direction: '',
    dependencies: [],
    resources: [],
    maxSeconds: 120,
    maxAttempts: 3,
    lastAttemptId: null,
    hold: false,
    priority: 'Normal',
    reason: '',
    createdAt: new Date().toISOString(),
  };
  return [
    {
      ...common,
      id: 'D-001',
      title: 'Design the three-room prototype route',
      kind: 'layout',
      team: 'Level Design',
      workerId: 'W-03',
      goalId: 'level-design',
      resources: ['layout:prototype'],
      brief:
        'Design an entry, objective room, and exit using the supplied logical kit. Write layout.json and explain the route, landmarks, and pacing. This is a design specification; no Unreal assets are connected.',
      acceptance:
        'Three catalog rooms, stable IDs, valid positions, entry-to-objective-to-exit connectivity, and a clear design rationale.',
    },
    {
      ...common,
      id: 'R-001',
      title: 'Review the accepted layout independently',
      kind: 'review',
      team: 'QA & Integration',
      workerId: 'W-07',
      goalId: 'qa-integration',
      dependencies: ['D-001'],
      brief:
        'Inspect the accepted design and its evidence. Write review.json with verdict (pass, revise, or blocked), findings, and evidence. Check the brief independently. Do not claim engine traversal or playtesting occurred.',
      acceptance:
        'An explicit verdict with reproducible findings and a distinction between design checks and checks needing Unreal/playtesting.',
    },
  ];
}
