// Plans are proposals. Only the controller creates records and grants execution.
export function planningContext(org, repair = null, { kinds, adapterIds }) {
  return {
    acceptedInputs: repair?.acceptedInputs || [],
    repair: repair
      ? { review: repair.review, verdict: repair.verdict, findings: repair.findings, evidence: repair.evidence }
      : null,
    limits: { maxTasks: 10, maxSeconds: 600, maxAttempts: 3, totalAttemptSeconds: 1800 },
    kinds,
    reviewKinds: ['review'],
    resourcePrefixes: ['layout:', 'document:'],
    capabilities:
      'Private text/JSON outputs and logical layout/review only. No engine, asset tools, source checkout, or playtesting. Reviews require accepted prerequisite artifacts. All results require director acceptance; failed or blocked work stops for attention.',
    workers: org.workers
      .filter(w => w.enabled && adapterIds.includes(w.provider))
      .map(w => ({
        id: w.id,
        name: w.displayName,
        team: w.team,
        role: w.jobTitle || w.role,
        responsibility: w.responsibility,
        provider: w.provider,
        model: w.model || '',
        paused: !!w.paused,
      })),
  };
}

export function simulatedPlan(context, brief) {
  const designer = context.workers.find(w => w.team === 'Level Design') || context.workers[0];
  const reviewer =
    context.workers.find(w => /reviewer/i.test(w.role || '')) ||
    context.workers.find(w => w.team.startsWith('QA')) ||
    context.workers.find(w => w.id !== designer.id) ||
    designer;
  const plan = {
    version: 'studio-plan-v1',
    summary: 'SIMULATED proposal: a logical three-room layout and independent review.',
    assumptions: [
      'Simulator template only; the requested brief has not been interpreted by a model.',
      'No engine or asset tools are connected.',
    ],
    directorDecisions: [
      'Approve the logical design scope; artistic direction and playtesting remain with the director.',
    ],
    tasks: [
      {
        key: 'layout',
        title: 'Design the logical three-room route',
        kind: 'layout',
        workerId: designer.id,
        brief: `Director brief (Simulator excerpt): ${brief.slice(0, 23000)}\nProduce a logical entry/objective/exit layout using the supplied catalog.`,
        acceptance:
          'Three distinct rooms, directed objective-to-exit route, and design rationale. Label engine checks and playtesting not-run.',
        dependencies: [],
        resources: ['layout:prototype'],
        maxSeconds: 120,
        maxAttempts: 3,
      },
      {
        key: 'review',
        title: 'Review the accepted layout',
        kind: 'review',
        workerId: reviewer.id,
        brief: 'Inspect the accepted layout. Return a traceable logical review with pass, revise, or blocked verdict.',
        acceptance:
          'Identify accepted input hashes and evidence. Separate logical checks from unperformed engine checks and playtesting.',
        dependencies: ['layout'],
        resources: [],
        maxSeconds: 120,
        maxAttempts: 3,
      },
    ],
  };
  if (context.repair) {
    plan.summary = 'SIMULATED repair proposal: new logical layout and independent review of the accepted repair.';
    plan.tasks[0].title = 'Repair the logical three-room route';
    plan.tasks[0].acceptedInputs = context.acceptedInputs.map(ref => ref.taskId);
    plan.tasks[0].brief +=
      '\nUse the pinned review findings and accepted sources. This is a Simulator template; it does not interpret or fix the findings.';
  }
  return plan;
}
